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

import { mkdir, mkdtemp, writeFile, rm, symlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { NativeRoot, nativeIds } from '../../../src/cache/streaming/native';
import { walkNative, walkWork, type WalkEvent } from '../../../src/cache/streaming/native-walk';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const directory = await mkdtemp(path.resolve('build/native-walk-'));
  roots.push(directory);
  const home = path.join(directory, 'home');
  await mkdir(home);
  return { directory: home, root: await NativeRoot.bind(home), budget: new WorkingBudget() };
}
async function collect(events: AsyncIterable<WalkEvent>) {
  const result: string[] = [];
  for await (const event of events) {
    result.push(event.tag + ':' + event.path);
  }
  return result;
}
it.each(['before', 'after'] as const)('rechecks a scoped parent %s traversal', async (when) => {
  const f = await fixture();
  await mkdir(path.join(f.directory, 'parent/child'), { recursive: true });
  await writeFile(path.join(f.directory, 'parent/child/file'), 'body');
  const parentNative = (await f.root.stat('parent'))!;
  if (when === 'before') {
    await utimes(path.join(f.directory, 'parent'), 0, 0);
  }
  await expect(
    (async () => {
      for await (const event of walkNative(f.root, 'parent/child', {
        budget: f.budget,
        parentNative,
      })) {
        if (when === 'after' && event.tag === 'directory-close') {
          await utimes(path.join(f.directory, 'parent'), 0, 0);
        }
      }
    })(),
  ).rejects.toThrow('Scoped traversal parent changed');
  expect(f.budget.retained).toBe(0);
});
it('lists files first and closes each directory around its complete sorted subtree', async () => {
  const f = await fixture();
  for (const dir of ['z-dir', 'a-dir', 'empty', '.mammoth']) {
    await mkdir(path.join(f.directory, dir));
  }
  for (const file of ['z', 'ä', 'a', 'z-dir/a', 'a-dir/z', '.mammoth/private']) {
    await writeFile(path.join(f.directory, file), 'body');
  }
  expect(await collect(walkNative(f.root, '', { budget: f.budget }))).toEqual([
    'directory-open:',
    'file:a',
    'file:z',
    'file:ä',
    'directory-open:a-dir',
    'file:a-dir/z',
    'directory-close:a-dir',
    'directory-open:empty',
    'directory-close:empty',
    'directory-open:z-dir',
    'file:z-dir/a',
    'directory-close:z-dir',
    'directory-close:',
  ]);
  expect(f.budget.retained).toBe(0);
});
it('projects an owned staging root onto logical paths without exposing metadata names', async () => {
  const f = await fixture();
  await f.root.createMetadataDirectory();
  await mkdir(f.root.resolve('.mammoth/stage/sub'), { recursive: true });
  await writeFile(f.root.resolve('.mammoth/stage/sub/file'), 'body');
  const events = [];
  for await (const event of walkNative(f.root, '.mammoth/stage', {
    budget: f.budget,
    logicalRoot: 'cache',
  })) {
    events.push([event.tag, event.path, event.nativePath]);
  }
  expect(events[2]).toEqual(['file', 'cache/sub/file', '.mammoth/stage/sub/file']);
  expect(f.budget.retained).toBe(0);
});
it('counts physical entries including excluded entries before retaining their names', async () => {
  const f = await fixture();
  for (const file of ['one', 'two', 'three']) {
    await writeFile(path.join(f.directory, file), 'x');
  }
  const work = walkWork();
  await expect(
    collect(
      walkNative(f.root, '', { budget: f.budget, maxDirectoryEntries: 2, prune: () => true }, work),
    ),
  ).rejects.toThrow('breadth');
  expect(work.entries).toBe(3);
  expect(work.peakNames).toBe(0);
  expect(f.budget.retained).toBe(0);
});
it('releases active frame charges on budget failure, cancellation and early return', async () => {
  const f = await fixture();
  await mkdir(path.join(f.directory, 'sub'));
  for (const file of ['a', 'b', 'c', 'sub/a']) {
    await writeFile(path.join(f.directory, file), 'x');
  }
  const tiny = new WorkingBudget(250);
  await expect(collect(walkNative(f.root, '', { budget: tiny }))).rejects.toThrow('budget');
  expect(tiny.retained).toBe(0);
  for await (const event of walkNative(f.root, '', { budget: f.budget })) {
    if (event.tag === 'file') {
      break;
    }
  }
  expect(f.budget.retained).toBe(0);
  const controller = new AbortController();
  await expect(
    (async () => {
      for await (const event of walkNative(f.root, '', {
        budget: f.budget,
        signal: controller.signal,
      })) {
        if (event.tag === 'file') {
          controller.abort(new Error('cancelled walk'));
        }
      }
    })(),
  ).rejects.toThrow('cancelled walk');
  expect(f.budget.retained).toBe(0);
});
it('rejects changed files and directory membership before traversal acceptance', async () => {
  const f = await fixture();
  await writeFile(path.join(f.directory, 'file'), 'body');
  await expect(
    (async () => {
      for await (const event of walkNative(f.root, '', { budget: f.budget })) {
        if (event.tag === 'file') {
          await writeFile(path.join(f.directory, 'file'), 'changed-body');
        }
      }
    })(),
  ).rejects.toThrow('file changed');
  await expect(
    (async () => {
      for await (const event of walkNative(f.root, '', { budget: f.budget })) {
        if (event.tag === 'file') {
          await mkdir(path.join(f.directory, 'new-child'));
        }
      }
    })(),
  ).rejects.toThrow('directory changed');
  expect(f.budget.retained).toBe(0);
});
it.each(['throw', 'abort', 'abort and throw'] as const)(
  'stops before yielding an inspected child on callback %s',
  async (outcome) => {
    const f = await fixture();
    await writeFile(path.join(f.directory, 'file'), 'body');
    const controller = new AbortController(),
      abort = new Error('inspection aborted'),
      failure = new Error('inspection failed'),
      events: string[] = [];
    const walk = walkNative(f.root, '', {
      budget: f.budget,
      signal: controller.signal,
      inspectChild() {
        if (outcome !== 'throw') {
          controller.abort(abort);
        }
        if (outcome !== 'abort') {
          throw failure;
        }
        return 'prune';
      },
    });
    await expect(
      (async () => {
        for await (const event of walk) {
          events.push(event.tag);
        }
      })(),
    ).rejects.toBe(outcome === 'throw' ? failure : abort);
    expect(events).toEqual(['directory-open']);
    expect(f.budget.retained).toBe(0);
  },
);
it('rejects links and a file/directory kind change after listing', async () => {
  const f = await fixture();
  await mkdir(path.join(f.directory, 'target'));
  await symlink(
    path.join(f.directory, 'target'),
    path.join(f.directory, 'link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await expect(collect(walkNative(f.root, '', { budget: f.budget }))).rejects.toThrow(
    'Unsupported',
  );
  await rm(path.join(f.directory, 'link'));
  await writeFile(path.join(f.directory, 'a'), 'body');
  await mkdir(path.join(f.directory, 'b'));
  await expect(
    (async () => {
      for await (const event of walkNative(f.root, '', { budget: f.budget })) {
        if (event.path === 'a') {
          await rm(path.join(f.directory, 'b'), { recursive: true });
          await writeFile(path.join(f.directory, 'b'), 'replacement');
        }
      }
    })(),
  ).rejects.toThrow('kind changed');
  expect(f.budget.retained).toBe(0);
});
it('does aggregate linear filesystem work across shared ancestors and retains only active sibling lists', async () => {
  const peaks: number[] = [];
  for (const width of [8, 32]) {
    const f = await fixture();
    for (let unit = 0; unit < width; unit++) {
      const sub = path.join(f.directory, 'cache', String(unit).padStart(3, '0'));
      await mkdir(sub, { recursive: true });
      for (let n = 0; n < 4; n++) {
        await writeFile(path.join(sub, String(n)), 'body');
      }
    }
    const work = walkWork();
    let files = 0;
    for await (const event of walkNative(f.root, '', { budget: f.budget }, work)) {
      if (event.tag === 'file') {
        files++;
      }
    }
    expect(files).toBe(width * 4);
    expect(work.listings).toBe(width + 2);
    expect(work.entries).toBe(1 + width * 5);
    expect(work.stats).toBe(3 * (width + 2) + 2 * width * 4);
    expect(f.root.work.stats).toBe(work.stats + 4); // managed and sibling binding plus root guards
    expect(f.budget.retained).toBe(0);
    peaks.push(work.peakNames);
  }
  // Growth is one list of immediate subdirectories, not their combined file records.
  expect(peaks[1] - peaks[0]).toBe(24 * (128 + 4 * 3));
});
it('does not open pruned subtrees or charge them recursively', async () => {
  const f = await fixture();
  await mkdir(path.join(f.directory, 'ignored/deep'), { recursive: true });
  await writeFile(path.join(f.directory, 'ignored/deep/body'), 'body');
  const work = walkWork();
  expect(
    await collect(
      walkNative(f.root, '', { budget: f.budget, prune: (p) => p === 'ignored' }, work),
    ),
  ).toEqual(['directory-open:', 'directory-close:']);
  expect(work.listings).toBe(1);
  expect(work.entries).toBe(1);
  expect(work.stats).toBe(3);
});

it('uses the reserved metadata policy for live roots and rejects metadata in staging', async () => {
  const f = await fixture();
  await mkdir(path.join(f.directory, '.MAMMOTH'));
  await writeFile(path.join(f.directory, '.MAMMOTH/private'), 'private');
  await mkdir(path.join(f.directory, 'cache/.mammoth.data'), { recursive: true });
  expect(await collect(walkNative(f.root, '', { budget: f.budget }))).toEqual([
    'directory-open:',
    'directory-open:cache',
    'directory-close:cache',
    'directory-close:',
  ]);
  await expect(
    collect(
      walkNative(f.root, 'cache', { budget: f.budget, logicalRoot: 'cache', metadata: 'reject' }),
    ),
  ).rejects.toThrow();
  await expect(
    collect(
      walkNative(f.root, 'cache', {
        budget: f.budget,
        logicalRoot: 'cache',
        metadata: 'reject',
        prune: () => true,
      }),
    ),
  ).rejects.toThrow('Reserved metadata');
  expect(f.budget.retained).toBe(0);
});
it.skipIf(process.platform === 'win32')(
  'rejects distinct native byte names that decode to the same Unicode name',
  async () => {
    const f = await fixture();
    await writeFile(
      Buffer.concat([Buffer.from(f.directory + '/'), Buffer.from([0xff])]),
      'invalid-byte',
    );
    await writeFile(path.join(f.directory, '\uFFFD'), 'literal replacement character');
    await expect(collect(walkNative(f.root, '', { budget: f.budget }))).rejects.toThrow(
      'Duplicate decoded',
    );
    expect(f.budget.retained).toBe(0);
  },
);

it('requires a reliable protected child ID while permitting device zero', () => {
  expect(nativeIds({ dev: 0n, ino: 42n })).toEqual(['0', '42']);
  expect(() => nativeIds({ dev: 1n, ino: 0n })).toThrow('Unsupported native object identity');
});
