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

import type { DependencyLayerPolicy } from '../lifecycle-types';
import { cacheInvocationSeedPrefix } from '../../cache/metadata-paths';
import { randomUUID } from 'node:crypto';
import { rename, mkdir } from 'node:fs/promises';
import { equal } from '../../cache/streaming/encoding';
import type { LocalOptions } from '../../cache/streaming/local-schema';
import {
  dependencyLayerSchema,
  type DependencyLayer,
} from '../../cache/streaming/dependency-layer-descriptor';
import {
  IndexDirectories,
  indexedEntries,
  nodeIsIntact,
  nodeMask,
  partitionBit,
} from '../../cache/streaming/install-index';
import { InstallParentPhase } from '../../cache/streaming/install-parent-phase';
import {
  sameNative,
  sameRename,
  sameObject,
  type NativeIdentity,
} from '../../cache/streaming/native';
import { retireOwnedDirectory } from '../../cache/streaming/owned-retirement';
import { ownsLocalSnapshot, type ResolvedModel } from '../../cache/streaming/model';
import type { MetadataBaseRestore } from '../../cache/streaming/metadata-base-restore';
import type { IndexedMetadataInput } from '../../cache/streaming/metadata-install-context';
import type { OwnedStore } from '../../cache/streaming/owned-store';
import type { NativeOperationOptions } from '../../cache/streaming/native-operation';

export const GRADLE_MODULES = 'caches/modules-2';
export const GRADLE_ARTIFACTS = GRADLE_MODULES + '/files-2.1';

const METADATA = /^metadata-[^/]+$/u;

export function gradleLayerCandidate(
  model: ResolvedModel,
  options: Pick<LocalOptions, 'role' | 'access' | 'context'>,
  cleanup: string,
): boolean {
  return (
    ['linux', 'darwin', 'win32'].includes(process.platform) &&
    model.tuple[2] === 'gradle' &&
    model.dependencyCacheLayer &&
    options.role === 'distributed-worker' &&
    options.access === 'writable' &&
    cleanup === 'none' &&
    !model.partitions.some((p) => ownsLocalSnapshot(p, options))
  );
}
export function gradleSeedPath(store: OwnedStore, descriptor: DependencyLayer): string {
  return store.root.resolve(descriptor[2] + '/caches');
}
export function checkGradleSeed(
  store: OwnedStore,
  descriptor: DependencyLayer,
  key: string | null,
): void {
  dependencyLayerSchema(store.codec.options.invocation).parse(descriptor);
  if (
    !gradleLayerCandidate(store.codec.options.model, store.codec.options, 'none') ||
    descriptor[4] !== key
  ) {
    throw new Error('Gradle seed owner/generation mismatch.');
  }
  const ids = [descriptor[5], descriptor[6]];
  if (
    store.codec.options.model.partitions.find((p) => p[0] === ids[0])?.[3] !== 'aggregate' ||
    store.codec.options.model.partitions.find((p) => p[0] === ids[1])?.[3] !== 'single-writer' ||
    new Set(ids).size !== 2 ||
    ids.some((id) => !store.codec.options.model.partitions.some((p) => p[0] === id && p[6] === 1))
  ) {
    throw new Error('Gradle seed partition mismatch.');
  }
}
export async function validateGradleSeedOwner(
  store: OwnedStore,
  descriptor: DependencyLayer,
): Promise<void> {
  dependencyLayerSchema(store.codec.options.invocation).parse(descriptor);
  const actual = await store.root.stat(descriptor[2]);
  if (
    !actual ||
    !sameObject(actual, descriptor[3]) ||
    actual[6] !== descriptor[3][6] ||
    actual[3] !== store.root.binding[3]
  ) {
    throw new Error(
      'Gradle seed owner missing or changed; retained at ' + gradleSeedPath(store, descriptor),
    );
  }
}
export async function retireGradleSeed(
  store: OwnedStore,
  descriptor: DependencyLayer,
  options: NativeOperationOptions,
): Promise<void> {
  const actual = await store.root.stat(descriptor[2]);
  if (!actual) {
    return;
  }
  if (
    !sameObject(actual, descriptor[3]) ||
    actual[6] !== descriptor[3][6] ||
    actual[3] !== store.root.binding[3]
  ) {
    throw new Error('Gradle seed owner changed; retained at ' + gradleSeedPath(store, descriptor));
  }
  await retireOwnedDirectory(store, descriptor[2], actual, options.budget, 'seed-member-retired');
}
type Selection = { input: IndexedMetadataInput; path: string; native: NativeIdentity };

/** Check every layout/cohort before assigning any source or moving any byte. */
export async function gradleDependencySources(
  store: OwnedStore,
  restored: MetadataBaseRestore,
): Promise<Selection[] | undefined> {
  const model = store.codec.options.model,
    context = restored.context,
    generation = restored.generation;
  if (!context || !generation || !restored.key) {
    return undefined;
  }
  const eligible = model.partitions.filter((p) => p[6] === 1);
  if (eligible.length !== 2) {
    return undefined;
  }
  const artifact = eligible.find(
    (p) => p[3] === 'aggregate' && p[1].length === 1 && p[1][0] === GRADLE_ARTIFACTS + '/**',
  );
  const metadata = eligible.find(
    (p) =>
      p[3] === 'single-writer' &&
      p[1].length === 1 &&
      (p[1][0] === GRADLE_MODULES + '/metadata-*/**' ||
        (p[1][0].startsWith(GRADLE_MODULES + '/') &&
          p[1][0].endsWith('/**') &&
          METADATA.test(p[1][0].slice(GRADLE_MODULES.length + 1, -3)))),
  );
  if (!artifact || !metadata) {
    return undefined;
  }
  const selected: Selection[] = [];
  for (const [partition, path] of [
    [metadata, GRADLE_MODULES],
    [artifact, GRADLE_ARTIFACTS],
  ] as const) {
    if (
      partition[5] !== 'default' ||
      partition[2].length !== model.tuple[3].length ||
      !partition[2].every((g, i) => g === model.tuple[3][i])
    ) {
      return undefined;
    }
    const entry = restored.entries.find((e) => e[1] === partition[0]),
      input = context.source(partition[0]);
    const original = generation[8].find((e) => e[1] === partition[0]);
    if (
      entry?.[2] !== 'available' ||
      !input ||
      input.upstream.kind !== 'native-metadata' ||
      original?.[0] !== 'object'
    ) {
      return undefined;
    }
    input.assertBound(store);
    equal(input.upstream.source.reference, original[2], 'exact seed object');
    const directories = new IndexDirectories(context.scratch, input.index);
    try {
      // Check only the partition boundaries. Gradle chooses which metadata format to consume.
      for (const [parent, name] of [
        ['', 'caches'],
        ['caches', 'modules-2'],
      ] as const) {
        const node = await directories.directory(parent);
        if (!node || node[6] !== 0 || nodeIsIntact(node)) {
          return undefined;
        }
        let count = 0;
        for await (const edge of indexedEntries(context.scratch, node)) {
          if (++count !== 1 || edge[0] !== name || edge[1] !== 'directory') {
            return undefined;
          }
        }
        if (count !== 1) {
          return undefined;
        }
      }
      const modules = await directories.directory(GRADLE_MODULES);
      if (!modules || modules[6] !== 0 || nodeIsIntact(modules)) {
        return undefined;
      }
      let count = 0;
      for await (const edge of indexedEntries(context.scratch, modules)) {
        if (
          edge[1] !== 'directory' ||
          (path === GRADLE_MODULES ? !METADATA.test(edge[0]) : edge[0] !== 'files-2.1')
        ) {
          return undefined;
        }
        count++;
      }
      if (!count || (path === GRADLE_ARTIFACTS && count !== 1)) {
        return undefined;
      }
      const node = path === GRADLE_MODULES ? modules : await directories.directory(path);
      if (!node || node[6] !== 0 || nodeMask(node) !== partitionBit(model, partition[0])) {
        return undefined;
      }
      selected.push({ input, path, native: [...(node[3] as NativeIdentity)] });
    } finally {
      directories.close();
    }
  }
  return selected;
}
/** Private owner until the successful handoff, hooks and final host activation complete. */
export async function installGradleSeed(
  store: OwnedStore,
  restored: MetadataBaseRestore,
  options: NativeOperationOptions,
): Promise<DependencyLayer | undefined> {
  const selected = await gradleDependencySources(store, restored);
  if (!selected) {
    return undefined;
  }
  const root = cacheInvocationSeedPrefix(store.codec.options.invocation) + randomUUID();
  let descriptor: DependencyLayer | undefined;
  const phases: InstallParentPhase[] = [],
    indexes: IndexDirectories[] = [];
  try {
    await store.makeParents(root);
    await mkdir(store.root.resolve(root));
    store.root.work.directoryCreations++;
    descriptor = [
      'gradle-layer',
      1,
      root,
      (await store.root.stat(root))!,
      restored.key!,
      selected[1].input.partition,
      selected[0].input.partition,
      null,
    ];
    await store.makeParents(root + '/caches/pending');
    for (let i = 0; i < selected.length; i++) {
      await store.makeParents(root + '/control/source-' + i + '/pending');
    }
    await store.makeParents(root + '/control/target/pending');
    const targetFacts = new Map<string, NativeIdentity>();
    for (const path of [root, root + '/caches']) {
      targetFacts.set(path, (await store.root.stat(path))!);
    }
    const target = new InstallParentPhase(
      store,
      root,
      root + '/control/target/',
      options.budget,
      async (p) => targetFacts.get(p) ?? null,
    );
    phases.push(target);
    await restored.context!.routeSeed(
      selected.map((s) => s.input.partition),
      async (inputs) => {
        for (const [i, selection] of selected.entries()) {
          if (inputs[i] !== selection.input) {
            throw new Error('Seed receipt changed during routing.');
          }
          const { input, path, native } = selection,
            directory = new IndexDirectories(input.context.scratch, input.index);
          indexes.push(directory);
          const source = new InstallParentPhase(
            store,
            input.nativeRoot,
            root + '/control/source-' + i + '/',
            options.budget,
            async (p) => {
              const logical = p === input.nativeRoot ? '' : p.slice(input.nativeRoot.length + 1),
                node = await directory.directory(logical);
              return node ? (node[3] as NativeIdentity) : null;
            },
          );
          phases.push(source);
          const from = input.nativeRoot + '/' + path,
            to = root + '/' + path;
          await source.parents(from);
          await target.parents(to);
          const before = await source.stat(from);
          if (!before || !sameNative(before, native, true) || (await target.stat(to))) {
            throw new Error('Seed rename endpoints changed.');
          }
          options.signal?.throwIfAborted();
          await rename(store.root.resolve(from), store.root.resolve(to));
          store.root.work.renames++;
          await store.fail('seed-rename-before-stat');
          const after = await target.stat(to);
          if (!after || !sameRename(before, after)) {
            throw new Error('Seed rename identity changed.');
          }
          if (path === GRADLE_MODULES) {
            targetFacts.set(to, after);
          }
          await source.changed(from);
          await target.changed(to);
          await source.barrier();
        }
        await target.barrier();
      },
    );
    await store.fail('seed-before-owner-seal');
    await store.fail('prepare-seed-installed');
    // Contents changed during staging; the original directory identity/mode/device may not.
    await validateGradleSeedOwner(store, descriptor);
    return descriptor;
  } catch (error) {
    for (const phase of phases) {
      phase.release();
    }
    if (descriptor) {
      try {
        await retireGradleSeed(store, descriptor, options);
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'Private Gradle seed retained at ' + gradleSeedPath(store, descriptor),
          { cause: cleanup },
        );
      }
    } else if (await store.root.stat(root)) {
      throw new AggregateError(
        [error],
        'Unresolved private Gradle seed retained at ' + store.root.resolve(root),
        { cause: error },
      );
    }
    throw error;
  } finally {
    for (const phase of phases) {
      phase.release();
    }
    for (const directory of indexes) {
      directory.close();
    }
  }
}

export const gradleDependencyLayer: DependencyLayerPolicy = {
  assertInputs(model, owner, cleanup, inputs) {
    if (gradleLayerCandidate(model, owner, cleanup) && inputs.existingDependencyLayer?.length) {
      throw new Error(
        'GRADLE_RO_DEP_CACHE is already set. Remove the conflicting value or disable dependency-cache-layer.',
      );
    }
  },
  async prepare(store, restored, cleanup, inputs, options) {
    if (
      gradleLayerCandidate(store.codec.options.model, store.codec.options, cleanup) &&
      inputs.hasWrapper?.()
    ) {
      return installGradleSeed(store, restored, options);
    }
  },
  check: checkGradleSeed,
  verify: validateGradleSeedOwner,
  retire: retireGradleSeed,
  path: gradleSeedPath,
};
