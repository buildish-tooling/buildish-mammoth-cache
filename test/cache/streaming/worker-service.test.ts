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

import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  rm,
  readdir,
  link,
  utimes,
  chmod,
} from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  WorkflowArtifactBackend,
  WorkflowArtifactDescriptor,
} from '../../../src/delta/backend';
import { STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES } from '../../../src/delta/backend';
import {
  freezeWorkerArtifact,
  uploadWorkerArtifact,
  discoverWorkerArtifacts,
  acquireWorkerArtifacts,
} from '../../../src/cache/streaming/worker-service';
import { workerArtifactName } from '../../../src/cache/streaming/worker-artifact-identity';
import { DownloadedWorkerArchive } from '../../../src/cache/streaming/worker-download';
import { NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';
import { OwnedStore } from '../../../src/cache/streaming/owned-store';
import { LocalCodec } from '../../../src/cache/streaming/local-schema';
import { invocationId, resolveModel } from '../../../src/cache/streaming/model';
import { mergeWorkerArchives } from '../../../src/cache/streaming/worker-merge';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { localFixtures } from './local-fixtures';
import { tuple } from '../../../src/cache/streaming/encoding';
import { initializeCompleteFixture } from './worker-complete-fixtures';
import {
  acceptWorkerMerge,
  installWorkerMerge,
} from '../../../src/cache/streaming/worker-incoming';
import {
  sourceFixture,
  freezeSources,
  freezeRetainedSources,
  cleanupSourceFixtures,
} from './worker-source-fixtures';
const roots: string[] = [],
  downloads: DownloadedWorkerArchive[] = [],
  merges: Awaited<ReturnType<typeof mergeWorkerArchives>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of merges.splice(0)) await r.dispose();
  for (const d of downloads.splice(0)) await d.dispose();
  await cleanupSourceFixtures();
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});
function backend() {
  const objects = new Map<number, { artifact: WorkflowArtifactDescriptor; bytes: Buffer }>();
  let id = 0;
  const upload = vi.fn(
    async (
      ...[_name, files, _root, options]: Parameters<WorkflowArtifactBackend['uploadArtifact']>
    ) => {
      expect(files).toHaveLength(1);
      expect(options?.skipArchive).toBe(true);
      const bytes = await readFile(files[0]),
        artifact = {
          id: ++id,
          name: path.basename(files[0]),
          size: bytes.length,
          digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
        };
      objects.set(id, { artifact, bytes });
      return artifact;
    },
  );
  const list = vi.fn(async () => [...objects.values()].map((x) => x.artifact));
  const get = vi.fn(async (name: string) => {
    const value = [...objects.values()].find((x) => x.artifact.name === name);
    if (!value) throw new Error('missing');
    return value.artifact;
  });
  const download = vi.fn(
    async (...[artifactId, options]: Parameters<WorkflowArtifactBackend['downloadArtifact']>) => {
      expect(options?.skipDecompress).toBe(true);
      const value = objects.get(artifactId);
      if (!value || !options?.path) throw new Error('missing');
      await writeFile(path.join(options.path, 'opaque-response-name.data'), value.bytes);
      return { downloadPath: options.path, digestMismatch: false };
    },
  );
  const api: WorkflowArtifactBackend = {
    capabilities: {
      ...STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES,
      supportsRawWorkerArchives: true,
    },
    uploadArtifact: upload,
    listArtifacts: list,
    getArtifact: get,
    downloadArtifact: download,
    deleteArtifact: vi.fn(async () => {}),
  };
  return { api, upload, list, get, download, objects };
}
async function fixture() {
  const f = await sourceFixture(),
    view = await freezeSources(f),
    b = backend(),
    archive = await freezeWorkerArtifact(b.api, f.store, view, f.budget);
  return { ...f, view, b, archive };
}
async function parent(f: { store: OwnedStore }) {
  const root = await mkdtemp(path.resolve('build/worker-service-parent-'));
  roots.push(root);
  const context = [...f.store.codec.options.context] as typeof f.store.codec.options.context;
  context[4] = 'parent';
  return {
    store: await OwnedStore.bind(
      root,
      new LocalCodec({
        ...f.store.codec.options,
        context,
        role: 'distributed-aggregator',
        invocation: invocationId(context, 'a'.repeat(32)),
      }),
    ),
    budget: new WorkingBudget(),
  };
}
it('round trips actual source/package through raw backend/native download and the same one-pass merger', async () => {
  const f = await fixture(),
    receipt = await uploadWorkerArtifact(f.b.api, f.archive, { retentionDays: 7 }),
    p = await parent(f),
    scope = {
      token: 'fixture-token',
      repository: f.store.codec.options.context[1],
      runId: Number(f.store.codec.options.context[3]),
    };
  expect(tuple(receipt.receipt)).toEqual(['artifact-receipt', '1', f.archive.name, f.archive.sha]);
  expect(f.b.upload.mock.calls[0][1]).toEqual([f.archive.file]);
  expect(f.b.upload.mock.calls[0][3]).toEqual({
    skipArchive: true,
    compressionLevel: 0,
    retentionDays: 7,
  });
  const selected = await discoverWorkerArtifacts(
      f.b.api,
      f.model,
      p.store.codec.options.context,
      [{ job: 'A', required: true, authorizedSnapshots: [] }],
      { scope },
    ),
    acquired = await acquireWorkerArtifacts(p.store, f.b.api, selected, { scope });
  downloads.push(...acquired);
  expect(path.basename(acquired[0].reference[2])).toBe('opaque-response-name.data');
  expect(acquired[0].reference[4]).toBe(f.archive.sha);
  expect(f.b.download.mock.calls[0][1]).toMatchObject({
    scope,
    skipDecompress: true,
    expectedHash: 'sha256:' + f.archive.sha,
  });
  const result = await mergeWorkerArchives(
    p.store,
    acquired.map((d) => d.input()),
    { budget: p.budget, ordinaryOrder: ['A'], ordinaryPolicy: 'strict' },
  );
  merges.push(result);
  expect(result.readers[0].work.archivePasses).toBe(1);
  expect(result.readers[0].work.bodyBytes).toBe(7);
  expect(result.stage.work.bodyBytes).toBe(7);
  await result.dispose();
  expect(p.budget.retained).toBe(0);
});
it('requires explicit raw capability and never falls back or traverses source on an unsupported backend', async () => {
  const f = await sourceFixture(),
    view = await freezeSources(f),
    b = backend();
  const unsupported = {
    ...b.api,
    capabilities: { ...STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES },
  };
  const before = f.store.root.work.readBytes;
  await expect(freezeWorkerArtifact(unsupported, f.store, view, f.budget)).rejects.toThrow(
    'explicitly support raw',
  );
  expect(f.store.root.work.readBytes).toBe(before);
  expect(b.upload).not.toHaveBeenCalled();
});
it.each(['bare', 'qualified'])(
  'normalizes %s service digest before accepting a receipt',
  async (style) => {
    const f = await fixture(),
      upload = f.b.upload.getMockImplementation()!;
    f.b.upload.mockImplementation(async (...args) => ({
      ...(await upload(...args)),
      digest: (style === 'qualified' ? 'sha256:' : '') + f.archive.sha.toUpperCase(),
    }));
    const receipt = await uploadWorkerArtifact(f.b.api, f.archive);
    expect(receipt.artifact.digest).toBe('sha256:' + f.archive.sha);
  },
);
it.each(['0'.repeat(64), 'sha1:unsupported'])(
  'rejects reported upload digest %s without receipt/readback fallback',
  async (digest) => {
    const f = await fixture(),
      upload = f.b.upload.getMockImplementation()!;
    f.b.upload.mockImplementation(async (...args) => ({ ...(await upload(...args)), digest }));
    await expect(uploadWorkerArtifact(f.b.api, f.archive)).rejects.toThrow(/unconfirmed/);
    expect(f.b.get).not.toHaveBeenCalled();
  },
);
it.each([true, false])(
  'abandons a lost response without service discovery/readback (reported digest=%s)',
  async (reported) => {
    const f = await fixture(),
      upload = f.b.upload.getMockImplementation()!,
      read = vi.spyOn(NativeReadPhase.prototype, 'read');
    f.b.upload.mockImplementation(async (...args) => {
      const artifact = await upload(...args);
      if (!reported) f.b.objects.get(artifact.id)!.artifact = { ...artifact, digest: null };
      throw new Error('ambiguous RPC outcome');
    });
    const before = await readFile(f.archive.file);
    await expect(uploadWorkerArtifact(f.b.api, f.archive)).rejects.toThrow(
      'retain immutable package at ' + f.archive.file,
    );
    expect(await readFile(f.archive.file)).toEqual(before);
    expect(f.b.get).not.toHaveBeenCalled();
    expect(f.b.list).not.toHaveBeenCalled();
    expect(f.b.download).not.toHaveBeenCalled();
    expect(f.b.upload).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  },
);
it('retains immutable package after raw SDK rejection while an inaccessible reader remains live', async () => {
  const f = await fixture();
  let release!: () => void;
  let reader!: Promise<Buffer>;
  f.b.upload.mockImplementation(async () => {
    reader = new Promise<void>((r) => {
      release = r;
    }).then(() => readFile(f.archive.file));
    throw new Error('SDK rejected before reader closed');
  });
  await expect(uploadWorkerArtifact(f.b.api, f.archive)).rejects.toThrow('unconfirmed');
  release();
  expect(await reader).toEqual(await readFile(f.archive.file));
  expect(f.b.get).not.toHaveBeenCalled();
  expect(f.b.download).not.toHaveBeenCalled();
});
it('discovers latest eligible attempts deterministically without legacy total-byte admission', async () => {
  const f = await fixture(),
    execution = [...f.store.codec.options.context] as typeof f.store.codec.options.context;
  execution[5] = 2;
  const descriptor = (attempt: number, id: number, digest: string | null = 'a'.repeat(64)) => {
    const c = [...execution] as typeof execution;
    c[5] = attempt;
    return {
      id,
      name: f.archive.name.replace(/-a[1-9][0-9]*-d/, '-a' + attempt + '-d'),
      size: 4 * 1024 ** 3,
      digest,
    };
  };
  const old = descriptor(1, 1, 'unsupported-old'),
    current = descriptor(2, 2),
    future = descriptor(3, 3);
  for (const rows of [
    [old, current, future],
    [future, current, old],
  ]) {
    f.b.list.mockResolvedValue(rows);
    const selected = await discoverWorkerArtifacts(f.b.api, f.model, execution, [
      { job: 'A', required: true, authorizedSnapshots: [] },
    ]);
    expect(selected[0].artifact.id).toBe(2);
    expect(selected[0].artifact.size).toBe(4 * 1024 ** 3);
  }
  f.b.list.mockResolvedValue([current, { ...current, id: 4 }]);
  await expect(
    discoverWorkerArtifacts(f.b.api, f.model, execution, [
      { job: 'A', required: true, authorizedSnapshots: [] },
    ]),
  ).rejects.toThrow('Ambiguous');
  f.b.list.mockResolvedValue([]);
  expect(
    await discoverWorkerArtifacts(f.b.api, f.model, execution, [
      { job: 'A', required: false, authorizedSnapshots: [] },
    ]),
  ).toEqual([]);
  f.b.list.mockResolvedValue([future]);
  await expect(
    discoverWorkerArtifacts(f.b.api, f.model, execution, [
      { job: 'A', required: false, authorizedSnapshots: [] },
    ]),
  ).rejects.toThrow('before');
});
it.each(['extra', 'directory', 'outside', 'mismatch', 'bytes', 'hardlink'])(
  'rejects malformed raw download %s without admitting an archive',
  async (fault) => {
    const f = await fixture(),
      receipt = await uploadWorkerArtifact(f.b.api, f.archive),
      p = await parent(f),
      download = f.b.download.getMockImplementation()!,
      foreign = p.store.root.resolve('foreign');
    await writeFile(foreign, 'preserved');
    f.b.download.mockImplementation(async (...args) => {
      const result = await download(...args),
        dir = args[1]!.path!;
      if (fault === 'extra') await writeFile(path.join(dir, 'extra'), 'extra');
      if (fault === 'directory') {
        await rm(path.join(dir, 'opaque-response-name.data'));
        await mkdir(path.join(dir, 'sub'));
      }
      if (fault === 'outside') result.downloadPath = foreign;
      if (fault === 'mismatch') result.digestMismatch = true;
      if (fault === 'bytes')
        await writeFile(path.join(dir, 'opaque-response-name.data'), Buffer.alloc(f.archive.bytes));
      if (fault === 'hardlink') {
        await rm(path.join(dir, 'opaque-response-name.data'));
        await link(foreign, path.join(dir, 'linked'));
      }
      return result;
    });
    await expect(
      DownloadedWorkerArchive.download(p.store, f.b.api, {
        artifact: receipt.artifact,
        context: f.store.codec.options.context,
        authorizedSnapshots: [],
      }),
    ).rejects.toThrow();
    expect(await readFile(foreign, 'utf8')).toBe('preserved');
    expect(await readdir(p.store.root.resolve(p.store.prefix + 'worker'))).toEqual([]);
  },
);
it('waits for an uncancellable backend download to settle before cancellation cleanup', async () => {
  const f = await fixture(),
    receipt = await uploadWorkerArtifact(f.b.api, f.archive),
    p = await parent(f),
    download = f.b.download.getMockImplementation()!,
    controller = new AbortController();
  let enter!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
      enter = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  f.b.download.mockImplementation(async (...args) => {
    enter();
    await gate;
    return download(...args);
  });
  const pending = DownloadedWorkerArchive.download(
    p.store,
    f.b.api,
    { artifact: receipt.artifact, context: f.store.codec.options.context, authorizedSnapshots: [] },
    { signal: controller.signal },
  );
  await started;
  controller.abort(new Error('cancelled SDK'));
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  await expect(pending).rejects.toThrow('cancelled SDK');
  expect(await readdir(p.store.root.resolve(p.store.prefix + 'worker'))).toEqual([]);
});

it('binds the exact genuine survivor once before outgoing identity reads', async () => {
  const f = await sourceFixture(),
    view = await freezeSources(f);
  let reads = 0;
  const changing = {
    get survivors() {
      reads++;
      return reads === 1
        ? view.survivors
        : ({
            ...view.survivors,
            index: { reference: ['foreign'] },
          } as unknown as typeof view.survivors);
    },
  };
  expect(workerArtifactName(f.model, f.store.codec.options.context, changing)).toBe(
    workerArtifactName(f.model, f.store.codec.options.context, view),
  );
  expect(reads).toBe(1);
  await f.finish();
  expect(f.budget.retained).toBe(0);
});

it('rejects serialized source tuples before they can mint an outgoing artifact identity', () => {
  const f = localFixtures();
  expect(() =>
    workerArtifactName(f.codec.options.model, f.codec.options.context, {
      survivors: { assert: () => {} },
    } as never),
  ).toThrow('original GC survivor receipt');
});

it('installs real multi-worker packages, whole workspace winners and independent empty/nonempty snapshots', async () => {
  const hard = ['.mammoth/**'],
    model = resolveModel(
      [
        'model',
        1,
        'gradle',
        hard,
        [
          ['data', ['d/**'], hard, 'aggregate', null, 'default', 0],
          [
            'workspaces',
            ['caches/transforms-4/**'],
            hard,
            'aggregate',
            null,
            'choose-worker-directory',
            0,
          ],
          ['state', ['state/**'], hard, 'single-writer', 'A', 'default', 0],
          ['other', ['other/**'], hard, 'single-writer', 'A', 'default', 0],
        ],
      ],
      'pipeline-',
      1,
    ),
    a = await sourceFixture(false, 'gradle', model, 'A'),
    b = await sourceFixture(false, 'gradle', model, 'B'),
    units = ['a', 'b'].map((x) => 'caches/transforms-4/' + x.repeat(32)),
    service = backend();
  await expect(
    discoverWorkerArtifacts(service.api, model, a.store.codec.options.context, [
      { job: 'B', required: true, authorizedSnapshots: ['state'] },
    ]),
  ).rejects.toThrow('authorization/owner');
  expect(service.list).not.toHaveBeenCalled();
  for (const [f, job] of [
    [a, 'A'],
    [b, 'B'],
  ] as const) {
    await writeFile(f.store.root.resolve('d/unique-' + job), job);
    for (const root of units) {
      await mkdir(f.store.root.resolve(root + '/transformed'), { recursive: true });
      await writeFile(f.store.root.resolve(root + '/metadata.bin'), 'm');
      await writeFile(f.store.root.resolve(root + '/results.bin'), 'r');
      // Losing bodies have an incompatible file/directory shape; they are validated independently.
      if (job === 'B')
        await mkdir(f.store.root.resolve(root + '/transformed/x'), { recursive: true });
      await writeFile(
        f.store.root.resolve(root + '/transformed/x' + (job === 'B' ? '/child' : '')),
        job,
      );
    }
    if (job === 'A') {
      await mkdir(f.store.root.resolve('state'), { recursive: true });
      await mkdir(f.store.root.resolve('other'), { recursive: true });
      await writeFile(f.store.root.resolve('state/value'), 'snapshot');
    }
  }
  // Freeze portable ordinary ties consistently on both native platforms.
  for (const f of [a, b])
    for (const name of ['d/a', 'd/b']) await utimes(f.store.root.resolve(name), 1, 1);
  const bodyReads = vi.spyOn(NativeReadPhase.prototype, 'read'),
    av = await freezeRetainedSources(a, units, ['state', 'other']),
    bv = await freezeRetainedSources(b, units),
    aa = await freezeWorkerArtifact(service.api, a.store, av, a.budget),
    ba = await freezeWorkerArtifact(service.api, b.store, bv, b.budget);
  expect(bodyReads.mock.calls).toHaveLength(19); // A:10 including snapshot, B:9.
  expect(bodyReads.mock.calls.reduce((sum, row) => sum + Number(row[1][5]), 0)).toBe(36);
  bodyReads.mockRestore();
  await uploadWorkerArtifact(service.api, aa);
  await uploadWorkerArtifact(service.api, ba);
  const p = await parent(a),
    selected = await discoverWorkerArtifacts(service.api, model, p.store.codec.options.context, [
      { job: 'A', required: true, authorizedSnapshots: ['state', 'other'] },
      { job: 'B', required: true, authorizedSnapshots: [] },
      { job: 'optional-absent', required: false, authorizedSnapshots: [] },
    ]),
    acquired = await acquireWorkerArtifacts(p.store, service.api, selected);
  downloads.push(...acquired);
  const f = { ...p, root: p.store.root.path, model, context: p.store.codec.options.context };
  await initializeCompleteFixture(f, ['B', 'A']);
  const result = await mergeWorkerArchives(
    p.store,
    acquired.map((d) => d.input()),
    {
      budget: p.budget,
      ordinaryOrder: ['B', 'A'],
      ordinaryPolicy: 'strict',
      snapshots: [
        { partition: 'state', job: 'A', required: true },
        { partition: 'other', job: 'A', required: true },
      ],
    },
  );
  merges.push(result);
  expect(result.readers.map((r) => r.work.archivePasses)).toEqual([1, 1]);
  expect(result.readers.reduce((sum, r) => sum + r.work.bodyBytes, 0)).toBe(36);
  expect(result.stage.work.bodyBytes).toBe(23); // 9 ordinary + 6 whole workspaces + 8 snapshot.
  expect(result.warnings.count).toBe(2);
  const accepted = await acceptWorkerMerge(p.store, result, p.budget);
  expect(accepted.work.snapshotCopyBytes).toBe(8);
  expect(accepted.snapshots).toHaveLength(2);
  await installWorkerMerge(p.store, accepted, p.budget);
  for (const root of units) {
    expect(await readFile(p.store.root.resolve(root + '/transformed/x'), 'utf8')).toBe('A');
    expect((await p.store.root.stat(root + '/transformed/x'))![2]).toBe('file');
  }
  for (const name of ['A', 'B'])
    expect(await readFile(p.store.root.resolve('d/unique-' + name), 'utf8')).toBe(name);
  expect(await readFile(p.store.root.resolve('state/value'), 'utf8')).toBe('snapshot');
  for (const snapshot of accepted.snapshots) await snapshot.verify(new AbortController().signal);
  expect(tuple(await p.store.state())[4]).toBe('prepare-pending');
  await accepted.dispose();
  expect(p.budget.retained).toBe(0);
});

it.each([Array(65).fill('state'), ['data'], ['unknown'], ['state', 'state']])(
  'rejects invalid snapshot authorization %j before discovery or download I/O',
  async (authorization) => {
    const f = await fixture(),
      p = await parent(f);
    await expect(
      discoverWorkerArtifacts(f.b.api, f.model, p.store.codec.options.context, [
        { job: 'A', required: true, authorizedSnapshots: authorization },
      ]),
    ).rejects.toThrow('snapshot authorization');
    await expect(
      acquireWorkerArtifacts(p.store, f.b.api, [
        {
          artifact: { id: 1, name: f.archive.name, size: f.archive.bytes, digest: f.archive.sha },
          context: f.store.codec.options.context,
          authorizedSnapshots: authorization,
        },
      ]),
    ).rejects.toThrow('snapshot authorization');
    await expect(
      DownloadedWorkerArchive.download(p.store, f.b.api, {
        artifact: { id: 1, name: f.archive.name, size: f.archive.bytes, digest: f.archive.sha },
        context: f.store.codec.options.context,
        authorizedSnapshots: authorization,
      }),
    ).rejects.toThrow('snapshot authorization');
    expect(f.b.list).not.toHaveBeenCalled();
    expect(f.b.download).not.toHaveBeenCalled();
  },
);

it('installs real Maven direct-unit packages with strict portable metadata repair and no losing writes', async () => {
  const hard = ['.mammoth/**'],
    model = resolveModel(
      [
        'model',
        1,
        'maven',
        hard,
        [['data', ['repository/**'], hard, 'aggregate', null, 'default', 0]],
      ],
      'pipeline-',
      1,
    ),
    a = await sourceFixture(false, 'maven', model, 'A'),
    b = await sourceFixture(false, 'maven', model, 'B'),
    units = ['repository/g/a/1', 'repository/g/a/2'],
    service = backend();
  for (const [f, job] of [
    [a, 'A'],
    [b, 'B'],
  ] as const) {
    await rm(f.store.root.resolve('d'), { recursive: true });
    for (const root of units) {
      await mkdir(f.store.root.resolve(root), { recursive: true });
      for (const [name, body] of [
        ['a.jar', 'jar'],
        ['_remote.repositories', 'origin'],
      ]) {
        const file = f.store.root.resolve(root + '/' + name);
        await writeFile(file, body);
        await chmod(file, job === 'A' ? 0o644 : 0o755);
        await utimes(file, job === 'A' ? 1 : 2, job === 'A' ? 1 : 2);
      }
    }
    const view = await freezeRetainedSources(f, units),
      archive = await freezeWorkerArtifact(service.api, f.store, view, f.budget);
    await uploadWorkerArtifact(service.api, archive);
  }
  const p = await parent(a),
    selected = await discoverWorkerArtifacts(
      service.api,
      model,
      p.store.codec.options.context,
      ['A', 'B'].map((job) => ({ job, required: true, authorizedSnapshots: [] })),
    ),
    acquired = await acquireWorkerArtifacts(p.store, service.api, selected);
  downloads.push(...acquired);
  await initializeCompleteFixture(
    { ...p, root: p.store.root.path, model, context: p.store.codec.options.context },
    ['B', 'A'],
  );
  const result = await mergeWorkerArchives(
    p.store,
    acquired.map((d) => d.input()),
    {
      budget: p.budget,
      ordinaryOrder: ['B', 'A'],
      ordinaryPolicy: 'strict',
    },
  );
  merges.push(result);
  expect(result.readers.map((r) => r.work.archivePasses)).toEqual([1, 1]);
  expect(result.readers.reduce((sum, r) => sum + r.work.bodyBytes, 0)).toBe(36);
  expect(result.stage.work.bodyBytes).toBe(18);
  const accepted = await acceptWorkerMerge(p.store, result, p.budget);
  await installWorkerMerge(p.store, accepted, p.budget);
  for (const root of units) {
    const n = (await p.store.root.stat(root + '/a.jar'))!;
    expect(n[8]).toBe('2000000000');
    if (process.platform !== 'win32') expect(n[6] & 0o777).toBe(0o755);
    expect(await readFile(p.store.root.resolve(root + '/a.jar'), 'utf8')).toBe('jar');
  }
  await accepted.dispose();
  expect(p.budget.retained).toBe(0);
});

it.each([null, undefined, { id: 0, name: 'invalid', size: 0, digest: null }])(
  'retains package without receipt/discovery on invalid direct response %s',
  async (response) => {
    const f = await fixture();
    f.b.upload.mockResolvedValue(response as unknown as Awaited<ReturnType<typeof f.b.upload>>);
    const before = await readFile(f.archive.file);
    await expect(uploadWorkerArtifact(f.b.api, f.archive)).rejects.toThrow('unconfirmed');
    await expect(uploadWorkerArtifact(f.b.api, f.archive)).rejects.toThrow('already attempted');
    expect(f.b.upload).toHaveBeenCalledTimes(1);
    expect(f.b.get).not.toHaveBeenCalled();
    expect(f.b.download).not.toHaveBeenCalled();
    expect(await readFile(f.archive.file)).toEqual(before);
  },
);
