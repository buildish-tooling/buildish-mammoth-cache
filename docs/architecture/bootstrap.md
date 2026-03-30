---
title: Bootstrap Process
weight: 40
description: How the action initializes configuration, the cache model, and wrapper provisioning before handing off to the build.
---

<!--
Copyright 2026 The Apache Software Foundation

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

The bootstrap process runs at the start of every phase (prepare and finalize). It resolves
configuration, builds the cache model, and provisions Gradle wrappers — all before any
cache-specific logic runs.

## Entrypoints

The two CI-facing entrypoints call into the shared phase logic:

| Phase    | CI entrypoint                | Phase entry function     |
| -------- | ---------------------------- | ------------------------ |
| prepare  | `src/phases/prepare/cli.ts`  | `runPrepareExecution()`  |
| finalize | `src/phases/finalize/cli.ts` | `runFinalizeExecution()` |

Both entry functions call `bootstrapPhase()` from `src/phases/bootstrap.ts` as their first step.

## Prepare phase

```mermaid
flowchart TD
    A[runPrepareExecution] --> B[bootstrapPhase]
    B --> C[Read & validate config]
    C --> D[Build CacheModel]
    D --> E[provisionWrapperJars]
    E --> F[executePrepareAction]
    F --> G[restoreBaseCache]
    G --> H[armBaseCacheFinalize]
    H --> I[capture pre-build manifest]
    I --> J[download + apply delta artifacts\nif distributed-worker]
    J --> Z[hand off to build steps]
```

**`bootstrapPhase()`** (`src/phases/bootstrap.ts`):

1. Reads action inputs (via `HostInputSource`).
2. Optionally loads and merges a config file.
3. Validates and normalizes the merged config with Zod.
4. Detects the Java major version by running `java -version`.
5. Constructs the `CacheModel` (`src/cache/model.ts`): partition definitions, cache keys, path
   calculations.
6. Calls `provisionWrapperJars()` (`src/gradle/wrapper/download.ts`) to download, verify, and
   install any missing `gradle-wrapper.jar` files referenced by discovered properties files.

**`executePrepareAction()`** (`src/phases/prepare/flow.ts`):

1. Calls `restoreBaseCache()` which classifies the restore outcome (miss / partial-hit / exact-hit).
2. If restore-cleanup mode is `prune-managed`, deletes managed files and re-restores.
3. Arms the finalize phase via `armBaseCacheFinalize()` (writes a state flag so the finalize phase
   knows a restore was attempted).
4. Captures the pre-build file snapshot (`captureCacheManifest()`).
5. For `distributed-worker` or `distributed-aggregator` modes, downloads and applies applicable
   delta artifact packages.

## Finalize phase

```mermaid
flowchart TD
    A[runFinalizeExecution] --> B[bootstrapPhase]
    B --> C[Read & validate config]
    C --> D[Build CacheModel]
    D --> E[provisionWrapperJars]
    E --> F[executeFinalizeAction]
    F --> G{isBaseCacheFinalizeArmed?}
    G -- No --> Z1[skip save]
    G -- Yes --> H[capture post-build manifest]
    H --> I[computeCacheDelta]
    I --> J[saveBaseCache\nif eligible]
    I --> K[stageDeltaArtifact +\nuploadDeltaArtifact\nif distributed-worker]
    J --> Z2[done]
    K --> Z2
```

**`executeFinalizeAction()`** (`src/phases/finalize/flow.ts`):

1. Checks that the finalize arm flag is set (written by the prepare phase).
2. Captures the post-build file snapshot.
3. Calls `computeCacheDelta()` (`src/cache/manifest.ts`) to diff pre- and post-build manifests.
4. Calls `saveBaseCache()` (skipped for `distributed-worker`; see [Base Cache Design](../base-cache/)).
5. For `distributed-worker`: stages the delta artifact locally, then uploads it.
6. For `distributed-aggregator`: downloads worker deltas, merges them, applies the merged delta.

## Configuration loading

The full priority order for action configuration:

```
Action input overrides
        ↓
Config-file values (workspace-relative .yml / .json / .yaml)
        ↓
Built-in defaults
```

Validation is performed with Zod schemas (`src/config/action-config.ts`) after merging all layers.
If any value is invalid, the action fails at bootstrap before touching the cache or wrappers.

## Cache model

The `CacheModel` (`src/cache/model.ts`) is constructed once during bootstrap and passed through the
whole phase. It encapsulates:

- The resolved `GRADLE_USER_HOME` path.
- The active partition list with their computed include/exclude globs.
- The rendered primary cache key.
- The ordered restore key sequence.
- The computed `partitionFingerprint`.

The `CacheModel` is intentionally immutable after construction so that both phases see exactly the
same partition layout and key values.
