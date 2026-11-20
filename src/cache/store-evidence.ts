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
import path from 'node:path';
import { fileIdentity, sameFileIdentity, type FileIdentity } from './file-identity';
import {
  guardedPath,
  hashGuardedFile,
  regularStat,
  verifyParents,
  type DirectoryValidationBatch,
} from './guarded-files';

/** One finalize invocation owns these proofs. Never serialize them or share across retries. */
export class StoreEvidence {
  private transportDirectories?: ReadonlyMap<string, FileIdentity>;
  private transportSealed = false;
  private readonly snapshotDirectories = new Map<string, string>();
  private readonly digests = new Map<string, { digest: string; identity: FileIdentity }>();
  private readonly work = new Map<string, { count: number; ms: number; bytes: number }>();
  async measure<T>(name: string, action: () => Promise<T>, bytes = 0): Promise<T> {
    const start = performance.now();
    try {
      return await action();
    } finally {
      const entry = this.work.get(name) ?? { count: 0, ms: 0, bytes: 0 };
      entry.count++;
      entry.ms += performance.now() - start;
      entry.bytes += bytes;
      this.work.set(name, entry);
    }
  }
  observeDirectories(directories: ReadonlyMap<string, FileIdentity>): void {
    if (this.transportSealed) {
      const previous = this.transportDirectories!;
      if (
        previous.size !== directories.size ||
        [...directories].some(([name, identity]) => {
          const known = previous.get(name);
          return !known || !sameFileIdentity(known, identity, true);
        })
      )
        throw new Error('Frozen publication transport directory changed.');
    } else {
      this.transportDirectories = new Map(
        [...directories].map(([name, identity]) => [name, { ...identity }]),
      );
    }
  }
  sealTransportDirectories(): void {
    if (!this.transportDirectories) throw new Error('Missing publication directory observation.');
    this.transportSealed = true;
  }
  checkSnapshotDirectories(root: string, directories: ReadonlyMap<string, FileIdentity>): void {
    const signature = JSON.stringify(
      [...directories].map(([name, identity]) => {
        const { dev, ino, size, mode, mtimeMs, ctimeMs } = identity;
        return [name, dev, ino, size, mode, mtimeMs, ctimeMs];
      }),
    );
    const previous = this.snapshotDirectories.get(root);
    if (previous !== undefined && previous !== signature)
      throw new Error('Frozen snapshot directory changed.');
    this.snapshotDirectories.set(root, signature);
  }
  remember(root: string, relative: string, digest: string, identity: FileIdentity): void {
    this.digests.set(guardedPath(root, relative), { digest, identity: { ...identity } });
  }
  async hash(
    root: string,
    relative: string,
    expected: { size: number; contentSha256?: string },
    native?: FileIdentity,
    directories?: DirectoryValidationBatch,
  ): Promise<string> {
    const key = guardedPath(root, relative);
    await verifyParents(root, path.posix.dirname(relative), false, directories);
    const current = await regularStat(key);
    if (
      !current ||
      current.size !== expected.size ||
      (native && !sameFileIdentity(native, fileIdentity(current), true))
    )
      throw new Error(`Frozen store source changed: ${relative}`);
    const known = this.digests.get(key);
    if (known && sameFileIdentity(known.identity, fileIdentity(current), true)) {
      if (expected.contentSha256 && known.digest !== expected.contentSha256)
        throw new Error(`Store digest binding changed: ${relative}`);
      return known.digest;
    }
    if (known) throw new Error(`Frozen store source changed: ${relative}`);
    const identity = fileIdentity(current);
    const digest = await this.measure(
      'payload-hash',
      () => hashGuardedFile(root, relative, expected, identity, directories),
      expected.size,
    );
    this.remember(root, relative, digest, identity);
    return digest;
  }
  measureSync<T>(name: string, action: () => T): T {
    const start = performance.now();
    try {
      return action();
    } finally {
      const entry = this.work.get(name) ?? { count: 0, ms: 0, bytes: 0 };
      entry.count++;
      entry.ms += performance.now() - start;
      this.work.set(name, entry);
    }
  }
  lines(): string[] {
    return [...this.work].map(
      ([name, w]) =>
        `Publication work ${name}: ${w.count} operation(s), ${w.bytes} byte(s), ${w.ms.toFixed(1)} ms.`,
    );
  }
}
