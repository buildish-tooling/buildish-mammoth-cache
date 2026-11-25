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

import { directoryBreadthError } from './tree-state';
import { workspaceRoot, workspaceKind } from '../immutable-workspaces';
import type { Value } from './encoding';
import type { ResolvedModel } from './model';
import type { InstallScratch } from './install-scratch';
import {
  indexedNode,
  indexedEntries,
  nodeIsIntact,
  nodeMask,
  partitionBit,
  type IndexedNode,
} from './install-index';
import { compareName } from './tree-state';

export type InstallUnit = readonly [string, string, string];

// candidate, operation/branch, logicalPath, desired/native kind, partition index,
// source node/current node, complete semantic unit, children byte span
export type Selection = readonly [
  'candidate',
  'operation' | 'branch',
  string,
  'file' | 'directory',
  number,
  number | null,
  number | null,
  InstallUnit | null,
  number,
  number,
];

export interface DesiredIndex {
  readonly partition: number;
  readonly root: number;
}

/** One bounded postorder page; no NativeN records retained across directory width. */
export async function selectionPage(
  scratch: InstallScratch,
  tail: number | null,
  token: symbol,
  signal: AbortSignal,
): Promise<readonly [number, number]> {
  const edges: { name: string; offset: number; oldKind: Value; kind: Value }[] = [];
  let charge = 0;
  try {
    while (tail !== null) {
      signal.throwIfAborted();
      const row = await scratch.record(tail);
      try {
        const v = row.value as readonly Value[],
          name = Buffer.from(String(v[2])).toString('utf8'),
          bytes = 128 + 4 * Buffer.byteLength(name);
        scratch.budget.retain(bytes);
        charge += bytes;
        edges.push({ name, offset: Number(v[3]), oldKind: v[4], kind: v[5] });
        tail = v[1] as number | null;
      } finally {
        row.release();
      }
    }
    edges.sort((a, b) => compareName(a.name, b.name));
    const start = scratch.position;
    for (const edge of edges) {
      signal.throwIfAborted();
      await scratch.append(['selected', edge.name, edge.offset, edge.oldKind, edge.kind], token);
    }
    return [start, scratch.position];
  } finally {
    scratch.budget.release(charge);
  }
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#install-batches-and-recovery.
// Both frozen inventories are complete before this join: ownership summaries allow
// selection/coarsening BEFORE old-body hashing, with no speculative live changes.
export async function selectInstall(
  scratch: InstallScratch,
  model: ResolvedModel,
  currentRoot: number,
  desired: readonly DesiredIndex[],
  signal = new AbortController().signal,
  maxDirectoryEntries = 100000,
  pruneAggregates = false,
): Promise<number | null> {
  if (
    desired.length > model.partitions.length ||
    new Set(desired.map((d) => d.partition)).size !== desired.length ||
    desired.some(
      (d) =>
        !Number.isSafeInteger(d.partition) ||
        d.partition < 0 ||
        d.partition >= model.partitions.length,
    )
  ) {
    throw new Error('Invalid desired partition contexts.');
  }
  if (!Number.isSafeInteger(maxDirectoryEntries) || maxDirectoryEntries < 1) {
    throw new Error('Invalid output directory allowance.');
  }
  const claim = scratch.claim();
  const replacementMask = desired.reduce(
    (mask, d) =>
      pruneAggregates || model.partitions[d.partition][3] === 'single-writer'
        ? mask | partitionBit(model, model.partitions[d.partition][0])
        : mask,
    0n,
  );
  const partition = (mask: bigint) => {
    for (let i = 0; i < model.partitions.length; i++) {
      if (mask === 1n << BigInt(i)) {
        return i;
      }
    }
    return -1;
  };
  const unit = (
    p: number,
    path: string,
    kind: 'file' | 'directory',
    workspace: InstallUnit | null,
    direct: InstallUnit | null,
  ): InstallUnit =>
    model.partitions[p][3] === 'single-writer'
      ? ['snapshot', model.partitions[p][0], 'partition']
      : (workspace ??
        direct ?? [
          kind === 'file' ? 'file' : 'empty-directory',
          path,
          kind === 'file' ? 'file' : 'subtree',
        ]);
  async function visit(
    path: string,
    oldOffset: number | null,
    incoming: readonly { partition: number; offset: number }[],
    workspace: InstallUnit | null,
    direct: InstallUnit | null,
  ): Promise<number | null> {
    signal.throwIfAborted();
    const held: { release: () => void }[] = [];
    try {
      const oldLease = oldOffset === null ? null : await indexedNode(scratch, oldOffset);
      if (oldLease) {
        held.push(oldLease);
      }
      const old = oldLease?.node ?? null;
      const sources: { partition: number; offset: number; node: IndexedNode }[] = [];
      for (const source of incoming) {
        const lease = await indexedNode(scratch, source.offset);
        held.push(lease);
        sources.push({ ...source, node: lease.node });
      }
      if (
        !sources.length &&
        old &&
        !workspace &&
        !direct &&
        (nodeMask(old) & replacementMask) === 0n
      ) {
        return null;
      }
      const files = sources.filter((s) => s.node[1] === 'file'),
        dirs = sources.filter((s) => s.node[1] === 'directory');
      if (files.length > 1 || (files.length && dirs.length)) {
        throw new Error('Selected desired file/directory collision.');
      }
      if (old?.[1] === 'protected' && sources.length) {
        throw new Error('Selected outcome overlaps protected native entry.');
      }
      if (
        sources.some((source) => nodeIsIntact(source.node)) &&
        (old || sources.length !== 1 || dirs.length !== 1 || pruneAggregates)
      ) {
        throw new Error('Intact source directory is no longer eligible.');
      }
      const mask = sources.reduce((m, s) => m | nodeMask(s.node), 0n),
        single = partition(mask);
      let scope = workspace;
      if (
        path &&
        (dirs.some((s) => model.partitions[s.partition][3] === 'aggregate') ||
          (pruneAggregates && old?.[1] === 'directory')) &&
        model.tuple[2] === 'gradle' &&
        workspaceRoot(path) === path
      ) {
        let jar = false;
        for (const node of [
          ...dirs.map((s) => s.node),
          ...(pruneAggregates && old?.[1] === 'directory' ? [old] : []),
        ]) {
          if (nodeIsIntact(node)) {
            jar ||= node[11] === 'intact-jars';
          } else {
            for await (const child of indexedEntries(scratch, node)) {
              if (
                child[1] === 'file' &&
                (child[0] === 'classes.jar' || child[0] === 'sources.jar')
              ) {
                jar = true;
              }
            }
          }
        }
        scope = [workspaceKind(path, jar ? [path + '/classes.jar'] : []), path, 'subtree'];
      }
      let directHere: InstallUnit | null = null;
      if (model.tuple[2] === 'maven' && (path === 'repository' || path.startsWith('repository/'))) {
        for (const source of dirs) {
          if (model.partitions[source.partition][3] === 'aggregate') {
            for await (const child of indexedEntries(scratch, source.node)) {
              if (child[1] === 'file') {
                directHere = ['maven-directory', path, 'direct'];
                break;
              }
            }
          }
        }
      }
      if (
        pruneAggregates &&
        old?.[1] === 'directory' &&
        model.tuple[2] === 'maven' &&
        (path === 'repository' || path.startsWith('repository/')) &&
        directHere === null
      ) {
        for await (const child of indexedEntries(scratch, old)) {
          if (child[1] === 'file') {
            directHere = ['maven-directory', path, 'direct'];
            break;
          }
        }
      }
      const appendOp = async (
        p: number,
        source: number | null,
        previous: number | null,
        kind: 'file' | 'directory',
        u: InstallUnit,
      ) =>
        scratch.append(
          ['candidate', 'operation', path, kind, p, source, previous, u, 0, 0],
          claim.token,
        );
      const physicalOld = (p: number) =>
        old !== null && old[1] !== 'protected' && old[6] === 0 && nodeMask(old) === 1n << BigInt(p);
      if (files.length) {
        const source = files[0],
          p = source.partition;
        if (old && !physicalOld(p)) {
          throw new Error('Replacement preimage is not wholly owned by selected partition.');
        }
        return appendOp(p, source.offset, oldOffset, 'file', unit(p, path, 'file', scope, direct));
      }
      if (path && single >= 0 && dirs.length === 1 && sources.length === 1) {
        const p = single,
          source = dirs[0],
          snapshot = model.partitions[p][3] === 'single-writer';
        if (!old && !snapshot && scope === null && source.node[6] === 0) {
          return appendOp(p, source.offset, null, 'directory', ['directory', path, 'subtree']);
        }
        if ((snapshot || scope !== null) && (!old || physicalOld(p))) {
          return appendOp(
            p,
            source.offset,
            oldOffset,
            'directory',
            unit(p, path, 'directory', scope, null),
          );
        }
        if (
          scope === null &&
          source.node[7] === source.node[8] &&
          model.partitions[p][3] === 'aggregate'
        ) {
          if (old?.[1] === 'directory' && !pruneAggregates) {
            return null;
          }
          if (old?.[1] !== 'directory') {
            if (old && !physicalOld(p)) {
              throw new Error('Empty directory presence cannot replace protected preimage.');
            }
            return appendOp(p, source.offset, oldOffset, 'directory', [
              'empty-directory',
              path,
              'subtree',
            ]);
          }
        }
      }
      if (!sources.length && old) {
        const p = partition(nodeMask(old));
        const authoritative =
          p >= 0 &&
          ((replacementMask & (1n << BigInt(p))) !== 0n ||
            (model.partitions[p][3] === 'aggregate' &&
              (scope !== null || (old[1] === 'file' && direct !== null))));
        if (
          path &&
          authoritative &&
          physicalOld(p) &&
          (old[1] === 'file' || model.partitions[p][3] === 'single-writer' || scope !== null)
        ) {
          return appendOp(
            p,
            null,
            oldOffset,
            old[1] as 'file' | 'directory',
            unit(p, path, old[1] as 'file' | 'directory', scope, direct),
          );
        }
        if (old[1] !== 'directory') {
          return null;
        }
      }
      if (old && old[1] !== 'directory' && dirs.length) {
        throw new Error('Structural shape replacement escapes a complete selected unit.');
      }
      // Name-order merge uses one page frontier per input, not width×producer records.
      const readers: {
        source: number;
        iterator: AsyncGenerator<readonly [string, IndexedNode[1], number]>;
        head: IteratorResult<readonly [string, IndexedNode[1], number]>;
      }[] = [];
      let tail: number | null = null,
        count = 0,
        outputCount = 0,
        aliasCharge = 0;
      const aliases = new Set<string>();
      try {
        if (old?.[1] === 'directory') {
          const iterator = indexedEntries(scratch, old);
          readers.push({ source: -1, iterator, head: await iterator.next() });
        }
        for (const source of dirs) {
          const iterator = indexedEntries(scratch, source.node);
          readers.push({ source: source.partition, iterator, head: await iterator.next() });
        }
        while (readers.some((r) => !r.head.done)) {
          signal.throwIfAborted();
          const name = readers
            .filter((r) => !r.head.done)
            .map((r) => r.head.value![0])
            .sort(compareName)[0];
          if (process.platform === 'win32' || process.platform === 'darwin') {
            // Conservative native collision profile: never let two binary-distinct
            // paths alias during a case/normalization-sensitive sequence of moves.
            const key =
              process.platform === 'darwin'
                ? name.normalize('NFD').toUpperCase()
                : name.toUpperCase();
            if (aliases.has(key)) {
              throw new Error('Native case/normalization path alias.');
            }
            const charge = 64 + 4 * Buffer.byteLength(key);
            scratch.budget.retain(charge);
            aliasCharge += charge;
            aliases.add(Buffer.from(key).toString());
          }
          let previous: number | null = null,
            previousKind: Value = null,
            desiredKind: Value = null;
          const children: { partition: number; offset: number }[] = [];
          for (const reader of readers) {
            if (!reader.head.done && reader.head.value[0] === name) {
              if (reader.source === -1) {
                previous = reader.head.value[2];
                previousKind = reader.head.value[1];
              } else {
                children.push({ partition: reader.source, offset: reader.head.value[2] });
                desiredKind = reader.head.value[1];
              }
            }
          }
          const childPath = path ? path + '/' + name : name;
          const child = await visit(childPath, previous, children, scope, directHere);
          let survives = children.length > 0 || previous !== null;
          if (child !== null && children.length === 0) {
            const record = await scratch.record(child);
            try {
              const selected = record.value as Selection;
              if (selected[1] === 'operation' && selected[5] === null) {
                survives = false;
              }
            } finally {
              record.release();
            }
          }
          if (survives && ++outputCount > maxDirectoryEntries) {
            throw directoryBreadthError(path, maxDirectoryEntries, 'install selection');
          }
          if (child !== null) {
            tail = await scratch.append(
              ['selected-edge', tail, name, child, previousKind, desiredKind ?? previousKind],
              claim.token,
            );
            count++;
          }
          for (const reader of readers) {
            if (!reader.head.done && reader.head.value[0] === name) {
              reader.head = await reader.iterator.next();
            }
          }
        }
      } finally {
        try {
          for (const reader of readers) {
            await reader.iterator.return(undefined);
          }
        } finally {
          aliases.clear();
          scratch.budget.release(aliasCharge);
        }
      }
      if (!count) {
        return null;
      }
      const [start, end] = await selectionPage(scratch, tail, claim.token, signal);
      return scratch.append(
        ['candidate', 'branch', path, 'directory', -1, null, oldOffset, null, start, end],
        claim.token,
      );
    } finally {
      for (const lease of held) {
        lease.release();
      }
    }
  }
  try {
    const result = await visit(
      '',
      currentRoot,
      desired.map((d) => ({ partition: d.partition, offset: d.root })),
      null,
      null,
    );
    signal.throwIfAborted();
    return result;
  } finally {
    claim.release();
  }
}
