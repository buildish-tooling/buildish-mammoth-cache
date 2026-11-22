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

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  OpenedInvocation,
  invocationAnchor,
  encodeInvocationAnchor,
  decodeInvocationAnchor,
  disabledInvocationAnchor,
} from '../../../src/cache/streaming/invocation';
import { NativeRoot } from '../../../src/cache/streaming/native';
import { resolveModel } from '../../../src/cache/streaming/model';
import { rawSha, tuple } from '../../../src/cache/streaming/encoding';
import { captureObservations } from '../../../src/cache/streaming/observation-capture';
import { executeGc } from '../../../src/cache/streaming/gc-execute';
import { observationFixture } from './observation-fixtures';
import { installFixture } from './install-fixture';
const cleanup: (() => unknown)[] = [];
let directory: string, bundle: string;
beforeAll(async () => {
  directory = await mkdtemp(path.resolve('build/invocation-process-'));
  bundle = path.join(directory, 'fixture.mjs');
  const result = await build({
    entryPoints: ['test/cache/streaming/invocation-process-fixture.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    metafile: true,
  });
  expect(
    Object.keys(result.metafile!.inputs).filter((p) =>
      /src\/(?:ci\/github|build-tool|phases\/bootstrap|config\/)/.test(p),
    ),
  ).toEqual([]);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(options: Parameters<typeof observationFixture>[1] = {}) {
  const f = await observationFixture('gradle', options);
  cleanup.push(async () => {
    expect(f.budget.retained).toBe(0);
    await f.close();
  });
  const a = invocationAnchor(f.store.root, f.store.codec.options.context, String(f.bindings[4]));
  return { ...f, a };
}
it('cold reopens a multi-row model larger than the CI state bound without provider/config imports', async () => {
  const hard = ['.mammoth/**'],
    model = resolveModel(
      [
        'model',
        1,
        'gradle',
        hard,
        Array.from({ length: 4 }, (_, i) => [
          'p' + i,
          Array.from({ length: 1600 }, (_, j) => 'p' + i + '/entry-' + j),
          hard,
          'aggregate',
          null,
          'default',
        ]),
      ],
      'large-',
      1,
    ),
    f = await fixture({ model });
  expect(tuple(f.bindings[6])[3]).toBeGreaterThan(65536);
  const raw = encodeInvocationAnchor(f.a);
  expect(Buffer.byteLength(raw)).toBeLessThan(2048);
  expect(decodeInvocationAnchor(raw)).toEqual(f.a);
  const opened = await OpenedInvocation.open(f.a, f.budget);
  expect(opened.store.codec.options.model.id).toBe(model.id);
  expect(opened.bindings).toEqual(
    await f.store.readDocument(tuple(await f.store.state())[5], 'bindings'),
  );
  expect(JSON.parse(execFileSync(process.execPath, [bundle, raw], { encoding: 'utf8' }))).toEqual({
    id: model.id,
    phase: 'quiescent',
    retained: 0,
  });
}, 30000);
it('reopens current ownership and latest mutable progress rather than a CI state digest', async () => {
  const f = await fixture(),
    first = await OpenedInvocation.open(f.a, f.budget);
  await f.files('', { 'data/file': 'body' });
  await captureObservations(f.store, { budget: f.budget });
  const second = await OpenedInvocation.open(f.a, f.budget);
  expect(second.state[4]).toBe('observations-frozen');
  expect(second.state[3]).toBeGreaterThan(first.state[3]);
  expect((await OpenedInvocation.current(f.root, f.budget))!.anchor[4]).toEqual(f.a[4]);
});
it.each(['root', 'invocation', 'canonical'] as const)('rejects %s anchor changes', async (kind) => {
  const f = await fixture(),
    a = structuredClone(f.a);
  if (kind === 'root') {
    a[3][4] = String(BigInt(a[3][4]) + 1n);
    await expect(OpenedInvocation.open(a, f.budget)).rejects.toThrow('root');
  }
  if (kind === 'invocation') {
    a[5] = 'b'.repeat(32);
    await expect(OpenedInvocation.open(a, f.budget)).rejects.toThrow('anchor');
  }
  if (kind === 'canonical') expect(() => decodeInvocationAnchor(JSON.stringify(a))).toThrow();
});
it.each(['model', 'bindings', 'missing-state'] as const)(
  'rejects corrupt or incomplete %s without importing current config',
  async (kind) => {
    const f = await fixture(),
      state = tuple(await f.store.state()),
      reference = tuple(kind === 'model' ? f.bindings[6] : state[5]);
    if (kind === 'missing-state') await rm(f.store.root.resolve(f.store.prefix + 'state.json'));
    else await writeFile(f.store.root.resolve(String(reference[2])), Buffer.from('[]\n'));
    await expect(OpenedInvocation.open(f.a, f.budget)).rejects.toThrow();
  },
);
it('keeps disabled state bounded and refuses an uninitialized namespace', async () => {
  const f = await installFixture();
  cleanup.push(() => f.close());
  expect(await OpenedInvocation.current(f.root, f.budget)).toBeNull();
  await expect(
    OpenedInvocation.open(
      invocationAnchor(f.store.root, f.store.codec.options.context, String(f.bindings[4])),
      f.budget,
    ),
  ).rejects.toThrow('Prepare');
  const off = disabledInvocationAnchor(f.store.codec.options.context, f.root);
  expect(decodeInvocationAnchor(encodeInvocationAnchor(off))).toEqual(off);
});
it.each(['gradle', 'maven'] as const)(
  'captures and completes GC for a real %s worker with no base quiescence',
  async (tool) => {
    const f = await observationFixture(tool, {
      role: 'distributed-worker',
      purgeGlobs: ['data/*.lock'],
    });
    cleanup.push(async () => {
      expect(f.budget.retained).toBe(0);
      await f.close();
    });
    await f.files('', { 'data/body': 'payload', 'data/runtime.lock': 'keep' });
    const out = await captureObservations(f.store, { budget: f.budget });
    expect(out.purge.status).toBe('skipped');
    expect(await readFile(f.store.root.resolve('data/runtime.lock'), 'utf8')).toBe('keep');
    await executeGc(f.store, { budget: f.budget });
    const state = tuple(await f.store.state());
    expect(state[4]).toBe('gc-complete');
    expect(state[13]).toBeNull();
  },
);
it('does not allow worker purge or relax base/read-only admission', async () => {
  const f = await fixture({ role: 'distributed-worker', purgeGlobs: ['data/*.lock'] });
  await expect(
    captureObservations(f.store, {
      budget: f.budget,
      purgeWindow: {
        root: f.store.root,
        invocation: f.store.codec.options.invocation,
        assertCurrent: (): undefined => {},
      },
    }),
  ).rejects.toThrow('Worker');
  const base = await fixture(),
    state = base.store.codec.schemas.documents['local-state'].parse(await base.store.state());
  state[3]++;
  state[4] = 'build-ready';
  state[13] = null;
  await base.store.updateState(state);
  await expect(captureObservations(base.store, { budget: base.budget })).rejects.toThrow(
    'quiescent',
  );
  const ro = await fixture({ access: 'read-only' });
  await expect(captureObservations(ro.store, { budget: ro.budget })).rejects.toThrow('writable');
});

it('matches independent canonical enabled/disabled anchor vectors', async () => {
  const text = await readFile('docs/dev/cache-protocol-vectors.md', 'utf8'),
    section = text.split('## A0:')[1];
  for (const example of ['enabled', 'disabled']) {
    const part = section.split('### ' + example)[1].split('### ')[0],
      bytes = part.match(/```text\n([\s\S]*?)```/)![1],
      expected = part.match(/Raw SHA-256: `([a-f0-9]{64})`/)![1];
    expect(decodeInvocationAnchor(bytes)).toEqual(JSON.parse(bytes));
    expect(encodeInvocationAnchor(JSON.parse(bytes))).toBe(bytes);
    expect(rawSha(Buffer.from(bytes))).toBe(expected);
  }
});

it('does not return absent ownership after cancellation during the locator read', async () => {
  const f = await installFixture();
  cleanup.push(() => f.close());
  const controller = new AbortController(),
    actual = NativeRoot.prototype.stat;
  const spy = vi.spyOn(NativeRoot.prototype, 'stat').mockImplementation(async function (
    this: NativeRoot,
    relative: string,
  ) {
    const result = await actual.call(this, relative);
    if (relative === '.mammoth/v1/current.json') controller.abort(new Error('locator canceled'));
    return result;
  });
  try {
    await expect(OpenedInvocation.current(f.root, f.budget, controller.signal)).rejects.toThrow(
      'locator canceled',
    );
    expect(spy.mock.calls.filter(([p]) => p === '.mammoth/v1/current.json')).toHaveLength(1);
  } finally {
    spy.mockRestore();
  }
});
