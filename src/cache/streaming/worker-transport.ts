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

import { Transform, Writable, type Readable, type TransformOptions } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw, crc32, type ZlibOptions } from 'node:zlib';
import { extract } from '../../../build/patched-tar-stream/index.js';

export const WORKER_TRANSPORT_CHUNK_BYTES = 64 * 1024;
const QUEUE_BYTES = 16 * 1024;
export interface WorkerTarHeader {
  readonly name: string;
  readonly type: 'file' | 'directory';
  readonly size: number;
  readonly mode: number;
  readonly mtimeMs: number;
}

export interface WorkerTarEntry {
  readonly header: WorkerTarHeader;
  readonly body: AsyncIterable<Buffer>;
}

export interface WorkerTransportCompletion {
  readonly uncompressedBytes: bigint;
}

export type WorkerEntryConsumer = (entry: WorkerTarEntry, signal: AbortSignal) => Promise<void>;

/**
 * Protocol: docs/dev/cache-protocol.md#worker-transport and #tar-profile.
 * Owns/destroys the source. Supply a byte stream with <=64KiB chunks/high-water mark.
 * The consumer must drain each body and honor cancellation for its own side effects.
 * Entries are provisional: resolution proves framing only, not application grammar,
 * producer eligibility or permission to install. The application codec adds that gate.
 */
export async function readWorkerTransport(
  source: Readable,
  consume: WorkerEntryConsumer,
  options: { signal?: AbortSignal } = {},
): Promise<WorkerTransportCompletion> {
  if (
    source.readableObjectMode ||
    source.readableEncoding ||
    source.readableHighWaterMark > WORKER_TRANSPORT_CHUNK_BYTES
  ) {
    source.destroy();
    throw new Error('Worker transport requires a bounded byte source.');
  }
  const controller = new AbortController(),
    signal = controller.signal;
  const inflaterOptions: ZlibOptions & TransformOptions = {
    chunkSize: QUEUE_BYTES,
    readableHighWaterMark: QUEUE_BYTES,
    writableHighWaterMark: QUEUE_BYTES,
  };
  const inflater = createInflateRaw(inflaterOptions);
  const tar = extract({ mammothStrict: true, highWaterMark: QUEUE_BYTES });
  const gzipHeader = Buffer.alloc(10),
    trailer = Buffer.alloc(8);
  let headerBytes = 0,
    trailerBytes = 0,
    deflateEnded = false,
    checksum = 0,
    moduloSize = 0;
  let uncompressedBytes = 0n,
    consumerTask: Promise<void> = Promise.resolve();
  const abort = (reason: unknown) => {
    if (!signal.aborted) {
      controller.abort(
        reason instanceof Error
          ? reason
          : new Error('Worker transport aborted.', { cause: reason }),
      );
    }
  };
  // Dispose each consumer's abort subscription; a shared never-settled Promise.race
  // would retain one reaction for every entry in a long archive.
  function consumeOrAbort(work: Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(signal.reason);
      };
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        () => {
          cleanup();
          resolve();
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
      if (signal.aborted) {
        onAbort();
      }
    });
  }
  const externalAbort = () => abort(options.signal?.reason);
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  if (options.signal?.aborted) {
    externalAbort();
  }
  inflater.on('end', () => {
    deflateEnded = true;
  });
  const meter = new Transform({
    highWaterMark: QUEUE_BYTES,
    transform(chunk: Buffer, _encoding, callback) {
      checksum = crc32(chunk, checksum);
      moduloSize = (moduloSize + chunk.length) >>> 0;
      uncompressedBytes += BigInt(chunk.length);
      callback(null, chunk);
    },
  });
  function tail(bytes: Buffer): void {
    if (bytes.length > trailer.length - trailerBytes) {
      throw new Error('Trailing bytes after the worker gzip member.');
    }
    bytes.copy(trailer, trailerBytes);
    trailerBytes += bytes.length;
  }
  const input = new Writable({
    highWaterMark: QUEUE_BYTES,
    decodeStrings: false,
    write(chunk: Buffer, _encoding, callback) {
      try {
        if (!Buffer.isBuffer(chunk) || chunk.length > WORKER_TRANSPORT_CHUNK_BYTES) {
          throw new Error('Worker compressed chunk exceeds the resident byte bound.');
        }
        let bytes = chunk;
        if (headerBytes < gzipHeader.length) {
          const take = Math.min(bytes.length, gzipHeader.length - headerBytes);
          bytes.copy(gzipHeader, headerBytes, 0, take);
          headerBytes += take;
          bytes = bytes.subarray(take);
          if (headerBytes < gzipHeader.length) {
            callback();
            return;
          }
          if (
            gzipHeader[0] !== 31 ||
            gzipHeader[1] !== 139 ||
            gzipHeader[2] !== 8 ||
            gzipHeader[3] !== 0 ||
            gzipHeader.readUInt32LE(4) !== 0
          ) {
            throw new Error('Invalid fixed worker gzip header.');
          }
        }
        if (!bytes.length) {
          callback();
          return;
        }
        if (deflateEnded) {
          tail(bytes);
          callback();
          return;
        }
        const before = inflater.bytesWritten;
        // Standard writable callbacks propagate native output pressure, without polling.
        inflater.write(bytes, (error?: Error | null) => {
          if (error) {
            callback(error);
            return;
          }
          try {
            const used = inflater.bytesWritten - before;
            if (!Number.isSafeInteger(used) || used < 0 || used > bytes.length) {
              throw new Error('Invalid native inflater consumed-byte count.');
            }
            if (used < bytes.length) {
              deflateEnded = true;
              tail(bytes.subarray(used));
            }
            callback();
          } catch (error) {
            callback(error as Error);
          }
        });
      } catch (error) {
        callback(error as Error);
      }
    },
    final(callback) {
      if (headerBytes !== gzipHeader.length) {
        callback(new Error('Truncated worker gzip header.'));
        return;
      }
      inflater.end();
      callback();
    },
  });
  tar.on('entry', (header, body, next) => {
    let bodyEnded = false;
    body.on('end', () => {
      bodyEnded = true;
    });
    body.on('error', () => {});
    consumerTask = (async () => {
      if ((header.type !== 'file' && header.type !== 'directory') || header.mtimeMs === undefined) {
        throw new Error('Missing strict worker header facts.');
      }
      const portable: WorkerTarHeader = {
        name: header.name,
        type: header.type,
        size: header.size,
        mode: header.mode,
        mtimeMs: header.mtimeMs,
      };
      await consumeOrAbort(
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return consume({ header: portable, body }, signal);
        }),
      );
      if (!bodyEnded) {
        throw new Error('Worker consumer returned before draining its body.');
      }
      next();
    })().catch(abort);
  });
  const observe = (promise: Promise<void>): Promise<void> => promise.catch(abort);
  // Observe both pipelines immediately; either direction aborts the entire operation.
  const outputDone = observe(pipeline(inflater, meter, tar, { signal }));
  const inputDone = observe(pipeline(source, input, { signal }));
  try {
    await Promise.all([inputDone, outputDone]);
    await consumerTask;
    if (signal.aborted) {
      throw signal.reason;
    }
    if (trailerBytes !== trailer.length) {
      throw new Error('Truncated worker gzip trailer.');
    }
    if (trailer.readUInt32LE(0) !== checksum) {
      throw new Error('Worker gzip CRC mismatch.');
    }
    if (trailer.readUInt32LE(4) !== moduloSize) {
      throw new Error('Worker gzip ISIZE mismatch.');
    }
    return { uncompressedBytes };
  } catch (error) {
    abort(error);
    throw signal.reason;
  } finally {
    options.signal?.removeEventListener('abort', externalAbort);
    // All normal/error paths have settled the pipelines and the one active consumer.
    await Promise.all([inputDone, outputDone]);
    await consumerTask;
  }
}
