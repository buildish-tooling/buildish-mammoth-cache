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

import { createCipheriv, createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  readWorkerTransport,
  type WorkerTarHeader,
  type WorkerTarEntry,
} from '../../../src/cache/streaming/worker-transport';
import { ends, paxRecord, tarMember } from './tar-fixtures';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function source(bytes: Buffer, chunk = 16384, splits: number[] = []) {
  const stats = { supplied: 0, closed: false };
  const stream = Readable.from(
    (async function* () {
      let at = 0,
        step = 0;
      try {
        while (at < bytes.length) {
          const b = bytes.subarray(at, at + (splits[step++] ?? chunk));
          at += b.length;
          stats.supplied += b.length;
          yield b;
        }
      } finally {
        stats.closed = true;
      }
    })(),
    { objectMode: false, highWaterMark: 16384 },
  );
  return { stream, stats };
}
const drain = async ({ header, body }: WorkerTarEntry) => {
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.length;
  }
  expect(bytes).toBe(header.size);
};
const smallTar = Buffer.concat([tarMember('payload/aggregate/f', Buffer.from('abc')), ends]);
const smallGzip = gzipSync(smallTar);
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const trace = readFileSync('docs/dev/cache-protocol-vectors.md', 'utf8')
  .split('### Complete application trace')[1]
  .match(/```text\n([\s\S]*?)\n```/)![1]
  .split('\n')
  .map((line) => JSON.parse(line));
interface Expected {
  header: WorkerTarHeader;
  body: Buffer;
}

function w1Fixture(): { gzip: Buffer; expected: Expected[] } {
  const members: Buffer[] = [],
    expected: Expected[] = [];
  for (const w of trace) {
    let header: WorkerTarHeader, body: Buffer;
    if (w[0] === 'file' || w[0] === 'directory') {
      const t = w[0] === 'file' ? w[2] : w[1],
        prefix = t[1] === 0 ? 'payload/aggregate/' : 'payload/snapshot/metadata/';
      header = {
        name: prefix + t[2] + (t[3] === 'directory' && t[2] ? '/' : ''),
        type: t[3],
        size: t[4],
        mode: t[5],
        mtimeMs: t[6],
      };
      body = w[0] === 'file' ? Buffer.from(w[3], 'hex') : Buffer.alloc(0);
    } else {
      const tuple = w[0] === 'control' ? w[2] : w[1];
      body = Buffer.from(JSON.stringify(tuple) + '\n');
      header = {
        name:
          w[0] === 'identity'
            ? '.mammoth-meta/identity.json'
            : w[0] === 'complete'
              ? '.mammoth-meta/complete.json'
              : `.mammoth-meta/${w[1]}.json`,
        type: 'file',
        mode: 384,
        mtimeMs: 0,
        size: body.length,
      };
    }
    const pax: Buffer[] = [];
    const pathNeeded =
      Buffer.byteLength(header.name) > 100 || Buffer.byteLength(header.name) !== header.name.length;
    if (pathNeeded) {
      pax.push(paxRecord('path', header.name));
    }
    if (header.mtimeMs % 1000) {
      pax.push(
        paxRecord(
          'mtime',
          Math.floor(header.mtimeMs / 1000) + '.' + String(header.mtimeMs % 1000).padStart(3, '0'),
        ),
      );
    }
    if (pax.length) {
      members.push(tarMember('PaxHeader', Buffer.concat(pax), { type: 'x' }));
    }
    members.push(
      tarMember(pathNeeded ? 'PaxHeader' : header.name, body, {
        type: header.type === 'directory' ? '5' : '0',
        mode: header.mode,
        time: Math.floor(header.mtimeMs / 1000),
      }),
    );
    expected.push({ header, body });
  }
  return { gzip: gzipSync(Buffer.concat([...members, ends])), expected };
}
const w1 = w1Fixture();
async function readW1(bytes: Buffer, chunk = 16384, splits: number[] = []) {
  const input = source(bytes, chunk, splits);
  let index = 0,
    complete = false;
  const work = readWorkerTransport(
    input.stream,
    async ({ header, body }) => {
      const row = w1.expected[index++];
      expect(header).toEqual(row.header);
      const chunks: Buffer[] = [];
      for await (const b of body) {
        chunks.push(b);
      }
      expect(Buffer.concat(chunks)).toEqual(row.body);
      if (header.name === '.mammoth-meta/complete.json') {
        complete = true;
      }
    },
    { signal: AbortSignal.timeout(2000) },
  );
  return { input, work, state: () => ({ index, complete }) };
}
describe('worker transport completion', () => {
  it.each([1, 7, 16384])(
    'matches all literal W1 application bytes with %i-byte source chunks',
    async (chunk) => {
      const run = await readW1(w1.gzip, chunk);
      const result = await run.work;
      expect(run.state()).toEqual({ index: 28, complete: true });
      expect(result.uncompressedBytes).toBeGreaterThan(0n);
      expect(run.input.stats.closed).toBe(true);
    },
  );
  it('preserves exact DEFLATE/trailer splits', async () => {
    const run = await readW1(w1.gzip, 16384, [10, w1.gzip.length - 18, 8]);
    await run.work;
    expect(run.state().complete).toBe(true);
  });
  it.each(['crc', 'size', 'short'] as const)(
    'rejects a late %s error after final application metadata',
    async (kind) => {
      const bytes = Buffer.from(w1.gzip);
      if (kind !== 'short') {
        bytes[bytes.length - (kind === 'crc' ? 8 : 4)] ^= 1;
      }
      const run = await readW1(kind === 'short' ? bytes.subarray(0, -1) : bytes);
      await expect(run.work).rejects.toThrow(
        kind === 'crc' ? 'CRC' : kind === 'size' ? 'ISIZE' : 'trailer',
      );
      expect(run.state().complete).toBe(true);
      expect(run.input.stats.closed).toBe(true);
    },
  );
  it.each([Buffer.from([0]), Buffer.from('junk'), gzipSync(Buffer.alloc(0)), smallGzip])(
    'rejects trailing bytes/another gzip member',
    async (tail) => {
      const input = source(Buffer.concat([smallGzip, tail]), 7);
      await expect(readWorkerTransport(input.stream, drain)).rejects.toThrow('Trailing');
      expect(input.stats.closed).toBe(true);
    },
  );
  it.each([0, 3, 4])('validates fixed gzip field at %i before inflation', async (at) => {
    const bytes = Buffer.from(smallGzip);
    bytes[at] ^= 1;
    const input = source(bytes, 1);
    let delivered = false;
    await expect(
      readWorkerTransport(input.stream, async (entry) => {
        delivered = true;
        await drain(entry);
      }),
    ).rejects.toThrow('fixed worker gzip');
    expect(delivered).toBe(false);
    expect(input.stats.closed).toBe(true);
  });
  it('rejects incomplete header/DEFLATE and propagates strict TAR padding errors', async () => {
    for (const bytes of [smallGzip.subarray(0, 9), smallGzip.subarray(0, 12)]) {
      const input = source(bytes, 1);
      await expect(readWorkerTransport(input.stream, drain)).rejects.toThrow();
      expect(input.stats.closed).toBe(true);
    }
    const raw = Buffer.from(smallTar);
    raw[515] = 1;
    await expect(readWorkerTransport(source(gzipSync(raw)).stream, drain)).rejects.toThrow(
      'padding',
    );
  });
  it('keeps abort-listener subscriptions constant across completed entries', async () => {
    const raw = Buffer.concat([
      ...Array.from({ length: 256 }, (_, n) =>
        tarMember(`.mammoth-meta/${n}.json`, Buffer.from('[]'), { mode: 384 }),
      ),
      ends,
    ]);
    const counts: number[] = [];
    await readWorkerTransport(source(gzipSync(raw)).stream, async (entry, signal) => {
      counts.push(getEventListeners(signal, 'abort').length);
      await drain(entry);
    });
    expect(counts).toHaveLength(256);
    expect(new Set(counts).size).toBe(1);
  });
});
describe('flow and cancellation', () => {
  // Large buffers below are bounded test fixtures, never a production body catalogue.
  const payload = createCipheriv('aes-256-ctr', Buffer.alloc(32, 7), Buffer.alloc(16)).update(
    Buffer.alloc(4 * 1024 * 1024),
  );
  const compressed = gzipSync(Buffer.concat([tarMember('payload/aggregate/large', payload), ends]));
  it('propagates a gated body pause to compressed source progress, then resumes', async () => {
    const input = source(compressed),
      entered = deferred(),
      resume = deferred(),
      controller = new AbortController();
    let actualHash = '';
    const work = readWorkerTransport(
      input.stream,
      async ({ body }) => {
        entered.resolve();
        await resume.promise;
        const sha = createHash('sha256');
        for await (const b of body) {
          sha.update(b);
        }
        actualHash = sha.digest('hex');
      },
      { signal: controller.signal },
    );
    try {
      await entered.promise;
      await delay(25);
      const stopped = input.stats.supplied;
      await delay(25);
      expect(input.stats.supplied).toBe(stopped);
      expect(stopped).toBeLessThan(compressed.length / 2);
      resume.resolve();
      await work;
      expect(actualHash).toBe(hash(payload));
      expect(input.stats.closed).toBe(true);
    } finally {
      resume.resolve();
      controller.abort();
      await work.catch(() => {});
    }
  });
  it('closes upstream early when the consumer fails mid-body', async () => {
    const input = source(compressed);
    let consumed = 0;
    await expect(
      readWorkerTransport(input.stream, async ({ body }) => {
        for await (const b of body) {
          consumed += b.length;
          if (consumed >= 32768) {
            throw new Error('consumer failed');
          }
        }
      }),
    ).rejects.toThrow('consumer failed');
    expect(consumed).toBeLessThan(payload.length / 2);
    expect(input.stats.supplied).toBeLessThan(compressed.length / 2);
    expect(input.stats.closed).toBe(true);
  });
  it('aborts even while the consumer is paused on its own work', async () => {
    const input = source(compressed),
      entered = deferred(),
      release = deferred(),
      controller = new AbortController();
    const work = readWorkerTransport(
      input.stream,
      async () => {
        entered.resolve();
        await release.promise;
      },
      { signal: controller.signal },
    );
    await entered.promise;
    controller.abort(new Error('external cancellation'));
    try {
      await expect(work).rejects.toThrow('external cancellation');
      expect(input.stats.closed).toBe(true);
    } finally {
      release.resolve();
    }
  });
  it('rejects an already-aborted operation without invoking its consumer', async () => {
    const input = source(smallGzip),
      controller = new AbortController();
    controller.abort(new Error('already aborted'));
    await expect(
      readWorkerTransport(
        input.stream,
        async () => {
          throw new Error('must not run');
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow('already aborted');
    expect(input.stream.destroyed).toBe(true);
  });
  it('rejects an undrained consumer and propagates original source failures', async () => {
    const input = source(smallGzip);
    await expect(readWorkerTransport(input.stream, async () => {})).rejects.toThrow(
      'before draining',
    );
    expect(input.stats.closed).toBe(true);
    const failed = Readable.from(
      (async function* () {
        yield smallGzip.subarray(0, 10);
        throw new Error('source failed');
      })(),
      { objectMode: false, highWaterMark: 16384 },
    );
    await expect(readWorkerTransport(failed, drain)).rejects.toThrow('source failed');
    expect(failed.destroyed).toBe(true);
  });
  it('enforces resident source bounds, not total archive bytes', async () => {
    const tooWide = source(Buffer.alloc(65537), 65537);
    await expect(readWorkerTransport(tooWide.stream, drain)).rejects.toThrow('resident byte bound');
    expect(tooWide.stats.closed).toBe(true);
    const objectStream = Readable.from([smallGzip]);
    await expect(readWorkerTransport(objectStream, drain)).rejects.toThrow('bounded byte source');
    expect(objectStream.destroyed).toBe(true);
    const buffered = new Readable({ highWaterMark: 131072, read() {} });
    await expect(readWorkerTransport(buffered, drain)).rejects.toThrow('bounded byte source');
    expect(buffered.destroyed).toBe(true);
  });
});
