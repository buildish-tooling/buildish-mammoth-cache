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

import { describe, expect, it } from 'vitest';

import * as buildResults from '../../../src/build-tool/gradle/build-results';
import {
  SERVICE_PLUGIN_FILE_NAME,
  createInitScriptContents,
  createServicePluginContents,
  toGroovySingleQuotedString,
  validateCaptureRootPath,
} from '../../../src/build-tool/gradle/build-result-capture-scripts';

describe('Gradle build-result capture script boundary', () => {
  it('preserves the build-results facade for path-embedding controls', () => {
    expect(buildResults.toGroovySingleQuotedString).toBe(toGroovySingleQuotedString);
    expect(buildResults.validateCaptureRootPath).toBe(validateCaptureRootPath);
  });

  it('generates paired scripts with the same safely encoded capture root', () => {
    const captureRoot = "/runner's-temp/.buildish-mammoth-cache";
    const captureRootLiteral = "'/runner\\'s-temp/.buildish-mammoth-cache'";

    const initScript = createInitScriptContents(captureRoot);
    const servicePlugin = createServicePluginContents(captureRoot);

    expect(initScript).toContain(`apply from: '${SERVICE_PLUGIN_FILE_NAME}'`);
    expect(initScript).toContain(`def captureRootDir = ${captureRootLiteral}`);
    expect(servicePlugin).toContain(`def captureRootDir = ${captureRootLiteral}`);
  });

  it.each(['$', '`', '\n', '\r', '\0'])(
    'rejects %j before generating executable Groovy',
    (value) => {
      const captureRoot = `/runner/${value}/.buildish-mammoth-cache`;

      expect(() => createInitScriptContents(captureRoot)).toThrow(/not permitted/iu);
      expect(() => createServicePluginContents(captureRoot)).toThrow(/not permitted/iu);
    },
  );

  it('generates disabled scripts without embedding an environment path', () => {
    expect(createInitScriptContents(null)).toContain('def captureRootDir = null');
    expect(createServicePluginContents(null)).toContain('def captureRootDir = null');
  });
});
