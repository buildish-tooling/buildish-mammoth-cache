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

import * as manifestFacade from '../../src/cache/manifest';
import * as manifestFormat from '../../src/cache/manifest-format';

describe('cache manifest module boundary', () => {
  it('preserves the manifest facade for format and delta consumers', () => {
    expect(manifestFacade.CACHE_MANIFEST_SCHEMA_VERSION).toBe(
      manifestFormat.CACHE_MANIFEST_SCHEMA_VERSION,
    );
    expect(manifestFacade.calculateCanonicalCacheManifestDigest).toBe(
      manifestFormat.calculateCanonicalCacheManifestDigest,
    );
    expect(manifestFacade.computeCacheDelta).toBe(manifestFormat.computeCacheDelta);
    expect(manifestFacade.deserializeCacheDeltaManifest).toBe(
      manifestFormat.deserializeCacheDeltaManifest,
    );
    expect(manifestFacade.deserializeCacheManifest).toBe(manifestFormat.deserializeCacheManifest);
    expect(manifestFacade.serializeCacheDeltaManifest).toBe(
      manifestFormat.serializeCacheDeltaManifest,
    );
    expect(manifestFacade.serializeCacheManifest).toBe(manifestFormat.serializeCacheManifest);
  });

  it('keeps filesystem capture outside the provider-neutral format module', () => {
    expect('captureCacheManifest' in manifestFormat).toBe(false);
    expect('captureCacheMetadataSnapshot' in manifestFormat).toBe(false);
    expect(manifestFacade.captureCacheManifest).toBeTypeOf('function');
    expect(manifestFacade.captureCacheMetadataSnapshot).toBeTypeOf('function');
  });
});
