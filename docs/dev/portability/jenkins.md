---
title: Jenkins Support
weight: 40
description: Architecture notes and implementation options for adding Jenkins provider support.
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

Jenkins is a natural target for the Mammoth Cache because it is widely used in the Apache
ecosystem and has no native equivalent of the Gradle/Maven caching features this action provides.
The architecture's eight seam interfaces can all be implemented, and the distributed
worker/aggregator pattern maps well to Jenkins parallel stages. The main open question is not
_whether_ Jenkins can be supported but _how_ — because Jenkins plugins are JVM-based and this
codebase is TypeScript/Node.js.

## Why `using: node24` does not apply

GitHub Actions and Forgejo Actions support exactly three action runtime types: `node20`/`node24`,
`docker`, and `composite`. There is no `jvm` type. Jenkins has no equivalent constraint at all:
CI steps run arbitrary shell commands in whatever environment the agent provides. A Node.js
script, a fat JAR, and a Kotlin CLI binary are all equally valid entry points for a Jenkins
Pipeline step. The `using: node24` problem is specific to the GitHub/Forgejo action model.

## Interface assessment

### `BaseCacheBackend` (`src/cache/backend.ts`) — no native frontend; external store required

Jenkins has no built-in cache service comparable to the GitHub Actions cache. Options:

- **Artifactory or Nexus**: widely deployed in organisations that also run Jenkins; the REST API
  can serve as an imperative cache backend.
- **S3-compatible object store**: MinIO, AWS S3, GCS, etc. Same approach as Bitbucket.
- **Shared agent filesystem**: a network-mounted directory accessible from all agents works for
  same-controller setups, but breaks across agent pools.

The `BaseCacheBackend` interface is the right abstraction for all of these — a thin adapter
wrapping the chosen store requires no changes to the shared cache orchestration logic.

### `WorkflowArtifactBackend` (`src/delta/backend.ts`) — clean fit via Copy Artifact Plugin

The [Copy Artifact Plugin](https://plugins.jenkins.io/copyartifact/) maps almost directly to the
`WorkflowArtifactBackend` interface:

| Operation          | Copy Artifact / Jenkins equivalent                                    |
| ------------------ | --------------------------------------------------------------------- |
| `uploadArtifact`   | `archiveArtifacts` Pipeline step                                      |
| `listArtifacts`    | Jenkins REST API `GET /job/<name>/<build>/api/json?tree=artifacts[*]` |
| `downloadArtifact` | `copyArtifacts` Pipeline step or REST artifact download URL           |
| `deleteArtifact`   | Jenkins REST API `POST /job/<name>/<build>/artifact/<path>/doDelete`  |

Cross-execution artifact access (required for the distributed worker/aggregator model) is
supported — artifacts from upstream builds are accessible to downstream builds by build number.

### `HostStateStore` (`src/host/types.ts`) — workspace file + stash

Jenkins has no `saveState`/`getState` equivalent. The prepare phase writes key-value pairs to a
small JSON file in the workspace; the finalize phase reads it back. For Pipeline jobs, `stash` /
`unstash` can carry this file to a different node if prepare and finalize run on separate agents.
Since the values are plain strings, a workspace-resident JSON file is entirely sufficient.

### `HostReporter`, `HostInputSource`, `HostOutputSink` (`src/host/types.ts`) — straightforward

| Adapter           | Jenkins equivalent                                                      |
| ----------------- | ----------------------------------------------------------------------- |
| `HostReporter`    | `echo` / `println` in a Pipeline step; ANSI colour via AnsiColor plugin |
| `HostInputSource` | Pipeline `parameters {}` block or `withCredentials` for secrets         |
| `HostOutputSink`  | `env.VAR = value` in a Groovy step; no formal output concept needed     |

### `ReportSink` (`src/host/types.ts`) — HTML report via publishHTML

Jenkins has no built-in Markdown job summary equivalent. A Markdown-to-HTML conversion step
followed by `publishHTML` (or the Blue Ocean summary API) provides a reasonable approximation.

### `CiPlatformAdapter` / `CiJobContext` (`src/ci/types.ts`) — fully covered

All required `CiJobContext` fields are available from Jenkins built-in environment variables:

| Required value | Jenkins variable                                                   |
| -------------- | ------------------------------------------------------------------ |
| Job name       | `JOB_NAME`                                                         |
| Run ID         | `BUILD_NUMBER`                                                     |
| Run attempt    | `BUILD_NUMBER` (always 1 per build; retries are new build numbers) |
| Execution URL  | `BUILD_URL`                                                        |
| Branch name    | `GIT_BRANCH` (Git plugin)                                          |
| PR detection   | `CHANGE_ID` non-empty (Multibranch Pipeline)                       |
| Workspace      | `WORKSPACE`                                                        |
| Temp directory | `WORKSPACE_TMP`                                                    |

### Finalize phase — Pipeline `post {}` block

Jenkins Pipeline's `post { always { ... } }` block runs after the main `stages {}` body,
regardless of success or failure — a clean equivalent to GitHub's `post:` hook:

```groovy
pipeline {
    stages {
        stage('Prepare cache') { steps { sh 'node dist/prepare.js' } }
        stage('Build')         { steps { sh './gradlew build' } }
    }
    post {
        always { sh 'node dist/finalize.js' }
    }
}
```

For distributed mode, parallel worker stages upload delta artifacts and a sequential aggregator
stage downloads and merges them — this is idiomatic Jenkins Pipeline.

## Implementation paths

Three approaches are viable, in increasing implementation cost:

### Option A: Jenkins Shared Library wrapping the Node.js scripts

Create a [Jenkins Shared Library](https://www.jenkins.io/doc/book/pipeline/shared-libraries/)
in Groovy. The library provides `mammothCachePrepare()` and `mammothCacheFinalize()` global vars
that set up the environment (workspace paths, job context as environment variables) and shell out
to `node dist/prepare.js` / `node dist/finalize.js`. Jenkins-specific concerns (state file
stashing, artifact archiving/copying) are handled by the Groovy wrapper; all cache and delta
logic remains in the Node.js scripts unchanged.

**Tradeoffs:** Fastest path. Requires Node.js on the Jenkins agent (common in modern CI, not
universal). Single codebase. Not distributable via the Jenkins update centre.

### Option B: Thin Jenkins plugin delegating to Node.js

A proper `hudson.Plugin` extension point that declares a Node.js tool requirement and delegates
all logic to the scripts via shell steps. Same tradeoffs as option A but distributable via the
Jenkins update centre and installable without users manually configuring a shared library.

**Tradeoffs:** Slightly more setup than option A, but same Node.js requirement on agents.

### Option C: Full Kotlin/JVM port

Rewrite the core phase logic (`src/phases/`, `src/cache/`, `src/delta/`) in Kotlin, implementing
the same seam interfaces. The Jenkins adapter layer (`BaseCacheBackend`, `WorkflowArtifactBackend`,
etc.) is then written as a standard Jenkins plugin using the Jenkins Java API.

**Tradeoffs:** The highest investment but the only path to a true zero-dependency Jenkins plugin.
The existing interface boundaries are clean enough that the port is largely mechanical rather than
creative. See [Kotlin Multiplatform](../../kotlin-multiplatform/) for why a single Kotlin codebase
targeting both JS (GitHub/Forgejo) and JVM (Jenkins) was evaluated and not recommended.
