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

import { mkdir, mkdtemp, rm, writeFile, readFile, chmod, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGitHubBaseCacheBackend } from '../../src/ci/github/cache';
const roots: string[] = [];
beforeEach(() => {
  vi.stubEnv('ACTIONS_CACHE_SERVICE_V2', '1');
  vi.stubEnv('GITHUB_SERVER_URL', 'https://github.com');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.resolve('build/platform-transport-'));
  roots.push(root);
  const source = path.join(root, 'windows-home/cache');
  const target = path.join(root, 'mac-home/cache');
  await mkdir(path.join(source, 'data'), { recursive: true });
  await mkdir(target, { recursive: true });
  return { root, source, target };
}
it('relocates a real toolkit tar archive with stable version inputs, exclusions and cross-OS flags', async () => {
  const { root, source, target } = await fixture();
  const sdk = path.dirname(fileURLToPath(import.meta.resolve('@actions/cache')));
  const utils = await import(pathToFileURL(path.join(sdk, 'internal/cacheUtils.js')).href);
  const tar = await import(pathToFileURL(path.join(sdk, 'internal/tar.js')).href);
  const archive = path.join(root, 'archive');
  await mkdir(archive);
  await writeFile(path.join(source, 'data/a'), 'portable');
  await chmod(path.join(source, 'data/a'), 0o755);
  await writeFile(path.join(source, 'data/excluded'), 'excluded');
  const trickyNames = [
    'nested directory/file with spaces.txt',
    'Grüße für Jörg/français été à Noël cœur.txt',
    '資料/cache 🦣.bin',
    "a & b #1 + 50% = (ok) [x] 'quote' $cash !.txt",
    '-leading-dash.txt',
    'empty file',
  ];
  for (const name of trickyNames) {
    const file = path.join(source, 'data', name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, name === 'empty file' ? Buffer.alloc(0) : Buffer.from([0, 255, 13, 10]));
  }

  const paths = (base: string) => [
    path.join(base, 'data/**'),
    '!' + path.join(base, 'data/excluded'),
    '!' + base + '/**/',
  ];
  let version: string;
  const backend = {
    isFeatureAvailable: () => true,
    saveCache: vi.fn(
      async (patterns: string[], _key: string, _options?: unknown, crossOs?: boolean) => {
        expect(crossOs).toBe(true);
        version = utils.getCacheVersion(patterns, 'gzip', crossOs);
        const members = await utils.resolvePaths(patterns);
        expect(members.sort()).toEqual(
          ['data/a', ...trickyNames.map((name) => 'data/' + name)].sort(),
        );
        await tar.createTar(archive, members, 'gzip');
        return 1;
      },
    ),
    restoreCache: vi.fn(
      async (
        patterns: string[],
        key: string,
        _fallback?: string[],
        _options?: unknown,
        crossOs?: boolean,
      ) => {
        expect(crossOs).toBe(true);
        expect(utils.getCacheVersion(patterns, 'gzip', crossOs)).toBe(version);
        await tar.extractTar(path.join(archive, 'cache.tgz'), 'gzip');
        return key;
      },
    ),
  };
  const cwd = process.cwd(),
    workspace = process.env.GITHUB_WORKSPACE;
  await createGitHubBaseCacheBackend(backend, source).saveCache(paths(source), 'family');
  await createGitHubBaseCacheBackend(backend, target).restoreCache(paths(target), 'family');
  expect(await readFile(path.join(target, 'data/a'), 'utf8')).toBe('portable');
  for (const name of trickyNames) {
    expect(await readFile(path.join(target, 'data', name))).toEqual(
      name === 'empty file' ? Buffer.alloc(0) : Buffer.from([0, 255, 13, 10]),
    );
  }

  expect((await lstat(path.join(target, 'data/a'))).mode & 0o111).not.toBe(0);
  await expect(lstat(path.join(target, 'data/excluded'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(process.cwd()).toBe(cwd);
  expect(process.env.GITHUB_WORKSPACE).toBe(workspace);
});

it('restores process context after errors and serializes concurrent backend instances', async () => {
  const { source, target } = await fixture();
  const cwd = process.cwd(),
    workspace = process.env.GITHUB_WORKSPACE;
  const seen: string[] = [];
  const backend = {
    isFeatureAvailable: () => true,
    saveCache: async () => 1,
    restoreCache: async (_paths: string[], key: string) => {
      const expected = key === 'first' ? source : target;
      expect(process.cwd()).toBe(expected);
      expect(process.env.GITHUB_WORKSPACE).toBe(expected);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(process.cwd()).toBe(expected);
      seen.push(key);
      if (key === 'first') {
        throw new Error('transport failed');
      }
      return key;
    },
  };
  const outcomes = await Promise.allSettled([
    createGitHubBaseCacheBackend(backend, source).restoreCache([source + '/data/**'], 'first'),
    createGitHubBaseCacheBackend(backend, target).restoreCache([target + '/data/**'], 'second'),
  ]);
  expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'fulfilled']);
  expect(seen).toEqual(['first', 'second']);
  expect(process.cwd()).toBe(cwd);
  expect(process.env.GITHUB_WORKSPACE).toBe(workspace);
});

it('rejects archive patterns outside the managed root', async () => {
  const { source, target } = await fixture();
  const saveCache = vi.fn(async () => 1);
  const backend = createGitHubBaseCacheBackend(
    { isFeatureAvailable: () => true, saveCache, restoreCache: async () => undefined },
    source,
  );
  await expect(backend.saveCache([target + '/**'], 'family')).rejects.toThrow(/outside/);
  expect(saveCache).not.toHaveBeenCalled();
});

it.each(['cache home', 'cache\thome', 'cache"home'])(
  'skips unsupported SDK root %s with a warning instead of broken tar operations',
  async (name) => {
    const { root } = await fixture();
    const warn = vi.fn();
    const sdk = {
      isFeatureAvailable: vi.fn(() => true),
      saveCache: vi.fn(async () => 1),
      restoreCache: vi.fn(async () => 'family'),
    };
    const backend = createGitHubBaseCacheBackend(sdk, path.join(root, name), warn);
    expect(backend.isFeatureAvailable()).toBe(false);
    expect(await backend.restoreCache([], 'family')).toBeUndefined();
    expect(await backend.saveCache([], 'family')).toBe(-1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('Workflow artifact exchange remains available');
    expect(sdk.restoreCache).not.toHaveBeenCalled();
    expect(sdk.saveCache).not.toHaveBeenCalled();
  },
);

it('uses operation-local roots and lookup-only without changing SDK version paths', async () => {
  const { source, target } = await fixture();
  const calls: { paths: string[]; root: string; lookup: boolean }[] = [];
  const sdk = {
    isFeatureAvailable: () => true,
    saveCache: async () => 1,
    restoreCache: async (
      paths: string[],
      key: string,
      _fallback?: string[],
      options?: { lookupOnly?: boolean },
    ) => {
      calls.push({ paths, root: process.cwd(), lookup: !!options?.lookupOnly });
      return key;
    },
  };
  const backend = createGitHubBaseCacheBackend(sdk, source);
  await backend.restoreCache([path.join(target, 'data/**')], 'exact', [], { archiveRoot: target });
  expect(await backend.lookupCache!([path.join(source, 'data/**')], 'exact')).toBe('exact');
  expect(calls).toEqual([
    { paths: ['data/**'], root: target, lookup: false },
    { paths: ['data/**'], root: source, lookup: true },
  ]);
});
