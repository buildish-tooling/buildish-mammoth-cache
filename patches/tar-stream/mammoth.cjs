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

// Protocol: docs/dev/cache-protocol.md#tar-profile
// Called only by the extractor's opt-in Mammoth profile; stock decoding is unchanged.
const MAX_EXTENSION_BYTES = 64 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function invalid(message) {
  throw new Error(`Invalid Mammoth TAR: ${message}`);
}
function number(raw, offset, size, base256 = false) {
  const bytes = raw.subarray(offset, offset + size);
  let value = 0n;
  if (bytes[0] === 128 && base256) {
    for (const b of bytes.subarray(1)) value = value * 256n + BigInt(b);
  } else {
    let ended = false,
      digits = false;
    for (const b of bytes) {
      if (b === 0 || b === 32) {
        if (b === 0 || digits) ended = true;
        continue;
      }
      if (ended || b < 48 || b > 55) invalid('octal field');
      digits = true;
      value = value * 8n + BigInt(b - 48);
    }
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid('unsafe integer');
  return Number(value);
}
function text(raw, offset, size) {
  const bytes = raw.subarray(offset, offset + size),
    end = bytes.indexOf(0);
  try {
    return utf8.decode(end < 0 ? bytes : bytes.subarray(0, end));
  } catch {
    invalid('UTF-8');
  }
}
function checkHeader(raw) {
  if (
    !raw.subarray(257, 263).equals(Buffer.from('ustar\0')) ||
    !raw.subarray(263, 265).equals(Buffer.from('00'))
  )
    invalid('USTAR header');
  if (![0, 48, 53, 120].includes(raw[156])) invalid('entry type');
  for (const [offset, size] of [
    [0, 100],
    [345, 155],
  ])
    text(raw, offset, size);
  if (text(raw, 157, 100) || text(raw, 265, 32) || text(raw, 297, 32)) invalid('link/owner names');
  if (number(raw, 108, 8) || number(raw, 116, 8) || number(raw, 329, 8) || number(raw, 337, 8))
    invalid('owner/device numbers');
  if (number(raw, 100, 8) > 511) invalid('mode');
  number(raw, 148, 8);
  number(raw, 124, 12, true);
  number(raw, 136, 12);
}
function admit(header, pending) {
  if (
    header.type === 'pax-header' &&
    (pending || header.size === 0 || header.size > MAX_EXTENSION_BYTES)
  )
    invalid('PAX admission');
}
function decodePax(buf) {
  const result = Object.create(null);
  let offset = 0;
  while (offset < buf.length) {
    let cursor = offset,
      length = 0;
    if (buf[cursor] < 49 || buf[cursor] > 57) invalid('PAX length');
    while (cursor < buf.length && buf[cursor] !== 32) {
      if (cursor - offset >= 5 || buf[cursor] < 48 || buf[cursor] > 57) invalid('PAX length');
      length = length * 10 + buf[cursor++] - 48;
    }
    const end = offset + length;
    if (
      cursor === buf.length ||
      length > MAX_EXTENSION_BYTES ||
      end > buf.length ||
      end <= cursor + 2 ||
      buf[end - 1] !== 10
    )
      invalid('PAX boundary');
    const equal = buf.indexOf(61, cursor + 1),
      keySize = equal - cursor - 1;
    if (equal < 0 || equal >= end - 1 || keySize < 4 || keySize > 5) invalid('PAX key');
    const key = buf.toString('utf8', cursor + 1, equal);
    if (!['path', 'size', 'mtime'].includes(key)) invalid('PAX key');
    if (Object.hasOwn(result, key)) invalid('duplicate PAX key');
    let value;
    try {
      value = utf8.decode(buf.subarray(equal + 1, end - 1));
    } catch {
      invalid('PAX UTF-8');
    }
    if (key === 'path' && !value) invalid('empty PAX path');
    if (
      key === 'size' &&
      (!/^(?:0|[1-9][0-9]*)$/.test(value) ||
        value.length > 16 ||
        BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER))
    )
      invalid('PAX size');
    if (key === 'mtime') {
      const m = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,3}))?$/.exec(value);
      if (
        !m ||
        m[1].length > 13 ||
        BigInt(m[1]) * 1000n + BigInt((m[2] ?? '').padEnd(3, '0')) > BigInt(Number.MAX_SAFE_INTEGER)
      )
        invalid('PAX mtime');
    }
    result[key] = value;
    offset = end;
  }
  return result;
}
function effective(header, rawName) {
  const control = header.name.startsWith('.mammoth-meta/');
  if (header.pax && (control || rawName.startsWith('.mammoth-meta/'))) invalid('control PAX');
  if (!Number.isSafeInteger(header.size) || header.size < 0) invalid('size');
  let time;
  if (header.pax?.mtime) {
    const [whole, frac = ''] = header.pax.mtime.split('.');
    time = Number(BigInt(whole) * 1000n + BigInt(frac.padEnd(3, '0')));
  } else time = header.mtime.getTime();
  if (!Number.isSafeInteger(time) || time < 0) invalid('mtime');
  header.mtimeMs = time;
  if (control) {
    if (
      header.type !== 'file' ||
      header.mode !== 384 ||
      time !== 0 ||
      header.size > MAX_EXTENSION_BYTES
    )
      invalid('control header');
    return;
  }
  if (header.type === 'directory') {
    if (header.size !== 0 || header.mode !== 493 || time !== 0 || !header.name.endsWith('/'))
      invalid('directory header');
  } else if (header.type !== 'file' || header.mode !== (420 | (header.mode & 73)))
    invalid('file header');
}
module.exports = { checkHeader, admit, decodePax, effective };
