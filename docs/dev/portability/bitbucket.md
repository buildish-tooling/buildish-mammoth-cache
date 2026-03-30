---
title: Bitbucket Pipelines Support
weight: 30
description: Architecture notes and open items for adding Bitbucket Pipelines provider support.
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

Bitbucket Pipelines differs from GitHub Actions substantially, but the architecture's eight seam
interfaces can all be implemented. The central constraint is that **Bitbucket has no suitable
programmatic cache frontend**: its native cache system is entirely declarative and cannot be
driven at runtime. Every other interface has a workable or straightforward mapping.

## Interface assessment

### `BaseCacheBackend` (`src/cache/backend.ts`) — no suitable native frontend

This is the most significant gap. The architecture calls `restoreCache(key, restoreKeys, paths)`
and `saveCache(key, paths)` **at runtime** with a composite key
(`${prefix}-v${schema}-${partitionFingerprint}-${javaVersion}-${os}-${arch}-${ref}`) and a
restore-key fallback sequence.

Bitbucket's native cache system is **entirely declarative**: it is configured in
`bitbucket-pipelines.yml` at pipeline definition time, keyed only by a hash of specified files,
and managed entirely by the platform. There is no API to imperatively upload to or download from a
cache entry from within a script. The Bitbucket REST API exposes only management operations (list,
clear) — not content access.

The only viable implementation is an **external object store** (S3, GCS, Backblaze B2, etc.)
called imperatively via REST. The `BaseCacheBackend` interface is the right abstraction for this —
a thin adapter wrapping S3 or similar would work — but users must provision and configure their
own storage bucket. This is a meaningfully higher setup burden than providers with a native cache
API.

### `WorkflowArtifactBackend` (`src/delta/backend.ts`) — workable with constraints

Bitbucket Pipelines has a job artifact system, but with two important constraints:

- Artifact paths must be **relative to `BITBUCKET_CLONE_DIR`** (the checkout directory). Delta
  packages produced by worker jobs must therefore be staged inside the clone dir before the step
  ends, rather than being written directly to `~/.gradle/`.
- Artifact paths must be **declared in the YAML** at pipeline definition time. Users must
  pre-declare the expected delta artifact paths in `bitbucket-pipelines.yml`.

For the aggregator side, the Bitbucket REST API provides
`GET /2.0/repositories/{ws}/{repo}/pipelines/{uuid}/steps/{step_uuid}/artifacts/{name}` which
allows downloading artifacts from a specific named step after it completes. The distributed
aggregator pattern (running after all workers via sequential steps or a stage) works correctly
because the documented limitation that "parallel step artifacts may not be accessible to sibling
parallel steps" does not apply — the aggregator runs after workers complete, not alongside them.

### `HostStateStore` (`src/host/types.ts`) — clean fit via `after-script`

Bitbucket's `after-script` step option runs after the main `script` block, regardless of whether
it succeeded or failed — exactly analogous to GitHub Actions' `post:` hook. Crucially, it runs in
the **same Docker container**, so any state written to a temp file by the prepare phase (in
`script:`) is immediately available to the finalize phase (in `after-script:`). No cross-process
state serialization protocol is needed.

`BITBUCKET_EXIT_CODE` is available in `after-script` to replicate the success/failure gating that
the finalize phase uses to decide whether to save the cache.

### `HostReporter` (`src/host/types.ts`) — easy

Plain stdout/stderr with Bitbucket's ANSI section markers
(`section_start:<timestamp>:<label>` / `section_end:<timestamp>:<label>`) instead of GitHub's
`::group::` / `::endgroup::`. Functionally equivalent.

### `HostInputSource` (`src/host/types.ts`) — easy

Bitbucket has no action-input concept, but the action's `config-file` mechanism covers this.
Configuration arrives via pipeline variables (repository or workspace level) plus the config file.

### `HostOutputSink` (`src/host/types.ts`) — easy

Write `VAR=value` to `$BITBUCKET_PIPELINES_VARIABLES_PATH` and declare the variable name under
`output-variables:` in the step. Consumed by later steps automatically.

### `ReportSink` (`src/host/types.ts`) — limited

Bitbucket has no equivalent of GitHub's markdown job summary. Reports would be written to stdout
or saved as a file artifact. Not a blocker.

### `CiPlatformAdapter` / `CiJobContext` (`src/ci/types.ts`) — mostly fine, one gap

Rich `BITBUCKET_*` environment variables cover most of `CiJobContext`:

| Required value | Bitbucket variable          |
| -------------- | --------------------------- |
| Run ID         | `BITBUCKET_BUILD_NUMBER`    |
| Run attempt    | `BITBUCKET_STEP_RUN_NUMBER` |
| Execution URL  | `BITBUCKET_BUILD_URL`       |
| Server URL     | `BITBUCKET_BITBUCKET_URL`   |

**Gap**: Bitbucket does not expose the step name as an environment variable. Distributed mode uses
job names to identify delta artifacts, so each worker would need to pass its name explicitly as a
pipeline variable or action input rather than having it inferred automatically.

## Finalize phase — `after-script` model

The prepare/finalize split maps cleanly onto Bitbucket's `script` / `after-script` structure:

```yaml
- step:
    name: Build
    script:
      - node dist/prepare.js    # restore cache, provision wrapper
      - ./gradlew build
    after-script:
      - node dist/finalize.js   # compute delta, save cache / upload artifact
    artifacts:
      - .gradle-delta/**        # pre-declared delta package path
```

## Key uncertainties

- Which S3-compatible storage service to recommend or support as the default cache backend.
  Bitbucket Cloud users do not have a natural Atlassian-managed object store to target.
- Whether Bitbucket Data Center (self-hosted) runners provide different options for a cache
  backend compared to Bitbucket Cloud.
- Token scoping for the REST API calls needed by the aggregator to fetch worker artifacts.
  `BITBUCKET_ACCESS_TOKEN` (if configured) or repository access tokens would be the likely
  mechanism.
- Exact behavior of `BITBUCKET_STEP_RUN_NUMBER` across manual re-runs vs. automatic retries.

## Recommended approach

1. Implement `BaseCacheBackend` backed by S3 (or any S3-compatible store) via the AWS SDK or
   plain REST. Accept the bucket name, region, and credentials as pipeline variables.
2. Implement the adapter in `src/ci/bitbucket/` using `after-script` for the finalize phase.
3. Require users to pass the step name as an explicit input (`step-name:`) in distributed mode.
4. Add a `bitbucket-pipelines.yml` template to `descriptors/bitbucket/` that users can `include`.

