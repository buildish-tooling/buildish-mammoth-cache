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

import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { ends, paxRecord, tarMember } from './tar-fixtures';
import type { Unit } from '../../../src/cache/streaming/schema';
import type { WorkerEvent } from '../../../src/cache/streaming/worker-codec';
import type { Membership, MembershipSpool } from '../../../src/cache/streaming/worker-state';
import type { Value } from '../../../src/cache/streaming/encoding';
export const vectors = readFileSync('docs/dev/cache-protocol-vectors.md', 'utf8');
export const modelVector = [
  'model',
  1,
  'maven',
  ['.mammoth/**'],
  [
    ['data', ['repository/**'], ['.mammoth/**'], 'aggregate', null, 'default'],
    ['metadata', ['metadata/**'], ['.mammoth/**'], 'single-writer', 'A', 'default'],
  ],
] as const;
export const modelId = '7d96641b72b11e9e4e8f8b58eb1bdcd2faf03331b0b0c670233fe933209e4c2c';
export const familyId =
  'mammoth-s1-maven-db28172d252fd67b0feb15f23ac18c39c38164039839912ff27f4d5da44be3ef';
export const context = ['github', 'example/repo', 'ci', '42', 'A', 1, 'rev-1', 'maven'] as const;
export function workerTrace(example: 'W0' | 'W1'): Value[][] {
  let section = vectors.split('## ' + example + ':')[1].split('\n## ')[0];
  if (example === 'W1') section = section.split('### Complete application trace')[1];
  return section
    .match(/```text\n([\s\S]*?)\n```/)![1]
    .split('\n')
    .map((line) => JSON.parse(line));
}

/** Small fixture-only in-memory ledger, deliberately not production spool storage. */
export class FixtureMembership implements MembershipSpool {
  readonly rows: Membership[] = [];
  disposed = false;
  async append(row: Membership): Promise<void> {
    if (this.rows.length === 1000) throw new Error('Fixture bound');
    this.rows.push(row);
  }
  async seal(): Promise<() => AsyncIterable<Value>> {
    const rows = this.rows;
    return () =>
      (async function* () {
        yield* rows;
      })();
  }
  async fork(): Promise<MembershipSpool> {
    return new FixtureMembership();
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}
export function byteSource(bytes: Buffer, chunk = 16384): Readable {
  return Readable.from(
    (async function* () {
      for (let n = 0; n < bytes.length; n += chunk) yield bytes.subarray(n, n + chunk);
    })(),
    { objectMode: false, highWaterMark: chunk },
  );
}
export function traceArchive(trace: Value[][]): Buffer {
  const members: Buffer[] = [];
  for (const w of trace) {
    if (w[0] === 'file' || w[0] === 'directory') {
      const t = (w[0] === 'file' ? w[2] : w[1]) as Value[],
        path = String(t[2]),
        type = t[3] as 'file' | 'directory',
        time = Number(t[6]);
      const name =
        (t[1] === 0 ? 'payload/aggregate/' : 'payload/snapshot/metadata/') +
        path +
        (type === 'directory' && path ? '/' : '');
      const pax: Buffer[] = [],
        needsPath = Buffer.byteLength(name) > 100 || Buffer.byteLength(name) !== name.length;
      if (needsPath) pax.push(paxRecord('path', name));
      if (time % 1000)
        pax.push(
          paxRecord('mtime', Math.floor(time / 1000) + '.' + String(time % 1000).padStart(3, '0')),
        );
      if (pax.length) members.push(tarMember('PaxHeader', Buffer.concat(pax), { type: 'x' }));
      members.push(
        tarMember(
          needsPath ? 'PaxFile' : name,
          w[0] === 'file' ? Buffer.from(String(w[3]), 'hex') : Buffer.alloc(0),
          {
            type: type === 'directory' ? '5' : '0',
            mode: Number(t[5]),
            time: Math.floor(time / 1000),
          },
        ),
      );
    } else {
      const value = w[0] === 'control' ? w[2] : w[1],
        name =
          w[0] === 'identity'
            ? '.mammoth-meta/identity.json'
            : w[0] === 'complete'
              ? '.mammoth-meta/complete.json'
              : `.mammoth-meta/${w[1]}.json`;
      members.push(tarMember(name, Buffer.from(JSON.stringify(value) + '\n'), { mode: 384 }));
    }
  }
  return gzipSync(Buffer.concat([...members, ends]));
}
export async function* eventsFromTrace(trace: Value[][]): AsyncGenerator<WorkerEvent> {
  for (const w of trace) {
    if (w[0] === 'file') {
      const t = w[2] as Value[],
        bytes = Buffer.from(String(w[3]), 'hex');
      yield {
        type: 'file',
        path: String(t[2]),
        size: Number(t[4]),
        mode: Number(t[5]),
        mtimeMs: Number(t[6]),
        bytes: (async function* () {
          yield bytes;
        })(),
        async assertStable() {},
      };
    } else if (w[0] === 'control') {
      const t = w[2] as Value[];
      switch (t[0]) {
        case 'channel-open':
        case 'channel-close':
        case 'unit-close':
        case 'used-unit-close':
          yield { type: t[0] };
          break;
        case 'dir-open':
        case 'dir-close':
          yield { type: t[0], path: String(t[2]) };
          break;
        case 'unit-open':
        case 'used-unit-open':
          yield {
            type: t[0],
            unit: [t[2], t[3], t[4]] as Unit,
          };
          break;
        case 'used':
          yield { type: 'used', name: String(t[2]) };
          break;
      }
    }
  }
}
