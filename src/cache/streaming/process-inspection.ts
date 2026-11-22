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

import { opendir, lstat, open, readlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
export const GRADLE_DAEMON_MAIN = 'org.gradle.launcher.daemon.bootstrap.GradleDaemon';
export interface DaemonInspection {
  readonly remaining: boolean;
  readonly uncertain: boolean;
  readonly reason?: string;
}
/** Java's launcher options precede the main class; classpath/property text is not a main class. */
export function gradleDaemonArguments(argv: readonly string[]): 'daemon' | 'other' | 'uncertain' {
  const paired = new Set([
    '-cp',
    '-classpath',
    '--class-path',
    '-p',
    '--module-path',
    '--upgrade-module-path',
    '--add-modules',
    '--limit-modules',
    '--add-reads',
    '--add-exports',
    '--add-opens',
    '--patch-module',
    '--enable-native-access',
  ]);
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (paired.has(arg)) {
      if (argv[i + 1]?.startsWith('@')) return 'uncertain';
      i++;
      continue;
    }
    if (arg === '-jar' || arg === '-m' || arg === '--module') break;
    if (arg.startsWith('@')) return 'uncertain';
    if (arg.startsWith('-')) continue;
    if (arg === GRADLE_DAEMON_MAIN) return 'daemon';
    break;
  }
  return argv.includes(GRADLE_DAEMON_MAIN) ? 'uncertain' : 'other';
}
/** Windows native command-line quoting, including escaped quotes/backslashes. */
export function windowsArguments(line: string): string[] {
  const result: string[] = [];
  let value = '',
    quoted = false,
    active = false;
  for (let i = 0; i < line.length; i++) {
    if (!quoted && /\s/.test(line[i])) {
      if (active) {
        result.push(value);
        value = '';
        active = false;
      }
      continue;
    }
    active = true;
    let slashes = 0;
    while (line[i] === '\\') {
      slashes++;
      i++;
    }
    if (line[i] === '"') {
      value += '\\'.repeat(Math.floor(slashes / 2));
      if (slashes % 2) value += '"';
      else quoted = !quoted;
    } else {
      value += '\\'.repeat(slashes);
      if (i < line.length) value += line[i];
    }
  }
  if (quoted) throw new Error('Unterminated native command line.');
  if (active) result.push(value);
  return result;
}
async function limited(path: string): Promise<string> {
  const handle = await open(path, 'r'),
    bytes = Buffer.alloc(65537);
  let length = 0;
  try {
    while (length < bytes.length) {
      const got = await handle.read(bytes, length, bytes.length - length, null);
      if (!got.bytesRead) break;
      length += got.bytesRead;
    }
    if (length > 65536) throw new Error('Native process record exceeds bound.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    await handle.close();
  }
}
export function linuxStartTime(stat: string): string {
  const fields = stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/),
    value = fields[19];
  if (stat.indexOf('(') < 0 || !value || !/^\d+$/.test(value))
    throw new Error('Invalid process identity.');
  return value;
}
// Primary ABI: kernel.org/doc/html/v6.17/filesystems/proc.html.
async function linuxInspection(signal: AbortSignal): Promise<DaemonInspection> {
  const entries = await opendir('/proc');
  let remaining = false;
  for await (const e of entries) {
    signal.throwIfAborted();
    if (!/^\d+$/.test(e.name)) continue;
    const base = '/proc/' + e.name;
    try {
      const owner = await lstat(base);
      if (owner.uid !== process.getuid!()) continue;
      const before = linuxStartTime(await limited(base + '/stat')),
        line = await limited(base + '/cmdline'),
        after = linuxStartTime(await limited(base + '/stat'));
      if (before !== after)
        return {
          remaining,
          uncertain: true,
          reason: 'Process identity changed during inspection.',
        };
      const argv = line.split('\0');
      if (argv[argv.length - 1] === '') argv.pop();
      const kind = gradleDaemonArguments(argv);
      if (kind !== 'other') {
        const image = (await readlink(base + '/exe')).split('/').pop()!;
        if (!/^javaw?$/.test(image)) {
          if (/^javaw?$/.test(argv[0]?.split('/').pop() ?? ''))
            return {
              remaining,
              uncertain: true,
              reason: 'Java launcher has an unknown executable image.',
            };
          continue; // e.g. grep/pgrep arguments are not a running Java daemon.
        }
      }
      if (kind === 'uncertain')
        return { remaining, uncertain: true, reason: 'Ambiguous Java main-class arguments.' };
      if (kind === 'daemon') remaining = true;
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      return {
        remaining,
        uncertain: true,
        reason:
          'Process record unavailable: ' +
          ((error as NodeJS.ErrnoException).code ?? (error as Error).name),
      };
    }
  }
  signal.throwIfAborted();
  return { remaining, uncertain: false };
}
// Win32_Process exposes CommandLine/CreationDate/GetOwnerSid. Each JSON line is one
// process, never a buffered global process inventory. No observed PID is signalled.
const windowsInspection = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
Get-CimInstance Win32_Process -Filter "Name='java.exe' OR Name='javaw.exe'" | ForEach-Object {
 $owner=Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid
 if($owner.ReturnValue -ne 0){ ConvertTo-Json -Compress -InputObject @('unknown', [int]$_.ProcessId) }
 elseif($owner.Sid -eq $sid){
  if(!$_.CommandLine -or !$_.CreationDate -or !$_.ExecutablePath){ ConvertTo-Json -Compress -InputObject @('unknown', [int]$_.ProcessId) }
  else { ConvertTo-Json -Compress -InputObject @('process',[int]$_.ProcessId,$_.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture),$_.CommandLine) }
 }
}
`;
async function inspectWindows(signal: AbortSignal): Promise<DaemonInspection> {
  signal.throwIfAborted();
  const child = spawn(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(windowsInspection, 'utf16le').toString('base64'),
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  let tail = Buffer.alloc(0),
    remaining = false,
    uncertain = false;
  const finish = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  void finish.catch(() => {});
  const timer = setTimeout(() => {
      uncertain = true;
      child.kill();
    }, 30000),
    abort = () => {
      uncertain = true;
      child.kill();
    };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of child.stdout!) {
      tail = Buffer.concat([tail, Buffer.from(chunk)]);
      let at: number;
      while ((at = tail.indexOf(10)) >= 0) {
        const bytes = tail.subarray(0, at);
        tail = tail.subarray(at + 1);
        if (bytes.length > 65536) throw new Error('Oversized process record.');
        const row = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
        if (
          !Array.isArray(row) ||
          row[0] !== 'process' ||
          row.length !== 4 ||
          !Number.isInteger(row[1]) ||
          row[1] <= 0 ||
          typeof row[2] !== 'string' ||
          !/^\d+$/.test(row[2]) ||
          typeof row[3] !== 'string'
        )
          uncertain = true;
        else {
          const kind = gradleDaemonArguments(windowsArguments(row[3]));
          remaining ||= kind === 'daemon';
          uncertain ||= kind === 'uncertain';
        }
      }
      if (tail.length > 65536) throw new Error('Oversized process record.');
    }
    const code = await finish;
    signal.throwIfAborted();
    return { remaining, uncertain: uncertain || code !== 0 || tail.length !== 0 };
  } catch (error) {
    child.kill();
    await finish.catch(() => {});
    signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
export async function inspectGradleDaemons(
  signal = new AbortController().signal,
): Promise<DaemonInspection> {
  signal.throwIfAborted();
  if (process.platform === 'linux') return linuxInspection(signal);
  if (process.platform === 'win32') return inspectWindows(signal);
  if (process.platform === 'darwin') {
    const { inspectDarwinDaemons } = await import('./darwin-process-inspection');
    return inspectDarwinDaemons(signal);
  }
  // Unknown platforms cannot establish exclusivity.
  return { remaining: false, uncertain: true };
}
