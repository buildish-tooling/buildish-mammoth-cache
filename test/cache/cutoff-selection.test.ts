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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { captureCacheMetadataSnapshot, type CacheMetadataSnapshot } from '../../src/cache/manifest';
import type { CacheModel } from '../../src/cache/model';
import { selectCutoffActivity, fingerprintMetadata } from '../../src/cache/cutoff-selection';
import { cutoffManifestSchema } from '../../src/cache/cutoff-format';
import * as fsUtil from '../../src/util/fs';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
const old = 1700000000000,
  cutoff = old + 30 * 86400_000;
function snapshot(): CacheMetadataSnapshot {
  return {
    buildToolId: 'test',
    cacheRoot: '/cache',
    partitions: [
      {
        partitionId: 'data',
        entries: ['changed', 'equal', 'imported', 'read', 'stale', 'worker-used'].map(
          (relativePath, i) => ({
            relativePath,
            size: 1,
            atimeMs: relativePath === 'read' ? cutoff + 1 : old,
            mtimeMs: old,
            identity: {
              dev: 1,
              ino: i,
              mode: 33188,
              size: 1,
              atimeMs: relativePath === 'read' ? cutoff + 1 : old,
              mtimeMs: old,
              ctimeMs:
                relativePath === 'changed' ? cutoff + 1 : relativePath === 'equal' ? cutoff : old,
            },
          }),
        ),
      },
    ],
  };
}
describe('cutoff metadata contracts', () => {
  it('rejects Maven sibling ownership across snapshot publication units before expansion', () => {
    const input = snapshot(),
      entries = input.partitions[0]!.entries;
    const mixed = {
      ...input,
      buildToolId: 'maven',
      partitions: [
        {
          partitionId: 'data',
          entries: [{ ...entries[0]!, relativePath: 'repository/g/a/1/a.jar' }],
        },
        {
          partitionId: 'metadata',
          entries: [{ ...entries[1]!, relativePath: 'repository/g/a/1/_remote.repositories' }],
        },
      ],
    };
    const policy = {
      id: 'metadata',
      publication: 'single-writer',
    } as CacheModel['partitions'][number];
    expect(() =>
      selectCutoffActivity(
        mixed,
        cutoff,
        cutoff + 100,
        14,
        true,
        { upserts: [], used: [] },
        [policy],
        [],
      ),
    ).toThrow(/cannot span single-writer/);
  });
  it('distinguishes absent and empty snapshots and rejects partial usage snapshots', () => {
    const manifest = (p: object) => ({
      schemaVersion: 5,
      buildToolId: 'test',
      partitions: [{ partitionId: 'data', upserts: [], usedPaths: [], ...p }],
    });
    expect(cutoffManifestSchema.parse(manifest({})).partitions[0]!.snapshot).toBeUndefined();
    expect(cutoffManifestSchema.parse(manifest({ snapshot: true })).partitions[0]!.snapshot).toBe(
      true,
    );
    expect(cutoffManifestSchema.safeParse(manifest({ snapshot: false })).success).toBe(false);
    expect(
      cutoffManifestSchema.safeParse(manifest({ snapshot: true, usedPaths: ['data/a'] })).success,
    ).toBe(false);
  });
  it('selects preserved-mtime changes, tied timestamps, used-only paths and GC in the same observation', () => {
    const result = selectCutoffActivity(snapshot(), cutoff, cutoff + 100, 14, true, {
      upserts: ['imported'],
      used: ['worker-used', 'missing'],
    });
    expect(result.upserts.map((e) => e.relativePath)).toEqual(['changed', 'equal', 'imported']);
    expect(result.used).toEqual(['read', 'worker-used']);
    expect(result.gc.map((e) => e.relativePath)).toEqual(['stale']);
    expect(result.fileCount).toBe(6);
    expect(result.byteCount).toBe(6);
    expect(selectCutoffActivity(snapshot(), cutoff, cutoff + 100, 14, false).gc).toEqual([]);
  });
  it('explicitly permits clock/coalescing misses and hashes metadata independently of own atime', () => {
    const state = snapshot(),
      fingerprint = fingerprintMetadata(state);
    for (const e of state.partitions[0]!.entries) {
      Object.assign(e, { atimeMs: e.atimeMs + 100 });
      e.identity.atimeMs += 100;
    }
    expect(fingerprintMetadata(state)).toBe(fingerprint);
    state.partitions[0]!.entries[0]!.identity.ctimeMs += 0.25;
    expect(fingerprintMetadata(state)).not.toBe(fingerprint);
    expect(selectCutoffActivity(state, cutoff + 1000, cutoff + 2000, 14, true).upserts).toEqual([]);
    expect(selectCutoffActivity(state, old - 1, cutoff, 14, true).upserts).toHaveLength(6);
  });
  it('rejects old/deletion/precondition/native fields and reserved or duplicate paths', () => {
    const valid = {
      schemaVersion: 5,
      buildToolId: 'test',
      partitions: [
        {
          partitionId: 'data',
          upserts: [
            {
              relativePath: 'a',
              payloadPath: 'payload/000001.bin',
              contentSha256: 'a'.repeat(64),
              size: 1,
              mode: 420,
              mtimeMs: 1.999,
            },
          ],
          usedPaths: [],
        },
      ],
    };
    expect(cutoffManifestSchema.parse(valid).partitions[0]!.upserts[0]!.mtimeMs).toBe(1);
    for (const name of ['previous', 'deleted', 'identity'])
      expect(cutoffManifestSchema.safeParse({ ...valid, [name]: [] }).success).toBe(false);
    expect(cutoffManifestSchema.safeParse({ ...valid, schemaVersion: 2 }).success).toBe(false);
    expect(
      cutoffManifestSchema.safeParse({
        ...valid,
        partitions: [{ partitionId: 'data', upserts: [], usedPaths: ['.MAMMOTH. /local'] }],
      }).success,
    ).toBe(false);
    expect(
      cutoffManifestSchema.safeParse({
        ...valid,
        partitions: [
          { ...valid.partitions[0], usedPaths: ['.mammoth/cutoff-state-v1/state.json'] },
        ],
      }).success,
    ).toBe(false);
    expect(
      cutoffManifestSchema.safeParse({
        ...valid,
        partitions: [...valid.partitions, ...valid.partitions],
      }).success,
    ).toBe(false);
  });
  it('captures native identities without reading content and excludes the reserved namespace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cutoff-meta-'));
    roots.push(root);
    await mkdir(path.join(root, '.mammoth/cutoff-state-v1'), { recursive: true });
    await writeFile(path.join(root, 'artifact'), 'bytes');
    await writeFile(path.join(root, '.mammoth/cutoff-state-v1/state.json'), 'local');
    const hash = vi
      .spyOn(fsUtil, 'hashStableFileSha256')
      .mockRejectedValue(new Error('unexpected content read'));
    const model = {
      cacheRoot: root,
      buildToolId: 'test',
      partitions: [{ id: 'data', relativeIncludeGlobs: ['**'], relativeExcludeGlobs: [] }],
    } as unknown as CacheModel;
    const captured = await captureCacheMetadataSnapshot(model);
    expect(captured.partitions[0]!.entries.map((e) => e.relativePath)).toEqual(['artifact']);
    expect(captured.partitions[0]!.entries[0]!.identity.ctimeMs).toBeGreaterThan(0);
    expect(hash).not.toHaveBeenCalled();
  });
});
