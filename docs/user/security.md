---
title: Security
weight: 50
description: Required permissions, wrapper verification, token scoping, and hard cache exclusions for Apache Buildish Mammoth Cache for Gradle and Maven.
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

## GitHub Actions permissions

The minimum required token permissions depend on the job mode and read-only setting.

| Scenario                | `actions` | `contents` |
| ----------------------- | --------- | ---------- |
| Standalone, cache write | `write`   | `read`     |
| Standalone, read-only   | `read`    | `read`     |
| Distributed worker      | `write`   | `read`     |
| Distributed aggregator  | `write`   | `read`     |
| Cache disabled          | none      | `read`     |

`actions: write` is required to save cache entries and to upload or download workflow artifacts used
by the distributed delta exchange. `contents: read` is required for workspace checkout.

The `github-token` input (or `GITHUB_TOKEN` environment variable) is used only by the **Gradle**
action for authenticated wrapper JAR downloads against the GitHub API. The Maven action does not
use it. It is never written to job summaries or persisted in post-action state.

## Security

### Gradle wrapper verification {#gradle-wrapper-verification}

Every `gradle-wrapper.jar` provisioned by this action goes through a three-step verification chain
before it is written to disk:

1. **SHA-256 checksum** — the expected digest is downloaded from `services.gradle.org` over HTTPS
   and compared to the downloaded JAR bytes.
2. **Detached OpenPGP signature** — the ASCII-armored `.asc` signature is downloaded from
   `services.gradle.org` and verified against a pinned Gradle signing-key allowlist using a fresh
   ephemeral GnuPG home. The pinned keys live in `src/gradle/wrapper/signature.ts`.
3. **Race-condition guard** — the JAR is written atomically via a temporary file so a partially
   written JAR is never exposed to the Gradle invocation.

The key allowlist is designed to support smooth Gradle signing-key rotation: old and new keys may
overlap in the allowlist. Remove a retired key only after it no longer signs any wrapper version
you intend to support.

To override the GnuPG binary (for example, on Windows runners where multiple `gpg` variants may
exist), set the `BUILDISH_MAMMOTH_CACHE_GRADLE_GPG_COMMAND` environment variable before the action
runs.

### Token scoping

- `github-token` is used exclusively by the Gradle action for authenticated requests to
  `api.github.com` and `raw.githubusercontent.com` when downloading wrapper JARs. It is applied
  per-host so it is never sent to any other endpoint.
- The token is never written to workflow summaries, log output, or post-action state.

### Hard cache safety exclusions

The following paths are excluded from every active partition unconditionally and cannot be overridden.

**Gradle**

| Pattern                     | Reason                                                                  |
| --------------------------- | ----------------------------------------------------------------------- |
| `**/configuration-cache/**` | May contain encrypted secrets; volatile by nature                       |
| `**/*.lock`                 | PID-bearing files that cause hangs if restored on another runner        |
| `caches/*/cc-keystore`      | Configuration-cache encryption key material                             |
| `caches/journal-1/**`       | Gradle's local-only file-access journal; migrating it causes corruption |

**Maven**

| Pattern                         | Reason                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `**/*.lastUpdated`              | Stale remote-check markers; cause silent re-resolution when shared across runners                               |
| `**/resolver-status.properties` | Maven Resolver group-level remote-check status; per-runner state and a common distributed-merge conflict source |
| `**/_remote.repositories`       | Records which remote a file came from; not portable across different CI environments                            |
| `**/*.lock`                     | PID-bearing resolver lock files that cause hangs if restored on another runner                                  |
