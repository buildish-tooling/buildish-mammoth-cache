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

import type { Value } from '../../../src/cache/streaming/encoding';
import { afterEach, beforeAll, afterAll, expect, it, vi } from 'vitest';
import { readFile, writeFile, rm, mkdtemp, utimes } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { composedFixture } from './composed-fixture';
import { prepareStateFixture } from './prepare-state-fixture';
import { nativeCacheBackend, cleanupBaseFixtures } from './base-fixtures';
import { prepareStreaming } from '../../../src/cache/streaming/prepare';
import { postStreamingBase } from '../../../src/cache/streaming/base-post';
import { PrepareFacts, type DigestHandoff } from '../../../src/cache/streaming/prepare-state';
import { PreparedDigests } from '../../../src/cache/streaming/prepare-digests';
import { freezeInstallPlan } from '../../../src/cache/streaming/install-plan';
import { executeInstall } from '../../../src/cache/streaming/install-execute';
import type { NativeIdentity } from '../../../src/cache/streaming/native';
import { tuple } from '../../../src/cache/streaming/encoding';
import { NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';
import { walkNative } from '../../../src/cache/streaming/native-walk';
const fixtures: { close(): Promise<unknown>; budget: { retained: number } }[] = [];
let processDir: string, bundle: string;
beforeAll(async () => {
  processDir = await mkdtemp(path.resolve('build/digest-process-'));
  bundle = path.join(processDir, 'fixture.mjs');
  await build({
    entryPoints: ['test/cache/streaming/prepared-digests-process-fixture.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
  });
});
afterAll(async () => {
  await rm(processDir, { recursive: true, force: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
  await cleanupBaseFixtures();
});
async function warm(directory = false) {
  const sdk = await nativeCacheBackend(),
    f = await composedFixture({ cacheBackend: async () => sdk.backend });
  fixtures.push(f);
  const post = (anchor: Parameters<typeof postStreamingBase>[0]['anchor']) =>
    postStreamingBase({
      anchor,
      budget: f.budget,
      assertCurrent: () => undefined,
      cacheBackend: async () => sdk.backend,
      removeHooks: async () => {},
    });
  const ready = await prepareStreaming(f.request);
  await f.files('', { 'data/a': 'aaa', 'data/sub/b': 'bbb', 'data/sub/c': 'ccc' });
  await post(ready.anchor);
  if (directory) await rm(f.store.root.resolve('data'), { recursive: true });
  const next = await prepareStreaming({ ...f.request, nonce: 'b'.repeat(32) });
  return { f, sdk, next, post };
}
it('retains one directory placement and reuses digests in an actual new post process', async () => {
  const { f, next } = await warm(true);
  const facts = await PrepareFacts.open(next.store, { budget: f.budget });
  try {
    expect(facts.digestHandoffs.filter((h) => h[2] === 'data')).toHaveLength(1);
    const h = facts.digestHandoffs.find((h) => h[2] === 'data')!,
      rows: unknown[] = [];
    await next.store.readStream(
      h[3],
      'digest-placements',
      { budget: f.budget, partition: 'data' },
      async (v) => {
        rows.push(v);
      },
    );
    expect(rows.filter((v) => (v as string[])[0] === 'digest-placement')).toHaveLength(1);
  } finally {
    facts.close();
  }
  const input = path.join(processDir, 'anchor.json'),
    out = path.join(processDir, 'out.json');
  await writeFile(input, JSON.stringify(next.anchor));
  execFileSync(process.execPath, [bundle, input, out], { stdio: 'pipe', timeout: 15000 });
  expect(JSON.parse(await readFile(out, 'utf8'))).toEqual({ outcome: 'no-change', hashes: 0 });
}, 30000);
it.each(['unchanged', 'edit', 'atime', 'new'] as const)(
  'individual file placements: %s',
  async (mode) => {
    const { f, next, post } = await warm();
    if (mode === 'edit') {
      const before = await next.store.root.stat('data/a');
      await writeFile(next.store.root.resolve('data/a'), 'ZZZ');
      await utimes(
        next.store.root.resolve('data/a'),
        Number(BigInt(before![7]) / 1000000n) / 1000,
        Number(BigInt(before![8]) / 1000000n) / 1000,
      );
    }
    if (mode === 'atime') {
      const before = await next.store.root.stat('data/a');
      await readFile(next.store.root.resolve('data/a')); // own read, without rewriting mtime/ctime
      expect((await next.store.root.stat('data/a'))![8]).toBe(before![8]);
    }
    if (mode === 'new') await f.files('', { 'data/new': 'new' });
    const hash = vi.spyOn(NativeReadPhase.prototype, 'hash');
    const done = await post(next.anchor);
    expect(hash.mock.calls.filter((c) => c[2] === null)).toHaveLength(
      mode === 'edit' || mode === 'new' ? 1 : 0,
    );
    expect(done.outcome).toBe(mode === 'edit' || mode === 'new' ? 'published' : 'no-change');
  },
  30000,
);
it('worker-stage descendant overrides preserve unchanged siblings from base origins', async () => {
  const f = await prepareStateFixture();
  fixtures.push(f);
  const a = await f.incoming('data', { 'data/a': 'aaa', 'data/b': 'bbb' });
  const h0 = await executeInstall(
    f.store,
    await freezeInstallPlan(f.store, [a], f.budget),
    f.budget,
    { digestStage: 0 },
  );
  let facts = await PrepareFacts.open(f.store, { budget: f.budget });
  const selected = structuredClone(facts.selection!);
  selected[5] = ['miss'];
  selected[6] = ['selected', []];
  selected[7] = [];
  selected[9] = 'base-installed';
  try {
    await facts.commit({ selection: selected, digestHandoffs: h0 });
  } finally {
    facts.close();
  }
  const b = await f.incoming('data', { 'data/a': 'new' });
  const h1 = await executeInstall(
    f.store,
    await freezeInstallPlan(f.store, [b], f.budget),
    f.budget,
    { digestStage: 1 },
  );
  facts = await PrepareFacts.open(f.store, { budget: f.budget });
  const complete = structuredClone(facts.selection!);
  complete[9] = 'workers-installed';
  const activity = await f.store.writeStream(
    'activity',
    { budget: f.budget, partition: null },
    (async function* () {
      yield ['dir-open', ''] as const;
      yield ['dir-close', ''] as const;
    })(),
  );
  try {
    await facts.commit({
      selection: complete,
      activity,
      digestHandoffs: [...facts.digestHandoffs, ...h1],
    });
  } finally {
    facts.close();
  }
  facts = await PrepareFacts.open(f.store, { budget: f.budget });
  const digests = await PreparedDigests.open(facts, { budget: f.budget });
  try {
    for await (const e of walkNative(f.store.root, '', { budget: f.budget })) {
      if (e.tag === 'file')
        expect(await digests.take('data', e.path, e.identity)).toBe(
          await f.store.root.hash(e.nativePath, e.identity),
        );
    }
    await digests.finish();
  } finally {
    await digests.close();
    facts.close();
  }
});
it('rejects a missing committed placement referent instead of hashing through it', async () => {
  const { f, next, post } = await warm(true);
  const facts = await PrepareFacts.open(next.store, { budget: f.budget });
  try {
    await rm(next.store.root.resolve(facts.digestHandoffs[0][3][2]));
  } finally {
    facts.close();
  }
  await expect(post(next.anchor)).rejects.toThrow();
});

it('rejects snapshot rows after digest handoffs in a resealed prepare-source candidate', async () => {
  const { f, next } = await warm(true);
  const facts = await PrepareFacts.open(next.store, { budget: f.budget });
  try {
    const h = facts.digestHandoffs[0];
    await expect(
      next.store.writeStream(
        'prepare-sources',
        { budget: f.budget, partition: null },
        (async function* () {
          yield facts.selection!;
          yield h;
          yield [
            'snapshot-source',
            [
              'state',
              'baseline',
              ['baseline', 'pinned'],
              h[3],
              next.store.prefix + 'retained/state',
            ],
          ] as const;
        })(),
      ),
    ).rejects.toThrow('Snapshot source follows');
  } finally {
    facts.close();
  }
});
it('rejects a missing committed original source Q, independently of placement-Q presence', async () => {
  const { f, next, post } = await warm(true);
  const facts = await PrepareFacts.open(next.store, { budget: f.budget });
  try {
    const h = facts.digestHandoffs.find((h) => h[2] === 'data')!;
    let source: string | undefined;
    await next.store.readStream(
      h[3],
      'digest-placements',
      { budget: f.budget, partition: 'data' },
      async (v) => {
        if (Array.isArray(v) && v[0] === 'digest-source') source = (v[1] as string[])[2];
      },
    );
    expect(source).toBeDefined();
    await rm(next.store.root.resolve(source!));
  } finally {
    facts.close();
  }
  await expect(post(next.anchor)).rejects.toThrow();
});
it.each(['span', 'native', 'unmatched-tail'] as const)(
  'rejects resealed invalid %s evidence even without matching current leaves',
  async (mode) => {
    const f = await prepareStateFixture();
    fixtures.push(f);
    await f.files('', { 'data/a': 'old', 'data/b': 'old' });
    const incoming = await f.incoming('data', { 'data/a': 'new', 'data/b': 'new' });
    const h = await executeInstall(
      f.store,
      await freezeInstallPlan(f.store, [incoming], f.budget),
      f.budget,
      { digestStage: 0 },
    );
    const rows: Value[] = [];
    await f.store.readStream(
      h[0][3],
      'digest-placements',
      { budget: f.budget, partition: 'data' },
      async (v) => {
        if (Array.isArray(v) && ['digest-source', 'digest-placement'].includes(String(v[0])))
          rows.push(structuredClone(v));
      },
    );
    const target = rows[mode === 'unmatched-tail' ? 2 : 1] as unknown as [
      string,
      string,
      string,
      [string, string, number, number],
      unknown[],
    ];
    if (mode === 'native') target[4][4] = '999999999';
    else target[3][2]++;
    const malformed = await f.store.writeStream(
      'digest-placements',
      { budget: f.budget, partition: 'data' },
      (async function* () {
        yield* rows;
      })(),
    );
    let facts = await PrepareFacts.open(f.store, { budget: f.budget });
    const s = structuredClone(facts.selection!);
    s[5] = ['miss'];
    s[6] = ['selected', []];
    s[7] = [];
    s[9] = 'base-installed';
    try {
      await facts.commit({
        selection: s,
        digestHandoffs: [
          f.store.codec.schemas.rows.digestHandoff.parse(['digest-handoff', 0, 'data', malformed]),
        ],
      });
    } finally {
      facts.close();
    }
    facts = await PrepareFacts.open(f.store, { budget: f.budget });
    const digests = await PreparedDigests.open(facts, { budget: f.budget });
    try {
      await expect(digests.finish()).rejects.toThrow();
    } finally {
      await digests.close();
      facts.close();
    }
  },
);

it('rejects a committed source footer corrupted beyond a matched member before publication', async () => {
  const f = await prepareStateFixture();
  fixtures.push(f);
  const entries = Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => ['data/f' + String(i).padStart(4, '0'), 'x']),
  );
  await f.files('', entries);
  const incoming = await f.incoming('data', entries);
  const handoffs = await executeInstall(
    f.store,
    await freezeInstallPlan(f.store, [incoming], f.budget),
    f.budget,
    { digestStage: 0 },
  );
  let facts = await PrepareFacts.open(f.store, { budget: f.budget });
  try {
    const selection = structuredClone(facts.selection!);
    selection[5] = ['miss'];
    selection[6] = ['selected', []];
    selection[7] = [];
    selection[9] = 'base-installed';
    await facts.commit({ selection, digestHandoffs: handoffs });
  } finally {
    facts.close();
  }
  // Damage only the source's final digest, preserving valid canonical rows and byte length.
  const file = f.store.root.resolve(incoming.evidence[2]),
    bytes = await readFile(file);
  const last = bytes.lastIndexOf(Buffer.from('["local-end"'));
  const at = bytes.indexOf(34, bytes.indexOf(44, bytes.indexOf(44, last) + 1) + 1) + 1;
  bytes[at] = bytes[at] === 97 ? 98 : 97;
  await writeFile(file, bytes);
  facts = await PrepareFacts.open(f.store, { budget: f.budget });
  const reader = await PreparedDigests.open(facts, { budget: f.budget });
  try {
    expect(
      await reader.take('data', 'data/f0000', (await f.store.root.stat('data/f0000'))!),
    ).toMatch(/^[a-f0-9]{64}$/);
    await expect(reader.finish()).rejects.toThrow();
    expect(
      f.store.codec.schemas.documents['local-state'].parse(await f.store.state())[7],
    ).toBeNull();
  } finally {
    await reader.close();
    facts.close();
  }
}, 30000);

it('keeps populated 16-partition origin frontiers within the default decoded budget', async () => {
  const f = await prepareStateFixture({ partitionCount: 16 });
  fixtures.push(f);
  const handoffs: DigestHandoff[] = [];
  let first: NativeIdentity | undefined;
  for (const p of f.model.partitions) {
    const input = await f.incoming(
      p[0],
      Object.fromEntries(
        Array.from({ length: 128 }, (_, i) => [
          'shared/d' + String(i).padStart(4, '0') + '/' + p[0],
          'x',
        ]),
      ),
    );
    const rows: Value[] = [['digest-source', input.evidence]];
    for await (const row of f.store.rows(input.evidence, 'native-evidence', {
      budget: f.budget,
      partition: p[0],
    })) {
      const value = tuple(row.value);
      if (value[0] !== 'file') continue;
      first ??= value[2] as NativeIdentity;
      rows.push([
        'digest-placement',
        value[1],
        'file',
        ['span', input.evidence[4], row.start, row.end],
        value[2],
      ]);
    }
    const ref = await f.store.writeStream(
      'digest-placements',
      { budget: f.budget, partition: p[0] },
      (async function* () {
        yield* rows;
      })(),
    );
    handoffs.push(f.store.codec.schemas.rows.digestHandoff.parse(['digest-handoff', 0, p[0], ref]));
  }
  let facts = await PrepareFacts.open(f.store, { budget: f.budget });
  try {
    const selection = structuredClone(facts.selection!);
    selection[5] = ['miss'];
    selection[6] = ['selected', []];
    selection[7] = [];
    selection[9] = 'base-installed';
    await facts.commit({ selection, digestHandoffs: handoffs });
  } finally {
    facts.close();
  }
  facts = await PrepareFacts.open(f.store, { budget: f.budget });
  const reader = await PreparedDigests.open(facts, { budget: f.budget });
  try {
    expect(f.budget.retained).toBeLessThan(8 * 1024 * 1024);
    expect(await reader.take('p000', 'shared/d0000/p000', first!)).toMatch(/^[a-f0-9]{64}$/);
    await reader.finish();
    process.stdout.write('DIGEST_FRONTIER_CHARGED_PEAK ' + f.budget.peakRetained + '\n');
  } finally {
    await reader.close();
    facts.close();
  }
  expect(f.budget.retained).toBe(0);
}, 30000);
