---
title: GitLab CI Support
weight: 20
description: Architecture notes and open items for adding GitLab CI provider support.
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

GitLab CI differs from GitHub Actions more substantially than Forgejo does. The pipeline model,
cache API, artifact API, and execution lifecycle all require purpose-built adapters.

## What needs to be built

### `BaseCacheBackend` (`src/cache/backend.ts`)

GitLab CI has a native cache service, but it is configured declaratively in `.gitlab-ci.yml` rather
than imperatively at runtime. An imperative cache backend would need to use the
[GitLab Cache API](https://docs.gitlab.com/ee/api/jobs.html) or GitLab's S3-compatible cache proxy.

Alternatively, the cache backend could be backed by an S3-compatible object store configured
via environment variables — keeping the provider adapter thin while relying on infrastructure that
GitLab CI runners typically have access to.

### `WorkflowArtifactBackend` (`src/delta/backend.ts`)

GitLab CI has a job artifact system. The GitLab REST API provides endpoints for downloading
artifacts from specific jobs within a pipeline, which maps well to the distributed delta use case.

Key differences from GitHub:

- Artifact identity is by job name + pipeline ID, not by artifact name + run ID.
- Artifact expiry is configured in `.gitlab-ci.yml` (`artifacts.expire_in`).
- Cross-pipeline artifact access requires a personal or project access token with `read_api` scope.

### Host adapters (`src/host/types.ts`)

GitLab CI provides no `@actions/core` equivalent. Each host adapter must be implemented from scratch:

| Adapter           | GitLab equivalent                                                        |
| ----------------- | ------------------------------------------------------------------------ |
| `HostReporter`    | `console.log` with ANSI section markers (`\e[0Ksection_start:`)          |
| `HostStateStore`  | Write/read from a dotenv-format state file (no native cross-phase state) |
| `HostInputSource` | Read from CI/CD variables (`process.env`)                                |
| `HostOutputSink`  | Write to a dotenv-format output file (if using `CI_JOB_ENV` / artifacts) |
| `ReportSink`      | Write a Markdown report artifact; no built-in job summary equivalent     |

### `CiPlatformAdapter` (`src/ci/types.ts`)

GitLab CI exposes rich environment metadata via predefined variables:

| Required value | GitLab variable                                    |
| -------------- | -------------------------------------------------- |
| Job name       | `CI_JOB_NAME`                                      |
| Run ID         | `CI_PIPELINE_ID`                                   |
| Run attempt    | `CI_PIPELINE_IID` (pipeline-level sequence number) |
| Execution URL  | `CI_JOB_URL`                                       |
| Server URL     | `CI_SERVER_URL`                                    |

### Finalize (post) phase

GitLab CI does not have a built-in post-execution hook equivalent to GitHub's `post:`. Options:

1. **`after_script`**: runs after the job script in the same runner environment, but does not have
   access to the full job environment after failure and cannot be conditionally skipped easily.
2. **Separate pipeline job**: a dedicated `finalize` job that runs after the build jobs, depending
   on them via `needs:`. This is the cleanest approach and maps well to the distributed
   aggregator model.

The recommended approach is a separate pipeline job, which means the user's `.gitlab-ci.yml` would
explicitly declare both a prepare and a finalize invocation, rather than relying on a transparent
post hook.

## Key uncertainties

- Whether a thin `after_script` finalize is acceptable for standalone (non-distributed) jobs.
- How to handle `HostStateStore` reliably — writing to a file artifact and downloading it in
  the finalize job is one option, but it introduces a mandatory artifact dependency.
- Token scoping: cross-pipeline artifact access requires broader API token permissions than
  typical jobs use.

## Recommended approach

1. Implement the GitLab adapter in `src/ci/gitlab/`.
2. Start with the separate-pipeline-job model for finalize (cleaner, works for both standalone
   and distributed).
3. Implement `HostStateStore` backed by a small artifact file passed between jobs.
4. Add a `.gitlab-ci.yml` template to `descriptors/gitlab/` that users can `include`.
