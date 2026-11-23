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

import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { extract, type Header } from '../../../build/patched-tar-stream/index.js';
import { STREAMING_PROFILES, streamingFamilyId } from '../../../src/cache/streaming/profiles';
import { checksum, ends, paxArchive, paxRecord, tarHeader, tarMember } from './tar-fixtures';
const helper = createRequire(import.meta.url)('../../../patches/tar-stream/mammoth.cjs') as {
  decodePax(b: Buffer): Record<string, string>;
};
async function parse(bytes: Buffer, strict = true, chunk = 512): Promise<Header[]> {
  const ex = extract({ mammothStrict: strict, highWaterMark: 512 });
  const headers: Header[] = [];
  ex.on('entry', (h, body, next) => {
    headers.push(h);
    body.on('error', () => {});
    body.on('end', next);
    body.resume();
  });
  await pipeline(
    Readable.from(
      (async function* () {
        for (let i = 0; i < bytes.length; i += chunk) yield bytes.subarray(i, i + chunk);
      })(),
      { objectMode: false, highWaterMark: chunk },
    ),
    ex,
  );
  return headers;
}
describe('opt-in worker TAR profile', () => {
  it('preserves literal PAX Unicode/milliseconds across one-byte splits', async () => {
    const h = await parse(
      paxArchive(Buffer.from('29 path=payload/aggregate/é\n24 mtime=1700000000.123\n')),
      true,
      1,
    );
    expect(h[0].name).toBe('payload/aggregate/é');
    expect(h[0].mtimeMs).toBe(1700000000123);
  });
  it('keeps the non-opt-in upstream behavior', async () => {
    const bytes = paxArchive(Buffer.concat([paxRecord('path', 'old'), paxRecord('path', 'new')]));
    expect((await parse(bytes, false))[0].name).toBe('new');
    await expect(parse(bytes)).rejects.toThrow('duplicate PAX');
    expect(await parse(tarMember('plain'), false)).toHaveLength(1);
  });
  it('continues through buffered entries and TAR ends after synchronous acknowledgments', async () => {
    const ex = extract({ mammothStrict: true });
    const names: string[] = [];
    ex.on('entry', (header, body, next) => {
      names.push(header.name);
      body.resume();
      next();
    });
    const expected = ['payload/aggregate/a', 'payload/aggregate/b', 'payload/aggregate/c'];
    const bytes = Buffer.concat([...expected.map((name) => tarMember(name)), ends]);
    await pipeline(Readable.from([bytes]), ex);
    expect(names).toEqual(expected);
  });
  it('forwards an entry consumer cancellation to the extractor', async () => {
    const ex = extract({ mammothStrict: true });
    const reason = new Error('entry consumer canceled');
    ex.on('entry', (_header, body) => body.destroy(reason));
    const bytes = Buffer.concat([tarMember('payload/aggregate/f', Buffer.from('abc')), ends]);
    await expect(pipeline(Readable.from([bytes]), ex)).rejects.toBe(reason);
  });
  it('rejects unknown/duplicate keys before decoding their invalid values', () => {
    expect(() => helper.decodePax(paxRecord('other', Buffer.from([255])))).toThrow('PAX key');
    expect(() =>
      helper.decodePax(
        Buffer.concat([paxRecord('path', 'first'), paxRecord('path', Buffer.from([255]))]),
      ),
    ).toThrow('duplicate PAX');
  });
  it('admits the inclusive extension byte bound separately from semantic key rejection', async () => {
    let body: Buffer = Buffer.alloc(0);
    for (let n = 65500; n <= 65536; n++) {
      const b = paxRecord('other', 'x'.repeat(n));
      if (b.length === 65536) {
        body = b;
        break;
      }
    }
    expect(body.length).toBe(65536);
    await expect(parse(paxArchive(body))).rejects.toThrow('PAX key');
    await expect(parse(tarHeader('PaxHeader', 65537, { type: 'x' }))).rejects.toThrow(
      'PAX admission',
    );
    await expect(parse(tarHeader('PaxHeader', 0, { type: 'x' }))).rejects.toThrow('PAX admission');
  });
  it.each(['g', 'L', 'K', '1', '2', '3', '4', '6', 'S'])(
    'rejects type %s without its body',
    async (type) => {
      await expect(parse(tarHeader('bad', 65536, { type }))).rejects.toThrow('entry type');
    },
  );
  it.each([
    '0 path=x\n',
    '-1 path=x\n',
    '010 path=x\n',
    '999999 path=x\n',
    '99 path=x\n',
    '10 path=x!',
    '10 pathxx\n',
    '12 path=abc\njunk',
  ])('rejects malformed records %j', async (text) => {
    await expect(parse(paxArchive(Buffer.from(text)))).rejects.toThrow('PAX');
  });
  it.each([
    ['size', '3junk'],
    ['size', '01'],
    ['size', '-1'],
    ['size', '9007199254740992'],
    ['mtime', '1.1234'],
    ['mtime', '-1'],
    ['mtime', '1e3'],
    ['mtime', '9007199254741.000'],
  ])('rejects %s=%s', async (key, value) => {
    await expect(parse(paxArchive(paxRecord(key, value)))).rejects.toThrow('PAX');
  });
  it('rejects invalid UTF-8 while preserving an actual replacement character', async () => {
    await expect(parse(paxArchive(paxRecord('path', Buffer.from([195, 40]))))).rejects.toThrow(
      'UTF-8',
    );
    expect((await parse(paxArchive(paxRecord('path', 'payload/aggregate/�'))))[0].name).toContain(
      '�',
    );
    const h = tarHeader('x');
    h[0] = 255;
    checksum(h);
    await expect(parse(Buffer.concat([h, ends]))).rejects.toThrow('UTF-8');
  });
  it('rejects pending/renamed/control extensions', async () => {
    const p = tarMember('PaxHeader', paxRecord('path', 'payload/aggregate/f'), { type: 'x' });
    await expect(parse(Buffer.concat([p, p, tarMember('f'), ends]))).rejects.toThrow(
      'PAX admission',
    );
    await expect(parse(Buffer.concat([p, ends]))).rejects.toThrow('Unexpected end');
    await expect(
      parse(paxArchive(paxRecord('path', '.mammoth-meta/identity.json'))),
    ).rejects.toThrow('control PAX');
    await expect(
      parse(paxArchive(paxRecord('path', 'payload/aggregate/f'), '.mammoth-meta/identity.json')),
    ).rejects.toThrow('control PAX');
  });
  it('checks zero padding and two complete TAR ends', async () => {
    const m = tarMember('payload/aggregate/f', Buffer.from('x')),
      dirty = Buffer.from(m);
    dirty[513] = 1;
    await expect(parse(Buffer.concat([dirty, ends]))).rejects.toThrow('padding');
    await expect(parse(m)).rejects.toThrow('Unexpected end');
    await expect(parse(Buffer.concat([m, Buffer.alloc(512)]))).rejects.toThrow('Unexpected end');
    await expect(parse(Buffer.concat([m, ends, Buffer.alloc(1)]))).rejects.toThrow(
      'Unexpected end',
    );
    await expect(parse(Buffer.concat([m, ends, m, ends]))).rejects.toThrow('member after ends');
    expect(await parse(Buffer.concat([m, ends, ends]))).toHaveLength(1);
  });
  it('checks raw portable fields before upstream normalization', async () => {
    for (const opts of [{ mode: 0o100644 }, { uid: 1 }])
      await expect(parse(Buffer.concat([tarHeader('x', 0, opts), ends]))).rejects.toThrow(
        'Invalid Mammoth TAR',
      );
    const h = tarHeader('x');
    h[124] = 57;
    checksum(h);
    await expect(parse(Buffer.concat([h, ends]))).rejects.toThrow('octal');
    const checksumBad = tarHeader('x');
    checksumBad[0] = 121;
    await expect(parse(Buffer.concat([checksumBad, ends]))).rejects.toThrow('Invalid tar header');
  });
  it('rejects junk in the checksum field before permissive upstream parsing', async () => {
    const h = tarHeader('payload/aggregate/f');
    h[154] = 120;
    await expect(parse(Buffer.concat([h, ends]))).rejects.toThrow('octal field');
    expect(await parse(Buffer.concat([h, ends]), false)).toHaveLength(1);
  });
  it('checks effective directory/control metadata before body delivery', async () => {
    await expect(parse(Buffer.concat([tarHeader('d/', 0, { type: '5' }), ends]))).rejects.toThrow(
      'directory',
    );
    await expect(
      parse(Buffer.concat([tarHeader('.mammoth-meta/identity.json', 65537, { mode: 384 }), ends])),
    ).rejects.toThrow('control header');
    expect(
      await parse(
        Buffer.concat([
          tarMember('payload/aggregate/', Buffer.alloc(0), { type: '5', mode: 493 }),
          ends,
        ]),
      ),
    ).toHaveLength(1);
  });
});
it('binds the new family namespace independently from old keys', () => {
  expect(STREAMING_PROFILES.worker).toBe('worker-tar-v2');
  expect(
    streamingFamilyId('maven', 'db28172d252fd67b0feb15f23ac18c39c38164039839912ff27f4d5da44be3ef'),
  ).toBe('mammoth-s1-maven-db28172d252fd67b0feb15f23ac18c39c38164039839912ff27f4d5da44be3ef');
  expect(() => streamingFamilyId('gradle', 'old-key')).toThrow();
});
