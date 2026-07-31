---
title: Maintenance
weight: 10
description: Ongoing maintenance tasks for Buildish Mammoth Cache for Gradle and Maven — signing keys, schema versions, partition fingerprints, and CI checks.
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

## Gradle signing-key rotation

When Gradle publishes a new signing key at <https://gradle.org/keys/>:

1. Verify the new key's fingerprint matches the published fingerprint on that page.
2. Add the new key to the `GRADLE_TRUSTED_SIGNING_KEY_ALLOWLIST` array in
   `src/build-tool/gradle/wrapper/signature.ts` alongside the current key.
3. After the old key is no longer used to sign any wrapper version you support, remove it from the
   allowlist.

Keep old and new keys in the allowlist concurrently during the rotation window to avoid breaking
builds that pin an older Gradle version.

The allowlist is validated at action load time — unrecognized key material in the allowlist causes
a startup error rather than silently broken signature verification.

## Cache schema version

`CACHE_SCHEMA_VERSION` in `src/config/types.ts` is part of every action-owned cache family. Bump it
whenever a change to the cache content or partition layout would make an existing base cache entry
invalid or unsafe to reuse on the next run.

Schema version bumps create a new cache family: existing lineages from the previous version are
effectively abandoned and a cold start occurs for all users.

## Partition fingerprint changes

The `partitionFingerprint` value is a 16-character hex prefix of the SHA-256 of the full ordered
partition layout (including IDs, includes, excludes, and hard excludes). Any change to the active
partition set automatically produces a new fingerprint — and therefore a new cache family — without
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

The `codeql` job in `.github/workflows/ci.yml` is currently disabled with `if: false` because GitHub
Advanced Security is unavailable for the repository. It is retained as preparatory configuration,
but it does not currently analyse source or upload SARIF results. The required-check aggregator
accepts the resulting skipped state.

When the repository can use CodeQL, replace the temporary condition with the intended repository
scope and validate the job before documenting it as an active check. The prepared job uses
`github/codeql-action` with `build-mode: none` to analyse TypeScript source directly and scopes
`security-events: write` to that job.

## CI Node.js and npm setup helper

`.github/actions/setup-node-npm` is an internal composite action for workflows in this repository.
Callers must check out the repository first because the helper resolves the npm version through
`scripts/resolve-npm-version.mjs` in the current workspace.

The `cache` input is explicit: a package-manager name such as `npm` enables setup-node caching, while
the default blank value disables both requested caching and setup-node's automatic inference from
`package.json#packageManager`. Keep both setup-node branches aligned and update
`test/setup-node-npm-action.test.ts` whenever the helper contract changes.

## Public action contract

`src/config/public-contract.ts` is the typed source of truth for public input names, applicability,
defaults, config-file permission and value representation, descriptions, and prepare outputs.
`src/config/inputs.ts` reads and overlays raw inputs through that contract, while
`src/config/normalize.ts` owns normalization shared by all build tools. Tool adapters retain only
tool-specific normalization.

When adding or changing an input or output:

1. Update the typed contract.
2. Select the config-file value representation when the input is file-configurable, then update
   shared or tool-specific normalization as needed.
3. Refresh the matching action descriptor and the generated contract block in
   `docs/user/configuration.md`.
4. Add detailed prose or examples when the compact contract description is not sufficient.

`test/config/public-contract.test.ts` compares both action descriptors and the documentation block
to the typed contract exactly. The test fails on undeclared reads/outputs, declared-but-unused
metadata fields, default drift, description drift, tool-applicability drift, and stale reference
rows.

## Gradle build-result capture

`src/build-tool/gradle/build-results.ts` owns capture-file installation and cleanup, bounded JSON
loading and validation, report correlation, and Gradle summary rendering. The executable Groovy
init script and build-service source are generated by
`src/build-tool/gradle/build-result-capture-scripts.ts`.

Keep environment-path validation and non-interpolating Groovy string encoding beside those source
generators. Both generated files must reject suspicious capture roots independently so future
callers cannot bypass the executable-source boundary. The build-results module re-exports the
existing path-embedding helpers as its stable facade.

## Manifest performance benchmark

`npm run benchmark:manifest -- 10000 --shape=broad,deep` measures manifest capture, delta
computation, and serialization against repeatable synthetic broad and deep cache trees. Use the same
file count and shape list for before/after comparisons, and record Node version, elapsed capture
time, peak heap, and peak RSS. The fixture and local filesystem dominate parts of the result, so
treat the numbers as directional rather than as a production service-level objective.

On POSIX systems, a constrained-descriptor check can be run in a subshell without changing machine
configuration:

```bash
ulimit -n 64
npm run benchmark:manifest -- 10000 --shape=broad,deep
```

Manifest and metadata traversal use a shared default concurrency bound of 32. If that implementation
constant changes, rerun both normal and constrained-descriptor scenarios and verify that canonical
manifest digests remain unchanged across concurrency limits.

## Adding a new CI provider

See [CI Abstraction Layer](../../architecture/ci-abstraction/) for the interfaces a new provider
adapter must implement and the rules that keep provider-specific logic out of the shared core.

Per-provider implementation notes:

- [Codeberg / Forgejo CI](../portability/codeberg/)
- [GitLab CI](../portability/gitlab/)
