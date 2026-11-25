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

// SDK transport double only. Real entrypoints/adapters/lifecycle and owned files execute.
import { cp, mkdir, readFile, writeFile, readdir, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = () => process.env.MAMMOTH_TEST_STORE!;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export async function trace(event: string, detail: unknown = null) {
  await appendFile(process.env.MAMMOTH_TEST_TRACE!, JSON.stringify([event, detail]) + '\n');
}
async function rows(kind: string): Promise<Record<string, unknown>[]> {
  await mkdir(root() + '/' + kind, { recursive: true });
  const entries = await readdir(root() + '/' + kind);
  return Promise.all(
    entries
      .filter((n) => n.endsWith('.json'))
      .sort()
      .map(async (n) => JSON.parse(await readFile(root() + '/' + kind + '/' + n, 'utf8'))),
  );
}
export function isFeatureAvailable() {
  return process.env.MAMMOTH_TEST_UNAVAILABLE !== '1';
}
export async function saveCache(paths: string[], key: string) {
  await trace('cache-save', { paths, key });
  if (process.env.MAMMOTH_TEST_EXIT_SAVE === '1') {
    process.exit(73);
  }
  const id = hash(key + JSON.stringify(paths)),
    dir = root() + '/cache/' + id;
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < paths.length; i++) {
    await cp(path.resolve(paths[i]), dir + '/' + i, { recursive: true, preserveTimestamps: true });
  }
  await writeFile(dir + '.json', JSON.stringify({ key, paths, dir }));
  if (process.env.MAMMOTH_TEST_OCCUPY_RETURN === '1' && key.includes('-p-data-')) {
    const managed = process.env.MAVEN_USER_HOME ?? process.env.GRADLE_USER_HOME!;
    await mkdir(managed + '/data', { recursive: true });
    await writeFile(managed + '/data/a', 'foreign return occupant');
  }
  return 1;
}
export async function restoreCache(
  paths: string[],
  key: string,
  prefixes: string[] = [],
  options?: { lookupOnly?: boolean },
) {
  await trace(options?.lookupOnly ? 'cache-lookup' : 'cache-restore', { paths, key });
  if (process.env.MAMMOTH_TEST_FAIL_RESTORE === '1') {
    throw new Error('Fixture restore failed');
  }
  const candidates = await rows('cache');
  for (const prefix of [key, ...prefixes]) {
    const selected = candidates
      .reverse()
      .find(
        (row) =>
          (row.key as string).startsWith(prefix) &&
          JSON.stringify(row.paths) === JSON.stringify(paths),
      );
    if (!selected) {
      continue;
    }
    if (!options?.lookupOnly) {
      for (let i = 0; i < paths.length; i++) {
        await mkdir(path.dirname(path.resolve(paths[i])), { recursive: true });
        await cp(selected.dir + '/' + i, path.resolve(paths[i]), {
          recursive: true,
          preserveTimestamps: true,
        });
      }
    }
    return selected.key as string;
  }
  return undefined;
}
const artifact = {
  async uploadArtifact(name: string, files: string[]) {
    await trace('artifact-upload', name);
    if (process.env.MAMMOTH_TEST_UPLOAD_OUTCOME === 'throw') {
      throw new Error('Fixture raw upload unavailable');
    }
    if (process.env.MAMMOTH_TEST_UPLOAD_OUTCOME === 'null') {
      return null;
    }
    const items = await rows('artifacts'),
      id = items.length + 1,
      bytes = await readFile(files[0]),
      digest = hash(bytes),
      dir = root() + '/artifacts/' + id;
    await mkdir(dir, { recursive: true });
    await cp(files[0], dir + '/' + name);
    const metadata = { id, name, size: bytes.length, digest };
    await writeFile(dir + '.json', JSON.stringify(metadata));
    if (process.env.MAMMOTH_TEST_UPLOAD_OUTCOME === 'lost') {
      throw new Error('Fixture lost upload acknowledgement');
    }
    if (process.env.MAMMOTH_TEST_MUTATE_PACKAGE === '1') {
      await appendFile(files[0], 'changed');
    }
    return metadata;
  },
  async listArtifacts() {
    await trace('artifact-list');
    return { artifacts: await rows('artifacts') };
  },
  async getArtifact(name: string) {
    await trace('artifact-get', name);
    const item = (await rows('artifacts')).find((row) => row.name === name);
    if (!item) {
      throw new Error('Artifact missing');
    }
    return { artifact: item };
  },
  async downloadArtifact(id: number, options: { path: string }) {
    await trace('artifact-download', id);
    const item = (await rows('artifacts')).find((row) => row.id === id)!;
    await mkdir(options.path, { recursive: true });
    const destination = options.path + '/' + item.name;
    await cp(root() + '/artifacts/' + id + '/' + item.name, destination);
    return { downloadPath: destination, digestMismatch: false };
  },
  async deleteArtifact() {
    throw new Error('Unexpected artifact deletion');
  },
};
export default artifact;
