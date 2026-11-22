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

import { sameNative, type NativeIdentity } from './native';
import type { Value } from './encoding';
import { encodeRecord, add } from './encoding';
import { LocalStreamGrammar } from './local-stream';
import type { OwnedStore, Reference } from './owned-store';
import type { VerifiedIncoming } from './install-evidence';
import { nextEvidence } from './install-evidence';
import { InstallScratch } from './install-scratch';
import {
  indexedNode,
  indexedEntries,
  nodeMask,
  partitionBit,
  type IndexedNode,
} from './install-index';
import { selectionPage, type Selection } from './install-selection';
import { NativeReadPhase, NativeHashBuffer } from './native-read-phase';
import { compareMembership } from './tree-state';

export type CapturedSelection = readonly [...Selection, number, number];
export interface PreimageWork {
  hashedFiles: number;
  hashedBytes: number;
  trustedFiles: number;
}
// A producer receipt is process-local upstream evidence. JSON facts cannot replace it.
class TrustedCursor {
  private head: readonly Value[] | null | undefined;
  readonly rows;
  constructor(
    private readonly store: OwnedStore,
    readonly input: VerifiedIncoming,
    readonly scratch: InstallScratch,
    signal: AbortSignal,
    maxDirectoryEntries: number,
  ) {
    input.assertBound(store, input.partition, input.evidence, input.nativeRoot);
    this.rows = store.rows(
      input.evidence,
      'native-evidence',
      { budget: scratch.budget, partition: input.partition, maxDirectoryEntries },
      signal,
    );
  }
  private async next() {
    let row: Value | null;
    do {
      row = await nextEvidence(this.rows);
    } while (Array.isArray(row) && row[0] !== 'file');
    this.head = row as readonly Value[] | null;
  }
  async hash(path: string, native: NativeIdentity): Promise<string | null> {
    if (this.head === undefined) await this.next();
    while (
      this.head &&
      compareMembership(['member', 'file', String(this.head[1])], ['member', 'file', path]) < 0
    )
      await this.next();
    return this.head &&
      this.head[1] === path &&
      sameNative(this.head[2] as NativeIdentity, native, true)
      ? String(this.head[3])
      : null;
  }
  async finish() {
    while (this.head !== null) await this.next();
  }
  async close() {
    await this.rows.return(undefined as never);
  }
}

// Protocol: docs/dev/cache-lifecycle-protocol.md#install-batches-and-recovery.
// Hash only final, nonoverlapping old selectors. Active parent facts are carried
// through this phase, rather than restatting every ancestor for every leaf.
export async function captureInstallPreimages(
  store: OwnedStore,
  scratch: InstallScratch,
  root: number | null,
  trusted: readonly VerifiedIncoming[] = [],
  signal = new AbortController().signal,
  maxDirectoryEntries = 100000,
): Promise<{ root: number | null; references: (Reference | null)[]; work: PreimageWork }> {
  using hashes = new NativeHashBuffer(scratch.budget);
  const claim = scratch.claim(),
    model = store.codec.options.model,
    phase = new NativeReadPhase(store.root, '', hashes);
  const sinks: (InstallScratch | null)[] = model.partitions.map(() => null),
    refs: (Reference | null)[] = model.partitions.map(() => null);
  const trustedReaders: (TrustedCursor | null)[] = model.partitions.map(() => null),
    headerBytes: number[] = model.partitions.map(() => 0);
  const frames: { node: IndexedNode; emitted: bigint }[] = [];
  const work: PreimageWork = { hashedFiles: 0, hashedBytes: 0, trustedFiles: 0 };
  async function sink(p: number) {
    if (!sinks[p]) {
      sinks[p] = await InstallScratch.create(store, scratch.budget);
      const grammar = new LocalStreamGrammar('native-evidence', {
        codec: store.codec,
        budget: scratch.budget,
        partition: model.partitions[p][0],
      });
      try {
        headerBytes[p] = encodeRecord(grammar.header()).length;
      } finally {
        grammar.dispose();
      }
    }
    return sinks[p]!;
  }
  async function parents(p: number) {
    const bit = partitionBit(model, model.partitions[p][0]),
      output = await sink(p);
    for (const frame of frames)
      if (!(frame.emitted & bit)) {
        await output.append(['directory', frame.node[2], frame.node[3]]);
        frame.emitted |= bit;
      }
  }
  async function nativeTree(offset: number, p: number): Promise<void> {
    signal.throwIfAborted();
    const lease = await indexedNode(scratch, offset),
      node = lease.node;
    try {
      const output = await sink(p);
      if (node[6] !== 0 || nodeMask(node) !== partitionBit(model, model.partitions[p][0]))
        throw new Error('Selected preimage crosses physical ownership.');
      if (node[1] === 'protected') throw new Error('Protected member in selected preimage.');
      if (node[1] === 'file') {
        const native = node[3] as NativeIdentity,
          known = (await trustedReaders[p]?.hash(node[2], native)) ?? null;
        const sha = await phase.hash(node[2], native, known, signal);
        if (known !== null) work.trustedFiles++;
        else {
          work.hashedFiles++;
          work.hashedBytes = add(work.hashedBytes, Number(native[5]));
        }
        await output.append(['file', node[2], native, sha]);
      } else {
        await phase.enter(node[2], node[3] as NativeIdentity);
        await output.append(['directory', node[2], node[3]]);
        for (const kind of ['file', 'directory'])
          for await (const entry of indexedEntries(scratch, node))
            if (entry[1] === kind) await nativeTree(entry[2], p);
        await phase.leave(node[2], node[3] as NativeIdentity);
      }
    } finally {
      lease.release();
    }
  }
  async function visit(offset: number): Promise<number> {
    signal.throwIfAborted();
    const lease = await scratch.record(offset),
      node = lease.value as Selection;
    try {
      if (node[6] === null) return offset;
      if (node[1] === 'operation') {
        const p = node[4],
          output = await sink(p);
        await parents(p);
        const start = output.position + headerBytes[p];
        await nativeTree(node[6], p);
        const end = output.position + headerBytes[p];
        return scratch.append([...node, start, end], claim.token);
      }
      const old = await indexedNode(scratch, node[6]);
      try {
        await phase.enter(old.node[2], old.node[3] as NativeIdentity);
        frames.push({ node: old.node, emitted: 0n });
        let tail: number | null = null;
        for (const kind of ['file', 'directory', null])
          for await (const raw of scratch.rows(node[8], node[9])) {
            signal.throwIfAborted();
            const edge = raw as readonly Value[];
            if (edge[3] !== kind) continue;
            const child = await visit(Number(edge[2]));
            tail = await scratch.append(
              ['selected-edge', tail, edge[1], child, edge[3], edge[4]],
              claim.token,
            );
          }
        frames.pop();
        await phase.leave(old.node[2], old.node[3] as NativeIdentity);
        const [start, end] = await selectionPage(scratch, tail, claim.token, signal);
        return scratch.append([...node.slice(0, 8), start, end], claim.token);
      } finally {
        old.release();
      }
    } finally {
      lease.release();
    }
  }
  try {
    for (const input of trusted) {
      const p = model.partitions.findIndex((v) => v[0] === input.partition);
      if (p < 0 || trustedReaders[p])
        throw new Error('Duplicate/unknown trusted preimage projection.');
      trustedReaders[p] = new TrustedCursor(store, input, scratch, signal, maxDirectoryEntries);
    }
    const result = root === null ? null : await visit(root);
    for (const cursor of trustedReaders) await cursor?.finish();
    for (let p = 0; p < sinks.length; p++)
      if (sinks[p])
        refs[p] = await store.writeStream(
          'native-evidence',
          { budget: scratch.budget, partition: model.partitions[p][0], maxDirectoryEntries },
          sinks[p]!.rows(0, sinks[p]!.position),
          signal,
        );
    signal.throwIfAborted();
    return { root: result, references: refs, work };
  } finally {
    claim.release();
    await Promise.all([
      ...trustedReaders.filter((v): v is TrustedCursor => v !== null).map((v) => v.close()),
      ...sinks.filter((v): v is InstallScratch => v !== null).map((v) => v.close()),
    ]);
  }
}
