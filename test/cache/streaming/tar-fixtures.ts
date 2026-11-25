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

// Independent fixture encoder; no production TAR/PAX encoder is used here.
export function tarHeader(
  name: string,
  size = 0,
  options: { type?: string; mode?: number; time?: number; uid?: number } = {},
): Buffer {
  const b = Buffer.alloc(512);
  b.write(name, 0, 100);
  for (const [offset, length, value] of [
    [100, 8, options.mode ?? 420],
    [108, 8, options.uid ?? 0],
    [116, 8, 0],
    [124, 12, size],
    [136, 12, options.time ?? 0],
  ]) {
    b.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, 'ascii');
  }
  b[156] = (options.type ?? '0').charCodeAt(0);
  b.write('ustar\0', 257, 'ascii');
  b.write('00', 263, 'ascii');
  return checksum(b);
}
export function checksum(b: Buffer): Buffer {
  b.fill(32, 148, 156);
  b.write(
    [...b]
      .reduce((n, byte) => n + byte, 0)
      .toString(8)
      .padStart(6, '0') + '\0 ',
    148,
    'ascii',
  );
  return b;
}
export function tarMember(
  name: string,
  body: Buffer = Buffer.alloc(0),
  options: Parameters<typeof tarHeader>[2] = {},
): Buffer {
  return Buffer.concat([
    tarHeader(name, body.length, options),
    body,
    Buffer.alloc((512 - (body.length % 512)) % 512),
  ]);
}
export function paxRecord(key: string, value: string | Buffer): Buffer {
  const suffix = Buffer.concat([
    Buffer.from(` ${key}=`),
    Buffer.isBuffer(value) ? value : Buffer.from(value),
    Buffer.from('\n'),
  ]);
  let length = suffix.length + 1;
  while (length !== String(length).length + suffix.length) {
    length = String(length).length + suffix.length;
  }
  return Buffer.concat([Buffer.from(String(length)), suffix]);
}
export const ends = Buffer.alloc(1024);
export function paxArchive(body: Buffer, fileName = 'payload/aggregate/f'): Buffer {
  return Buffer.concat([tarMember('PaxHeader', body, { type: 'x' }), tarMember(fileName), ends]);
}
