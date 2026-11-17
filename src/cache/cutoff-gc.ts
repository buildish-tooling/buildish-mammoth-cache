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
import { rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { guardedPath, regularStat, verifyParents } from './guarded-files';
import { fileIdentity, sameFileIdentity } from './file-identity';
import { persistCutoffJournal, cutoffGcEnabled, type CutoffJournal } from './cutoff-state';
import type { TimestampCacheGcResult } from './gc';

/** Execute only the frozen plan; never reclassify after Mammoth's own reads. */
export async function collectCutoffGarbage(
  state: CutoffJournal,
): Promise<TimestampCacheGcResult | null> {
  if (!cutoffGcEnabled(state.policy)) return null;
  if (!state.selection || state.observedAt === null)
    throw new Error('GC requires frozen decisions.');
  if (state.phase !== 'completed' && state.phase !== 'publication-intent') {
    state.phase = 'deleting';
    await persistCutoffJournal(state);
  }
  const progress = new Set(state.deletedPaths);
  for (const target of state.selection.gc) {
    await verifyParents(state.model.cacheRoot, path.posix.dirname(target.relativePath));
    const file = guardedPath(state.model.cacheRoot, target.relativePath);
    const current = await regularStat(file);
    if (current) {
      if (
        progress.has(target.relativePath) ||
        !sameFileIdentity(target.identity, fileIdentity(current), true)
      )
        throw new Error(`Frozen GC target changed: ${target.relativePath}`);
      await rm(file);
    }
    if (!progress.has(target.relativePath)) {
      progress.add(target.relativePath);
    }
    let parent = path.dirname(file);
    while (parent !== state.model.cacheRoot) {
      try {
        await rmdir(parent);
      } catch (e) {
        if (
          e &&
          typeof e === 'object' &&
          'code' in e &&
          ['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String(e.code))
        )
          break;
        throw e;
      }
      parent = path.dirname(parent);
    }
  }
  // The frozen plan already permits missing targets on replay. Checkpoint the whole sweep
  // once, rather than rewriting and syncing that complete plan after every unlink.
  if (progress.size !== state.deletedPaths.length) {
    const completed = { ...state, deletedPaths: [...progress].sort() };
    await persistCutoffJournal(completed);
    Object.assign(state, completed);
  }
  const deletedByteCount = state.selection.gc.reduce(
    (n, e) => n + (progress.has(e.relativePath) ? e.identity.size : 0),
    0,
  );
  return {
    mode: 'timestamp',
    cutoffTimeMs: state.observedAt - state.policy.cacheGcOlderThanDays * 86400000,
    scannedFileCount: state.selection.fileCount,
    deletedFileCount: progress.size,
    deletedByteCount,
    keptFileCount: state.selection.fileCount - progress.size,
    message: `Cutoff GC deleted ${progress.size} old, unprotected managed file(s).`,
  };
}
