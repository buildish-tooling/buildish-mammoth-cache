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

1. Verify the primary key fingerprint and, when present, the signing subkey fingerprint against
   that page. Use the complete public key block, including its signing subkey.
2. Add the new key to the `GRADLE_TRUSTED_SIGNING_KEY_ALLOWLIST` array in
   `src/build-tool/gradle/wrapper/signature.ts` alongside the current key. Set `expectedFingerprint`
   to the primary fingerprint and `expectedSigningFingerprint` to the signing subkey fingerprint.
   Omit `expectedSigningFingerprint` only when the primary key signs directly.
3. After the old key is no longer used to sign any wrapper version you support, remove it from the
   allowlist.

Keep old and new keys in the allowlist concurrently during the rotation window to avoid breaking
builds that pin an older Gradle version.

The allowlist is validated lazily before the first detached-signature verification and cached for
the process. A key-material or fingerprint mismatch fails verification. GnuPG must verify the
signature successfully, and the reported primary and signing fingerprints must match a pinned
entry. Verification uses an isolated temporary keyring with automatic key retrieval disabled.

## Cache schema and profile changes

The streaming family identity binds `CACHE_SCHEMA_VERSION` from
`src/config/types.ts`, the resolved partition model, and the named wire,
native, generation and local profiles. The current family uses schema 8 and
the v2 worker, native, generation and local profiles. An incompatible
format change needs corresponding profiles, vectors, Action docs and a
coordinated upgrade. Old backend families start cold.

Changes to ordered partition ownership, purge rules, publication settings
or writer assignment already affect the model digest. See the canonical
[model/key contract](../native-base-protocol/#model-family-and-key-identities).

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

The `codeql` job in `.github/workflows/ci.yml` is currently disabled with `if: false` during the
private-to-public preparation period. This is intentional preparatory configuration only: it does
not currently analyse source or upload SARIF results, and the required-check aggregator accepts
the resulting skipped state.

As part of the public cutover, replace the temporary condition with the intended repository scope
and validate the job before documenting it as an active check. The prepared job uses
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

## Cache lifecycle checks

The default tests cover exact reuse, worker validation, GC and source return.
The installation-work regressions count activity across partitions and shared
directories. Product logs include elapsed phase timing for diagnosis.

## Adding a new CI provider

See [CI Abstraction Layer](../../architecture/ci-abstraction/) for the interfaces a new provider
adapter must implement and the rules that keep provider-specific logic out of the shared core.

Per-provider implementation notes:

- [Codeberg / Forgejo CI](../portability/codeberg/)
- [GitLab CI](../portability/gitlab/)

## Dependency metadata snapshot qualification

Unit coverage exercises complete membership replacement, configured exclusions, writer ownership,
missing versus empty versus invalid contributions, optional discovery, publication projection, GC,
and interrupted-owner rejection. The archive test uses the installed GitHub glob
implementation and GNU tar, rather than a backend that ignores path patterns.

To check real Gradle recovery after ordinary artifact eviction while retaining captured binary
metadata, supply an already installed Gradle executable:

```sh
INTEGRATION_TESTS=1 BUILDISH_TEST_GRADLE_EXECUTABLE=/absolute/path/to/gradle/bin/gradle \
  node_modules/.bin/vitest run test/integration/gradle-metadata-eviction.test.ts
```

The test uses a loopback Maven repository, a disposable Gradle home under `build/`, and
`--no-daemon`. It does not provision Gradle or use public dependency repositories. It is skipped
when the executable is not supplied. This checks missing-artifact recovery after a native snapshot round trip; it does not promise offline completeness, binary-index merging, or portability
across every Gradle format and platform.
