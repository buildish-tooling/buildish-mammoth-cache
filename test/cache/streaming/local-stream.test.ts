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
  writeLocalStream,
  type LocalPurpose,
  type LocalStreamOptions,
  type LocalStreamSeal,
  localPurposes,
} from '../../../src/cache/streaming/local-stream';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { encodeRecord, rawSha, type Value } from '../../../src/cache/streaming/encoding';
import { resolveModel, invocationId } from '../../../src/cache/streaming/model';
import { localFixtures, localOptions, native, directory, h, nonce } from './local-fixtures';
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
  const f = localFixtures(o),
    partition = null;
  const opts: LocalStreamOptions = {
    codec: f.codec,
    budget: new WorkingBudget(),
    partition,
    installKind: () => 'file',
  };
  const logical = 'metadata/empty.bin';
  let rows: Value[] = [];
  switch (purpose) {
    case 'model':
      rows = [
        ['model-header', o.model.tuple[2], o.model.tuple[3]],
        ...o.model.partitions.map((p) => ['partition', ...p] as Value),
      ];
      break;
    case 'handoff':
      rows = [
        ['handoff', 3, 'key', null, null, 1, 'disabled', null, null, f.q('activity'), 0, 0],
        ...o.model.partitions.map((p) => ['partition', p[0], 'miss', null, null] as Value),
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
        ['file', 'empty.bin', 'metadata', native, 'none', 'retain'],
        ['dir-close', 'metadata'],
        ['dir-close', ''],
      ];
      break;
    case 'install-plan':
      rows = [
        ['install-context', nonce],
        ['install-unit-open', 'file', logical, 'file'],
        [
          'install',
          1,
          logical,
          f.prefix + 'install/source',
          ['metadata-member', nonce, 'source', 'metadata', 1],
          null,
          'insert',
          null,
        ],
        ['install-unit-close', 'file', logical],
      ];
      break;
  }
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
    f.header[2] === 'install-plan' &&
    (!Array.isArray(rows[0]) || rows[0][0] !== 'install-context')
  )
    rows = [['install-context', nonce], ...rows];
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
    ['file', root + '/a.jar', 'data', native],
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
    ['file', 'a.jar', 'data', native, 'none', 'retain'],
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
  (mixed[7] as Value[])[4] = 'used';
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

it('requires independent install kinds and supports authoritative empty snapshot deletion', async () => {
  const f = fixture('install-plan');
  f.opts = { ...f.opts, installKind: undefined };
  await expect(write(f)).rejects.toThrow('member kind');
  f.opts = { ...f.opts, installKind: () => 'file' };
  const rows: Value[] = [
    ['install-unit-open', 'snapshot', 'metadata', 'partition'],
    [
      'install',
      1,
      'metadata/stale',
      null,
      null,
      ['metadata-member', nonce, 'current', 'metadata', 1],
      'delete',
      f.prefix + 'backup/1',
    ],
    ['install-unit-close', 'snapshot', 'metadata'],
  ];
  expect((await write(f, rows)).seal.records).toBe(4);
  expect((await write(f, [rows[0], rows[2]])).seal.records).toBe(3);
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
      ['file', root + '/metadata.bin', 'data', native],
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
      ['file', 'metadata.bin', 'data', native, 'none', decision],
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
      ['metadata-member', nonce, 'current', 'metadata', 1],
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
      ['metadata-member', nonce, 'source', 'data', 1],
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
    (bad[1] as Value[])[5] = ['metadata-member', nonce, 'current', 'metadata', 1];
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
    [
      'install',
      1,
      'data',
      f.prefix + 'install/data/data',
      ['metadata-member', nonce, 'source', 'data', 1],
      null,
      'insert',
      null,
    ],
    ['install-unit-close', 'directory', 'data'],
  ];
  await write(f, rows);
  const snapshot = structuredClone(rows);
  (snapshot[1] as Value[])[3] = f.prefix + 'install/metadata/data';
  (snapshot[1] as Value[])[4] = ['metadata-member', nonce, 'source', 'metadata', 1];
  await expect(write(f, snapshot)).rejects.toThrow('aggregate source');
});

it.each([
  'native-evidence',
  'stage-evidence',
  'install-current',
  'install-evidence',
  'gc-evidence',
  'move-plan',
  'outbound-evidence',
  'return-evidence',
  'adjustments',
  'digest-placements',
  'prepare-sources',
  'post-sources',
  'publication-partitions',
  'worker-sources',
])('rejects removed persisted stream purpose %s without compatibility', async (purpose) => {
  const f = fixture('activity');
  await expect(
    (async () => {
      for await (const bytes of writeLocalStream(
        records(f.rows),
        purpose as LocalPurpose,
        f.opts,
        () => {},
      ))
        void bytes;
    })(),
  ).rejects.toThrow();
  const header = [...f.header];
  header[2] = purpose;
  const digest = hash('local-' + purpose, [header, ...f.rows]);
  const bytes = Buffer.concat(
    [header, ...f.rows, ['local-end', f.rows.length, digest]].map(encodeRecord),
  );
  const reference: Value = [
    'ref',
    purpose,
    f.prefix + purpose + '.ndjson',
    bytes.length,
    rawSha(bytes),
  ];
  await expect(
    readLocalStream(chunks(bytes), purpose as LocalPurpose, f.opts, reference),
  ).rejects.toThrow();
  expect(f.opts.budget.retained).toBe(0);
});
