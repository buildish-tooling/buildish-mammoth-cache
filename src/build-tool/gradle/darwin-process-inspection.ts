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
import { GRADLE_DAEMON_MAIN, type DaemonInspection } from './process-inspection';

export const DARWIN_PS_ARGS = [
  '-Aww',
  '-o',
  'uid=',
  '-o',
  'pid=',
  '-o',
  'ucomm=',
  '-o',
  'args=',
] as const;
const maxRecord = 65536;
const javaImage = /^(?:javaw?|\/.*?\/bin\/javaw?)(?: +|$)/;

// Display text is not argv. Check the entire marker first; a property containing
// it can conservatively deny, but flattened argument boundaries cannot hide it.
function javaDisplay(text: string): 'daemon' | 'other' | 'uncertain' {
  if (text.includes(GRADLE_DAEMON_MAIN)) {
    return 'daemon';
  }
  const image = javaImage.exec(text);
  if (!image || /[@\\"']/.test(text)) {
    return 'uncertain';
  }
  let classpath = false;
  for (const [word] of text.slice(image[0].length).matchAll(/[^ ]+/g)) {
    if (classpath) {
      classpath = false;
      continue;
    }
    if (['-cp', '-classpath', '--class-path'].includes(word)) {
      classpath = true;
      continue;
    }
    if (
      /^-D[^= ]+(?:=.*)?$/.test(word) ||
      /^-X.+/.test(word) ||
      ['-ea', '-da', '-esa', '-dsa'].includes(word)
    ) {
      continue;
    }
    if (/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(word) && !word.endsWith('.java')) {
      return 'other';
    }
    return 'uncertain';
  }
  return 'uncertain';
}

// Protocol: docs/dev/cache-lifecycle-protocol.md#native-macos-process-evidence.
// Apple adv_cmds ps(1)/print.c: uid is effective UID; ucomm is accounting name;
// args is escaped display text with lost boundaries, never an exact argv codec.
export class DarwinProcessTable {
  private tail = Buffer.alloc(0);
  private self = false;
  private remaining = false;
  private uncertain = false;
  private ended = false;

  constructor(
    private readonly uid: number,
    private readonly pid: number,
  ) {
    if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(pid) || pid < 1) {
      throw new Error('Invalid process observer identity.');
    }
  }

  get bufferedBytes() {
    return this.tail.length;
  }

  push(chunk: Buffer): void {
    if (this.ended) {
      throw new Error('Process table already ended.');
    }
    let start = 0;
    while (start < chunk.length) {
      const lf = chunk.indexOf(10, start),
        end = lf < 0 ? chunk.length : lf;
      if (this.tail.length + end - start > maxRecord) {
        throw new Error('Oversized process record.');
      }
      const part = chunk.subarray(start, end);
      if (lf < 0) {
        this.tail = Buffer.concat([this.tail, part]);
        return;
      }
      const record = this.tail.length ? Buffer.concat([this.tail, part]) : part;
      this.tail = Buffer.alloc(0);
      this.record(new TextDecoder('utf-8', { fatal: true }).decode(record));
      start = lf + 1;
    }
  }

  private record(line: string) {
    for (let n = 0; n < line.length; n++) {
      const code = line.charCodeAt(n);
      if (code < 32 || code === 127) {
        throw new Error('Invalid process display controls.');
      }
    }
    const record = line.trimStart(),
      row = /^([0-9]+) +([0-9]+) +([^ ]+) /.exec(record);
    // ucomm is an accounting basename, not an argv image/path shifted into a missing column.
    if (!row || row[3].includes('/')) {
      throw new Error('Malformed process table record.');
    }
    const uid = Number(row[1]),
      pid = Number(row[2]);
    if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(pid)) {
      throw new Error('Invalid process identity.');
    }
    if (uid !== this.uid) {
      return;
    }
    if (pid < 1) {
      throw new Error('Invalid owned process identity.');
    }
    if (pid === this.pid) {
      if (this.self) {
        throw new Error('Duplicate observer process record.');
      }
      this.self = true;
    }
    const accountingJava = /^javaw?$/.test(row[3]),
      text = record.slice(row[0].length).trim();
    if (!accountingJava) {
      if (javaImage.test(text)) {
        this.uncertain = true;
      }
      return;
    }
    const kind = javaDisplay(text);
    this.remaining ||= kind === 'daemon';
    this.uncertain ||= kind === 'uncertain';
  }

  finish(): DaemonInspection {
    if (this.ended) {
      throw new Error('Process table already ended.');
    }
    this.ended = true;
    return {
      remaining: this.remaining,
      uncertain: this.uncertain || !this.self || this.tail.length !== 0,
    };
  }
}

/** One owned read-only inspector child; no discovered PID is ever signalled. */
export async function inspectDarwinDaemons(signal: AbortSignal): Promise<DaemonInspection> {
  signal.throwIfAborted();
  const table = new DarwinProcessTable(process.geteuid!(), process.pid),
    child = spawn('/bin/ps', [...DARWIN_PS_ARGS], {
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  let closed = false,
    failed = false,
    code: number | null = null,
    stopped = false,
    hard: ReturnType<typeof setTimeout> | undefined;
  const finish = new Promise<void>((resolve) => {
    child.once('error', () => {
      failed = true;
    });
    child.once('close', (exit) => {
      closed = true;
      code = exit;
      resolve();
    });
  });
  const stop = () => {
      if (closed || stopped) {
        return;
      }
      stopped = true;
      child.kill('SIGTERM');
      hard = setTimeout(() => {
        if (!closed) {
          child.kill('SIGKILL');
        }
      }, 500);
    },
    timer = setTimeout(stop, 30000);
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) {
    stop();
  }
  try {
    for await (const chunk of child.stdout!) {
      table.push(Buffer.from(chunk));
    }
    await finish;
    signal.throwIfAborted();
    if (failed || stopped || code !== 0) {
      throw new Error('Process inspection did not complete.');
    }
    return table.finish();
  } catch {
    stop();
    await finish;
    signal.throwIfAborted();
    return { remaining: false, uncertain: true, reason: 'macOS process evidence unavailable.' };
  } finally {
    clearTimeout(timer);
    clearTimeout(hard);
    signal.removeEventListener('abort', stop);
  }
}
