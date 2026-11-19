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

import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as metadata from '../../src/cache/metadata-io';
import { captureCacheMetadataSnapshot } from '../../src/cache/manifest';
import { selectCutoffActivity } from '../../src/cache/cutoff-selection';
import {
  newCutoffJournal,
  persistCutoffJournal,
  loadCutoffJournal,
  cutoffJournalPath,
  freezeCutoffSelection,
  verifyCutoffReplay,
  validateCutoffBudget,
  cutoffPolicy,
  cutoffJournalSchema,
  type CutoffJournal,
} from '../../src/cache/cutoff-state';
import type { CacheModel } from '../../src/cache/model';
import type { NormalizedActionConfig } from '../../src/config/types';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cutoff-state-'));
  roots.push(root);
  await mkdir(path.join(root, 'data'));
  await writeFile(path.join(root, 'data/a'), 'bytes');
  await utimes(path.join(root, 'data/a'), 1700000000, 1700000000);
  const include = path.join(root, 'data/**');
  const model: CacheModel = {
    cacheRoot: root,
    cacheFamilyKey: 'family',
    currentRefToken: 'main',
    currentRefLineagePrefix: 'family-ref-main-gen-',
    fallbackRefLineagePrefixes: [],
    plannedGenerationId: 'run-1',
    runnerOs: 'linux',
    runnerArch: 'x64',
    safeRefName: 'main',
    partitionFingerprint: 'layout',
    buildToolId: 'test',
    includePaths: [include],
    hardCacheExcludeGlobs: [],
    excludePaths: [],
    partitions: [
      {
        id: 'data',
        displayName: 'Data',
        description: '',
        relativeIncludeGlobs: ['data/**'],
        relativeExcludeGlobs: [],
        absoluteIncludeGlobs: [include],
        absoluteExcludeGlobs: [],
      },
    ],
  };
  const config = {
    jobMode: 'standalone',
    readOnly: false,
    cleanupEnabled: true,
    cacheGcMode: 'off',
    cacheGcOlderThanDays: 14,
    restoreCleanupMode: 'none',
    dependentJobs: [],
    allowDuplicateDependentDeltaPaths: false,
    phase: 'prepare',
  } as unknown as NormalizedActionConfig;
  const state = newCutoffJournal(model, cutoffPolicy(config), {
    repository: 'test/repo',
    workflowName: 'CI',
    jobName: 'test',
    runId: 1,
    runAttempt: 1,
    sourceRevision: null,
  });
  await persistCutoffJournal(state);
  return { root, model, state, config };
}
async function freeze(state: CutoffJournal, gc = false) {
  if (gc) state.policy.cacheGcMode = 'timestamp';
  state.cutoff = Date.now() + 100;
  state.phase = 'build-ready';
  await persistCutoffJournal(state);
  const snapshot = await captureCacheMetadataSnapshot(state.model);
  await freezeCutoffSelection(
    state,
    selectCutoffActivity(snapshot, state.cutoff, state.cutoff, 14, gc),
    state.cutoff,
  );
}
it('retains only current across five completed lifecycles and rejects superseded replay', async () => {
  const { root, model, state } = await fixture();
  let previous = state;
  for (let i = 0; i < 5; i++) {
    await freeze(previous);
    previous.phase = 'completed';
    await persistCutoffJournal(previous);
    expect(await loadCutoffJournal(model, cutoffJournalPath(previous.invocation))).toEqual(
      previous,
    );
    expect(
      (await readdir(path.join(root, '.mammoth/cutoff-state-v2'))).filter((p) =>
        p.startsWith('journal-'),
      ),
    ).toHaveLength(1);
    if (i === 4) break;
    const next = newCutoffJournal(model, previous.policy, previous.execution);
    await persistCutoffJournal(next);
    await expect(loadCutoffJournal(model, cutoffJournalPath(previous.invocation))).rejects.toThrow(
      /superseded/,
    );
    previous = next;
  }
});
it('preserves recovery through failed pointer writes and reclaims orphan attempts', async () => {
  const { root, model, state } = await fixture();
  const original = metadata.writeMetadata;
  const spy = vi.spyOn(metadata, 'writeMetadata').mockImplementation(async (...args) => {
    if (args[1].endsWith('/current.json')) throw new Error('pointer failed');
    return original(...args);
  });
  for (let i = 0; i < 4; i++) {
    await expect(
      persistCutoffJournal(newCutoffJournal(model, state.policy, state.execution)),
    ).rejects.toThrow('pointer failed');
    expect(await loadCutoffJournal(model, cutoffJournalPath(state.invocation))).toEqual(state);
    expect(
      (await readdir(path.join(root, '.mammoth/cutoff-state-v2'))).filter((p) =>
        p.startsWith('journal-'),
      ),
    ).toHaveLength(2);
  }
  spy.mockRestore();
  await persistCutoffJournal(newCutoffJournal(model, state.policy, state.execution));
  expect(
    (await readdir(path.join(root, '.mammoth/cutoff-state-v2'))).filter((p) =>
      p.startsWith('journal-'),
    ),
  ).toHaveLength(1);
});
it('reuses frozen evidence after own reads and refuses material drift', async () => {
  const { root, state } = await fixture();
  await freeze(state);
  const frozen = structuredClone(state.selection);
  await readFile(path.join(root, 'data/a'));
  await verifyCutoffReplay(state);
  expect(state.selection).toEqual(frozen);
  await writeFile(path.join(root, 'data/a'), 'changed');
  await expect(verifyCutoffReplay(state)).rejects.toThrow(/changed/);
});
it('permits only originally planned missing deletions and rejects recreated targets', async () => {
  const { root, state } = await fixture();
  await freeze(state, true);
  expect(state.selection!.gc).toHaveLength(1);
  await rm(path.join(root, 'data/a'));
  await verifyCutoffReplay(state);
  await writeFile(path.join(root, 'data/a'), 'new');
  await expect(verifyCutoffReplay(state)).rejects.toThrow(/target changed/);
});
it('does not adopt a failed freeze and reserves seal/deletion/publication space before I/O', async () => {
  const { root, state } = await fixture();
  state.cutoff = Date.now() + 100;
  state.phase = 'build-ready';
  await persistCutoffJournal(state);
  state.policy.cacheGcMode = 'timestamp';
  const snap = await captureCacheMetadataSnapshot(state.model),
    selection = selectCutoffActivity(snap, state.cutoff, state.cutoff, 14, true);
  const spy = vi.spyOn(metadata, 'writeMetadata').mockRejectedValue(new Error('disk failed'));
  await expect(freezeCutoffSelection(state, selection, state.cutoff)).rejects.toThrow();
  expect(state.selection).toBeNull();
  spy.mockRestore();
  await freezeCutoffSelection(state, selection, state.cutoff);
  expect(() => validateCutoffBudget(state, { records: 1, bytes: 64 * 1024 * 1024 })).toThrow(
    /budget/,
  );
  expect(() => validateCutoffBudget(state, { records: 200000, bytes: 100 })).toThrow(/budget/);
  expect(await readFile(path.join(root, 'data/a'), 'utf8')).toBe('bytes');
});
it('round-trips a representative 10000 selected-target plan with one inventory and bounded seals', async () => {
  const { state, model } = await fixture();
  await freeze(state);
  const native = (await captureCacheMetadataSnapshot(model)).partitions[0]!.entries[0]!.identity;
  state.selection!.upserts = Array.from({ length: 10000 }, (_, i) => ({
    partitionId: 'data',
    relativePath: `data/${String(i).padStart(6, '0')}`,
    identity: { ...native },
  }));
  await persistCutoffJournal(state);
  expect(
    (await loadCutoffJournal(model, cutoffJournalPath(state.invocation))).selection!.upserts,
  ).toHaveLength(10000);
  expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(8 * 1024 * 1024);
});

it('validates phase/policy/seal invariants and cannot cancel budget with duplicate progress', async () => {
  const { state } = await fixture();
  await freeze(state, true);
  for (const broken of [
    { ...state, observedAt: null },
    { ...state, phase: 'package-sealed' },
    { ...state, phase: 'publication-intent' },
    { ...state, policy: { ...state.policy, cacheGcMode: 'off' } },
    { ...state, deletedPaths: ['data/a', 'data/a'] },
  ])
    expect(cutoffJournalSchema.safeParse(broken).success).toBe(false);
  expect(() =>
    validateCutoffBudget({ ...state, deletedPaths: Array(200001).fill('data/a') }),
  ).toThrow(/actual/);
  // Nonworkers do not reserve an impossible worker seal.
  expect(() => validateCutoffBudget(state, { records: 3, bytes: 64 * 1024 * 1024 })).not.toThrow();
});
it('reuses committed observations after journal write succeeds but pointer write fails', async () => {
  const { state, model } = await fixture();
  state.cutoff = Date.now() + 100;
  state.phase = 'build-ready';
  await persistCutoffJournal(state);
  const snapshot = await captureCacheMetadataSnapshot(model),
    first = selectCutoffActivity(snapshot, state.cutoff, state.cutoff, 14, false);
  const original = metadata.writeMetadata;
  const spy = vi.spyOn(metadata, 'writeMetadata').mockImplementation(async (...args) => {
    if (args[1].endsWith('/current.json')) throw new Error('late pointer failure');
    return original(...args);
  });
  await expect(freezeCutoffSelection(state, first, state.cutoff)).rejects.toThrow(
    'late pointer failure',
  );
  expect(state.selection).toBeNull();
  spy.mockRestore();
  const changed = { ...first, used: ['data/a'] };
  await freezeCutoffSelection(state, changed, state.cutoff + 1000);
  expect(state.selection).toEqual(first);
  expect(state.observedAt).toBe(state.cutoff);
});

it('allows completed read-only state without frozen decisions while preserving writable invariants', async () => {
  const { state } = await fixture();
  state.cutoff = Date.now();
  state.phase = 'completed';
  await expect(persistCutoffJournal(state)).rejects.toThrow(/Missing frozen/);
  state.policy.readOnly = true;
  await persistCutoffJournal(state);
  const completed = await loadCutoffJournal(state.model, cutoffJournalPath(state.invocation));
  expect(completed).toMatchObject({ phase: 'completed', selection: null, observedAt: null });
  state.observedAt = Date.now();
  await expect(persistCutoffJournal(state)).rejects.toThrow(/Decisions without/);
  state.observedAt = null;
  state.phase = 'observations-frozen';
  await expect(persistCutoffJournal(state)).rejects.toThrow(/Read-only lifecycle/);
});
