---
title: '[FROM README] Permissions, security, maintenance, and current status'
description: Temporary home for permissions, security, maintenance, and status details moved from the project README.
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

This page currently carries content moved from the project README. It will likely be reorganized later.

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

The `github-token` input (or `GITHUB_TOKEN` environment variable) is used only for authenticated
wrapper JAR downloads against the GitHub API. It is never written to job summaries or persisted
in post-action state.

## Security

### Gradle wrapper verification

Every `gradle-wrapper.jar` provisioned by this action goes through a three-step verification chain
before it is written to disk:

1. **SHA-256 checksum** — the expected digest is downloaded from `services.gradle.org` over HTTPS
   and compared to the downloaded JAR bytes.
2. **Detached OpenPGP signature** — the ASCII-armored `.asc` signature is downloaded from
   `services.gradle.org` and verified against a pinned Gradle signing-key allowlist using a fresh
   ephemeral GnuPG home. The pinned keys live in `src/wrapper/signature.ts`.
3. **Race-condition guard** — the JAR is written atomically via a temporary file so a partially
   written JAR is never exposed to the Gradle invocation.

The key allowlist is designed to support smooth Gradle signing-key rotation: old and new keys may
overlap in the allowlist. Remove a retired key only after it no longer signs any wrapper version
you intend to support.

To override the GnuPG binary (for example, on Windows runners where multiple `gpg` variants may
exist), set the `BUILDISH_MAMMOTH_CACHE_GRADLE_GPG_COMMAND` environment variable before the action
runs.

### Token scoping

- `github-token` is used exclusively for authenticated requests to `api.github.com` and
  `raw.githubusercontent.com` when downloading wrapper JARs. It is applied per-host so it is never
  sent to any other endpoint.
- The token is never written to workflow summaries, log output, or post-action state.

### Hard cache safety exclusions

The following paths are excluded from every cache partition unconditionally and cannot be overridden:

| Pattern                     | Reason                                                                  |
| --------------------------- | ----------------------------------------------------------------------- |
| `**/configuration-cache/**` | May contain encrypted secrets; volatile by nature                       |
| `**/*.lock`                 | PID-bearing files that cause hangs if restored on another runner        |
| `caches/*/cc-keystore`      | Configuration-cache encryption key material                             |
| `caches/journal-1/**`       | Gradle's local-only file-access journal; migrating it causes corruption |

## Maintenance notes

### Gradle signing-key rotation

When Gradle publishes a new signing key at <https://gradle.org/keys/>:

1. Verify the new key's fingerprint matches the published fingerprint.
2. Add the new key to the `GRADLE_TRUSTED_SIGNING_KEY_ALLOWLIST` array in
   `src/wrapper/signature.ts` alongside the current key.
3. After the old key is no longer used to sign any wrapper version you support, remove it from the
   allowlist.

Keep old and new keys in the allowlist concurrently during the rotation window to avoid breaking
builds that pin an older Gradle version.

### Cache schema version

`cacheSchemaVersion` in `src/config/types.ts` is part of the default cache key template. Bump it
whenever a change to the cache content or partition layout would make an existing base cache entry
invalid or unsafe to reuse.

### Partition fingerprint changes

The `partitionFingerprint` value is a 16-character SHA-256 digest of the full ordered partition
layout. Any change to the active partition set, include globs, exclude globs, or the
`HARD_CACHE_EXCLUDE_GLOBS` list automatically produces a new fingerprint and therefore a new cache
key lineage. No manual bump is needed.

### Adding a new CI provider

See [CI abstraction](./ci-abstraction/) for the provider boundary rules and the interfaces that a
new adapter must implement.

## Current status

Mammoth Cache for Gradle is under active development.

Implemented today:

- shared `prepare` / `finalize` lifecycle entrypoints and orchestration
- provider-neutral CI/runtime/reporting/storage seams
- Gradle wrapper discovery, static validation, download, and checksum verification
- base cache restore/save orchestration
- distributed worker / aggregator delta exchange, merge, and cleanup
- grouped-log and summary reporting through provider report sinks
- GitHub consumer packaging under `descriptors/github/**` and `dist/github/**`

The remaining portability architecture work is limited to **new provider implementations**, not more shared-core
rewrites:

- Codeberg / Forgejo: validate toolkit/runtime compatibility and add provider-specific adapter/descriptor wiring where
  GitHub reuse is insufficient
- GitLab: add a GitLab-facing runtime/report/cache/artifact implementation around the existing shared
  `prepare` / `finalize` core

Only the GitHub consumer path is implemented and bundled today. For the remaining cross-provider work, see:

- [Implementation plan](./implementation-plan/)
- [Provider portability implementation plan](./provider-portability-implementation-plan/)
- [Codeberg CI support evaluation](./codeberg-ci-support-evaluation/)
- [GitLab CI support evaluation](./gitlab-ci-support-evaluation/)
