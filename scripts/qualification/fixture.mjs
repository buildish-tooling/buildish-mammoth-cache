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

// Q1-only deterministic fixture/oracle. No resident file catalogue.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  mkdir,
  open,
  opendir,
  readFile,
  rm,
  stat,
  statfs,
  utimes,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

export function relativeFile(index, count) {
  const width = count / 4;
  assert(Number.isInteger(width) && width > 0);
  const partition = Math.min(3, Math.floor(index / width));
  const local = index - partition * width;
  return `q${partition}/${Math.floor(local / 1000)}/${local}.bin`;
}
export function body(index, changed = false) {
  const bytes = Buffer.alloc(64, changed ? 90 : 65);
  bytes.write(String(index) + ':', 0, 'ascii');
  return bytes;
}
export async function generate(root, count) {
  assert(Number.isSafeInteger(count) && count >= 4 && count % 4 === 0);
  // Eight bounded producers, each retaining only its current path/body.
  for (let p = 0; p < 4; p++)
    for (let group = 0; group < Math.ceil(count / 4 / 1000); group++)
      await mkdir(path.join(root, 'q' + p, String(group)), { recursive: true });
  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < count) {
        const index = next++,
          file = path.join(root, relativeFile(index, count));
        await writeFile(file, body(index), { flag: 'wx' });
      }
    }),
  );
}
export async function mutate(root, count) {
  const modified = count / 10,
    deleted = count / 20;
  assert(Number.isInteger(deleted));
  for (let i = 0; i < modified; i++) {
    const file = path.join(root, relativeFile(i, count));
    const before = await stat(file);
    await writeFile(file, body(i, true));
    await utimes(file, before.atime, new Date(before.mtimeMs + 2000));
  }
  for (let i = modified; i < modified + deleted; i++)
    await rm(path.join(root, relativeFile(i, count)));
  for (let i = count / 4; i < count / 4 + deleted; i++) {
    const file = path.join(root, 'q0', String(Math.floor(i / 1000)), i + '.bin');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body(i, true), { flag: 'wx' });
  }
  return { modified, deleted, added: deleted, untouched: count - modified - deleted };
}
export async function verify(root, count, changed = false) {
  let seen = 0,
    bytes = 0;
  async function visit(relative) {
    const directory = await opendir(path.join(root, relative));
    for await (const entry of directory) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(name);
        continue;
      }
      assert(entry.isFile(), 'Unexpected native kind: ' + name);
      const match = /^q([0-3])\/([0-9]+)\/([0-9]+)\.bin$/u.exec(name);
      assert(match, 'Unexpected fixture member: ' + name);
      const partition = Number(match[1]),
        local = Number(match[3]);
      assert.equal(Number(match[2]), Math.floor(local / 1000));
      const width = count / 4,
        index = partition * width + local;
      const added = changed && partition === 0 && local >= width && local < width + count / 20;
      assert(added || local < width, 'Unexpected fixture index');
      assert(
        !(changed && partition === 0 && local >= count / 10 && local < count * 0.15),
        'Deleted file survived',
      );
      const data = await readFile(path.join(root, name));
      assert.deepEqual(data, body(added ? local : index, added || (changed && index < count / 10)));
      seen++;
      bytes += data.length;
    }
  }
  for (let p = 0; p < 4; p++) await visit('q' + p);
  assert.equal(seen, count);
  return { files: seen, bytes };
}
export async function capacity(root, count) {
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'allocation-probe');
  const handle = await open(file, 'wx');
  try {
    await handle.write(body(0));
  } finally {
    await handle.close();
  }
  const fs = await statfs(root),
    size = await import('node:fs/promises').then((m) => m.stat(file));
  await rm(file);
  const allocated = Math.max(Number(size.blocks ?? 0) * 512, Number(fs.bsize), 4096);
  const free = Number(fs.bavail) * Number(fs.bsize);
  // Qualification-only preflight, not a Mammoth admission limit. Allow four coexisting native views + archives/headroom.
  return {
    free,
    allocationPerFile: allocated,
    estimatedRequired: count * allocated * 4 + 1024 ** 3,
  };
}
