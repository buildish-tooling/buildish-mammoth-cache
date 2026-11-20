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

import { createHash } from 'node:crypto';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { pack } from '../../../build/patched-tar-stream/index.js';
import { add, decodeRecord, encodeRecord, tuple, type Value } from './encoding';
import { readWorkerTransport, type WorkerTarHeader } from './worker-transport';
import { WorkerState, type WorkerContext, type WorkerSummary } from './worker-state';
import type { Unit } from './schema';
import { withAbort, abortableValues } from './abort';

// Protocol: docs/dev/cache-protocol.md#reader-state-machine and #file-metadata-pairing
export interface WorkerFile {
  readonly path: string;
  readonly partition: string;
  readonly ordinal: number;
  readonly header: WorkerTarHeader;
  readonly body: AsyncIterable<Buffer>;
}
export interface WorkerReader extends WorkerContext {
  consumeFile(file: WorkerFile, signal: AbortSignal): Promise<void>;
  /** Validated events remain provisional until readWorkerArchive resolves. */
  event?(value: Value, signal: AbortSignal): Promise<void>;
}
export async function readWorkerArchive(
  source: Readable,
  options: WorkerReader,
  signal?: AbortSignal,
): Promise<WorkerSummary> {
  let state: WorkerState | undefined;
  try {
    await readWorkerTransport(
      source,
      async ({ header, body }, transportSignal) => {
        state ??= new WorkerState(options, transportSignal);
        if (header.name.startsWith('.mammoth-meta/')) {
          const release = options.budget.holdRecord(header.size);
          try {
            const bytes = Buffer.allocUnsafe(header.size);
            let at = 0;
            for await (const chunk of body) {
              if (at + chunk.length > bytes.length)
                throw new Error('Control body length mismatch.');
              chunk.copy(bytes, at);
              at += chunk.length;
            }
            if (at !== bytes.length) throw new Error('Truncated control body.');
            const value = decodeRecord(bytes),
              name =
                state.sequence === 0 && tuple(value)[0] === 'identity'
                  ? '.mammoth-meta/identity.json'
                  : tuple(value)[0] === 'complete'
                    ? '.mammoth-meta/complete.json'
                    : `.mammoth-meta/${add(state.sequence)}.json`;
            if (header.name !== name) throw new Error('Wrong control member sequence/name.');
            await state.control(value);
            await options.event?.(value, transportSignal);
          } finally {
            release();
          }
        } else {
          state.payloadHeader(header);
          if (header.type === 'directory') {
            for await (const _ of body) void _;
          } else {
            const file = state.file,
              digest = createHash('sha256');
            let bytes = 0;
            const observed = (async function* () {
              for await (const chunk of body) {
                bytes = add(bytes, chunk.length);
                if (bytes > header.size) throw new Error('Payload length mismatch.');
                digest.update(chunk);
                yield chunk;
              }
            })();
            await options.consumeFile(
              {
                path: file.path,
                partition: file.partition,
                ordinal: file.ordinal,
                header,
                body: observed,
              },
              transportSignal,
            );
            state.body(digest.digest('hex'), bytes);
          }
        }
      },
      { signal },
    );
    if (!state) throw new Error('Missing worker identity.');
    return state.finish();
  } finally {
    if (state) await state.dispose();
    else await options.membership.dispose();
  }
}
export type WorkerEvent =
  | { type: 'channel-open' | 'channel-close' | 'unit-close' | 'used-unit-close' }
  | { type: 'dir-open' | 'dir-close'; path: string }
  | { type: 'unit-open' | 'used-unit-open'; unit: Unit }
  | { type: 'used'; name: string }
  | {
      type: 'file';
      path: string;
      size: number;
      mode: number;
      mtimeMs: number;
      bytes: AsyncIterable<Uint8Array>;
      assertStable(signal: AbortSignal): Promise<void>;
    };
export interface WorkerWriter extends WorkerContext {
  readonly snapshots: readonly string[];
  assertStable(signal: AbortSignal): Promise<void>;
}
/** Caller supplies ordered frozen events and body guards; no filesystem walker or backend. */
export async function writeWorkerArchive(
  destination: Writable,
  options: WorkerWriter,
  events: (signal: AbortSignal) => AsyncIterable<WorkerEvent>,
  external?: AbortSignal,
): Promise<WorkerSummary> {
  const controller = new AbortController(),
    signal = controller.signal;
  const abort = (error: unknown) => {
    if (!signal.aborted)
      controller.abort(
        error instanceof Error ? error : new Error('Worker writer aborted.', { cause: error }),
      );
  };
  const outside = () => abort(external?.reason);
  external?.addEventListener('abort', outside, { once: true });
  if (external?.aborted) outside();
  let state: WorkerState;
  try {
    state = new WorkerState(options, signal);
  } catch (error) {
    external?.removeEventListener('abort', outside);
    destination.destroy();
    await options.membership.dispose();
    throw error;
  }
  const archive = pack({ highWaterMark: 16384 }),
    gzip = createGzip({ chunkSize: 16384 });
  const output = pipeline(archive, gzip, destination, { signal }).catch(abort);
  let iterator: AsyncIterator<WorkerEvent> | undefined,
    pendingNext = false,
    completed = false;
  async function control(value: Value): Promise<void> {
    await state.control(value);
    const name =
      tuple(value)[0] === 'identity'
        ? '.mammoth-meta/identity.json'
        : tuple(value)[0] === 'complete'
          ? '.mammoth-meta/complete.json'
          : `.mammoth-meta/${state.sequence}.json`;
    const bytes = encodeRecord(value);
    await withAbort(
      new Promise<void>((resolve, reject) => {
        const sink = archive.entry({ name, mode: 384, mtime: new Date(0) }, bytes, (error) =>
          error ? reject(error) : resolve(),
        );
        sink.on('error', () => {});
      }),
      signal,
    );
  }
  try {
    signal.throwIfAborted();
    await withAbort(options.assertStable(signal), signal);
    await control(state.identityTuple(options.snapshots));
    iterator = events(signal)[Symbol.asyncIterator]();
    while (true) {
      pendingNext = true;
      const next = await withAbort(iterator.next(), signal);
      pendingNext = false;
      if (next.done) break;
      const e = next.value;
      switch (e.type) {
        case 'channel-open':
          await control(state.channelOpenTuple());
          break;
        case 'channel-close':
          await control(state.channelCloseTuple());
          break;
        case 'dir-open': {
          if (state.purpose !== 'usage') {
            const name = state.headerName(e.path, true),
              header: WorkerTarHeader = { name, type: 'directory', size: 0, mode: 493, mtimeMs: 0 };
            state.payloadHeader(header);
            await withAbort(
              new Promise<void>((resolve, reject) => {
                const sink = archive.entry(
                  { name, type: 'directory', mode: 493, mtime: new Date(0) },
                  Buffer.alloc(0),
                  (error) => (error ? reject(error) : resolve()),
                );
                sink.on('error', () => {});
              }),
              signal,
            );
          }
          await control(['dir-open', state.cid, e.path]);
          break;
        }
        case 'dir-close':
          await control(['dir-close', state.cid, e.path]);
          break;
        case 'unit-open':
        case 'used-unit-open':
          await control([e.type, state.cid, ...e.unit]);
          break;
        case 'unit-close':
        case 'used-unit-close': {
          const close = state.unitCloseTuple();
          if (close[0] !== e.type) throw new Error('Wrong unit close event.');
          await control(close);
          break;
        }
        case 'used': {
          const path = state.currentPath ? state.currentPath + '/' + e.name : e.name;
          await control(['used', state.cid, e.name, options.model.owner(path)[0]]);
          break;
        }
        case 'file': {
          await withAbort(e.assertStable(signal), signal);
          const name = state.headerName(e.path),
            header: WorkerTarHeader = {
              name,
              type: 'file',
              size: e.size,
              mode: e.mode,
              mtimeMs: e.mtimeMs,
            };
          state.payloadHeader(header);
          const millis = BigInt(e.mtimeMs),
            seconds = millis / 1000n,
            fractional = Number(millis % 1000n);
          const pax =
            fractional || seconds > 2147483647n
              ? {
                  mtime:
                    String(seconds) + (fractional ? '.' + String(fractional).padStart(3, '0') : ''),
                }
              : undefined;
          const sink = archive.entry({
            name,
            size: e.size,
            mode: e.mode,
            mtime: new Date(pax ? 0 : e.mtimeMs),
            ...(pax ? { pax } : {}),
          });
          let size = 0;
          const sha = createHash('sha256');
          const bytes = Readable.from(
            (async function* () {
              for await (const chunk of abortableValues(e.bytes, signal)) {
                signal.throwIfAborted();
                if (!(chunk instanceof Uint8Array) || chunk.byteLength > 256 * 1024)
                  throw new Error('Invalid resident file chunk.');
                const b = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
                size = add(size, b.length);
                if (size > e.size) throw new Error('Source body exceeds header.');
                sha.update(b);
                yield b;
              }
            })(),
            { objectMode: false, highWaterMark: 16384 },
          );
          await pipeline(bytes, sink, { signal });
          state.body(sha.digest('hex'), size);
          await withAbort(e.assertStable(signal), signal);
          await control(state.fileMetaTuple());
          break;
        }
        default:
          throw new Error('Unknown worker writer event.');
      }
    }
    await withAbort(options.assertStable(signal), signal);
    await control(state.completeTuple());
    archive.finalize();
    await output;
    if (signal.aborted) throw signal.reason;
    completed = true;
    return state.finish();
  } catch (error) {
    abort(error);
    throw signal.reason;
  } finally {
    if (!completed) abort(new Error('Incomplete worker writer.'));
    try {
      if (iterator?.return) {
        const cleanup = iterator.return();
        if (pendingNext) void cleanup.catch(() => {});
        else await cleanup;
      }
    } finally {
      try {
        await output;
      } finally {
        try {
          await state.dispose();
        } finally {
          external?.removeEventListener('abort', outside);
        }
      }
    }
  }
}
