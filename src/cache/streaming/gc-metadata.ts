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

import { ObservationIndex } from './observation-index';
import type { Reference } from './owned-store';
import { equal, tuple, type Value } from './encoding';
import { isCacheMetadataPath } from '../metadata-paths';
import { isMavenTransientFile } from '../maven-repository';
import { isWorkspaceScaffolding, parentPath } from './tree-state';

interface Member {
  row: Value;
  optional: boolean;
  accept?: () => void;
}

// Protocol: docs/dev/cache-lifecycle-protocol.md#shared-gc-parent-projections.
// Exact ORIGINAL metadata membership, not current native/deletion/return authority.
export async function checkSharedGcMetadata(
  index: ObservationIndex,
  evidence: Reference,
): Promise<{ units: number; targets: number }> {
  ObservationIndex.assert(index);
  const store = index.store,
    options = index.options,
    signal = options.signal ?? new AbortController().signal;
  let context = false,
    expected: AsyncIterator<Member> | undefined,
    head: IteratorResult<Member> | undefined,
    units = 0,
    targets = 0;
  const begin = async (r: readonly Value[]) => {
    if (expected) throw new Error('Nested shared GC metadata unit.');
    expected = originalGcMembers(index, r)[Symbol.asyncIterator]();
    head = await expected.next();
    units++;
  };
  try {
    await store.readStream(
      evidence,
      'gc-evidence',
      { ...options, partition: null, gcMode: 'shared' },
      async (v) => {
        const r = tuple(v);
        if (r[0] === 'local-stream' || r[0] === 'local-end') return;
        if (r[0] === 'gc-context') {
          equal(r[1], index.reference, 'exact shared GC context');
          context = true;
          return;
        }
        if (!context) throw new Error('Missing shared GC context.');
        if (r[0] === 'gc-unit-open') {
          await begin(r);
          return;
        }
        if (!expected || !head) throw new Error('Missing GC metadata unit.');
        if (r[0] === 'gc-unit-close') {
          while (!head.done && head.value.optional) head = await expected.next();
          if (!head.done) throw new Error('Incomplete original GC membership.');
          await expected.return?.();
          expected = undefined;
          head = undefined;
          return;
        }
        while (
          !head.done &&
          head.value.optional &&
          !(tuple(head.value.row)[0] === r[0] && tuple(head.value.row)[1] === r[1])
        )
          head = await expected.next();
        if (head.done) throw new Error('Extra GC member.');
        equal(v, head.value.row, 'original GC member/projection');
        head.value.accept?.();
        if (r[0] === 'target') targets++;
        head = await expected.next();
      },
      signal,
    );
    if (expected) throw new Error('Incomplete GC metadata unit.');
    signal.throwIfAborted();
    return { units, targets };
  } finally {
    await expected?.return?.();
  }
}

/** Provisional original-unit metadata. Complete consumption/stream sealing is required. */
export async function* originalGcMembers(
  index: ObservationIndex,
  r: readonly Value[],
): AsyncGenerator<Member> {
  ObservationIndex.assert(index);
  const store = index.store;
  if (r[1] === 'file') {
    const file = await index.file(String(r[2]));
    try {
      if (file.node[6] !== 'delete') throw new Error('GC unit was retained.');
    } finally {
      file.release();
    }
    yield* expectedFile(String(r[2]));
  } else {
    const dir = await index.directory(String(r[2]));
    try {
      const u = dir.node[9];
      if (!u) throw new Error('Missing original GC unit.');
      equal([u[1], u[2], u[3], u[5]], [r[1], r[2], r[3], 'delete'], 'original complete GC unit');
    } finally {
      dir.release();
    }
    yield* expectedTree(String(r[2]), r[3] === 'direct');
  }
  async function* parent(path: string): AsyncGenerator<Member> {
    const p = await index.directory(path);
    try {
      yield {
        row: ['gc-parent', path, ['span', index.reference[4], p.node[3], p.node[4]]],
        optional: false,
      };
    } finally {
      p.release();
    }
  }
  async function* expectedFile(path: string): AsyncGenerator<Member> {
    yield* parent(parentPath(path));
    const f = await index.file(path);
    try {
      yield { row: ['target', path, f.node[3], f.node[2]], optional: false };
    } finally {
      f.release();
    }
  }
  async function* expectedTree(
    path: string,
    direct: boolean,
  ): AsyncGenerator<Member, { removed: boolean; owner: string | null }> {
    const lease = await index.directory(path),
      d = lease.node;
    try {
      yield* parent(d[1]);
      let cleanup = !direct && !isWorkspaceScaffolding(store.codec.options.model, path),
        owner: string | null = null;
      for await (const e of index.children(d)) {
        if (e[5] === null) {
          if (
            direct &&
            e[2] !== 'directory' &&
            !isCacheMetadataPath(path + '/' + e[1]) &&
            !isMavenTransientFile(e[1])
          )
            throw new Error('Incomplete Maven GC coordinate: protected artifact sibling.');
          cleanup = false;
          continue;
        }
        const child = await index.node(e[5]);
        try {
          if (child.node[0] === 'observed-file') {
            const f = child.node;
            if (f[6] !== 'delete') throw new Error('Partial GC selection in original unit.');
            yield { row: ['target', f[1], f[3], f[2]], optional: false };
            if (owner !== null && owner !== f[3]) cleanup = false;
            owner ??= f[3];
          } else if (!direct) {
            const result = yield* expectedTree(child.node[1], false);
            cleanup &&= result.removed;
            if (owner !== null && result.owner !== owner) cleanup = false;
            owner ??= result.owner;
          }
        } finally {
          child.release();
        }
      }
      if (owner === null) {
        try {
          owner = store.codec.options.model.owner(d[1] + '/.workspace-directory-probe')[0];
        } catch {
          cleanup = false;
        }
      }
      let removed = false;
      if (cleanup && owner !== null)
        yield {
          row: ['target', d[1], owner, d[2]],
          optional: true,
          accept: () => {
            removed = true;
          },
        };
      return { removed, owner };
    } finally {
      lease.release();
    }
  }
}
