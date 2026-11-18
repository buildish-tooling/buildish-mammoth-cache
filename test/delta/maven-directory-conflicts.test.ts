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
import { afterEach, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { mavenFixtureModel, mavenFixtureState } from '../support/maven-cache';
import { cutoffFixtureCi } from '../support/cutoff-fixture';
import { stageCutoffPackage, type CutoffPackage } from '../../src/delta/cutoff-service';
import { applyCutoffPlan, mergeCutoffPackages } from '../../src/delta/cutoff-apply';
import { resolveMavenDirectoryConflicts } from '../../src/delta/maven-directory-conflicts';

const roots: string[] = [];
const directory = 'repository/test/example/1.0';
const jar = `${directory}/example-1.0.jar`,
  marker = `${directory}/_remote.repositories`;
const inputs = {
  'cache-partitions': JSON.stringify([
    { id: 'repository', 'conflict-handling': 'choose-worker-directory' },
  ]),
};
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'directory-winner-'));
  roots.push(root);
  const target = await mavenFixtureModel(path.join(root, 'target'), inputs);
  const ci = cutoffFixtureCi(root, 'aggregator');
  async function worker(name: string, files: Record<string, string>, settings = inputs) {
    const home = path.join(root, name);
    for (const [file, bytes] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(home, file)), { recursive: true });
      await writeFile(path.join(home, file), bytes);
      await chmod(path.join(home, file), name === 'a' ? 0o644 : 0o755);
      await utimes(path.join(home, file), 1700000000, name === 'a' ? 1700000000 : 1700001000);
    }
    const state = await mavenFixtureState(home, name, settings);
    return stageCutoffPackage(state.state, state.ci);
  }
  return { root, target, ci, worker };
}
const files = (value: string, extra = false) => ({
  [jar]: value,
  [marker]: `marker-${value}`,
  ...(extra ? { [`${directory}/sources.jar`]: 'sources' } : {}),
});
const entries = (pkg: CutoffPackage) => pkg.manifest.partitions.flatMap((p) => p.upserts);

it('selects one entire view over three producers independent of input order and duplicate overrides', async () => {
  const { worker, target, ci } = await fixture();
  const a = await worker('a', files('A')),
    b = await worker('b', files('B', true)),
    c = await worker('c', files('C'));
  for (const order of [
    [a, b, c],
    [a, c, b],
    [b, a, c],
    [b, c, a],
    [c, a, b],
    [c, b, a],
  ])
    for (const override of [false, true]) {
      const plan = mergeCutoffPackages(order, target, ci, override);
      expect(plan.upserts.map((p) => p.entry)).toEqual(entries(a));
      expect(new Set(plan.upserts.map((p) => p.rootDirectory))).toEqual(new Set([a.rootDirectory]));
      expect(plan.directoryConflicts?.count).toBe(1);
      expect(plan.directoryConflicts?.details[0]).toContain("selected 'a'");
    }
  const plan = mergeCutoffPackages([c, b, a], target, ci);
  await applyCutoffPlan(plan, target);
  expect(await readFile(path.join(target.cacheRoot, jar), 'utf8')).toBe('A');
  await expect(readFile(path.join(target.cacheRoot, directory, 'sources.jar'))).rejects.toThrow();
});

it('treats differing membership as a conflict even when shared files match', async () => {
  const { worker, target, ci } = await fixture();
  const a = await worker('a', files('A')),
    b = await worker('b', files('A', true));
  const plan = mergeCutoffPackages([b, a], target, ci);
  expect(plan.upserts.map((p) => p.entry)).toEqual(entries(a));
  expect(plan.directoryConflicts?.count).toBe(1);
});

it('retains one producer attributes even for identical bytes instead of OR-ing losing modes', async () => {
  const { worker, target, ci } = await fixture();
  const a = await worker('a', files('A')),
    b = await worker('b', files('A'));
  expect(entries(a)[0]!.mode).not.toBe(entries(b)[0]!.mode);
  const plan = mergeCutoffPackages([b, a], target, ci);
  expect(plan.upserts.map((p) => p.entry)).toEqual(entries(a));
  expect(plan.directoryConflicts).toBeUndefined();
});

it('never elects usage-only packages or retains losing-only usage', async () => {
  const { worker, target, ci } = await fixture();
  const a = await worker('a', files('A')),
    b = await worker('b', files('B', true));
  const usage = structuredClone(a);
  usage.metadata.producer.jobName = '0-usage';
  for (const p of usage.manifest.partitions) {
    p.upserts = [];
    p.usedPaths =
      p.partitionId === 'repository'
        ? [jar, `${directory}/sources.jar`, 'repository/unrelated/keep']
        : [];
  }
  const plan = mergeCutoffPackages([usage, b, a], target, ci);
  expect(plan.upserts.map((p) => p.entry)).toEqual(entries(a));
  expect(plan.used).toEqual(['repository/unrelated/keep']);
});

it('rejects ambiguous producer contributions even if payloads match', async () => {
  const { worker, target, ci } = await fixture();
  const a = await worker('a', files('A'));
  expect(() => mergeCutoffPackages([a, structuredClone(a)], target, ci)).toThrow(
    /Ambiguous worker directory/,
  );
});

it.each([false, true])(
  'rejects extra target siblings before any worker writes (excluded: %s)',
  async (excluded) => {
    const { worker, target, ci } = await fixture();
    const unrelated = 'repository/aaa/other/1.0/other.jar';
    const settings = excluded
      ? {
          'cache-partitions': JSON.stringify([
            {
              id: 'repository',
              'conflict-handling': 'choose-worker-directory',
              excludes: ['**/extra.jar'],
            },
          ]),
        }
      : inputs;
    const a = await worker('a', { ...files('A'), [unrelated]: 'new-unrelated' }, settings);
    await mkdir(path.dirname(path.join(target.cacheRoot, unrelated)), { recursive: true });
    await writeFile(path.join(target.cacheRoot, unrelated), 'original-unrelated');
    await mkdir(path.join(target.cacheRoot, directory), { recursive: true });
    await writeFile(path.join(target.cacheRoot, marker), 'original-marker');
    await writeFile(path.join(target.cacheRoot, directory, 'extra.jar'), 'existing-extra');
    const model = await mavenFixtureModel(target.cacheRoot, settings);
    const plan = mergeCutoffPackages([a], model, ci);
    await expect(applyCutoffPlan(plan, model)).rejects.toThrow(
      /Incomplete Maven repository directory/,
    );
    expect(await readFile(path.join(target.cacheRoot, unrelated), 'utf8')).toBe(
      'original-unrelated',
    );
    expect(await readFile(path.join(target.cacheRoot, marker), 'utf8')).toBe('original-marker');
  },
);

it('rejects mixed policies across partition ownership of one directory', async () => {
  const { worker, target } = await fixture();
  const a = await worker('a', files('A'));
  const split = {
    ...target,
    partitions: [
      ...target.partitions,
      { ...target.partitions[0]!, id: 'strict', conflictHandling: undefined },
    ],
  };
  const pkg = structuredClone(a);
  const [first, ...remaining] = pkg.manifest.partitions[0]!.upserts;
  pkg.manifest.partitions[0]!.upserts = remaining;
  pkg.manifest.partitions.push({ partitionId: 'strict', upserts: [first!], usedPaths: [] });
  expect(() => resolveMavenDirectoryConflicts([pkg], split)).toThrow(/mixed conflict-handling/);
});

it('bounds diagnostic storage including long producer lists and identifiers', async () => {
  const { worker, target } = await fixture();
  const seed = await worker('a', files('A'));
  const packages = Array.from({ length: 25 }, (_, i) => {
    const pkg = structuredClone(seed);
    pkg.metadata.producer.jobName = String(i).padStart(3, '0') + 'x'.repeat(150);
    pkg.manifest.partitions[0]!.upserts = Array.from({ length: 30 }, (_, d) => ({
      ...entries(seed)[0]!,
      relativePath: `repository/${'d'.repeat(300)}${d}/file`,
      contentSha256: i.toString(16).padStart(64, '0'),
    }));
    return pkg;
  });
  const result = resolveMavenDirectoryConflicts(packages, target);
  expect(result.count).toBe(30);
  expect(result.details.length).toBeLessThanOrEqual(10);
  expect(Buffer.byteLength(result.details.join('\n'))).toBeLessThan(8192);
  expect(result.details[0]).toContain('(+19 producers)');
});

it('forwards only the selected native view and re-elects using the forwarding producer identity', async () => {
  const { worker, target, ci } = await fixture();
  const a = await worker('a', files('A')),
    b = await worker('b', files('B', true));
  await applyCutoffPlan(mergeCutoffPackages([b, a], target, ci), target);
  const forwarded = await mavenFixtureState(target.cacheRoot, 'forwarder', inputs);
  const pkg = await stageCutoffPackage(forwarded.state, forwarded.ci);
  expect(entries(pkg).map((e) => e.relativePath)).toEqual(entries(a).map((e) => e.relativePath));
  const c = await worker('c', files('C'));
  const plan = mergeCutoffPackages([pkg, c], target, ci);
  expect(new Set(plan.upserts.map((p) => p.rootDirectory))).toEqual(new Set([c.rootDirectory]));
  expect(plan.upserts.map((p) => p.entry)).toEqual(entries(c));
});
