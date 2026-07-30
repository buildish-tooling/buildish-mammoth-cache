---
title: Contributing
weight: 10
description: Local development setup, verification workflow, and a guide to adding a new build-tool adapter.
---

<!--
Copyright 2026 The Buildish Authors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

This page describes everything you need to go from a fresh checkout to a green `make check` run,
and then explains how to add a new build-tool adapter.

For the contribution process (branching model, PR expectations, code-of-conduct) please read
`CONTRIBUTING.md` at the repository root.

---

## Prerequisites

| Tool          | Minimum version                                       | Notes                                                              |
| ------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| Node.js       | as specified in `.nvmrc`                              | Use [nvm](https://github.com/nvm-sh/nvm): `nvm install && nvm use` |
| npm           | as specified in `package.json` `packageManager` field | Provision this exact version after selecting Node.js               |
| Java          | 21+                                                   | Required only for local integration tests; any distribution works  |
| Maven (`mvn`) | 3.9+                                                  | Required only for the Maven distributed-reuse integration test     |

No project tooling needs to be installed globally. The setup below only updates the npm CLI in
the selected nvm-managed Node.js installation; all project dependencies are installed locally
via `npm ci`.

---

## Local setup

```bash
# 1. Select the correct Node.js version
nvm install   # installs if not present, selects the version from .nvmrc
nvm use

# 2. Provision the npm version selected by package.json
npm_version="$(node scripts/resolve-npm-version.mjs)"
if [[ "$(npm --version)" != "$npm_version" ]]; then
  npm install --global --ignore-scripts --no-audit --no-fund "npm@$npm_version"
fi

# 3. Install dependencies (clean install from package-lock.json)
make build    # runs npm ci + tsc + esbuild in one step
```

---

## Running unit tests

```bash
make test           # build (incremental) then run all unit tests
npm run test        # run tests only (assumes build is current)
```

Unit tests live in `test/` and are discovered by Vitest. They run fast (~1 s) and do not
require Java, Maven, or network access.

---

## Running integration tests

Integration tests exercise the full prepare → build → finalize pipeline against real Gradle
and Maven builds, using a local file-based artifact store instead of the CI artifact service.
They take several minutes because Gradle and Maven download dependencies the first time.

```bash
# All local integration tests (requires Java 21+; Maven also required for the Maven test)
make integration-test

# Individual tests
make integration-test-build-reporting           # multi-build Gradle flow with build-reporting
make integration-test-gradle-distributed-reuse  # worker-A → worker-B → aggregator (Gradle)
make integration-test-maven-distributed-reuse   # worker-A → worker-B → aggregator (Maven)
```

To keep the staged workspace on disk after a run (useful for debugging):

```bash
BUILDISH_MAMMOTH_CACHE_KEEP_LOCAL_IT=1 make integration-test-build-reporting
```

The staged root path is printed at the end of each run.

---

## Code quality gate

`make check` is the mandatory gate before committing. It runs everything from a clean slate:

```bash
make check
```

Internally this runs in order: `clean-all` → `build` → `test` → `lint-check` →
`release-legal-category-x-check` → `rat-check`.

Individual steps:

| Command                    | What it does                                                 |
| -------------------------- | ------------------------------------------------------------ |
| `make lint-check`          | ESLint + Prettier format check                               |
| `make lint-fix`            | Auto-fix ESLint issues and rewrite Prettier formatting       |
| `make rat-check`           | Apache RAT license-header verification (requires Java 21+)   |
| `make release-legal-check` | Verify `legal/github/LICENSE` and `legal/github/NOTICE`      |
| `make smoke-test`          | End-to-end smoke test of the bundled GitHub Action           |
| `make zizmor-check`        | GitHub Actions security analysis (requires `zizmor` on PATH) |

---

## Adding a new build-tool adapter

Mammoth Cache is designed so that all build-tool-specific logic is isolated behind the
`BuildToolAdapter` interface (`src/build-tool/types.ts`). The shared prepare and finalize phases
call adapter methods at well-defined lifecycle points and never import tool-specific modules.

To add a new adapter (for example, for `sbt`), you need to:

### 1. Implement `BuildToolAdapter`

Create `src/build-tool/sbt/adapter.ts` and implement every method of the interface:

- **`getName()`** — human-readable name shown in job summaries (e.g. `"sbt"`).
- **`getBuildToolId()`** — stable lowercase machine-readable id baked into every cache manifest
  (e.g. `"sbt"`). This can never be changed without invalidating all existing caches.
- **`getCacheRoot()`** — absolute path to the directory that should be cached (e.g.
  `$HOME/.sbt` or `$HOME/.ivy2/cache`). Read from the normalized action config.
- **`getBuiltInPartitionPresets()`** — return the ordered list of cache partition presets
  relevant to your tool. Model them on the Gradle or Maven presets for reference.
- **`getHardCacheExcludeGlobs()`** — globs for files that must never be cached (lock files,
  daemon sockets, build-tool-internal state that is OS-specific or references absolute paths).
- **`provision(options)`** — download, verify, and install the tool if needed. For tools with a
  wrapper script (like Gradle), verify the JAR; for tools installed via PATH, just check the
  version and log it.
- **`installBuildHooks(context)`** — install any hooks that capture per-invocation build
  metadata (e.g. an init script). If your tool has no hook mechanism, return immediately.
- **`collectBuildReport(context)`** — read the hook output, clean up installed hooks, and return
  a `BuildReport` with Markdown summary lines, plain-text log lines, and per-build metadata.

### 2. Add a config module

Create `src/build-tool/sbt/config.ts` following the pattern of `gradle/config.ts` or
`maven/config.ts`. The config module is responsible for:

- Defining the raw input schema (using the shared `sharedActionInputSchema` as a base).
- Normalizing raw string inputs into a typed `NormalizedSbtConfig`.
- Computing the cache key prefix and the cache root path.
- Wiring the `buildToolAdapterFactory` that the phases call.

### 3. Create CI entry-point files

Create `src/ci/github/sbt/main.ts` and `src/ci/github/sbt/post.ts` following the Gradle or
Maven entry-point files. These are thin wrappers that call `executePrepareAction` and
`executeFinalizeAction` with an `sbt`-specific `buildToolAdapterFactory`.

Add the two new bundles to `package.json`'s `bundle:github:sbt:main` and
`bundle:github:sbt:post` scripts, and wire them in `bundle:github:sbt` and `bundle:github`.

### 4. Add an `action.yml`

Create `actions/github/sbt/action.yml` following the Gradle or Maven action definition. Declare
all inputs (shared ones plus any sbt-specific ones) and the two entry-point `using: node24`
steps.

### 5. Add unit and integration tests

- Unit tests: `test/build-tool/sbt/adapter.test.ts`, `test/build-tool/sbt/config.test.ts`.
- Integration test: `test/integration/sbt-distributed-reuse.test.ts` (if applicable).
- Wire the integration test into the Vitest integration project and add a
  `make integration-test-sbt-distributed-reuse` target.
