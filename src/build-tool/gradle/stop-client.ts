/*
 * Copyright 2026 The Buildish Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
export interface GradleInstallation {
  readonly gradleHome: string;
  readonly gradleUserHome: string;
  readonly javaHome: string;
}

// The PowerShell job owns its native pipeline. Stop-Job on timeout terminates only
// that pipeline, including client descendants; never any daemon from process discovery.
const windowsStop = `
$ErrorActionPreference='Stop'
$job=Start-Job -ScriptBlock {
 & $env:ComSpec /d /s /v:off /c '""%MAMMOTH_STOP_HOME%\\bin\\gradle.bat" --stop --gradle-user-home "%MAMMOTH_STOP_USER_HOME%""' 1>$null 2>$null
 if($LASTEXITCODE -ne 0){throw 'Gradle stop client failed'}
}
try {
 if(!(Wait-Job $job -Timeout ([int]$env:MAMMOTH_STOP_SECONDS))){exit 124}
 Receive-Job $job -ErrorAction Stop | Out-Null
 if($job.State -ne 'Completed'){exit 1}
} finally { Stop-Job $job; Remove-Job $job -Force }
`;
// This tiny POSIX group leader owns its own watchdog even if Mammoth dies.
// It signals only -its-own-live-PID, so a recycled PID/group cannot be targeted.
const posixSupervisor = `
const {spawn}=require('node:child_process');
let stopping=false;
function stop(){
 if(stopping)return;
 stopping=true;
 setTimeout(()=>process.kill(-process.pid,'SIGKILL'),2000);
 process.kill(-process.pid,'SIGTERM');
}
process.on('SIGTERM',stop);
process.on('disconnect',stop);
process.on('message',message=>{if(message==='stop')stop();});
const watchdog=setTimeout(stop,Number(process.argv[1]));
const child=spawn(process.argv[2],process.argv.slice(3),{stdio:'ignore'});
function done(code){
 if(stopping)return;
 clearTimeout(watchdog);
 process.send(['client-exit',code],()=>process.kill(-process.pid,'SIGKILL'));
}
child.once('error',()=>done(1));
child.once('close',code=>done(code??1));
`;
/** A bounded owned stop client, not a daemon PID kill fallback. */
export async function stopGradleInstallation(
  installation: GradleInstallation,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Invalid stop-client deadline.');
  }
  const env = {
    ...process.env,
    JAVA_HOME: installation.javaHome,
    GRADLE_USER_HOME: installation.gradleUserHome,
    // Launcher defaults are small; do not inherit build JVM heaps/agents into stop clients.
    JAVA_OPTS: '',
    GRADLE_OPTS: '',
    JAVA_TOOL_OPTIONS: '',
    JDK_JAVA_OPTIONS: '',
    _JAVA_OPTIONS: '',
    NODE_OPTIONS: '',
    MAMMOTH_STOP_HOME: installation.gradleHome,
    MAMMOTH_STOP_USER_HOME: installation.gradleUserHome,
    MAMMOTH_STOP_SECONDS: String(Math.max(1, Math.ceil(timeoutMs / 1000))),
  };
  const windows = process.platform === 'win32',
    command = windows ? 'powershell.exe' : process.execPath,
    args = windows
      ? [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(windowsStop, 'utf16le').toString('base64'),
        ]
      : [
          '-e',
          posixSupervisor,
          String(timeoutMs),
          path.join(installation.gradleHome, 'bin', 'gradle'),
          '--stop',
          '--gradle-user-home',
          installation.gradleUserHome,
        ],
    child = spawn(command, args, {
      cwd: installation.gradleHome,
      env,
      detached: !windows,
      windowsHide: true,
      stdio: windows ? 'ignore' : ['ignore', 'ignore', 'ignore', 'ipc'],
    });
  let expired = false,
    completion: number | undefined;
  child.on('message', (message) => {
    if (
      Array.isArray(message) &&
      message.length === 2 &&
      message[0] === 'client-exit' &&
      Number.isSafeInteger(message[1])
    ) {
      completion = message[1];
    }
  });
  const terminate = () => {
    expired = true;
    if (child.connected) {
      child.send('stop', () => {});
    }
  };
  if (!windows) {
    signal.addEventListener('abort', terminate, { once: true });
    if (signal.aborted) {
      terminate();
    }
  }
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, reason) =>
        resolve(!windows && code === null && reason === 'SIGKILL' ? (completion ?? null) : code),
      );
    });
    signal.throwIfAborted();
    if (expired || code !== 0) {
      throw new Error('Gradle stop client failed or exceeded its deadline.');
    }
  } finally {
    signal.removeEventListener('abort', terminate);
  }
}
