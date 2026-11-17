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

import type { Stats } from 'node:fs';
import { z } from 'zod';

const nativeNumber = z.number().finite();
export const fileIdentitySchema = z
  .object({
    dev: nativeNumber,
    ino: nativeNumber,
    mode: nativeNumber,
    size: nativeNumber,
    atimeMs: nativeNumber,
    mtimeMs: nativeNumber,
    ctimeMs: nativeNumber,
  })
  .strict();
export type FileIdentity = z.infer<typeof fileIdentitySchema>;
export function fileIdentity(stats: Stats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    atimeMs: stats.atimeMs,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}
/** Ignore access time only for reads attributed to Mammoth inside its exclusive boundary. */
export function sameFileIdentity(a: FileIdentity, b: FileIdentity, ownRead = false): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    (ownRead || a.atimeMs === b.atimeMs)
  );
}
