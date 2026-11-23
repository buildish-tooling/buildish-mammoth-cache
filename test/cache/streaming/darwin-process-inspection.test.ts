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

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import type * as ChildProcess from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  DarwinProcessTable,
  DARWIN_PS_ARGS,
  inspectDarwinDaemons,
} from '../../../src/build-tool/gradle/darwin-process-inspection';
import {
  GRADLE_DAEMON_MAIN as main,
  inspectGradleDaemons,
} from '../../../src/build-tool/gradle/process-inspection';
import { ExclusiveWindow } from '../../../src/cache/streaming/quiescence';
import { quiescenceFixture, gradleResolver } from './quiescence-fixture';
const cleanup: (() => Promise<void>)[] = [];
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
beforeEach(() => {
  // The reader's fake process table is portable; Windows has no native geteuid.
  vi.stubGlobal('process', Object.create(process, { geteuid: { value: () => 501 } }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const self = '501 42 node /opt/node/bin/node mammoth.cjs\n';
function table(line: string) {
  const value = new DarwinProcessTable(501, 42);
  value.push(Buffer.from(self + line));
  return value.finish();
}
it.each([
  '501 99 java /jdk/bin/java -cp /gradle/lib ' + main + ' 9.2.1',
  '501 99 java /space é/home/bin/java -Dguh=/tab\\^Ihome ' + main + ' 9.2.1',
  '501 99 java /jdk/bin/java -Dmention=' + main + ' Other',
  '501 99 java /jdk/bin/java Other "' + main + '"',
])('denies a literal marker anywhere in Java display: %s', (line) => {
  expect(table(line + '\n')).toEqual({ remaining: true, uncertain: false });
});
it.each([
  '501 99 java /jdk/bin/java -cp /classes Other',
  '501 99 java /space é/home/bin/java -Xmx32m -Dproperty=value Other arg',
  '501 99 java java -ea --class-path /classes Other',
  '501 99 grep grep ' + main,
  '501 99 node /bin/node -e "java ' + main + '"',
  '502 99 java /jdk/bin/java ' + main,
  '0 0 kernel_task kernel_task',
])('recognizes noncandidate ordinary records without argv reconstruction: %s', (line) => {
  expect(table(line + '\n')).toEqual({ remaining: false, uncertain: false });
});
it.each([
  '501 99 java (java)',
  '501 99 java [java]',
  '501 99 java <defunct>',
  '501 99 java /jdk/bin/java',
  '501 99 java /jdk/bin/java -Xmx32m',
  '501 99 java /jdk/bin/java @args.txt',
  '501 99 java /jdk/bin/java -Demail=a@b Other',
  '501 99 java /jdk/bin/java -jar app.jar',
  '501 99 java /jdk/bin/java -m module/Other',
  '501 99 java /jdk/bin/java Source.java',
  '501 99 java /jdk/bin/java -cp',
  '501 99 java /jdk/bin/java --unknown-flag Other',
  '501 99 java /jdk/bin/java Other "quoted arg"',
  '501 99 java /jdk/bin/java Other \\^Jdisplay',
  '501 99 node /jdk/bin/java Other',
  '501 99 java /unknown/image Other',
])('keeps unavailable/indirect/ambiguous candidates uncertain: %s', (line) => {
  expect(table(line + '\n').uncertain).toBe(true);
});
it.each(['', '0 99 node node\n', '501 99 node node'])(
  'requires the observer and complete EOF: %j',
  (text) => {
    const parser = new DarwinProcessTable(501, 42);
    parser.push(Buffer.from(text));
    expect(parser.finish().uncertain).toBe(true);
  },
);
it.each([
  'nonnumeric 99 java /jdk/bin/java Other\n',
  '501 -1 java /jdk/bin/java Other\n',
  '501 99 /jdk/bin/java ' + main + '\n',
  '501 9007199254740992 java /jdk/bin/java Other\n',
  '501 0 java /jdk/bin/java Other\n',
  '501 99 java /jdk/bin/java Other\tbad\n',
  '501 99 java /jdk/bin/java Other\0bad\n',
  '501 42 node /bin/node observer-again\n',
  '\n',
])('rejects malformed evidence without exposing its bytes: %j', (text) => {
  expect(() => table(text)).toThrow();
});
it('bounds partial storage and never retains the process catalogue', () => {
  const parser = new DarwinProcessTable(501, 42);
  for (const byte of Buffer.from(self)) parser.push(Buffer.from([byte]));
  for (let n = 0; n < 10000; n++) {
    parser.push(Buffer.from('501 99 node /node other\n'));
    expect(parser.bufferedBytes).toBe(0);
  }
  expect(parser.finish()).toEqual({ remaining: false, uncertain: false });
  expect(() => parser.push(Buffer.from(self))).toThrow('ended');
  const overflow = new DarwinProcessTable(501, 42);
  overflow.push(Buffer.alloc(65536, 97));
  expect(overflow.bufferedBytes).toBe(65536);
  expect(() => overflow.push(Buffer.from('a'))).toThrow('Oversized');
  expect(overflow.bufferedBytes).toBe(65536);
});
it('decodes fragmented Unicode only after complete record and rejects invalid UTF8', () => {
  const bytes = Buffer.from(self + '501 99 java /space é/home/bin/java Other\n'),
    parser = new DarwinProcessTable(501, 42);
  for (const byte of bytes) parser.push(Buffer.from([byte]));
  expect(parser.finish()).toEqual({ remaining: false, uncertain: false });
  expect(() => new DarwinProcessTable(501, 42).push(Buffer.from([255, 10]))).toThrow();
});
function child(run: (f: ReturnType<typeof fake>) => void, resistant = false) {
  const f = fake(resistant);
  vi.mocked(spawn).mockImplementationOnce(() => {
    queueMicrotask(() => run(f));
    return f as unknown as ReturnType<typeof spawn>;
  });
  return f;
}
function fake(resistant: boolean) {
  const f = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    close: (code?: number | null) => void;
  };
  f.stdout = new PassThrough();
  f.close = (code = 0) => {
    f.stdout.end();
    f.emit('close', code);
  };
  f.kill = vi.fn((signal: string) => {
    if (!resistant || signal === 'SIGKILL') f.close(null);
    return true;
  });
  return f;
}
const actualSelf = () => `${process.geteuid!()} ${process.pid} node /node mammoth\n`;
it('uses fixed native args/locale and waits for complete successful close', async () => {
  const f = child((f) => {
    f.stdout.write(actualSelf());
    f.close();
  });
  expect(await inspectDarwinDaemons(new AbortController().signal)).toEqual({
    remaining: false,
    uncertain: false,
  });
  const [command, args, options] = vi.mocked(spawn).mock.calls[0];
  expect(command).toBe('/bin/ps');
  expect(args).toEqual([...DARWIN_PS_ARGS]);
  expect(options?.env?.LC_ALL).toBe('C');
  expect(options?.env?.LANG).toBe('C');
  expect(options?.stdio).toEqual(['ignore', 'pipe', 'ignore']);
  expect(f.kill).not.toHaveBeenCalled();
});
it.each(['nonzero', 'error', 'bad-record', 'missing-lf'] as const)(
  'denies failed owned observation %s',
  async (kind) => {
    const f = child((f) => {
      if (kind === 'error') f.emit('error', new Error('private diagnostic not logged'));
      f.stdout.write(
        kind === 'bad-record'
          ? 'bad\n'
          : actualSelf().trimEnd() + (kind === 'missing-lf' ? '' : '\n'),
      );
      if (kind !== 'bad-record') f.close(kind === 'nonzero' ? 1 : 0);
    });
    expect((await inspectDarwinDaemons(new AbortController().signal)).uncertain).toBe(true);
    if (kind === 'bad-record') expect(f.kill).toHaveBeenCalledWith('SIGTERM');
  },
);
it('does not spawn on pre-cancelled inspection', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled before spawn'));
  await expect(inspectDarwinDaemons(controller.signal)).rejects.toThrow('cancelled before spawn');
  expect(spawn).not.toHaveBeenCalled();
});
it('awaits owned child settlement after cancellation and escalates only that child', async () => {
  vi.useFakeTimers();
  const controller = new AbortController(),
    f = child(() => {}, true);
  const result = inspectDarwinDaemons(controller.signal);
  const rejected = expect(result).rejects.toThrow('cancelled inspection');
  controller.abort(new Error('cancelled inspection'));
  expect(f.kill).toHaveBeenCalledWith('SIGTERM');
  await vi.advanceTimersByTimeAsync(500);
  await rejected;
  expect(f.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  expect(vi.getTimerCount()).toBe(0);
});
it('bounds a hung inspector and settles it before returning uncertain', async () => {
  vi.useFakeTimers();
  const f = child(() => {}, true);
  const result = inspectDarwinDaemons(new AbortController().signal);
  await vi.advanceTimersByTimeAsync(30500);
  expect((await result).uncertain).toBe(true);
  expect(f.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  expect(vi.getTimerCount()).toBe(0);
});

function darwin() {
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }));
}
it.skipIf(process.platform === 'win32').each(['clean', 'remaining', 'uncertain'] as const)(
  'default Darwin dispatch/controller uses %s evidence before granting a window',
  async (kind) => {
    const f = await quiescenceFixture();
    cleanup.push(async () => {
      expect(f.budget.retained).toBe(0);
      await f.close();
    });
    await f.register('8.5');
    const before = await f.store.state(),
      stop = vi.fn(async () => {});
    darwin();
    child((f) => {
      f.stdout.write(actualSelf());
      if (kind !== 'clean')
        f.stdout.write(
          `${process.geteuid!()} 99 java /jdk/bin/java ${kind === 'remaining' ? main : '@hidden'}\n`,
        );
      f.close();
    });
    const gate = await ExclusiveWindow.establish(f.store, f.budget, {
      assertCurrent: (): undefined => {},
      lifecycle: gradleResolver({ stop }),
      exitGraceMs: 0,
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    if (kind === 'clean') {
      expect(gate.status).toBe('ready');
      if (gate.status !== 'ready') throw new Error(gate.message);
      gate.window.close();
      expect(((await f.store.state()) as unknown[])[4]).toBe('build-ready');
    } else {
      expect(gate.status).toBe('skipped-not-quiescent');
      expect(await f.store.state()).toEqual(before);
    }
  },
);
it('dispatches real-shaped Darwin native evidence through the public inspector', async () => {
  darwin();
  child((f) => {
    f.stdout.write(actualSelf());
    f.close();
  });
  expect(await inspectGradleDaemons()).toEqual({ remaining: false, uncertain: false });
});
it.skipIf(process.platform === 'win32')(
  'keeps Darwin queries/stops/metadata independent of payload growth with 1/16 captured installations',
  async () => {
    darwin();
    const costs = [];
    for (const installs of [1, 16])
      for (const width of [4, 16]) {
        const f = await quiescenceFixture();
        cleanup.push(async () => {
          expect(f.budget.retained).toBe(0);
          await f.close();
        });
        for (let n = 0; n < installs; n++) await f.register('version-' + n);
        await f.files(
          '',
          Object.fromEntries(Array.from({ length: width }, (_, n) => ['data/file-' + n, 'body'])),
        );
        const before = { ...f.store.root.work },
          stop = vi.fn(async () => {}),
          native = child((f) => {
            f.stdout.write(actualSelf());
            f.close();
          });
        const gate = await ExclusiveWindow.establish(f.store, f.budget, {
          assertCurrent: (): undefined => {},
          lifecycle: gradleResolver({ stop }),
          exitGraceMs: 0,
        });
        if (gate.status !== 'ready') throw new Error(gate.message);
        expect(stop).toHaveBeenCalledTimes(installs);
        for (let n = 0; n < width; n++) gate.window.assertCurrent();
        gate.window.close();
        expect(native.kill).not.toHaveBeenCalled();
        const w = f.store.root.work;
        costs.push({
          installs,
          stats: w.stats - before.stats,
          opens: w.opens - before.opens,
        });
      }
    expect(spawn).toHaveBeenCalledTimes(4);
    expect(costs[0]).toEqual(costs[1]);
    expect(costs[2]).toEqual(costs[3]);
    process.stdout.write('V6_DARWIN_COST ' + JSON.stringify(costs) + '\n');
  },
  30000,
);
