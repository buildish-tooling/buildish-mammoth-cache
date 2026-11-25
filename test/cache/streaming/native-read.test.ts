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

import { mkdtemp, writeFile, rm, rename, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeRoot } from '../../../src/cache/streaming/native';
import { abortableValues } from '../../../src/cache/streaming/abort';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});
async function fixture() {
  const directory = await mkdtemp(path.resolve('build/native-read-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const root = await NativeRoot.bind(directory),
    body = Buffer.alloc(2 * 65536 + 13);
  body.fill(0x61, 0, 65536);
  body.fill(0x62, 65536, 2 * 65536);
  body.fill(0x63, 2 * 65536);
  await writeFile(root.resolve('body'), body);
  const emitted: Buffer[] = [],
    handles: FileHandle[] = [],
    closures: Promise<void>[] = [],
    open = root.openRead.bind(root);
  vi.spyOn(root, 'openRead').mockImplementation(async (...args) => {
    const result = await open(...args);
    handles.push(result.handle);
    cleanup.push(() => result.handle.close());
    const close = result.handle.close.bind(result.handle);
    let done!: () => void;
    closures.push(
      new Promise<void>((resolve) => {
        done = resolve;
      }),
    );
    vi.spyOn(result.handle, 'close').mockImplementation(async () => {
      try {
        await close();
      } finally {
        done();
      }
    });
    const create = result.handle.createReadStream.bind(result.handle);
    vi.spyOn(result.handle, 'createReadStream').mockImplementation((options) => {
      expect(options).toEqual({ autoClose: false, highWaterMark: 65536 });
      const stream = create(options),
        iterator = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = async function* () {
        for await (const chunk of { [Symbol.asyncIterator]: iterator }) {
          expect(Buffer.isBuffer(chunk)).toBe(true);
          emitted.push(chunk);
          yield chunk;
        }
        return undefined;
      };
      return stream;
    });
    return result;
  });
  return {
    directory,
    root,
    body,
    emitted,
    handles,
    closures,
    open: vi.mocked(root.openRead).getMockImplementation()!,
  };
}
async function closed(handle: FileHandle) {
  await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
}
async function drain(source: AsyncIterable<Buffer>) {
  const chunks: Buffer[] = [];
  for await (const chunk of source) {
    chunks.push(chunk);
  }
  return chunks;
}
it('forwards actual emitted buffers without wrapper copies and retains stable chunks across delayed pulls', async () => {
  const f = await fixture(),
    accepted = vi.fn(),
    from = vi.spyOn(Buffer, 'from'),
    reader = f.root.read('body', undefined, accepted);
  const first = await reader.next();
  expect(first.done).toBe(false);
  expect(first.value).toBe(f.emitted[0]);
  await setImmediate();
  expect(f.emitted).toHaveLength(1);
  expect(f.root.work.readBytes).toBe(65536);
  const second = await reader.next();
  expect(second.value).toBe(f.emitted[1]);
  expect(second.value).not.toBe(first.value);
  await setImmediate();
  expect(first.value).toEqual(f.body.subarray(0, 65536));
  const short = await reader.next();
  expect(short.value).toBe(f.emitted[2]);
  expect(short.value).toHaveLength(13);
  expect(await reader.next()).toEqual({ done: true, value: undefined });
  expect(f.emitted.map((chunk) => chunk.length)).toEqual([65536, 65536, 13]);
  expect(first.value).toEqual(f.body.subarray(0, 65536));
  expect(from.mock.calls.filter(([input]) => f.emitted.some((chunk) => input === chunk))).toEqual(
    [],
  );
  expect(f.root.work.readBytes).toBe(f.body.length);
  expect(accepted).toHaveBeenCalledTimes(1);
  await closed(f.handles[0]);
});
it('closes an early-return reader without claiming final acceptance or pulling another chunk', async () => {
  const f = await fixture(),
    accepted = vi.fn(),
    reader = f.root.read('body', undefined, accepted);
  await reader.next();
  await reader.return(undefined);
  expect(f.emitted).toHaveLength(1);
  expect(accepted).not.toHaveBeenCalled();
  await closed(f.handles[0]);
});
it('propagates stream read errors and closes the actual file handle without accepting EOF', async () => {
  const f = await fixture(),
    accepted = vi.fn(),
    reader = f.root.read('body', undefined, accepted);
  await reader.next();
  const create = vi.mocked(f.handles[0].createReadStream),
    stream = create.mock.results[0].value;
  stream.destroy(new Error('native stream failed'));
  await expect(reader.next()).rejects.toThrow('native stream failed');
  expect(accepted).not.toHaveBeenCalled();
  await closed(f.handles[0]);
});
it('closes the paused native reader when its actual consumer lifetime is cancelled', async () => {
  const f = await fixture(),
    accepted = vi.fn(),
    controller = new AbortController(),
    reader = abortableValues(f.root.read('body', undefined, accepted), controller.signal);
  await reader.next();
  controller.abort(new Error('consumer cancelled'));
  await expect(reader.next()).rejects.toThrow('consumer cancelled');
  await f.closures[0];
  expect(accepted).not.toHaveBeenCalled();
  await closed(f.handles[0]);
});
it('rejects unexpected encoded chunks without a fallback copy and closes the handle', async () => {
  const f = await fixture(),
    open = f.open,
    accepted = vi.fn();
  vi.spyOn(f.root, 'openRead').mockImplementation(async (...args) => {
    const result = await open(...args);
    vi.mocked(result.handle.createReadStream).mockImplementation(
      () => Readable.from(['encoded string']) as ReturnType<FileHandle['createReadStream']>,
    );
    return result;
  });
  await expect(drain(f.root.read('body', undefined, accepted))).rejects.toThrow('non-Buffer');
  expect(f.root.work.readBytes).toBe(0);
  expect(accepted).not.toHaveBeenCalled();
  await closed(f.handles[0]);
});
it('keeps final native file drift detection after forwarding all body chunks', async () => {
  const f = await fixture(),
    accepted = vi.fn(),
    reader = f.root.read('body', undefined, accepted);
  await reader.next();
  await writeFile(f.root.resolve('body'), Buffer.alloc(f.body.length, 0x7a));
  await expect(drain(reader)).rejects.toThrow('Native file changed during read');
  expect(accepted).not.toHaveBeenCalled();
  await closed(f.handles[0]);
});
it('keeps final source-name replacement detection independently of the opened handle facts', async () => {
  const f = await fixture(),
    open = f.open,
    accepted = vi.fn();
  vi.spyOn(f.root, 'openRead').mockImplementation(async (...args) => {
    const result = await open(...args),
      stat = result.handle.stat.bind(result.handle);
    vi.spyOn(result.handle, 'stat').mockImplementation(async (...options) => {
      const before = await stat(...options);
      await rename(f.root.resolve('body'), f.root.resolve('old'));
      await writeFile(f.root.resolve('body'), f.body);
      return before;
    });
    return result;
  });
  await expect(drain(f.root.read('body', undefined, accepted))).rejects.toThrow(
    'Native source name changed',
  );
  expect(accepted).not.toHaveBeenCalled();
  await closed(f.handles[0]);
});
it('closes the handle if final acceptance rejects', async () => {
  const f = await fixture();
  await expect(
    drain(
      f.root.read('body', undefined, () => {
        throw new Error('acceptance rejected');
      }),
    ),
  ).rejects.toThrow('acceptance rejected');
  await closed(f.handles[0]);
});
