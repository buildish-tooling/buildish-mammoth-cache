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

import type { Readable, Writable } from 'node:stream';

/** Narrow declarations for the upstream streaming API used by Mammoth. */
export interface Header {
  name: string;
  type: string;
  size: number;
  mode: number;
  uid: number;
  gid: number;
  mtime: Date;
  mtimeMs?: number;
  linkname: string | null;
  uname: string;
  gname: string;
  pax: Record<string, string> | null;
}
export interface Entry extends Readable {
  header: Header;
}
export interface Extract extends Writable, AsyncIterable<Entry> {
  on(
    event: 'entry',
    listener: (header: Header, body: Entry, next: (error?: Error) => void) => void,
  ): this;
  on(event: string, listener: (...args: any[]) => void): this;
}
export function extract(options?: { mammothStrict?: boolean; highWaterMark?: number }): Extract;

export interface PackHeader {
  name: string;
  type?: 'file' | 'directory';
  size?: number;
  mode?: number;
  mtime?: Date;
  uid?: number;
  gid?: number;
  uname?: string;
  gname?: string;
  pax?: Record<string, string>;
}
export interface Pack extends Readable {
  entry(header: PackHeader, callback?: (error?: Error | null) => void): Writable;
  entry(header: PackHeader, body: Buffer, callback?: (error?: Error | null) => void): Writable;
  finalize(): void;
}
export function pack(options?: { highWaterMark?: number }): Pack;
