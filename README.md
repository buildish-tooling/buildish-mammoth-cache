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

# Apache Buildish Mammoth Cache for Gradle

Apache Buildish Mammoth Cache for Gradle provides secure Gradle wrapper provisioning plus local and distributed cache
management for GitHub Actions today, prepared for Codeberg/Forgejo and GitLab CI in the future.

The shared core is structured so future provider integrations can target GitHub, Codeberg/Forgejo, and GitLab without
rewriting the wrapper, cache, or distributed-delta logic.

Use it in workflows as `apache/buildish-mammoth-cache-gradle/descriptors/github/internal-unreleased-consumer-path@<ref>`.

This Buildish Mammoth Cache family can grow with sibling actions for other build tools over time.

## Usage in GitHub workflows

Until the first public release exists, use a repository ref you control for testing.

```yaml
steps:
  - uses: actions/checkout@v5
  - uses: apache/buildish-mammoth-cache-gradle/descriptors/github/internal-unreleased-consumer-path@<ref>
```

## Runtime and toolchain requirements

- GitHub Action runtime: Node 24
- Local development baseline: Node `24.13.0`
- Expected npm version for repository tooling: `11.6.2`
- Java `21+` for Apache RAT license-header checks

The repository pins these versions so local development, CI, and the published action runtime stay aligned.

For Java installation and switching, we recommend [SDKMAN!](https://sdkman.io/). Install at least Java 21 before running
the RAT checks locally.

## GitHub action configuration

### `config-file`

- Default: unset
- Optional workspace-relative `.json`, `.yml`, or `.yaml` file containing a top-level object.
- Config-file keys use the same kebab-case names as the action inputs.
- Direct action inputs override values loaded from the file.
- `dependent-jobs` and `wrapper-properties-files` may be either strings or arrays in the file.
- `cache-partitions` may be expressed as a native YAML/JSON array in the file instead of a serialized JSON string.
- `github-token` is intentionally rejected in config files; pass secrets directly via action inputs or environment
  variables.
- The resolved file must remain inside the workspace after symlink resolution.

### `base-directory`

- Default: `.`
- Repository-relative base directory for wrapper discovery and other project-relative paths.
- Windows-style relative paths using `\` are accepted and normalized to internal POSIX-style paths.
- Absolute/rooted paths are rejected, including `C:\repo`, `\Windows\System32`, and `\\server\share`.
- Must remain inside the repository workspace.

### `cache-enabled`

- Default: `true`
- Accepted values: `true`, `false`
- Enables or disables cache orchestration.

### `read-only`

- Default: event-dependent
- Accepted values: `true`, `false`
- Defaults to `true` for `pull_request` / `pull_request_target`.
- Defaults to `false` for other events.
- Use this to prevent cache mutation.

### `job-mode`

- Default: `standalone`
- Supported values:
  - `standalone`
  - `distributed-worker`
  - `distributed-aggregator`
- Controls cache coordination behavior.

### `dependent-jobs`

- Default: empty
- Comma- or newline-separated job names.
- Only valid with distributed job modes.

### `cache-key-prefix`

- Default: `buildish-mammoth-gradle-cache-`
- Must start with an alphanumeric character.
- Remaining characters may only be letters, numbers, `.`, `_`, or `-`.

### `cache-key-template`

- Default: unset
- Optional restricted template for cache key generation.
- Supported placeholders:
  - `${cacheKeyPrefix}`
  - `${schemaVersion}`
  - `${partitionFingerprint}`
  - `${javaMajor}`
  - `${runnerOs}`
  - `${runnerArch}`
  - `${refName}`
- Custom templates must include `${partitionFingerprint}` so different cache partition layouts do not share the same
  base cache key.

### `cache-partitions`

- Default: empty
- Optional JSON array of cache partition overrides and custom partitions.
- In `config-file`, this may also be a native YAML/JSON array instead of a serialized string.
- Each object must contain:
  - `id`: lowercase letters, numbers, and `-` only
  - `includes`: array of Gradle-user-home-relative include globs
  - `excludes`: optional array of Gradle-user-home-relative exclude globs
- Overriding a built-in partition replaces its built-in include/exclude lists.
- Setting `includes: []` disables a built-in partition.
- Custom partitions must have at least include one glob.
- Hard safety excludes are always enforced even when a partition is overridden.

### `process-all-wrapper-files`

- Default: `false`
- Accepted values: `true`, `false`
- Scans for every matching wrapper properties file under `base-directory`.
- Cannot be combined with `wrapper-properties-files`.

### `wrapper-properties-glob`

- Default: `**/gradle/wrapper/gradle-wrapper.properties`
- Repository-relative discovery glob used beneath `base-directory`.
- Windows-style relative paths using `\` are accepted and normalized before evaluation.
- Absolute/rooted paths are rejected, including drive-prefixed, rooted, and UNC paths.

### `wrapper-properties-files`

- Default: empty
- Comma- or newline-separated explicit `gradle-wrapper.properties` files.
- Paths are relative to `base-directory`.
- Windows-style relative paths using `\` are accepted and normalized to internal POSIX-style paths.
- Absolute/rooted paths are rejected, including drive-prefixed, rooted, and UNC paths.
- Entries must be explicit file paths, not globs.

### `cleanup-enabled`

- Default: `true`
- Accepted values: `true`, `false`
- Enables the later cleanup-trigger flow used by cache management.

### `restore-cleanup-mode`

- Default: `none`
- Supported values:
  - `none`
  - `prune-managed`
- `prune-managed` only acts after a base-cache hit.
- It deletes files currently matched by the active managed partitions, then restores the matched base cache again.
- It never deletes files outside the action-managed partition space.
- It is intentionally an opt-in because it is more destructive and may increase restore time.

### `gradle-user-home`

- Default: `$GRADLE_USER_HOME` when set, otherwise `$HOME/.gradle`
- In v1, only the default Gradle user home is supported.
- Non-default values fail validation intentionally.

### `setup-java`

- Default: `false`
- Accepted values: `true`, `false`
- Reserved compatibility flag.
- In v1, setting `true` fails intentionally.
- Run `actions/setup-java` before this action instead.

### `github-token`

- Default: unset
- Optional GitHub token used only for authenticated wrapper JAR downloads against the GitHub API.
- When omitted, the action uses `GITHUB_TOKEN` from the runner environment if available.
- Helps reduce throttling when fetching `gradle-wrapper.jar` from the Gradle source repository.
- Downloaded wrapper JARs are accepted only after detached-signature and SHA-256 verification.
- Gradle signing keys are pinned in-source as an allowlist so old and new keys can overlap during rotation.
- Never written to summaries or persisted post-action state.

## Cache partitions and restore cleanup

### Built-in partitions

The action resolves the Gradle user home into ordered logical partitions:

- `modules` — dependency artifacts, jars, and resource stores
- `transforms-metadata` — artifact transforms and related metadata; disabled by default
- `kotlin-dsl` — compiled Kotlin DSL scripts and generated Gradle API jars; enabled by default
- `build-cache` — the local Gradle build cache
- `wrapper-dists` — wrapper-downloaded Gradle distributions

See [The Gradle User Home Caches Directory](docs/gradle-cache-contents.md) for more details on what each partition covers.

Built-ins keep a deterministic order. Custom partitions are appended after the active built-ins in the order supplied by
`cache-partitions`.

The resolved partition order plus each partition's include/exclude set is hashed into `partitionFingerprint`, which is
part of the base cache key. Changing the active partition layout therefore produces a different base cache lineage
instead of reusing an incompatible one.

### Include and exclude semantics

- Includes define the files the action manages for a partition.
- Excludes remove files from that partition after includes are matched.
- Overriding a built-in replaces its built-in include/exclude lists.
- Built-in overrides with `includes: []` disable that built-in.
- Custom partitions with `includes: []` are rejected.
- If the same file matches more than one active partition, manifest capture fails instead of guessing an owner.

Hard safety excludes are always applied to every active partition and cannot be removed:

- `**/configuration-cache/**`
- `**/*.lock`
- `caches/*/cc-keystore`
- `caches/journal-1/**`

These exclusions are intentional safety rails for volatile or security-sensitive content.

### Supported glob subset

All partition globs are relative to the supported Gradle user home.

- Absolute paths are rejected.
- `..` traversal is rejected.
- Negated globs are rejected.
- Supported wildcards are:
  - `*` within a single path segment
  - `**` as a whole path segment
- Include globs must end in `/**`.
- Include globs may not use `**` anywhere except the final segment.
- Exclude globs may use `**` as a whole path segment anywhere in the pattern.
- Other glob operators such as `?`, character classes, braces, and extglobs are rejected.

Examples:

- valid include: `caches/*/kotlin-dsl/**`
- valid exclude: `caches/modules-*/metadata-*/**`
- valid exclude: `**/*.lock`
- invalid include: `/home/runner/.gradle/caches/**`
- invalid include: `caches/**/tmp/**`
- invalid exclude: `!caches/foo/**`

### Partition customization example

Use `cache-partitions` as JSON. Example:

```json
[
  {
    "id": "modules",
    "includes": ["caches/modules-*/files-*/**", "caches/jars-*/**"],
    "excludes": ["caches/modules-*/metadata-*/**"]
  },
  {
    "id": "kotlin-dsl",
    "includes": []
  },
  {
    "id": "custom-generated-jars",
    "includes": ["caches/*/generated-gradle-jars/**"],
    "excludes": []
  }
]
```

That example:

- overrides `modules`
- disables the built-in `kotlin-dsl` partition
- adds a custom partition named `custom-generated-jars`
- changes `partitionFingerprint`, so it uses a different base cache key than the default layout

### Restore cleanup behavior

`restore-cleanup-mode=prune-managed` is the safe, narrow cleanup mode supported today.

- It only runs after a base-cache hit.
- It only deletes files currently matched by the active managed partitions.
- After pruning, it restores the matched base cache again before the build starts.
- It does not delete unmanaged files elsewhere in `GRADLE_USER_HOME`.
- If you disable a partition, files from that now-disabled partition are no longer considered action-managed and are
  left untouched.
- If the follow-up restore misses after pruning, the action fails instead of continuing with a partially pruned managed
  cache space.

This is intentionally narrower than “delete everything outside the include patterns” because the action does not own all
of `GRADLE_USER_HOME`, especially on long-lived self-hosted runners.

## Usage examples

### Standalone — single Gradle job

The minimal setup for a single-job workflow.

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      actions: write  # required: cache write
      contents: read
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-java@v5
        with:
          distribution: temurin
          java-version: '21'
      - uses: apache/buildish-mammoth-cache-gradle/descriptors/github/internal-unreleased-consumer-path@<ref>
      - run: ./gradlew build
```

### Standalone — pull-request read-only mode

The action defaults to read-only on `pull_request` events. No extra configuration is needed.

```yaml
on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-java@v5
        with:
          distribution: temurin
          java-version: '21'
      - uses: apache/buildish-mammoth-cache-gradle/descriptors/github/internal-unreleased-consumer-path@<ref>
      - run: ./gradlew build
```

### Distributed — worker and aggregator jobs

A distributed workflow where independent worker jobs build in parallel and an aggregator merges the
resulting Gradle cache deltas.

```yaml
jobs:
  worker-a:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-java@v5
        with:
          distribution: temurin
          java-version: '21'
      - uses: apache/buildish-mammoth-cache-gradle/descriptors/github/internal-unreleased-consumer-path@<ref>
        with:
          job-mode: distributed-worker
      - run: ./gradlew :module-a:build

  worker-b:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-java@v5
        with:
          distribution: temurin
          java-version: '21'
      - uses: apache/buildish-mammoth-cache-gradle/descriptors/github/internal-unreleased-consumer-path@<ref>
        with:
          job-mode: distributed-worker
      - run: ./gradlew :module-b:build

  aggregator:
    needs: [worker-a, worker-b]
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-java@v5
        with:
          distribution: temurin
          java-version: '21'
      - uses: apache/buildish-mammoth-cache-gradle/descriptors/github/internal-unreleased-consumer-path@<ref>
        with:
          job-mode: distributed-aggregator
          dependent-jobs: worker-a, worker-b
```

### Config file — centralized configuration

Use a shared config file to avoid repeating inputs across jobs.

```yaml
# .github/buildish-mammoth-gradle.yml
job-mode: distributed-worker
cache-key-prefix: my-project-gradle-
wrapper-properties-files: gradle/wrapper/gradle-wrapper.properties
```

```yaml
steps:
  - uses: actions/checkout@v5
  - uses: apache/buildish-mammoth-cache-gradle/descriptors/github/internal-unreleased-consumer-path@<ref>
    with:
      config-file: .github/buildish-mammoth-gradle.yml
```

### Partition customization — prune kotlin-dsl, add custom partition

```yaml
steps:
  - uses: apache/buildish-mammoth-cache-gradle/descriptors/github/internal-unreleased-consumer-path@<ref>
    with:
      cache-partitions: |
        [
          { "id": "kotlin-dsl", "includes": [] },
          { "id": "my-generated", "includes": ["caches/*/my-generated/**"] }
        ]
```

## GitHub Actions permissions

The minimum required token permissions depend on the job mode and read-only setting.

| Scenario | `actions` | `contents` |
|---|---|---|
| Standalone, cache write | `write` | `read` |
| Standalone, read-only | `read` | `read` |
| Distributed worker | `write` | `read` |
| Distributed aggregator | `write` | `read` |
| Cache disabled | none | `read` |

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

| Pattern | Reason |
|---|---|
| `**/configuration-cache/**` | May contain encrypted secrets; volatile by nature |
| `**/*.lock` | PID-bearing files that cause hangs if restored on another runner |
| `caches/*/cc-keystore` | Configuration-cache encryption key material |
| `caches/journal-1/**` | Gradle's local-only file-access journal; migrating it causes corruption |

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

See [`docs/ci-abstraction.md`](docs/ci-abstraction.md) for the provider boundary rules and the
interfaces that a new adapter must implement.

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

- `IMPLEMENTATION-PLAN.md`
- `docs/provider-portability-implementation-plan.md`
- `docs/codeberg-ci-support-evaluation.md`
- `docs/gitlab-ci-support-evaluation.md`

## License

Apache Buildish is licensed under Apache License 2.0.

See:

- [`LICENSE`](./LICENSE)
- [`NOTICE`](./NOTICE)
- [`DISCLAIMER`](./DISCLAIMER)

Project governance and community docs:

- [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- [`SECURITY.md`](./SECURITY.md)
- [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)

## Incubation status

Apache Buildish is an effort undergoing incubation at The Apache Software Foundation (ASF), sponsored by the Apache
Incubator PMC.

Incubation is required of all newly accepted projects until a further review indicates that the infrastructure,
communications, and decision-making process have stabilized in a manner consistent with other successful ASF projects.

While incubation status is not necessarily a reflection of the completeness or stability of the code, it does indicate
that the project has yet to be fully endorsed by the ASF.
