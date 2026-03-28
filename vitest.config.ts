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

import { defineConfig } from 'vitest/config';

/**
 * Whether the integration test project should be included in this Vitest run.
 *
 * The integration tests in `test/integration/` run actual Gradle and Maven builds, which
 * require Java 21+ and take several minutes each. They are therefore opt-in: set the
 * environment variable `INTEGRATION_TESTS=1` to include them in the run, e.g.:
 *
 *   INTEGRATION_TESTS=1 npm run test
 *   make integration-test
 *
 * When the variable is absent (the normal case for `make check` and local unit-test runs),
 * the integration project is simply not registered and Vitest will only execute unit tests.
 */
const runIntegrationTests = process.env['INTEGRATION_TESTS'] === '1';

export default defineConfig({
  test: {
    /**
     * Two Vitest projects: `unit` (always runs) and `integration` (opt-in via INTEGRATION_TESTS=1).
     *
     * Using a projects array keeps coverage, environment, and timeout settings isolated between
     * the two suites. Coverage is collected for the unit project only — the integration tests
     * exercise the same source paths but are not included in the PR coverage report because they
     * require external tooling and take much longer.
     */
    projects: [
      {
        test: {
          name: 'unit',
          // Include all test files except the integration subdirectory.
          include: ['test/**/*.test.ts'],
          exclude: ['test/integration/**/*.test.ts'],
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
      },
      // Integration project is only registered when INTEGRATION_TESTS=1 is set so that the
      // normal `make check` / `npm run test` path stays fast and free of external dependencies.
      ...(runIntegrationTests
        ? [
            {
              test: {
                name: 'integration',
                include: ['test/integration/**/*.test.ts'],
                environment: 'node',
                // Each integration test runs real Gradle or Maven builds and may need several
                // minutes. 10 minutes is conservative enough to avoid false-positive timeouts
                // on a cold Gradle/Maven cache while still catching genuine hangs.
                testTimeout: 600_000,
              },
            },
          ]
        : []),
    ],
  },
});
