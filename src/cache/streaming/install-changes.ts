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

import { abortableValues } from './abort';
import { compareName, baseName, parentPath } from './tree-state';
import type { Value } from './encoding';
import type { InstallScratch } from './install-scratch';

export type ChangeNode = readonly ['change-node', string, Value | null, number, number];
interface Frame {
  path: string;
  payload: Value | null;
  tail: number | null;
  release: () => void;
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#install-batches-and-recovery.
// One hierarchical route at a time; records/pages live in a shared disposable spool.
export async function buildChangeIndex(
  scratch: InstallScratch,
  changes: AsyncIterable<readonly [string, Value]>,
  signal = new AbortController().signal,
): Promise<number> {
  const claim = scratch.claim();
  const frames: Frame[] = [];
  function push(path: string) {
    if (frames.length >= 101) throw new Error('Change tree depth exceeded.');
    frames.push({
      path,
      payload: null,
      tail: null,
      release: scratch.budget.holdRecord(256 + Buffer.byteLength(path)),
    });
  }
  async function close(): Promise<number> {
    const frame = frames.pop()!;
    const children: { name: string; offset: number; release: () => void }[] = [];
    try {
      let at = frame.tail;
      while (at !== null) {
        signal.throwIfAborted();
        const row = await scratch.record(at);
        try {
          const r = row.value as readonly Value[];
          const name = String(r[1]);
          const charge = 128 + 4 * Buffer.byteLength(name);
          scratch.budget.retain(charge);
          children.push({
            name,
            offset: Number(r[2]),
            release: () => scratch.budget.release(charge),
          });
          at = r[3] === null ? null : Number(r[3]);
        } finally {
          row.release();
        }
      }
      children.sort((a, b) => compareName(a.name, b.name));
      const start = scratch.position;
      for (let i = 0; i < children.length; i++) {
        signal.throwIfAborted();
        if (i && children[i - 1].name === children[i].name)
          throw new Error('Repeated change subtree.');
        await scratch.append(['change-child', children[i].name, children[i].offset], claim.token);
      }
      const end = scratch.position;
      const offset = await scratch.append(
        ['change-node', frame.path, frame.payload, start, end],
        claim.token,
      );
      if (frames.length) {
        const parent = frames[frames.length - 1];
        parent.tail = await scratch.append(
          ['change-link', baseName(frame.path), offset, parent.tail],
          claim.token,
        );
      }
      return offset;
    } finally {
      frame.release();
      for (const child of children) child.release();
    }
  }
  try {
    push('');
    for await (const [path, payload] of abortableValues(changes, signal)) {
      signal.throwIfAborted();
      while (
        frames.length > 1 &&
        frames[frames.length - 1].path !== path &&
        !path.startsWith(frames[frames.length - 1].path + '/')
      )
        await close();
      const parts = path.split('/');
      let current = '';
      for (const part of parts) {
        current = current ? current + '/' + part : part;
        if (frames.some((f) => f.path === current)) continue;
        if (parentPath(current) !== frames[frames.length - 1].path)
          throw new Error('Nonhierarchical change route.');
        push(current);
      }
      const frame = frames[frames.length - 1];
      if (frame.payload !== null) throw new Error('Duplicate change target.');
      frame.payload = payload;
      const previous = frame.release;
      const payloadRelease = scratch.budget.holdRecord(Buffer.byteLength(JSON.stringify(payload)));
      frame.release = () => {
        previous();
        payloadRelease();
      };
    }
    while (frames.length > 1) await close();
    const root = await close();
    signal.throwIfAborted();
    return root;
  } finally {
    for (const frame of frames) frame.release();
    claim.release();
  }
}
export async function changeNode(scratch: InstallScratch, offset: number) {
  const record = await scratch.record(offset);
  const value = record.value as ChangeNode;
  if (value[0] !== 'change-node') {
    record.release();
    throw new Error('Invalid change page.');
  }
  return { node: value, release: record.release };
}
export async function* changeChildren(scratch: InstallScratch, node: ChangeNode) {
  for await (const value of scratch.rows(node[3], node[4])) {
    const row = value as readonly Value[];
    if (row[0] !== 'change-child') throw new Error('Invalid change edge.');
    yield [String(row[1]), Number(row[2])] as const;
  }
}
