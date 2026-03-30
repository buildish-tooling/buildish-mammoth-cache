/*
 * Copyright 2026 The Apache Software Foundation
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

import { describe, expect, it } from 'vitest';

import {
  normalizeUserSuppliedRelativePath,
  validateNormalizedRelativePosixPath,
} from '../../src/util/paths';
import { parseSerializedJson } from '../../src/util/serialization';

describe('validation helpers', () => {
  it('parses serialized JSON and surfaces the underlying JSON syntax error', () => {
    expect(parseSerializedJson('{"ok":true}', 'fixture')).toEqual({ ok: true });
    expect(parseSerializedJson('[1,2,3]', 'fixture')).toEqual([1, 2, 3]);
    expect(() => parseSerializedJson('not-json', 'fixture')).toThrow(/Could not parse serialized/u);
  });

  it('validates normalized relative POSIX paths for caller-defined roots', () => {
    expect(validateNormalizedRelativePosixPath('payload/000001.bin', 'path', 'the package')).toBe(
      'payload/000001.bin',
    );
    expect(() => validateNormalizedRelativePosixPath('../escape', 'path', 'the package')).toThrow(
      /normalized relative POSIX path inside the package/u,
    );
    expect(() =>
      validateNormalizedRelativePosixPath('payload\\000001.bin', 'path', 'the package'),
    ).toThrow(/normalized relative POSIX path inside the package/u);
    expect(() => validateNormalizedRelativePosixPath('\\escape', 'path', 'the package')).toThrow(
      /normalized relative POSIX path inside the package/u,
    );
    expect(() =>
      validateNormalizedRelativePosixPath('\\\\server\\share\\payload.bin', 'path', 'the package'),
    ).toThrow(/normalized relative POSIX path inside the package/u);
    expect(() => validateNormalizedRelativePosixPath('C:/escape', 'path', 'the package')).toThrow(
      /normalized relative POSIX path inside the package/u,
    );
  });

  it('normalizes user-supplied relative paths to canonical POSIX form', () => {
    expect(normalizeUserSuppliedRelativePath('tools\\app\\gradle', 'path')).toBe(
      'tools/app/gradle',
    );
    expect(normalizeUserSuppliedRelativePath('tools/./app\\gradle/', 'path')).toBe(
      'tools/app/gradle',
    );
    expect(() => normalizeUserSuppliedRelativePath('\\Windows\\Blah', 'path')).toThrow(
      /must be a relative path/u,
    );
    expect(() => normalizeUserSuppliedRelativePath('\\\\server\\share\\repo', 'path')).toThrow(
      /must be a relative path/u,
    );
    expect(() => normalizeUserSuppliedRelativePath('C:\\repo', 'path')).toThrow(
      /must be a relative path/u,
    );
    expect(() => normalizeUserSuppliedRelativePath('../repo', 'path')).toThrow(
      /must stay within the repository workspace/u,
    );
  });
});
