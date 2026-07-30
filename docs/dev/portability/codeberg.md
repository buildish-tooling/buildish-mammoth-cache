---
title: Codeberg
weight: 10 / Forgejo CI Support
description: Architecture notes and open items for adding Codeberg and Forgejo CI provider support.
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

Forgejo Actions is API-compatible with GitHub Actions for most surface areas this action relies on,
including the `@actions/cache` toolkit and artifact APIs. Codeberg.org runs Forgejo, so support for
both platforms is expected to arrive together.

## What needs to be built

### `BaseCacheBackend` (`src/cache/backend.ts`)

Forgejo Actions exposes a cache service compatible with the GitHub Actions cache protocol.
The `@actions/cache` package is expected to work as-is, or with minor version pinning adjustments.

The `BaseCacheBackendCapabilities` for this provider would initially mirror GitHub's:

```typescript
{
  supportsCacheRestore: true,
  supportsCacheSave: true,
}
```

### `WorkflowArtifactBackend` (`src/delta/backend.ts`)

Forgejo's artifact API surface differs from GitHub's in a few areas:

- The artifact upload/download API is compatible at the REST level but uses different SDK paths.
- Run-scoped artifact listing and cross-run artifact access may require direct REST calls rather
  than the `@actions/artifact` v2 package.

The `WorkflowArtifactBackendCapabilities` would report what operations are confirmed working once
the integration is tested.

### Host adapters (`src/host/types.ts`)

`@actions/core` is available on Forgejo Actions and provides `saveState`, `getState`, `getInput`,
`setOutput`, `summary`, and log-group APIs. The GitHub host adapters in `src/ci/github/host.ts`
should be reusable with minor changes or extracted into a shared `@actions/core`-based adapter.

### `CiPlatformAdapter` (`src/ci/types.ts`)

Forgejo exposes GitHub-compatible environment variables (`GITHUB_JOB`, `GITHUB_RUN_ID`,
`GITHUB_RUN_ATTEMPT`, `GITHUB_SERVER_URL`, etc.). The GitHub provider implementation should be
largely reusable.

### Finalize (post) phase

Forgejo Actions supports a post-execution hook via `post:` in `action.yml`, matching GitHub's
model exactly. The same two-entrypoint approach used for GitHub Actions should work without changes
to the phase logic.

## Key uncertainties

- Artifact cross-run access: does Forgejo support fetching artifacts from a different run within
  the same workflow? This is required for the distributed worker/aggregator model.
- API rate limits and authentication token scopes for artifact and cache operations.
- Whether `FORGEJO_SERVER_URL` or `GITEA_SERVER_URL` should be preferred over `GITHUB_SERVER_URL`.

## Recommended approach

1. Start with a thin adapter in `src/ci/forgejo/` that delegates to `@actions/core` and
   `@actions/cache` wherever those packages work on Forgejo.
2. Replace only the parts that differ (artifact backend, server URL detection).
3. Add integration tests against a self-hosted Forgejo instance.
