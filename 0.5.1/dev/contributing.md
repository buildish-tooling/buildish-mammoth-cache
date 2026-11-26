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

For the contribution process and pull-request expectations, read
[`CONTRIBUTING.md`](https://github.com/buildish-tooling/buildish-mammoth-cache/blob/main/CONTRIBUTING.md).
The repository's
[`CODE_OF_CONDUCT.md`](https://github.com/buildish-tooling/buildish-mammoth-cache/blob/main/CODE_OF_CONDUCT.md)
defines the conduct policy and private reporting route.

---

## Prerequisites

| Tool          | Minimum version                                       | Notes                                                              |
| ------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| Node.js       | as specified in `.nvmrc`                              | Use [nvm](https://github.com/nvm-sh/nvm): `nvm install && nvm use` |
| npm           | as specified in `package.json` `packageManager` field | Provision this exact version after selecting Node.js               |
| Java          | 21+                                                   | Required only for local integration tests; any distribution works  |
| Maven (`mvn`) | 3.9+                                                  | Required for Maven integration tests                               |

No project tooling needs to be installed globally. The setup below only updates the npm CLI in
the selected nvm-managed Node.js installation; all project dependencies are installed locally
via `npm ci`.

`npm run compile` uses the native TypeScript 7 compiler supplied by the pinned
`typescript-native` npm alias. The separate `typescript` alias points to Microsoft's
TypeScript 6 compatibility package so ESLint's parser can continue using its supported
compiler API. Keep both aliases: replacing the compatibility alias with TypeScript 7
breaks API consumers. The alias name `typescript-native` avoids opting into
`typescript-eslint`'s separate experimental `@typescript/native` backend, which requires
TypeScript 7.1. Neither compiler is included in the shipped Action bundles.

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
make integration-test-maven-repository-semantics # installed Resolver, controlled file remotes
```

The repository-semantics suite requires an installed Maven 3.9+ distribution, `java`, `javac`,
and GNU tar. It compiles a small harness against that distribution's own Resolver libraries and
asserts that the enhanced local repository manager is used. It needs no Maven plugins or public
remotes. Projects, remotes, local repositories, and compiled harness files stay under `build/`;
user settings and credentials are not loaded. The suite reports the installed Maven/Resolver
versions and covers origin changes, absent markers, mirrors, local installs, snapshots, cache archive
restore, distributed directory conflicts, excluded-sibling preservation during aggregation/GC, and cutoff GC.
The archive test compares online bytes and origin entries against an independently populated native
repository rather than requiring a fresh download across origins: Resolver 1.9.27 can retain the
cached bytes after an existence check, while Resolver 2.0.24 defaults to downloading them again.
Offline origin rejection remains required when markers are retained.
The snapshot and same-ID URL assertions
were qualified with Maven 3.10.0 / Resolver 2.0.24; qualify other versions before extending those
conclusions. It is opt-in and does not run as part of ordinary `make check`.

The Java-sharing, Groovy-workspace and metadata-eviction suites also use an already installed
Gradle via `BUILDISH_TEST_GRADLE_EXECUTABLE`. Set `BUILDISH_TEST_JAVA_21_HOME` and
`BUILDISH_TEST_JAVA_25_HOME` to full installed JDK homes for the Java-sharing/Groovy cases.
These cases skip locally when their tools are absent. The designated CI integration step
provisions Gradle 9.6.1 and both JDKs and fails if these paths are missing.

### GitHub integration graph

The existing Gradle and Maven reusable workflows retain their standalone round-trip,
duplicate-invocation and fork-safe PR scenarios. On default-branch pushes, their distributed
worker/aggregator graph also exercises native runner interoperability:

| Stage        | Runner           | Java |
| ------------ | ---------------- | ---- |
| Worker A     | Ubuntu 26.04 x64 | 21   |
| Worker B     | Windows 2025 x64 | 25   |
| Worker C     | macOS 15 ARM64   | 21   |
| Aggregator   | Ubuntu 26.04 x64 | 21   |
| Fresh reader | Windows 2025 x64 | 21   |
| Fresh reader | macOS 15 ARM64   | 25   |

The readers repurpose the earlier native smoke jobs and wait for the aggregator's normal
post-job publication. They restore into isolated cache/project locations, require a Mammoth
cache hit and resolve all three workers' dependencies offline. Release-branch pushes retain
Linux distributed checks without native readers; PR scenarios remain read-only.
The Gradle fixture pins 9.6.1; Maven jobs provision a checksum-pinned 3.10.0 distribution
into runner temp. Windows builds use native batch launchers under PowerShell.

Gradle's aggregator is the explicit dependency-metadata writer. It first resolves metadata
online while rejecting JAR re-downloads, then verifies dependencies offline. Readers also
check restored Groovy metadata/empty output directories and a deliberately portable task's
`FROM-CACHE` result. Only worker A seeds that task: independently produced Gradle cache
archives can differ in invocation metadata despite identical outputs. Environment-sensitive
tasks may legitimately recompile. Maven keeps
origin markers and explicitly uses the existing `choose-worker-directory` conflict policy;
this checks artifact resolution, not Maven task-output caching.

A small custom partition checks each worker's contribution using names with spaces, accents,
Unicode and punctuation, plus empty/binary files. POSIX consumers check executable bits and
run restored scripts. The restored Gradle distribution launcher also runs on POSIX. Windows checks file bytes;
arbitrary executable-bit preservation through
Windows republishing is outside this graph. Cache roots use ordinary paths.

Review workflow routing, setup order, native launchers, quoting and assertions before pushing;
use existing static checks and focused local tests. Local review and Linux tests cannot prove
native Windows/macOS behavior or GitHub cache/artifact transport. A passing hosted run is
required for that evidence. The graph does not cover every OS as publisher/aggregator, every
directed OS pair or a Gradle/Maven version matrix.

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
`release-legal-incompatible-license-check` → `rat-check`.

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

- **`getBuildToolId()`** — stable identity bound into the cache model and lifecycle. Adding
  a build tool requires extending the supported identities and validating its model rules.
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
  Post hook cleanup, consumer quiescence and build reports belong to the tool
  lifecycle and post factories. Extend those paths for a new tool as needed.

### 2. Add a config module

Create `src/build-tool/sbt/config.ts` following the pattern of `gradle/config.ts` or
`maven/config.ts`. The config module is responsible for:

- Defining `RawSbtActionInputs` and `NormalizedSbtConfig` by extending the shared types in
  `src/config/types.ts`.
- Adding the tool and its inputs to `src/config/public-contract.ts`, including each allowed
  config-file value representation, and to the typed tool/input mapping in `src/config/inputs.ts`.
- Delegating raw reads and config-file overlay to `src/config/inputs.ts` and shared normalization to
  `src/config/normalize.ts`.
- Normalizing only sbt-specific values, such as its cache root. Shared code owns cache namespace,
  family, lineage, generation, cleanup, and distributed-job settings.

### 3. Create CI entry-point files

Create `src/ci/github/sbt/main.ts` and `src/ci/github/sbt/post.ts` following the Gradle or
Maven entry-point files. These are thin wrappers around `runStreamingPrepare` and
`runStreamingPost`, with tool-specific construction in prepare and deferred
services in post.

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
