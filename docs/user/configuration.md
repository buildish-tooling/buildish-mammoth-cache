---
title: Configuration Reference
weight: 30
description: All action inputs and config-file options for Apache Buildish Mammoth Cache for Gradle and Maven.
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

<!--
SYNC: This page is maintained manually in parallel with the `description:` and `default:` fields
in actions/github/gradle/action.yml and actions/github/maven/action.yml, and with the enum value
lists in src/config/types.ts. When adding, removing, or changing any input keep all of those
files up to date. See docs/dev/maintenance.md § "Action input documentation sync" for the full
list and rationale. Search for SYNC in the repository to find all sync-obligated locations.
-->

The action is available in two build-tool-specific variants that share most inputs:

- **Gradle** — `apache/buildish-mammoth-cache/actions/github/gradle@<sha>`
- **Maven** — `apache/buildish-mammoth-cache/actions/github/maven@<sha>`

All inputs described in [Common inputs](#common-inputs) apply to both. Inputs described under
[Gradle-only inputs](#gradle-only-inputs) or [Maven-only inputs](#maven-only-inputs) are accepted
only by the corresponding action and ignored (or rejected) by the other.

---

## Common inputs

### `config-file`

- Default: unset
- Optional workspace-relative `.json`, `.yml`, or `.yaml` file containing a top-level object.
- Config-file keys use the same kebab-case names as the action inputs.
- Direct action inputs override values loaded from the file.
- `dependent-jobs` and `wrapper-properties-files` may be either strings or arrays in the file.
- `cache-partitions` may be expressed as a native YAML/JSON array in the file instead of a serialized JSON string.
- `github-token` is intentionally rejected in config files; pass secrets directly via action inputs or environment variables.
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

- Default: `buildish-mammoth-gradle-cache-` for Gradle, `buildish-mammoth-maven-cache-` for Maven
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
- Custom templates must include `${partitionFingerprint}` so different cache partition layouts do not share the same base cache key.

### `cache-partitions`

- Default: empty
- Optional JSON array of cache partition overrides and custom partitions.
- In `config-file`, this may also be a native YAML/JSON array instead of a serialized string.
- Each object must contain:
  - `id`: lowercase letters, numbers, and `-` only
  - `includes`: array of cache-root-relative include globs
  - `excludes`: optional array of cache-root-relative exclude globs
- Overriding a built-in partition replaces its built-in include/exclude lists.
- Setting `includes: []` disables a built-in partition.
- Custom partitions must have at least one include glob.
- Hard safety excludes are always enforced even when a partition is overridden.

### `cleanup-enabled`

- Default: `true`
- Accepted values: `true`, `false`
- Enables the later cleanup-trigger flow used by cache management.

### `restore-cleanup-mode`

- Default: `none`
- Supported values: `none`, `prune-managed`
- `prune-managed` only acts after a base-cache hit.
- It deletes files currently matched by the active managed partitions, then restores the matched base cache again.
- It never deletes files outside the action-managed partition space.
- It is intentionally an opt-in because it is more destructive and may increase restore time.

### `allow-duplicate-dependent-delta-paths`

- Default: `false`
- Accepted values: `true`, `false`
- When `true`, the aggregator tolerates two worker deltas that both modified the same path (last writer wins).
- When `false`, any path conflict is treated as an error to prevent silent data loss.
- Only relevant for distributed aggregator jobs.

### `github-event-name`

- Default: unset (the action reads `GITHUB_EVENT_NAME` from the runner environment)
- **Reusable workflows only.** When a workflow is triggered via `workflow_call`, GitHub sets
  `GITHUB_EVENT_NAME` to `workflow_call` rather than the original caller's event name. Pass
  `${{ github.event_name }}` from the caller workflow to restore the correct value.
- Affects `isPullRequest` detection and the default read-only behavior on pull-request events.
- Example:
  ```yaml
  github-event-name: ${{ github.event_name }}
  ```

### `github-job-name`

- Default: unset (the action reads `GITHUB_JOB` from the runner environment)
- **Reusable workflows and matrix jobs.** Assigns a stable, predictable job name for cache
  coordination and artifact naming, independent of the GitHub Actions job key or matrix label.
- Example:
  ```yaml
  github-job-name: aggregator
  ```

### `github-ref-name`

- Default: unset (the action resolves the ref name from `GITHUB_REF_NAME`, `GITHUB_REF`, and
  the event payload)
- **Reusable workflows only.** When a workflow is triggered via `workflow_call`, the ref context
  visible inside the reusable workflow may differ from the caller's. Pass the resolved ref name
  from the caller workflow to ensure cache keys use the correct branch or tag.
- Example:
  ```yaml
  github-ref-name: ${{ github.ref_name }}
  ```

### `github-default-branch`

- Default: unset (the action reads the default branch from the event payload or
  `GITHUB_DEFAULT_BRANCH`)
- **Reusable workflows only.** Pass the caller's default branch so that cache key fallbacks
  target the correct base branch.
- Example:
  ```yaml
  github-default-branch: ${{ github.event.repository.default_branch }}
  ```

---

## Gradle-only inputs

### `github-token`

- Default: unset
- Used for authenticated wrapper JAR downloads against the GitHub API (see below).
- When omitted, the Gradle action falls back to `GITHUB_TOKEN` from the runner environment if available.
- Never written to summaries or persisted post-action state.

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

### `gradle-user-home`

- Default: `$GRADLE_USER_HOME` when set, otherwise `$HOME/.gradle`
- In v1, only the default Gradle user home is supported. Non-default values fail validation intentionally.

### `setup-java`

- Default: `false`
- Reserved compatibility flag. In v1, setting `true` fails intentionally.
- Run `actions/setup-java` before this action instead.

---

## Maven-only inputs

### `maven-local-repository`

- Default: `$MAVEN_USER_HOME` when set, otherwise `$HOME/.m2`
- Absolute path to the Maven local repository that the action should cache.
- In v1, the path must resolve to the default Maven local repository location.

---

## Distributed mode wiring example

The snippets below show the minimum input wiring needed to connect two worker jobs to an
aggregator. The `github-job-name` input gives each job a stable, human-readable name that is
independent of matrix labeling; the aggregator's `dependent-jobs` must list exactly those names.

See [Distributed Multi-Job Builds](distributed-jobs.md) for a full explanation of how the
delta exchange works and for additional configuration options.

### Gradle

```yaml
jobs:
  worker-a:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@dded0888837ed1f317902acf8a20df0ad188d165
        with: { distribution: temurin, java-version: '21' }
      - uses: apache/buildish-mammoth-cache/actions/github/gradle@<commit-sha>
        with:
          job-mode: distributed-worker
          github-job-name: worker-a # stable name used by the aggregator
          cache-key-prefix: my-project-gradle-
      - run: ./gradlew :module-a:build

  worker-b:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@dded0888837ed1f317902acf8a20df0ad188d165
        with: { distribution: temurin, java-version: '21' }
      - uses: apache/buildish-mammoth-cache/actions/github/gradle@<commit-sha>
        with:
          job-mode: distributed-worker
          github-job-name: worker-b
          cache-key-prefix: my-project-gradle-
      - run: ./gradlew :module-b:build

  aggregator:
    needs: [worker-a, worker-b]
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@dded0888837ed1f317902acf8a20df0ad188d165
        with: { distribution: temurin, java-version: '21' }
      - uses: apache/buildish-mammoth-cache/actions/github/gradle@<commit-sha>
        with:
          job-mode: distributed-aggregator
          dependent-jobs: worker-a, worker-b # must match github-job-name on each worker
          github-job-name: aggregator
          cache-key-prefix: my-project-gradle-
```

### Maven

```yaml
jobs:
  worker-a:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@dded0888837ed1f317902acf8a20df0ad188d165
        with: { distribution: temurin, java-version: '21' }
      - uses: apache/buildish-mammoth-cache/actions/github/maven@<commit-sha>
        with:
          job-mode: distributed-worker
          github-job-name: worker-a
          cache-key-prefix: my-project-maven-
      - run: mvn -pl module-a verify

  worker-b:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@dded0888837ed1f317902acf8a20df0ad188d165
        with: { distribution: temurin, java-version: '21' }
      - uses: apache/buildish-mammoth-cache/actions/github/maven@<commit-sha>
        with:
          job-mode: distributed-worker
          github-job-name: worker-b
          cache-key-prefix: my-project-maven-
      - run: mvn -pl module-b verify

  aggregator:
    needs: [worker-a, worker-b]
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@dded0888837ed1f317902acf8a20df0ad188d165
        with: { distribution: temurin, java-version: '21' }
      - uses: apache/buildish-mammoth-cache/actions/github/maven@<commit-sha>
        with:
          job-mode: distributed-aggregator
          dependent-jobs: worker-a, worker-b
          github-job-name: aggregator
          cache-key-prefix: my-project-maven-
```
