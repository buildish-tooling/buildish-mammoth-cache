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

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        // Interface/type-only files — no executable runtime behaviour.
        'src/build-tool/types.ts',
        'src/cache/backend.ts',
        'src/delta/backend.ts',
        'src/ci/types.ts',
        'src/config/types.ts',
        'src/host/types.ts',
        'src/build-tool/gradle/wrapper/types.ts',
        // Re-export barrels — no logic.
        'src/ci/index.ts',
        'src/ci/github/index.ts',
        // Trivial toolkit delegates (direct pass-through to @actions/*).
        'src/ci/github/cache.ts',
        'src/ci/github/host.ts',
        // Entry-point wrappers — thin orchestrators verified by smoke/e2e tests.
        'src/ci/github/gradle/main.ts',
        'src/ci/github/gradle/post.ts',
        'src/ci/github/maven/main.ts',
        'src/ci/github/maven/post.ts',
      ],
      reporter: ['text', 'html'],
    },
  },
});
