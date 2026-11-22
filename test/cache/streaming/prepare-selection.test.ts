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

import { expect, it } from 'vitest';
import { LocalCodec } from '../../../src/cache/streaming/local-schema';
import { writeLocalStream, readLocalStream } from '../../../src/cache/streaming/local-stream';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { rawSha, type Value } from '../../../src/cache/streaming/encoding';
import { invocationId, lineageId } from '../../../src/cache/streaming/model';
import { recordKey } from '../../../src/cache/streaming/native-records';
import { workerArtifactPrefix } from '../../../src/cache/streaming/worker-artifact-identity';
import { localOptions, localFixtures, nonce, h, directory } from './local-fixtures';
const selection: Value[] = [
  'prepare-selection',
  1,
  'refs/heads/main',
  null,
  ['execution', 1, '/tmp/mammoth', 7, 'enabled', null],
  ['miss'],
  ['selected', []],
  [],
  directory,
  'workers-installed',
];
const records = async function* (rows: readonly Value[]) {
  yield* rows;
};
function fixture(aggregator = false) {
  const options = { ...localOptions() };
  if (aggregator) {
    options.role = 'distributed-aggregator';
    options.context[4] = 'aggregator';
    options.invocation = invocationId(options.context, nonce);
  }
  const codec = new LocalCodec(options),
    budget = new WorkingBudget();
  return { ...localFixtures(options), codec, budget, stream: { codec, budget, partition: null } };
}
async function encode(
  f: ReturnType<typeof fixture>,
  values: readonly Value[],
  purpose: 'prepare-sources' | 'post-sources' = 'prepare-sources',
) {
  const chunks = [];
  for await (const chunk of writeLocalStream(records(values), purpose, f.stream, () => {}))
    chunks.push(chunk);
  expect(f.budget.retained).toBe(0);
  return Buffer.concat(chunks);
}
it('matches normative P0 canonical bytes, local framing, seal and raw hash independently', async () => {
  const f = fixture(),
    bytes = await encode(f, [selection]);
  const expected = [
    [
      'local-stream',
      1,
      'prepare-sources',
      '7ca0244a1b6d0e46ff8e799981e395ab96b10b620463b3b6071874ec46472299',
      '7d96641b72b11e9e4e8f8b58eb1bdcd2faf03331b0b0c670233fe933209e4c2c',
      'mammoth-s1-maven-db28172d252fd67b0feb15f23ac18c39c38164039839912ff27f4d5da44be3ef',
      null,
    ],
    selection,
    ['local-end', 1, '9cbcf2341bcc66817c6c5da2c0d701c0c17b3e1a8e1ca55f88ef3b6bd258955c'],
  ]
    .map((v) => JSON.stringify(v) + '\n')
    .join('');
  expect(bytes.toString()).toBe(expected);
  expect(bytes.length).toBe(547);
  expect(rawSha(bytes)).toBe('7328bade01fda3b1b7036c81dcb8df35ab2f3d7aeee5598cedd5ab198acb11fa');
  const accepted: Value[] = [];
  await readLocalStream(
    (async function* () {
      yield bytes;
    })(),
    'prepare-sources',
    f.stream,
    [
      'ref',
      'prepare-sources',
      f.prefix + 'selection.ndjson',
      bytes.length,
      '7328bade01fda3b1b7036c81dcb8df35ab2f3d7aeee5598cedd5ab198acb11fa',
    ],
    async (v) => {
      accepted.push(v);
    },
  );
  expect(accepted).toEqual([
    [
      'local-stream',
      1,
      'prepare-sources',
      '7ca0244a1b6d0e46ff8e799981e395ab96b10b620463b3b6071874ec46472299',
      '7d96641b72b11e9e4e8f8b58eb1bdcd2faf03331b0b0c670233fe933209e4c2c',
      'mammoth-s1-maven-db28172d252fd67b0feb15f23ac18c39c38164039839912ff27f4d5da44be3ef',
      null,
    ],
    selection,
    ['local-end', 1, '9cbcf2341bcc66817c6c5da2c0d701c0c17b3e1a8e1ca55f88ef3b6bd258955c'],
  ]);
  expect(f.budget.retained).toBe(0);
});
it('accepts pending/miss/pinned choices and preserves ordered snapshot rows after the header', async () => {
  const f = fixture(),
    row = structuredClone(selection),
    source: Value = [
      'snapshot-source',
      [
        'metadata',
        'baseline',
        ['baseline', 'origin'],
        f.q('native-evidence'),
        f.prefix + 'snapshots/native',
      ],
    ];
  row[5] = ['pending'];
  row[6] = ['pending'];
  row[7] = null;
  row[9] = 'selected';
  await encode(f, [row]);
  row[5] = [
    'pinned',
    recordKey(f.options.model.family, lineageId('refs/heads/main'), h, h),
    f.q('generation'),
  ];
  await encode(f, [row, source]);
  await encode(f, [source]);
  await expect(encode(f, [source, row])).rejects.toThrow('first');
  await expect(encode(f, [row, row])).rejects.toThrow('first');
  await expect(encode(f, [row], 'post-sources')).rejects.toThrow('first');
});
it('binds exact worker descriptor scope, basename, attempt, snapshot owner and producer uniqueness', async () => {
  const f = fixture(true),
    context = [...f.options.context];
  context[4] = 'A';
  const row = structuredClone(selection),
    artifact: Value[] = [
      1,
      workerArtifactPrefix(f.options.model, context as typeof f.options.context) +
        '1-d' +
        h +
        '.tar.gz',
      42,
      'sha256:' + h,
      context,
      ['metadata'],
    ];
  row[6] = ['selected', [artifact]];
  await encode(f, [row]);
  for (const modify of [
    (r: Value[]) => {
      (r[6] as Value[])[1] = [artifact, artifact];
    },
    (r: Value[]) => {
      const a = ((r[6] as Value[])[1] as Value[][])[0];
      (a[4] as Value[])[3] = 'different-run';
    },
    (r: Value[]) => {
      const a = ((r[6] as Value[])[1] as Value[][])[0];
      a[1] = 'other.tar.gz';
    },
    (r: Value[]) => {
      const a = ((r[6] as Value[])[1] as Value[][])[0];
      (a[4] as Value[])[5] = 2;
    },
    (r: Value[]) => {
      const a = ((r[6] as Value[])[1] as Value[][])[0];
      a[5] = ['data'];
    },
    (r: Value[]) => {
      const a = ((r[6] as Value[])[1] as Value[][])[0];
      a[3] = 'sha256:' + 'A'.repeat(64);
    },
  ])
    await expect(
      encode(f, [
        (() => {
          const bad = structuredClone(row);
          modify(bad);
          return bad;
        })(),
      ]),
    ).rejects.toThrow();
  const standalone = fixture();
  await expect(encode(standalone, [row])).rejects.toThrow();
});
it('rejects unknown fields, premature installed stages, wrong lineage and noncanonical cold projections', async () => {
  const f = fixture();
  for (const modify of [
    (r: Value[]) => {
      r.push(null);
    },
    (r: Value[]) => {
      r[3] = r[2];
    },
    (r: Value[]) => {
      r[5] = ['pending'];
    },
    (r: Value[]) => {
      r[6] = ['pending'];
    },
    (r: Value[]) => {
      r[7] = null;
    },
    (r: Value[]) => {
      r[7] = ['metadata'];
    },
    (r: Value[]) => {
      r[5] = ['pinned', 'wrong-family', f.q('generation')];
    },
    (r: Value[]) => {
      r[8] = 'unknown';
    },
    (r: Value[]) => {
      (r[4] as Value[])[4] = 'unknown';
    },
  ]) {
    const bad = structuredClone(selection);
    modify(bad);
    await expect(encode(f, [bad])).rejects.toThrow();
  }
});
