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
import { expect, it, vi } from 'vitest';
import * as encoding from '../../../src/cache/streaming/encoding';
import { LocalCodec } from '../../../src/cache/streaming/local-schema';
import {
  readLocalStream,
  readLocalRows,
  readLocalPrefix,
  writeLocalStream,
  type LocalPurpose,
  type LocalStreamOptions,
  type LocalStreamSeal,
  localPurposes,
} from '../../../src/cache/streaming/local-stream';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { encodeRecord, rawSha, type Value } from '../../../src/cache/streaming/encoding';
import { resolveModel, invocationId } from '../../../src/cache/streaming/model';
import { objectKey, type ObjectIdentity } from '../../../src/cache/streaming/native-records';
import { localFixtures, localOptions, native, directory, h, nonce } from './local-fixtures';
const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
function hash(domain: string, rows: Value[]): string {
  const hash = createHash('sha256').update('mammoth:' + domain + ':1\0');
  for (const row of rows) {
    const b = Buffer.from(JSON.stringify(row)),
      n = Buffer.alloc(8);
    n.writeBigUInt64BE(BigInt(b.length));
    hash.update(n).update(b);
  }
  return hash.digest('hex');
}
async function* records(rows: Value[]): AsyncGenerator<Value> {
  yield* rows;
}
async function* chunks(bytes: Buffer): AsyncGenerator<Buffer> {
  for (let i = 0; i < bytes.length; i += 37) yield bytes.subarray(i, i + 37);
}
function fixture(purpose: LocalPurpose, model?: ReturnType<typeof resolveModel>) {
  const o = { ...localOptions() };
  if (model) o.model = model;
  if (purpose === 'worker-sources') o.role = 'distributed-worker';
  const f = localFixtures(o),
    partition = [
      'native-evidence',
      'digest-placements',
      'stage-evidence',
      'adjustments',
      'outbound-evidence',
      'return-evidence',
      'move-plan',
    ].includes(purpose)
      ? 'metadata'
      : null;
  const opts: LocalStreamOptions = {
    codec: f.codec,
    budget: new WorkingBudget(),
    partition,
    installKind: () => 'file',
  };
  const logical = 'metadata/empty.bin',
    span: Value = ['span', h, 1, 2];
  let rows: Value[] = [];
  switch (purpose) {
    case 'model':
      rows = [
        ['model-header', o.model.tuple[2], o.model.tuple[3]],
        ...o.model.partitions.map((p) => ['partition', ...p] as Value),
      ];
      break;
    case 'install-current':
      rows = [
        ['dir-open', '', directory],
        ['parent-child', '', '.mammoth', 'directory', '1', '99'],
        ['dir-close', '', directory],
      ];
      break;
    case 'installations':
      rows = [
        [
          'installation',
          ['gradle-installation', 1, o.invocation, '/gradle', '8.10', '/cache', '/java'],
        ],
      ];
      break;
    case 'partition-state':
      rows = o.model.partitions.map((p) => [
        'partition-state',
        p[0],
        ['baseline-partition', 'empty', null],
        null,
        null,
        null,
        null,
      ]);
      break;
    case 'publication-partitions':
      rows = o.model.partitions.map((p) => ['empty', p[0]]);
      break;
    case 'worker-sources':
      rows = [['worker-snapshot', 'metadata', f.q('observations')]];
      break;
    case 'cursor-stack':
      rows = [
        ['frame', 0, '', 'directories', null, 'metadata', null],
        ['frame', 1, 'metadata', 'files', null, null, null],
      ];
      break;
    case 'activity':
      rows = [
        ['dir-open', ''],
        ['dir-open', 'metadata'],
        ['used', 'empty.bin', 'metadata'],
        ['dir-close', 'metadata'],
        ['dir-close', ''],
      ];
      break;
    case 'observations':
      rows = [
        ['dir-open', '', directory],
        ['child', 'metadata', 'directory', '1', '3'],
        ['dir-open', 'metadata', directory],
        ['child', 'empty.bin', 'file', '1', '2'],
        ['file', 'empty.bin', 'metadata', native, null, 'none', 'retain'],
        ['dir-close', 'metadata'],
        ['dir-close', ''],
      ];
      break;
    case 'native-evidence':
    case 'stage-evidence':
      rows = [
        ['directory', '', directory],
        ['directory', 'metadata', directory],
        ['file', logical, native, empty],
      ];
      break;
    case 'adjustments':
      rows = [
        ['ancestor-effect', 'metadata', '1', '3', h],
        ['adjust', logical, 2, native, span, span],
      ];
      break;
    case 'outbound-evidence':
    case 'return-evidence':
      rows = [
        [
          'transition',
          1,
          2,
          purpose === 'outbound-evidence' ? 'outbound' : 'return',
          native,
          native,
          span,
        ],
      ];
      break;
    case 'move-plan':
      rows = [
        ['move-source', f.q('native-evidence')],
        ['move-unit-open', 'file', logical, 'file'],
        ['move', 1, 'live', logical, logical, 'file', span, span],
        ['move-unit-close', 'file', logical, 1],
      ];
      break;
    case 'install-plan':
    case 'install-evidence':
      rows = [
        ['install-unit-open', 'file', logical, 'file'],
        ['install', 1, logical, f.prefix + 'install/source', f.evidence(), null, 'insert', null],
        ['install-unit-close', 'file', logical],
      ];
      break;
    case 'gc-evidence': {
      rows = [
        ['gc-unit-open', 'file', logical, 'file'],
        ['directory', 'metadata', directory],
        ['parent-child', 'metadata', 'empty.bin', 'file', '1', '2'],
        ['target', logical, 'metadata', native],
      ];
      rows.push(['gc-unit-close', 'file', logical, hash('gc-unit', rows)]);
      break;
    }
    case 'digest-placements':
      rows = [
        ['digest-source', f.q('native-evidence')],
        ['digest-placement', logical, 'file', (f.evidence() as readonly Value[])[2], native],
      ];
      break;
    case 'prepare-sources':
    case 'post-sources':
      rows = [
        [
          'snapshot-source',
          [
            'metadata',
            'baseline',
            ['baseline', 'pinned-key'],
            f.q('native-evidence'),
            f.prefix + 'sources/metadata',
          ],
        ],
      ];
      break;
  }
  if (purpose === 'install-plan' || purpose === 'install-evidence')
    rows.unshift(['install-context', f.q('install-current')]);
  const header: Value = [
    'local-stream',
    1,
    purpose,
    o.invocation,
    o.model.id,
    o.model.family,
    partition,
  ];
  const digest = hash('local-' + purpose, [header, ...rows]);
  const bytes = Buffer.from(
    [header, ...rows, ['local-end', rows.length, digest]]
      .map((r) => JSON.stringify(r) + '\n')
      .join(''),
  );
  const reference: Value = [
    'ref',
    purpose,
    f.prefix + purpose + '.ndjson',
    bytes.length,
    rawSha(bytes),
  ];
  return { ...f, opts, rows, header, bytes, reference, digest };
}
async function write(f: ReturnType<typeof fixture>, rows = f.rows) {
  if (
    (f.header[2] === 'install-plan' || f.header[2] === 'install-evidence') &&
    (!Array.isArray(rows[0]) || rows[0][0] !== 'install-context')
  )
    rows = [['install-context', f.q('install-current')], ...rows];
  let seal!: LocalStreamSeal;
  const output: Buffer[] = [];
  for await (const bytes of writeLocalStream(
    records(rows),
    f.header[2] as LocalPurpose,
    f.opts,
    (s) => {
      seal = s;
    },
  ))
    output.push(bytes);
  return { bytes: Buffer.concat(output), seal };
}
for (const purpose of localPurposes)
  it('checks independent ' + purpose + ' canonical framing and row grammar', async () => {
    const f = fixture(purpose),
      actual = await write(f);
    expect(actual.bytes).toEqual(f.bytes);
    expect(actual.seal.eventSha).toBe(f.digest);
    const seen: Value[] = [];
    const seal = await readLocalStream(
      chunks(f.bytes),
      purpose,
      f.opts,
      f.reference,
      async (row) => {
        seen.push(row);
      },
    );
    expect(seal).toEqual(actual.seal);
    expect(seen).toEqual([f.header, ...f.rows, ['local-end', f.rows.length, f.digest]]);
    expect(f.opts.budget.retained).toBe(0);
  });
it.each([
  'version',
  'identity',
  'purpose',
  'partition',
  'end-count',
  'event-hash',
  'raw-hash',
  'trailing',
  'truncated',
])('rejects local framing %s', async (kind) => {
  const f = fixture('activity');
  let bytes = f.bytes;
  if (kind === 'version')
    bytes = Buffer.from(bytes.toString().replace('"local-stream",1', '"local-stream",2'));
  if (kind === 'identity') bytes = Buffer.from(bytes.toString().replace(f.options.invocation, h));
  if (kind === 'purpose')
    bytes = Buffer.from(bytes.toString().replace('"activity"', '"observations"'));
  if (kind === 'partition') f.opts = { ...f.opts, partition: 'data' };
  if (kind === 'end-count')
    bytes = Buffer.from(bytes.toString().replace('"local-end",5', '"local-end",4'));
  if (kind === 'event-hash') bytes = Buffer.from(bytes.toString().replace(f.digest, h));
  if (kind === 'raw-hash') (f.reference as Value[])[4] = h;
  if (kind === 'trailing') bytes = Buffer.concat([bytes, encodeRecord(['dir-close', ''])]);
  if (kind === 'truncated') bytes = bytes.subarray(0, -1);
  await expect(readLocalStream(chunks(bytes), 'activity', f.opts, f.reference)).rejects.toThrow();
  expect(f.opts.budget.retained).toBe(0);
});
it('binds observation files to complete child projection before body', async () => {
  const f = fixture('observations'),
    rows = structuredClone(f.rows);
  (rows[3] as Value[])[4] = '999';
  await expect(write(f, rows)).rejects.toThrow('child projection');
  expect(f.opts.budget.retained).toBe(0);
});
it('includes full parent child projection in direct observation unit digest', async () => {
  const f = fixture('observations'),
    root = 'repository/g';
  const projection: Value[] = [
    ['directory', root, directory],
    ['child', root, 'a.jar', 'file', '1', '2'],
    ['file', root + '/a.jar', 'data', native, null],
  ];
  const sha = hash('observation-unit', projection);
  const rows: Value[] = [
    ['dir-open', '', directory],
    ['child', 'repository', 'directory', '1', '3'],
    ['dir-open', 'repository', directory],
    ['child', 'g', 'directory', '1', '3'],
    ['dir-open', root, directory],
    ['child', 'a.jar', 'file', '1', '2'],
    ['unit-open', 'maven-directory', root, 'direct', 'none', 'retain', sha],
    ['file', 'a.jar', 'data', native, null, 'none', 'retain'],
    ['unit-close', 'maven-directory', root, sha],
    ['dir-close', root],
    ['dir-close', 'repository'],
    ['dir-close', ''],
  ];
  const actual = await write(f, rows);
  expect(actual.seal.records).toBe(rows.length);
  const bad = structuredClone(rows);
  (bad[6] as Value[])[6] = h;
  await expect(write(f, bad)).rejects.toThrow('unit evidence');
  const mixed = structuredClone(rows);
  (mixed[7] as Value[])[5] = 'used';
  await expect(write(f, mixed)).rejects.toThrow('unit decisions');
});
it.each([
  'late-child',
  'child-collision',
  'breadth',
  'duplicate-file',
  'missing-unit',
  'wrong-owner',
  'unit-activity',
])('rejects local tree %s', async (kind) => {
  const f = fixture(
      kind === 'unit-activity' || kind === 'missing-unit' ? 'activity' : 'observations',
    ),
    rows = structuredClone(f.rows);
  if (kind === 'late-child') rows.splice(5, 0, ['child', 'z', 'file', '1', '9']);
  if (kind === 'child-collision') rows.splice(4, 0, ['child', 'empty.bin', 'directory', '1', '2']);
  if (kind === 'breadth') {
    f.opts = { ...f.opts, maxDirectoryEntries: 1 };
    rows.splice(4, 0, ['child', 'z', 'file', '1', '9']);
  }
  if (kind === 'duplicate-file') rows.splice(5, 0, rows[4]);
  if (kind === 'missing-unit')
    rows.splice(1, 0, ['dir-open', 'repository'], ['used', 'a.jar', 'data']);
  if (kind === 'wrong-owner') (rows[4] as Value[])[2] = 'data';
  if (kind === 'unit-activity') {
    rows.splice(
      1,
      rows.length - 1,
      ['dir-open', 'repository'],
      ['unit-open', 'maven-directory', 'repository', 'direct', 'used'],
      ['upsert', 'a.jar', 'data'],
    );
  }
  await expect(write(f, rows)).rejects.toThrow();
  expect(f.opts.budget.retained).toBe(0);
});
it.each(['overlap', 'index', 'escape', 'count', 'source'])(
  'rejects malformed move plan %s',
  async (kind) => {
    const f = fixture('move-plan'),
      rows = structuredClone(f.rows);
    if (kind === 'overlap')
      rows.splice(3, 0, [
        'move',
        2,
        'live',
        'metadata/empty.bin/child',
        'metadata/empty.bin/child',
        'file',
        ['span', h, 1, 2],
        ['span', h, 1, 2],
      ]);
    if (kind === 'index') (rows[2] as Value[])[1] = 2;
    if (kind === 'escape') (rows[2] as Value[])[4] = 'elsewhere';
    if (kind === 'count') (rows[3] as Value[])[3] = 2;
    if (kind === 'source') (rows[2] as Value[])[3] = 'metadata/other';
    await expect(write(f, rows)).rejects.toThrow();
  },
);
it('requires independent install kinds and supports authoritative empty snapshot deletion', async () => {
  const f = fixture('install-plan');
  f.opts = { ...f.opts, installKind: undefined };
  await expect(write(f)).rejects.toThrow('member kind');
  f.opts = { ...f.opts, installKind: () => 'file' };
  const rows: Value[] = [
    ['install-unit-open', 'snapshot', 'metadata', 'partition'],
    ['install', 1, 'metadata/stale', null, null, f.evidence(), 'delete', f.prefix + 'backup/1'],
    ['install-unit-close', 'snapshot', 'metadata'],
  ];
  expect((await write(f, rows)).seal.records).toBe(4);
  expect((await write(f, [rows[0], rows[2]])).seal.records).toBe(3);
});
it('checks prefix hash/count without a closing end and restores incremental hash state', async () => {
  const f = fixture('outbound-evidence'),
    bytes = Buffer.from([f.header, ...f.rows].map((v) => JSON.stringify(v) + '\n').join(''));
  const prefix: Value[] = [
    'prefix',
    'outbound-evidence',
    f.prefix + 'out.ndjson',
    bytes.length,
    1,
    rawSha(bytes),
  ];
  const state = await readLocalPrefix(chunks(bytes), 'outbound-evidence', f.opts, prefix);
  expect(state.rawHash.copy().update('next').digest('hex')).toBe(
    rawSha(Buffer.concat([bytes, Buffer.from('next')])),
  );
  expect(state.eventDigest.digest()).toBe(f.digest);
  prefix[4] = 0;
  await expect(readLocalPrefix(chunks(bytes), 'outbound-evidence', f.opts, prefix)).rejects.toThrow(
    'count',
  );
  await expect(
    readLocalPrefix(chunks(f.bytes), 'outbound-evidence', f.opts, [
      'prefix',
      'outbound-evidence',
      prefix[2],
      f.bytes.length,
      1,
      rawSha(f.bytes),
    ]),
  ).rejects.toThrow('Sealed');
});
it('rejects unsorted/duplicate catalogs and post sources during prepare', async () => {
  const f = fixture('partition-state');
  await expect(write(f, [f.rows[1], f.rows[0]])).rejects.toThrow('order');
  await expect(write(f, [f.rows[0]])).rejects.toThrow('Incomplete');
  const sources = fixture('prepare-sources'),
    bad = structuredClone(sources.rows);
  const source = (bad[0] as Value[])[1] as Value[];
  source[1] = 'local-writer';
  source[2] = ['local-writer', sources.options.invocation];
  await expect(write(sources, bad)).rejects.toThrow('Post-build');
});
it('checks producer selection scope and stable sorted inventory independently of ordinaryOrder', async () => {
  const f = fixture('producers');
  const producer = (job: string): Value => [
    'producer',
    [
      'artifact-' + job,
      'id-' + job,
      h,
      [...f.options.context.slice(0, 4), job, ...f.options.context.slice(5)],
      f.q('worker-archive'),
    ],
  ];
  expect((await write(f, [producer('A'), producer('B')])).seal.records).toBe(2);
  await expect(write(f, [producer('B'), producer('A')])).rejects.toThrow('producer inventory');
  const bad = producer('A') as Value[];
  ((bad[1] as Value[])[3] as Value[])[1] = 'other/repo';
  await expect(write(f, [bad])).rejects.toThrow('CI scope');
});
it('streams all64 new publication choices and prepare sources as bounded rows', async () => {
  const ids = Array.from({ length: 64 }, (_, i) => String(i).padStart(2, '0') + 'a'.repeat(62)),
    o = localOptions();
  const model = resolveModel(
    [
      'model',
      1,
      'maven',
      ['.mammoth/**'],
      ids.map((id) => [id, [id + '/**'], ['.mammoth/**'], 'single-writer', 'A', 'default']),
    ],
    'local64-',
    1,
  );
  const options = { ...o, model, invocation: invocationId(o.context, nonce) },
    f = localFixtures(options);
  const opts: LocalStreamOptions = {
    codec: new LocalCodec(options),
    budget: new WorkingBudget(),
    partition: null,
  };
  let choices = 0,
    sources = 0;
  for await (const _ of writeLocalStream(
    (async function* () {
      for (const id of ids) {
        const identity: ObjectIdentity = [model.family, model.id, id, h, h, h];
        yield [
          'new',
          id,
          identity,
          objectKey(identity),
          f.q('envelope'),
          f.q('native-tree'),
          f.q('move-plan'),
        ] as Value;
      }
    })(),
    'publication-partitions',
    opts,
    (s) => {
      choices = s.records;
    },
  ))
    void _;
  for await (const _ of writeLocalStream(
    (async function* () {
      for (const id of ids)
        yield [
          'snapshot-source',
          [
            id,
            'baseline',
            ['baseline', 'key-' + id],
            f.q('native-evidence'),
            f.prefix + 'source/' + id,
          ],
        ] as Value;
    })(),
    'prepare-sources',
    opts,
    (s) => {
      sources = s.records;
    },
  ))
    void _;
  expect(choices).toBe(64);
  expect(sources).toBe(64);
  expect(opts.budget.retained).toBe(0);
});
it('has no cumulative installation count/byte admission limit', async () => {
  const f = fixture('installations');
  let seal!: LocalStreamSeal;
  const registration = f.rows[0] as Value[];
  const source = async function* () {
    for (let i = 0; i < 100001; i++)
      yield [
        'installation',
        [
          ...(registration[1] as Value[]).slice(0, 4),
          'v'.repeat(30) + i,
          ...(registration[1] as Value[]).slice(5),
        ],
      ];
  };
  for await (const _ of writeLocalStream(source(), 'installations', f.opts, (s) => {
    seal = s;
  }))
    void _;
  const read = await readLocalStream(
    writeLocalStream(source(), 'installations', f.opts, () => {}),
    'installations',
    f.opts,
    ['ref', 'installations', f.prefix + 'installations.ndjson', seal.bytes, seal.sha],
  );
  expect(read).toEqual(seal);
  expect(seal.records).toBe(100001);
  expect(seal.bytes).toBeGreaterThan(16000000);
  expect(f.opts.budget.retained).toBe(0);
}, 20000);

it.each(['missing-parent', 'identity', 'collision', 'directory-target'])(
  'rejects internally inconsistent GC projection %s',
  async (kind) => {
    const f = fixture('gc-evidence'),
      rows = structuredClone(f.rows);
    if (kind === 'missing-parent') rows.splice(1, 2);
    if (kind === 'identity') (rows[2] as Value[])[5] = '99';
    if (kind === 'collision')
      rows.splice(3, 0, ['parent-child', 'metadata', 'empty.bin', 'directory', '1', '2']);
    if (kind === 'directory-target') (rows[3] as Value[])[3] = directory;
    const last = rows[rows.length - 1] as Value[];
    last[3] = hash('gc-unit', rows.slice(0, -1));
    await expect(write(f, rows)).rejects.toThrow();
    expect(f.opts.budget.retained).toBe(0);
  },
);
it('rejects child directory evidence inside a direct Maven GC unit', async () => {
  const f = fixture('gc-evidence'),
    root = 'repository/g',
    rows: Value[] = [
      ['gc-unit-open', 'maven-directory', root, 'direct'],
      ['directory', root, directory],
      ['parent-child', root, 'child', 'directory', '1', '3'],
      ['directory', root + '/child', directory],
    ];
  rows.push(['gc-unit-close', 'maven-directory', root, hash('gc-unit', rows)]);
  await expect(write(f, rows)).rejects.toThrow('scope');
  expect(f.opts.budget.retained).toBe(0);
});
it.each(['unowned', 'wrong-owner'])(
  'rejects meaningful native evidence empty directory %s',
  async (kind) => {
    const f = fixture('native-evidence'),
      rows: Value[] = [
        ['directory', '', directory],
        ['directory', kind === 'unowned' ? 'unowned' : 'repository', directory],
      ];
    await expect(write(f, rows)).rejects.toThrow();
    expect(f.opts.budget.retained).toBe(0);
  },
);
it('distinguishes file units, direct Maven directory roots and whole-directory move groups', async () => {
  const f = fixture('move-plan'),
    span: Value = ['span', h, 1, 2];
  const bad = structuredClone(f.rows);
  (bad[2] as Value[])[5] = 'directory';
  await expect(write(f, bad)).rejects.toThrow('ordinary file');
  const root = 'repository/g',
    direct: Value[] = [
      ['move-source', f.q('native-evidence')],
      ['move-unit-open', 'maven-directory', root, 'direct'],
      ['move', 1, 'live', root, root, 'directory', span, span],
      ['move-unit-close', 'maven-directory', root, 1],
    ];
  expect((await write(f, direct)).seal.records).toBe(4);
  const child = structuredClone(direct);
  (child[2] as Value[])[3] = root + '/child';
  (child[2] as Value[])[4] = root + '/child';
  await expect(write(f, child)).rejects.toThrow('match its direct unit root');
  const group: Value[] = [
    ['move-source', f.q('native-evidence')],
    ['move-unit-open', 'directory', 'metadata', 'subtree'],
    ['move', 1, 'live', 'metadata', 'metadata', 'directory', span, span],
    ['move-unit-close', 'directory', 'metadata', 1],
  ];
  expect((await write(f, group)).seal.records).toBe(4);
  (group[2] as Value[])[4] = 'metadata/child';
  (group[2] as Value[])[3] = 'metadata/child';
  await expect(write(f, group)).rejects.toThrow('single directory root');
  const install = fixture('install-plan');
  install.opts = { ...install.opts, installKind: () => 'directory' };
  await expect(write(install)).rejects.toThrow('ordinary file');
});
it('allows retained incomplete workspace observations but rejects deletion without markers', async () => {
  const original = localOptions(),
    model = resolveModel(
      [
        'model',
        1,
        'gradle',
        ['.mammoth/**'],
        [['data', ['**'], ['.mammoth/**'], 'aggregate', null, 'default']],
      ],
      'observed-',
      1,
    );
  const context = [...original.context] as typeof original.context;
  context[7] = 'gradle';
  const o = { ...original, model, context, invocation: invocationId(context, nonce) };
  const f = fixture('observations');
  f.opts = { ...f.opts, codec: new LocalCodec(o) };
  const root = 'caches/8.10/transforms/' + 'a'.repeat(32),
    paths = ['', 'caches', 'caches/8.10', 'caches/8.10/transforms', root];
  const facts: Value[] = [
      ['directory', root, directory],
      ['child', root, 'metadata.bin', 'file', '1', '2'],
      ['file', root + '/metadata.bin', 'data', native, null],
    ],
    sha = hash('observation-unit', facts);
  function rows(decision: string): Value[] {
    const result: Value[] = [];
    for (let i = 0; i < paths.length; i++) {
      result.push(['dir-open', paths[i], directory]);
      if (i + 1 < paths.length)
        result.push([
          'child',
          paths[i + 1].slice(paths[i].length + (paths[i] ? 1 : 0)),
          'directory',
          '1',
          '3',
        ]);
    }
    result.push(
      ['child', 'metadata.bin', 'file', '1', '2'],
      ['unit-open', 'artifact-transform', root, 'subtree', 'none', decision, sha],
      ['file', 'metadata.bin', 'data', native, null, 'none', decision],
      ['unit-close', 'artifact-transform', root, sha],
    );
    for (const path of [...paths].reverse()) result.push(['dir-close', path]);
    return result;
  }
  expect((await write(f, rows('retain'))).seal.records).toBeGreaterThan(10);
  await expect(write(f, rows('delete'))).rejects.toThrow('markers');
  expect(f.opts.budget.retained).toBe(0);
});
it('releases local names on early writer return and failing provisional consumer', async () => {
  const f = fixture('activity');
  let retired = false,
    sealed = false;
  const writer = writeLocalStream(
    (async function* () {
      try {
        yield ['dir-open', ''] as Value;
        yield ['dir-close', ''] as Value;
      } finally {
        retired = true;
      }
    })(),
    'activity',
    f.opts,
    () => {
      sealed = true;
    },
  );
  await writer.next();
  await writer.next();
  expect(f.opts.budget.retained).toBeGreaterThan(0);
  await writer.return(undefined);
  expect(retired).toBe(true);
  expect(sealed).toBe(false);
  expect(f.opts.budget.retained).toBe(0);
  await expect(
    readLocalStream(chunks(f.bytes), 'activity', f.opts, f.reference, async (row) => {
      if (Array.isArray(row) && row[0] === 'dir-open') throw new Error('local consumer');
    }),
  ).rejects.toThrow('local consumer');
  expect(f.opts.budget.retained).toBe(0);
});

it('allows explicit subtree file and directory cleanup in postorder', async () => {
  const original = localOptions(),
    model = resolveModel(
      [
        'model',
        1,
        'gradle',
        ['.mammoth/**'],
        [['data', ['**'], ['.mammoth/**'], 'aggregate', null, 'default']],
      ],
      'gc-subtree-',
      1,
    );
  const context = [...original.context] as typeof original.context;
  context[7] = 'gradle';
  const o = { ...original, model, context, invocation: invocationId(context, nonce) },
    f = fixture('gc-evidence');
  f.opts = { ...f.opts, codec: new LocalCodec(o) };
  const root = 'caches/8.10/transforms/' + 'a'.repeat(32),
    rows: Value[] = [
      ['gc-unit-open', 'artifact-transform', root, 'subtree'],
      ['directory', root, directory],
      ['parent-child', root, 'metadata.bin', 'file', '1', '2'],
      ['parent-child', root, 'results.bin', 'file', '1', '2'],
      ['parent-child', root, 'transformed', 'directory', '1', '3'],
      ['target', root + '/metadata.bin', 'data', native],
      ['target', root + '/results.bin', 'data', native],
      ['directory', root + '/transformed', directory],
      ['target', root + '/transformed', 'data', directory],
      ['target', root, 'data', directory],
    ];
  rows.push(['gc-unit-close', 'artifact-transform', root, hash('gc-unit', rows)]);
  expect((await write(f, rows)).seal.records).toBe(rows.length);
  expect(f.opts.budget.retained).toBe(0);
  for (const member of ['file', 'directory']) {
    const bad = rows.slice(0, 5);
    bad.push(['target', root, 'data', directory]);
    bad.push(
      member === 'file'
        ? ['target', root + '/metadata.bin', 'data', native]
        : ['directory', root + '/transformed', directory],
    );
    bad.push(['gc-unit-close', 'artifact-transform', root, hash('gc-unit', bad)]);
    await expect(write(f, bad)).rejects.toThrow('after directory cleanup target');
    expect(f.opts.budget.retained).toBe(0);
  }
});

it('serializes each activity row once across several files sharing a directory', async () => {
  const f = fixture('activity');
  f.rows.splice(3, 0, ['used', 'second.bin', 'metadata'], ['used', 'third.bin', 'metadata']);
  const serialized = vi.spyOn(encoding, 'encodeRecord'),
    genericDigest = vi.spyOn(encoding.Digest.prototype, 'update');
  try {
    const output: Buffer[] = [];
    for await (const bytes of writeLocalStream(records(f.rows), 'activity', f.opts, () => {}))
      output.push(bytes);
    expect(serialized).toHaveBeenCalledTimes(f.rows.length + 2);
    expect(genericDigest).not.toHaveBeenCalled();
    for (const [index, bytes] of output.entries())
      expect(bytes).toBe(serialized.mock.results[index].value);
    expect(f.opts.budget.retained).toBe(0);
  } finally {
    serialized.mockRestore();
    genericDigest.mockRestore();
  }
});

it('encodes intent-owned parent renames without widening ordinary content units', async () => {
  const f = fixture('install-plan');
  const rows = structuredClone(f.rows);
  (rows[2] as Value[])[1] = 2;
  rows.splice(2, 0, ['install-parent', 1, 'metadata', f.prefix + 'parents/one', directory]);
  expect((await write(f, rows)).seal.records).toBe(5);
  const badIdentity = structuredClone(rows);
  (badIdentity[2] as Value[])[4] = native;
  await expect(write(f, badIdentity)).rejects.toThrow();
  const gap = structuredClone(rows);
  (gap[2] as Value[])[1] = 2;
  await expect(write(f, gap)).rejects.toThrow('Noncontiguous');
  await expect(write(f, [rows[0], rows[1], rows[2], rows[4]])).rejects.toThrow('Empty operation');
  expect(f.opts.budget.retained).toBe(0);
});
it('keeps empty aggregate directory presence distinct from file and subtree move units', async () => {
  const f = fixture('install-plan');
  f.opts = { ...f.opts, installKind: () => 'directory' };
  const rows: Value[] = [
    ['install-unit-open', 'empty-directory', 'repository/empty', 'subtree'],
    [
      'install',
      1,
      'repository/empty',
      f.prefix + 'source/empty',
      f.evidence(),
      null,
      'insert',
      null,
    ],
    ['install-unit-close', 'empty-directory', 'repository/empty'],
  ];
  expect((await write(f, rows)).seal.records).toBe(4);
  const snapshotOwner = structuredClone(rows);
  snapshotOwner[0] = ['install-unit-open', 'empty-directory', 'metadata/empty', 'subtree'];
  snapshotOwner[2] = ['install-unit-close', 'empty-directory', 'metadata/empty'];
  await expect(write(f, snapshotOwner)).rejects.toThrow('aggregate owner');
  expect((await write(f, [rows[0], rows[2]])).seal.records).toBe(3);
  const child = structuredClone(rows);
  (child[1] as Value[])[2] = 'repository/empty/child';
  await expect(write(f, child)).rejects.toThrow('exact directory');
  const deletion = structuredClone(rows);
  deletion[1] = [
    'install',
    1,
    'repository/empty',
    null,
    null,
    f.evidence(),
    'delete',
    f.prefix + 'backup/empty',
  ];
  await expect(write(f, deletion)).rejects.toThrow('cannot delete');
  f.opts = { ...f.opts, installKind: () => 'file' };
  await expect(write(f, rows)).rejects.toThrow('exact directory');
  expect(f.opts.budget.retained).toBe(0);
});

it('exposes exact checked row positions for bounded joins and releases on early return', async () => {
  const f = fixture('installations');
  const iterator = readLocalRows(chunks(f.bytes), 'installations', f.opts, f.reference);
  let offset = 0,
    record = 0;
  while (true) {
    const row = await iterator.next();
    if (row.done) {
      expect(row.value.bytes).toBe(f.bytes.length);
      break;
    }
    expect(row.value.start).toBe(offset);
    expect(row.value.record).toBe(record++);
    expect(f.bytes.subarray(row.value.start, row.value.end)).toEqual(encodeRecord(row.value.value));
    offset = row.value.end;
  }
  expect(offset).toBe(f.bytes.length);
  expect(f.opts.budget.retained).toBe(0);
  for await (const row of readLocalRows(chunks(f.bytes), 'installations', f.opts, f.reference)) {
    void row;
    break;
  }
  expect(f.opts.budget.retained).toBe(0);
  const bad = structuredClone(f.reference) as Value[];
  bad[4] = '0'.repeat(64);
  await expect(
    (async () => {
      for await (const _ of readLocalRows(chunks(f.bytes), 'installations', f.opts, bad)) void _;
    })(),
  ).rejects.toThrow('local reference');
  expect(f.opts.budget.retained).toBe(0);
});

it.each(['changed-close', 'wrong-parent', 'collision', 'directory-file'])(
  'rejects invalid hash-free current inventory %s',
  async (kind) => {
    const f = fixture('install-current');
    const rows: Value[] = [
      ['dir-open', '', directory],
      ['file', 'a', native],
      ['parent-child', '', '.mammoth', 'directory', '1', '99'],
      ['dir-close', '', directory],
    ];
    if (kind === 'changed-close') {
      const changed = [...directory] as Value[];
      changed[4] = '999';
      rows[3] = ['dir-close', '', changed];
    }
    if (kind === 'wrong-parent') (rows[2] as Value[])[1] = 'other';
    if (kind === 'collision') rows[2] = ['parent-child', '', 'a', 'directory', '1', '99'];
    if (kind === 'directory-file') (rows[1] as Value[])[2] = directory;
    await expect(write(f, rows)).rejects.toThrow();
    expect(f.opts.budget.retained).toBe(0);
  },
);

it('resolves install evidence kind before the existing grammar accepts each provisional row', async () => {
  const f = fixture('install-plan');
  let resolved: Value | undefined;
  const opts = {
    ...f.opts,
    installKind: (row: Value) => {
      expect(resolved).toEqual(row);
      return 'file' as const;
    },
  };
  for await (const row of readLocalRows(
    chunks(f.bytes),
    'install-plan',
    opts,
    f.reference,
    new AbortController().signal,
    async (value) => {
      resolved = value;
    },
  )) {
    if (Array.isArray(row.value) && row.value[0] === 'install') expect(resolved).toBe(row.value);
  }
  expect(opts.budget.retained).toBe(0);
});
it('cancels a pending pre-accept evidence join and releases the held parser record', async () => {
  const f = fixture('install-plan'),
    controller = new AbortController();
  let entered!: () => void;
  const called = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = (async () => {
    for await (const row of readLocalRows(
      chunks(f.bytes),
      'install-plan',
      f.opts,
      f.reference,
      controller.signal,
      async () => {
        entered();
        await new Promise<void>(() => {});
      },
    ))
      void row;
  })();
  await called;
  controller.abort(new Error('cancel evidence frontier'));
  await expect(pending).rejects.toThrow('cancel evidence frontier');
  expect(f.opts.budget.retained).toBe(0);
});

it('requires exactly one leading frozen current context and accepts later global evidence indices', async () => {
  const plan = fixture('install-plan'),
    evidence = fixture('install-evidence');
  await expect(
    (async () => {
      for await (const row of writeLocalStream(
        records(plan.rows.slice(1)),
        'install-plan',
        plan.opts,
        () => {},
      ))
        void row;
    })(),
  ).rejects.toThrow('Missing install context');
  await expect(write(plan, [plan.rows[0], ...plan.rows])).rejects.toThrow('Duplicate/late');
  const later = structuredClone(evidence.rows);
  (later[2] as Value[])[1] = 17;
  expect((await write(evidence, later)).seal.records).toBe(4);
  await expect(write(plan, later)).rejects.toThrow('Noncontiguous');
  expect(plan.opts.budget.retained).toBe(0);
  expect(evidence.opts.budget.retained).toBe(0);
});

it('defers snapshot structural-directory ownership to full-subtree admission but still checks files', async () => {
  const f = fixture('install-plan'),
    original = localOptions();
  const model = resolveModel(
    [
      'model',
      1,
      'maven',
      ['.mammoth/**'],
      [['metadata', ['cache/**/*.bin'], ['.mammoth/**'], 'single-writer', 'A', 'default']],
    ],
    'structural-',
    1,
  );
  f.opts = {
    ...f.opts,
    codec: new LocalCodec({ ...original, model }),
    installKind: () => 'directory',
  };
  const rows: Value[] = [
    ['install-unit-open', 'snapshot', 'metadata', 'partition'],
    [
      'install',
      1,
      'cache',
      f.prefix + 'install/metadata/cache',
      f.evidence(),
      null,
      'insert',
      null,
    ],
    ['install-unit-close', 'snapshot', 'metadata'],
  ];
  expect(() => model.owner('cache')).toThrow();
  expect((await write(f, rows)).seal.records).toBe(4);
  f.opts = { ...f.opts, installKind: () => 'file' };
  await expect(write(f, rows)).rejects.toThrow();
  expect(f.opts.budget.retained).toBe(0);
});

it('admits one complete aggregate directory insert and rejects replacement or escape', async () => {
  const f = fixture('install-plan');
  f.opts = { ...f.opts, installKind: () => 'directory' };
  const rows: Value[] = [
    ['install-unit-open', 'directory', 'repository/new', 'subtree'],
    [
      'install',
      1,
      'repository/new',
      f.prefix + 'install/data/repository/new',
      f.evidence(),
      null,
      'insert',
      null,
    ],
    ['install-unit-close', 'directory', 'repository/new'],
  ];
  expect((await write(f, rows)).seal.records).toBe(4);
  expect(encodeRecord(rows[0]).toString()).toBe(
    '["install-unit-open","directory","repository/new","subtree"]\n',
  );
  expect(rawSha(encodeRecord(rows[0]))).toBe(
    '6cb4d1c444a391b9be44b31e9f7ff1291742c02f78d3192a53d41b5a9c120a25',
  );

  for (const operation of ['replace', 'delete']) {
    const bad = structuredClone(rows);
    (bad[1] as Value[])[6] = operation;
    (bad[1] as Value[])[5] = f.evidence();
    (bad[1] as Value[])[7] = f.prefix + 'backups/1';
    if (operation === 'delete') {
      (bad[1] as Value[])[3] = null;
      (bad[1] as Value[])[4] = null;
    }
    await expect(write(f, bad)).rejects.toThrow();
  }
  const escaped = structuredClone(rows);
  (escaped[1] as Value[])[2] = 'repository/new/child';
  await expect(write(f, escaped)).rejects.toThrow('single directory root');
  await expect(write(f, [rows[0], rows[2]])).rejects.toThrow('root count');
  expect(f.opts.budget.retained).toBe(0);
});

it('allows structurally unowned directory roots and binds aggregate rather than snapshot source paths', async () => {
  const hard = ['.mammoth/**'];
  const model = resolveModel(
    [
      'model',
      1,
      'maven',
      hard,
      [
        ['data', ['data/**/*.bin'], hard, 'aggregate', null, 'default'],
        ['metadata', ['metadata/**'], hard, 'single-writer', null, 'default'],
      ],
    ],
    'narrow-',
    1,
  );
  expect(() => model.owner('data/.workspace-directory-probe')).toThrow();
  const f = fixture('install-plan', model);
  f.opts = { ...f.opts, installKind: () => 'directory' };
  const rows: Value[] = [
    ['install-unit-open', 'directory', 'data', 'subtree'],
    ['install', 1, 'data', f.prefix + 'install/data/data', f.evidence(), null, 'insert', null],
    ['install-unit-close', 'directory', 'data'],
  ];
  await write(f, rows);
  const snapshot = structuredClone(rows);
  (snapshot[1] as Value[])[3] = f.prefix + 'install/metadata/data';
  await expect(write(f, snapshot)).rejects.toThrow('aggregate source');
});
