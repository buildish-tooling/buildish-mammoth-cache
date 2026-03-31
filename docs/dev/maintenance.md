---
title: Maintenance
weight: 10
description: Ongoing maintenance tasks for Apache Buildish Mammoth Cache for Gradle — signing keys, schema versions, and partition fingerprints.
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

## Gradle signing-key rotation

When Gradle publishes a new signing key at <https://gradle.org/keys/>:

1. Verify the new key's fingerprint matches the published fingerprint on that page.
2. Add the new key to the `GRADLE_TRUSTED_SIGNING_KEY_ALLOWLIST` array in
   `src/gradle/wrapper/signature.ts` alongside the current key.
3. After the old key is no longer used to sign any wrapper version you support, remove it from the
   allowlist.

Keep old and new keys in the allowlist concurrently during the rotation window to avoid breaking
builds that pin an older Gradle version.

The allowlist is validated at action load time — unrecognized key material in the allowlist causes
a startup error rather than silently broken signature verification.

## Cache schema version

`cacheSchemaVersion` in `src/config/types.ts` is part of the default cache key template. Bump it
whenever a change to the cache content or partition layout would make an existing base cache entry
invalid or unsafe to reuse on the next run.

Schema version bumps create a new cache key lineage: existing cache entries from the previous
version are effectively abandoned and a cold start occurs for all users.

## Partition fingerprint changes

The `partitionFingerprint` value is a 16-character hex prefix of the SHA-256 of the full ordered
partition layout (including IDs, includes, excludes, and hard excludes). Any change to the active
partition set automatically produces a new fingerprint — and therefore a new cache key — without
requiring a manual schema version bump. This covers:

- Enabling or disabling a built-in partition.
- Changing include or exclude globs for any active partition.
- Adding or removing a custom partition.
- Changing the `HARD_CACHE_EXCLUDE_GLOBS` list.

## Static analysis and security scanning

### ESLint and eslint-plugin-regexp

`npm run lint` runs ESLint with `@typescript-eslint` and `eslint-plugin-regexp`. The regexp
plugin enforces correctness rules across all regex literals in the codebase, including
`regexp/strict` (no unescaped `{`/`}` in patterns) and `regexp/no-unused-capturing-group`
(change to non-capturing groups when the match result is discarded). Three style rules are
intentionally disabled in `eslint.config.mjs` — `regexp/prefer-d`, `regexp/prefer-w`, and
`regexp/use-ignore-case` — because the codebase uses explicit character classes for clarity and
to avoid unintentional match widening.

### npm audit

`npm run verify` runs `npm audit --audit-level=high` as its first step. This catches known
high-severity CVEs in the dependency tree (which includes large transitive dependencies such as
`@azure/storage-blob` via `@actions/cache`). Run `npm audit` manually at any time to see the
full report at all severity levels.

### CodeQL

CodeQL analysis runs as the `codeql` job in `.github/workflows/ci.yml` on every push to `main`
or a `release/**` branch and on every pull request. The job uses
`github/codeql-action` (from the `github.com/github` organisation, which is implicitly approved
under Apache Infrastructure policy) with `build-mode: none` — CodeQL analyses the TypeScript
source directly without building, which is appropriate because the compiled bundles in `dist/`
contain no information the source does not.

The `analyze` job carries `if: github.repository_owner == 'apache'` so it skips cleanly when
run from a personal fork or from the repository's pre-incubation location. Remove that condition
once the repository is in the `apache` GitHub organisation.

Results are uploaded to the repository's **Security → Code scanning** tab as SARIF. The job
requires `security-events: write` permission, which is scoped to the job rather than the
workflow to follow least-privilege practice.

## Adding a new CI provider

See [CI Abstraction Layer](../../architecture/ci-abstraction/) for the interfaces a new provider
adapter must implement and the rules that keep provider-specific logic out of the shared core.

Per-provider implementation notes:

- [Codeberg / Forgejo CI](../portability/codeberg/)
- [GitLab CI](../portability/gitlab/)
