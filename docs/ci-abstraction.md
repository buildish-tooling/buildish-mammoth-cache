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

# CI Abstraction Layer

This document describes the provider-neutral seam that separates shared orchestration logic from
CI-provider-specific implementations, and explains what a new provider adapter must supply.

## Design goal

All cache, wrapper, and delta logic lives in the shared `src/` tree and must remain portable. CI
providers differ in how they expose environment variables, state persistence, artifact storage, and
job summaries. The abstraction layer isolates those differences behind stable TypeScript interfaces.

## Interface overview

```
src/ci/types.ts          CiJobContext, CiPlatformAdapter, CiExecutionUrls, HttpHeadersByHost
src/runtime-host/types.ts RuntimeInputSource, RuntimeStateStore, RuntimeOutputSink,
                           RuntimeReporter, RuntimeFailureReporter, CompositeRuntimeHost
src/reporting/types.ts   ReportSink
src/storage/cache.ts     BaseCacheBackend, BaseCacheBackendCapabilities
src/storage/artifacts.ts WorkflowArtifactBackend
```

### `CiJobContext` (`src/ci/types.ts`)

Normalised, read-only metadata about the current CI execution. Shared code reads only from this
struct; it never reads provider-specific environment variables directly.

| Field                      | Description                                           |
| -------------------------- | ----------------------------------------------------- |
| `eventName`                | Raw CI event name, e.g. `push`, `pull_request`        |
| `resolvedRefName`          | Human-readable ref, e.g. `main`, `feature/my-branch`  |
| `safeRefName`              | Cache-key-safe slug derived from `resolvedRefName`    |
| `runnerOs` / `runnerArch`  | Lowercased OS and CPU architecture                    |
| `defaultBranch`            | Repository default branch                             |
| `isPullRequest`            | Whether the event is a pull-request trigger           |
| `repository`               | `owner/name` slug                                     |
| `workflowName` / `jobName` | Display names                                         |
| `runId` / `runAttempt`     | Numeric execution identifiers, or `null`              |
| `tempDirectory`            | Absolute path to the runner temp directory, or `null` |
| `workspace`                | Absolute path to the checked-out workspace            |
| `actionPath`               | Absolute path to the action checkout, or `null`       |

### `CiPlatformAdapter` (`src/ci/types.ts`)

The top-level provider adapter surface consumed by the bootstrap flow.

```typescript
interface CiPlatformAdapter {
  readonly context: CiJobContext;
  readonly httpHeadersByHost: HttpHeadersByHost;
  readonly executionUrls: CiExecutionUrls;
  createBootstrapDiagnosticsLines(phase: CoreExecutionPhase): readonly string[];
}
```

`httpHeadersByHost` carries per-host authentication headers (e.g. `Authorization: Bearer <token>`
for `api.github.com`) without leaking them to unrelated hosts. Shared download code applies these
headers only to exact hostname matches over HTTPS.

### `CompositeRuntimeHost` (`src/runtime-host/types.ts`)

Thin wrapper around provider-specific runtime APIs for input resolution, state persistence, output
emission, and diagnostics.

| Interface                | Methods                 | GitHub Actions mapping               |
| ------------------------ | ----------------------- | ------------------------------------ |
| `RuntimeInputSource`     | `getInput(name)`        | `@actions/core.getInput`             |
| `RuntimeStateStore`      | `saveState`, `getState` | `@actions/core.saveState / getState` |
| `RuntimeOutputSink`      | `setOutput`             | `@actions/core.setOutput`            |
| `RuntimeReporter`        | `info`, `warning`       | `@actions/core.info / warning`       |
| `RuntimeFailureReporter` | `setFailed`             | `@actions/core.setFailed`            |

### `ReportSink` (`src/reporting/types.ts`)

Provider-specific surface for grouped log output and job summaries. Shared flows emit structured
data; the sink decides how to render it (e.g. GitHub Actions grouped log annotations vs. plain
text).

### `BaseCacheBackend` (`src/storage/cache.ts`)

Provider-neutral cache API:

```typescript
interface BaseCacheBackend {
  readonly capabilities: BaseCacheBackendCapabilities;
  isFeatureAvailable(): boolean;
  restoreCache(paths, primaryKey, restoreKeys?): Promise<string | undefined>;
  saveCache(paths, key): Promise<number>;
}
```

`capabilities.supportsRestoreKeys` controls whether restore-key prefixes are generated.
`capabilities.supportsExplicitSave` controls whether a post-action save call is attempted.

### `WorkflowArtifactBackend` (`src/storage/artifacts.ts`)

Provider-neutral workflow artifact API used by the distributed delta exchange to upload and
download per-worker delta packages. A provider implementation wraps its own artifact API
(e.g. `@actions/artifact` for GitHub) behind this interface.

## Provider boundary rules

These rules are enforced as a review checklist in [`docs/ci-abstraction-rule.md`](ci-abstraction-rule.md).

- **No raw `process.env` reads outside `src/ci/**`**. All environment information must flow
through `CiJobContext`, `CompositeRuntimeHost`, or a backend interface.
- **No provider-specific rendering in shared flows**. HTML, annotations, and summary formatting
  stay inside provider `ReportSink` implementations.
- **Lifecycle names are `prepare` / `finalize`**. Provider-level names (`main` / `post` for
  GitHub Actions) are confined to provider entrypoints.
- **Capability flags, not provider checks**. Shared code branches on `backend.capabilities.*`,
  never on a provider name string.

## Adding a new CI provider

To add support for a new CI platform (e.g. Codeberg/Forgejo or GitLab):

1. **Create a `CiPlatformAdapter` implementation** that reads the provider's environment variables
   and populates `CiJobContext` and `httpHeadersByHost`.
2. **Implement `CompositeRuntimeHost`** mapping the provider's input/output/state APIs.
3. **Implement `ReportSink`** for the provider's log/summary surface.
4. **Implement `BaseCacheBackend`** wrapping the provider's cache API. Set `capabilities`
   appropriately; set `supportsExplicitSave: false` if the provider auto-saves on job completion.
5. **Implement `WorkflowArtifactBackend`** for the provider's artifact upload/download API.
6. **Create provider entrypoints** (equivalent to `src/ci/github/main.ts` and
   `src/ci/github/post.ts`) that wire the above implementations and call
   `runPrepareExecution` / `runFinalizeExecution` from `src/entrypoints/cli/`.
7. **Add a descriptor** (equivalent to `descriptors/github/`) with the provider-specific action
   manifest and any packaging configuration.

No changes to shared `src/cache/`, `src/wrapper/`, `src/bootstrap.ts`, or `src/main-flow.ts`
should be required for a straightforward provider port.
