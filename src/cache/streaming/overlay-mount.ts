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

import { execFile } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import { release } from 'node:os';
import { promisify } from 'node:util';

export interface OverlayMountPaths {
  readonly target: string;
  readonly lower: string;
  readonly upper: string;
  readonly work: string;
}

export interface OverlayMountInfo {
  readonly namespace: string;
  readonly id: string;
  readonly filesystem: string;
  readonly root: string;
  readonly options: readonly string[];
}

export interface OverlayMountDriver {
  inspect(target: string, backingRoot?: string): Promise<OverlayMountInfo | null>;
  mount(paths: OverlayMountPaths): Promise<void>;
  unmount(target: string): Promise<void>;
  claimPrivateWork?(directory: string, uid: number): Promise<void>;
}

const exec = promisify(execFile);
const unescapeMountPath = (value: string) =>
  value.replace(/\\([0-7]{3})/gu, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );

/** Mount in the calling runner's namespace so subsequent action steps see it. */
export function linuxOverlayMount(useHostedSudo = false): OverlayMountDriver | undefined {
  if (process.platform !== 'linux') {
    return undefined;
  }
  async function command(name: 'mount' | 'umount' | 'chown', args: string[]) {
    const executable = '/usr/bin/' + name;
    await exec(
      useHostedSudo ? '/usr/bin/sudo' : executable,
      useHostedSudo ? ['-n', '--', executable, ...args] : args,
      { timeout: 15000, maxBuffer: 64 * 1024 },
    );
  }
  return {
    async inspect(target, backingRoot) {
      const [namespace, mounts] = await Promise.all([
        readlink('/proc/self/ns/mnt'),
        readFile('/proc/self/mountinfo', 'utf8'),
      ]);
      let result: OverlayMountInfo | null = null;
      for (const line of mounts.split('\n')) {
        const [head, tail] = line.split(' - ', 2);
        const fields = head.split(' ');
        if (fields.length < 6) {
          continue;
        }
        const mountpoint = unescapeMountPath(fields[4]);
        if (
          mountpoint.startsWith(target + '/') ||
          (backingRoot && (mountpoint === backingRoot || mountpoint.startsWith(backingRoot + '/')))
        ) {
          throw new Error('Unexpected mount beneath OverlayFS state: ' + mountpoint);
        }
        if (mountpoint === target) {
          if (result || !tail) {
            throw new Error('Ambiguous OverlayFS mountpoint: ' + target);
          }
          const [filesystem, , options] = tail.split(' ');
          result = {
            namespace,
            id: fields[0],
            filesystem,
            root: unescapeMountPath(fields[3]),
            options: [...fields[5].split(','), ...options.split(',')].map(unescapeMountPath),
          };
        }
      }
      return result;
    },
    async mount({ target, lower, upper, work }) {
      if (
        [lower, upper, work, target].some(
          (value) => /[,:\\]/u.test(value) || [...value].some((character) => character < ' '),
        )
      ) {
        throw new Error('Unsupported OverlayFS mount path.');
      }
      // userxattr uses user.overlay.* so the same layout works in a rootless test namespace.
      // index=off disables hard-link preservation. Worker capture requires single-link files.
      // metacopy=off makes copied-up files carry their bytes in upper for worker packaging.
      // redirect_dir=nofollow keeps an upper path from referring to a renamed lower subtree.
      // uuid=off avoids storing an overlay UUID in upper. Post uses the namespace and mount ID.
      // nosuid,nodev disable privilege elevation and device access through the merged cache.
      // Linux 7.0 added the explicit fsync=auto spelling. Older kernels use their default.
      const fsync = Number(release().split('.')[0]) >= 7 ? ',fsync=auto' : '';
      await command('mount', [
        '--internal-only',
        '-t',
        'overlay',
        '-o',
        `lowerdir=${lower},upperdir=${upper},workdir=${work},userxattr,index=off,metacopy=off,redirect_dir=nofollow,uuid=off,nosuid,nodev${fsync}`,
        '--',
        'overlay',
        target,
      ]);
    },
    unmount: (target) => command('umount', ['--', target]),
    claimPrivateWork: useHostedSudo
      ? (directory, uid) => command('chown', ['--no-dereference', '--', String(uid), directory])
      : undefined,
  };
}
