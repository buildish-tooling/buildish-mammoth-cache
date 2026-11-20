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

import { createHash, type Hash } from 'node:crypto';

// Protocol: docs/dev/cache-protocol.md#scalar-encoding and #digest-framing
export type Value = string | number | null | readonly Value[];
export const RECORD_BYTES = 64 * 1024;
export const STREAM_CHUNK_BYTES = 256 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export function uint(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  )
    throw new Error('Expected canonical uint.');
  return value;
}
export function add(a: number, b = 1): number {
  return uint(uint(a) + uint(b));
}
export function scalar(value: unknown, nonempty = false): string {
  if (typeof value !== 'string' || (nonempty && !value.length))
    throw new Error('Expected scalar string.');
  for (const character of value) {
    const cp = character.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) throw new Error('Lone UTF-16 surrogate.');
  }
  return value;
}
function quote(value: string): string {
  scalar(value);
  let bytes = 2;
  for (const character of value) {
    const cp = character.codePointAt(0)!;
    bytes += cp < 32 ? 6 : cp === 34 || cp === 92 ? 2 : Buffer.byteLength(character);
    if (bytes > RECORD_BYTES) throw new Error('String exceeds record bound.');
  }
  // eslint-disable-next-line no-control-regex -- canonical JSON escapes all control scalars.
  const escaped = value.replace(/[\u0000-\u001f"\\]/g, (c) =>
    c === '"' ? '\\"' : c === '\\' ? '\\\\' : '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
  return '"' + escaped + '"';
}
/** Iterative tuple walk also rejects objects, booleans and unsafe numbers. */
function* fragments(value: Value): Generator<string> {
  const stack: { values: readonly Value[]; next: number }[] = [];
  const active = new Set<readonly Value[]>();
  let current: Value = value;
  while (true) {
    if (Array.isArray(current)) {
      yield '[';
      if (current.length) {
        if (active.has(current)) throw new Error('Cyclic canonical array.');
        active.add(current);
        stack.push({ values: current, next: 1 });
        current = current[0];
        continue;
      }
      yield ']';
    } else if (typeof current === 'string') yield quote(current);
    else if (current === null) yield 'null';
    else if (
      typeof current === 'number' &&
      Number.isSafeInteger(current) &&
      !Object.is(current, -0)
    )
      yield String(current);
    else throw new Error('Invalid canonical value.');
    while (stack.length && stack[stack.length - 1].next === stack[stack.length - 1].values.length) {
      active.delete(stack.pop()!.values);
      yield ']';
    }
    if (!stack.length) return;
    const frame = stack[stack.length - 1];
    yield ',';
    current = frame.values[frame.next++];
  }
}
export function canonical(value: Value, maxBytes = RECORD_BYTES): Buffer {
  const parts: string[] = [];
  let bytes = 0;
  for (const part of fragments(value)) {
    bytes = add(bytes, Buffer.byteLength(part));
    if (bytes > maxBytes) throw new Error('Record exceeds byte bound.');
    parts.push(part);
  }
  return Buffer.from(parts.join(''));
}
export function encodeRecord(value: Value): Buffer {
  return Buffer.concat([canonical(value, RECORD_BYTES - 1), Buffer.from('\n')]);
}
export function decodeRecord(bytes: Uint8Array): Value {
  if (bytes.byteLength > RECORD_BYTES || !bytes.byteLength || bytes[bytes.byteLength - 1] !== 10)
    throw new Error('Invalid bounded record framing.');
  const value = JSON.parse(utf8.decode(bytes)) as Value;
  if (!encodeRecord(value).equals(bytes)) throw new Error('Noncanonical record encoding.');
  return value;
}
export interface RecordFrame {
  readonly value: Value;
  readonly raw: Buffer;
  readonly start: number;
  readonly end: number;
  readonly index: number;
}
export async function* decodeRecords(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<RecordFrame> {
  const record = Buffer.allocUnsafe(RECORD_BYTES);
  let length = 0,
    offset = 0,
    index = 0;
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array) || chunk.byteLength > STREAM_CHUNK_BYTES)
      throw new Error('Invalid resident stream chunk.');
    for (let at = 0; at < chunk.byteLength;) {
      const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        lf = bytes.indexOf(10, at),
        end = lf < 0 ? bytes.length : lf + 1,
        size = end - at;
      if (length + size > RECORD_BYTES) throw new Error('Record exceeds byte bound.');
      bytes.copy(record, length, at, end);
      length += size;
      at = end;
      if (lf >= 0) {
        const raw = Buffer.from(record.subarray(0, length)),
          start = offset;
        offset = add(offset, length);
        index = add(index);
        length = 0;
        yield { value: decodeRecord(raw), raw, start, end: offset, index };
      }
    }
  }
  if (length) throw new Error('Truncated NDJSON record.');
}
export async function* encodeRecords(
  records: AsyncIterable<Value> | Iterable<Value>,
): AsyncGenerator<Buffer> {
  for await (const value of records) yield encodeRecord(value);
}
export class Digest {
  private hash: Hash;
  constructor(domain: string) {
    if (!/^[a-z][a-z0-9-]*$/.test(domain)) throw new Error('Invalid digest domain.');
    this.hash = createHash('sha256').update(`mammoth:${domain}:1\0`);
  }
  update(value: Value): this {
    return this.encoded(canonical(value));
  }
  encoded(bytes: Buffer): this {
    const n = Buffer.allocUnsafe(8);
    n.writeBigUInt64BE(BigInt(bytes.length));
    this.hash.update(n).update(bytes);
    return this;
  }
  /** For already bounded model/producer configuration projections, never file lists. */
  projection(value: Value): this {
    let size = 0;
    for (const part of fragments(value)) size = add(size, Buffer.byteLength(part));
    const n = Buffer.allocUnsafe(8);
    n.writeBigUInt64BE(BigInt(size));
    this.hash.update(n);
    for (const part of fragments(value)) this.hash.update(part);
    return this;
  }
  copy(): Digest {
    const copy = new Digest('copy');
    copy.hash = this.hash.copy();
    return copy;
  }
  digest(): string {
    return this.hash.copy().digest('hex');
  }
}
export const H = (domain: string, value: Value): string =>
  new Digest(domain).projection(value).digest();
export const rawSha = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
export function tuple(value: Value, tag?: string, length?: number): readonly Value[] {
  if (
    !Array.isArray(value) ||
    (tag !== undefined && value[0] !== tag) ||
    (length !== undefined && value.length !== length)
  )
    throw new Error(`Invalid ${tag ?? 'tuple'} shape.`);
  return value;
}
export function equal(a: Value, b: Value, label = 'binding'): void {
  if (!canonical(a).equals(canonical(b))) throw new Error(`Mismatched ${label}.`);
}
