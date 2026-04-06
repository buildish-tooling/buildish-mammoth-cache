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
   ephemeral GnuPG home. The pinned keys live in `src/build-tool/gradle/wrapper/signature.ts`.
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

### Threat model

#### Assumed attacker capabilities

The threat model considers two attacker categories:

- **External attacker** — no repository access, no ability to push commits or create pull
  requests. An external attacker cannot interact with the repository's GitHub Actions cache at
  all.
- **Contributor with pull-request access** — can open a pull request and trigger
  `pull_request` / `pull_request_target` workflow runs. This is the primary threat actor for
  cache-poisoning scenarios.

Actors with direct push access to a repository's default branch are considered trusted. The
security posture of CI in general degrades when untrusted actors gain push access, which is
outside the scope of this threat model.

#### Impact of a successful cache poisoning

GitHub Actions cache entries are scoped to a branch and a workflow. A poisoned cache entry
means that malicious files — for example, a trojaned build-tool JAR or a plugin that executes
arbitrary code — can be injected into a future build that restores from that entry. Because
the build tool (Gradle or Maven) loads and executes JARs from its local cache directory,
arbitrary code execution within the build is a realistic impact of a successfully poisoned
entry.

The most dangerous scenario is poisoning the **default branch** (`main` / `master`) cache,
because all PR builds fall back to it via the restore key chain.

#### Mitigations already in place

| Mitigation                                | Detail                                                                                                                                                                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Read-only by default on PRs**           | `pull_request` and `pull_request_target` events default to `read-only: true`. Worker and aggregator jobs on PRs do not save cache entries or upload delta artifacts to the shared backend, so a PR build cannot mutate the default-branch cache.                |
| **Gradle wrapper JAR verification**       | Every wrapper JAR is verified with a SHA-256 checksum and a GnuPG detached signature against a pinned key allowlist before it is written to disk. A tampered JAR downloaded from a compromised `distributionUrl` is rejected before Gradle is invoked.          |
| **Hard cache exclusions**                 | Paths that could carry encryption key material, PID-bearing lock files, or per-runner absolute paths are excluded unconditionally and cannot be re-enabled via `cache-partitions` overrides. See [Hard cache safety exclusions](#hard-cache-safety-exclusions). |
| **Token never persisted**                 | `github-token` is applied per-host and never written to summaries, logs, or post-action state. A token leak via a poisoned cache is therefore not possible through this action.                                                                                 |
| **Delta artifact integrity verification** | Before a distributed aggregator applies any worker delta, it verifies each file's SHA-256 against the metadata in the artifact's `delta-package.json`. A corrupted or tampered artifact is rejected before any file is written to the cache directory.          |

#### Residual risks

- **Cache entries are not content-addressed at restore time.** GitHub's cache backend matches
  entries by key string, not by content hash. If a cache entry for a given key was replaced
  by a malicious actor who has write access to the repository, there is no mechanism to detect
  the substitution at restore time. This is a fundamental property of the underlying
  `@actions/cache` service.
- **Third-party plugin JARs are not re-verified after the initial build.** Once a plugin JAR is
  cached, subsequent restores trust the cache entry. A poisoned entry that replaces a legitimate
  plugin JAR will execute on the next build without further verification. Mitigate this by
  using lockfiles, dependency verification (Gradle's `--write-verification-metadata`), or
  `read-only: true` on jobs where cache freshness is not required.
- **`main` branch cache affects all subsequent workflows.** A single poisoned save to the
  default-branch cache lineage propagates to every future build on that branch until a clean
  entry overwrites it. Treat cache write access with the same sensitivity as push access.

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
