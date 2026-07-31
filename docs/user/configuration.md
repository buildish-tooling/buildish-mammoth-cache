---
title: Configuration Reference
weight: 30
description: All action inputs and config-file options for Buildish Mammoth Cache for Gradle and Maven.
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

The action is available in two build-tool-specific variants that share most inputs:

- **Gradle** — `buildish-tooling/buildish-mammoth-cache/actions/github/gradle@<sha>`
- **Maven** — `buildish-tooling/buildish-mammoth-cache/actions/github/maven@<sha>`

All inputs described in [Common inputs](#common-inputs) apply to both. Inputs described under
[Gradle-only inputs](#gradle-only-inputs) or [Maven-only inputs](#maven-only-inputs) are accepted
only by the corresponding action and ignored (or rejected) by the other.

The following compact matrix is generated from the typed public contract. The detailed sections
below add examples and rationale; the parity test ensures metadata, readers, config-file keys,
runtime outputs, and these reference rows cannot silently diverge.

<!-- BEGIN GENERATED PUBLIC ACTION CONTRACT -->

### Canonical input matrix

| Input                                   | Action        | Default                                       | Config file | Meaning                                                                                                                                                                      |
| --------------------------------------- | ------------- | --------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config-file`                           | Gradle, Maven | `event-dependent or unset`                    | no          | Optional workspace-relative JSON or YAML configuration file. Direct action inputs override file values; secrets and GitHub context inputs are direct-only.                   |
| `base-directory`                        | Gradle, Maven | `.`                                           | yes         | Repository-relative project base directory. Rooted paths and paths that escape the workspace are rejected.                                                                   |
| `cache-enabled`                         | Gradle, Maven | `true`                                        | yes         | Enables cache orchestration. Accepted values: true or false.                                                                                                                 |
| `read-only`                             | Gradle, Maven | `event-dependent or unset`                    | yes         | Disables cache and delta writes. Pull-request events default to true; repository config may make the policy stricter, but only a direct workflow input may lower that floor. |
| `job-mode`                              | Gradle, Maven | `standalone`                                  | yes         | Cache coordination mode: standalone, distributed-worker, or distributed-aggregator.                                                                                          |
| `dependent-jobs`                        | Gradle, Maven | `event-dependent or unset`                    | yes         | Comma- or newline-separated worker job names consumed by a distributed aggregator.                                                                                           |
| `allow-duplicate-dependent-delta-paths` | Gradle, Maven | `false`                                       | yes         | Allows a distributed aggregator to resolve non-identical overlapping worker paths by newest modification time. Exact same-content overlaps remain safe without this option.  |
| `cache-key-prefix`                      | Gradle, Maven | `buildish-mammoth-cache-`                     | yes         | Namespace prefix for action-owned cache families; build, runner, partition, ref-lineage, and generation identity are appended automatically.                                 |
| `cache-partitions`                      | Gradle, Maven | `event-dependent or unset`                    | yes         | JSON array of cache partition overrides and custom partitions. Hard safety exclusions remain non-overridable.                                                                |
| `cleanup-enabled`                       | Gradle, Maven | `true`                                        | yes         | Enables restore cleanup and timestamp garbage collection.                                                                                                                    |
| `restore-cleanup-mode`                  | Gradle, Maven | `none`                                        | yes         | Restore-time cleanup mode: none or prune-managed.                                                                                                                            |
| `cache-gc-mode`                         | Gradle, Maven | `timestamp`                                   | yes         | Pre-save managed-cache garbage collection mode: off or timestamp.                                                                                                            |
| `cache-gc-older-than-days`              | Gradle, Maven | `14`                                          | yes         | Age threshold for timestamp garbage collection. Must be at least 2 days.                                                                                                     |
| `github-token`                          | Gradle, Maven | `event-dependent or unset`                    | no          | Optional GitHub token for authenticated API requests. Pass secrets directly, never through repository config.                                                                |
| `github-job-check-run-id`               | Gradle, Maven | `event-dependent or unset`                    | no          | Optional check-run ID used to create a direct current-job link.                                                                                                              |
| `github-event-name`                     | Gradle, Maven | `event-dependent or unset`                    | no          | Optional triggering-event override for reusable workflows. Pass the trusted caller event.                                                                                    |
| `github-job-name`                       | Gradle, Maven | `event-dependent or unset`                    | no          | Optional stable job-name override used for distributed artifact coordination.                                                                                                |
| `github-ref-name`                       | Gradle, Maven | `event-dependent or unset`                    | no          | Optional resolved-ref override for reusable workflows.                                                                                                                       |
| `github-default-branch`                 | Gradle, Maven | `event-dependent or unset`                    | no          | Optional repository default-branch override for reusable workflows.                                                                                                          |
| `process-all-wrapper-files`             | Gradle        | `false`                                       | yes         | Processes every matching Gradle wrapper properties file. Cannot be combined with wrapper-properties-files.                                                                   |
| `wrapper-properties-glob`               | Gradle        | `**/gradle/wrapper/gradle-wrapper.properties` | yes         | Repository-relative Gradle wrapper properties discovery glob.                                                                                                                |
| `wrapper-properties-files`              | Gradle        | `event-dependent or unset`                    | yes         | Comma- or newline-separated explicit Gradle wrapper properties files relative to base-directory.                                                                             |
| `gradle-user-home`                      | Gradle        | `event-dependent or unset`                    | yes         | Gradle user home to manage. The current version accepts only the runner default.                                                                                             |
| `setup-java`                            | Gradle        | `false`                                       | yes         | Reserved compatibility flag. The current version rejects true; run actions/setup-java first.                                                                                 |
| `maven-user-home`                       | Maven         | `event-dependent or unset`                    | yes         | Absolute or working-directory-relative Maven user home to manage, including repository/ and wrapper/dists/; defaults to MAVEN_USER_HOME or ~/.m2.                            |

### Canonical output matrix

| Output                           | Meaning                                                                    |
| -------------------------------- | -------------------------------------------------------------------------- |
| `cache-family-key`               | Stable compatibility family shared by structurally compatible generations. |
| `cache-lineage-prefix`           | Current-ref prefix used to restore the newest immutable generation.        |
| `base-cache-restore-status`      | Classified base-cache restore outcome for prepare.                         |
| `restored-cache-key`             | Exact immutable generation restored during prepare, when any.              |
| `read-only`                      | Whether cache and delta writes are disabled.                               |
| `job-mode`                       | Effective standalone or distributed job mode.                              |
| `dependent-delta-status`         | Dependent-delta outcome: not-configured, applied, or skipped-read-only.    |
| `dependent-delta-artifact-count` | Number of dependent worker artifacts applied during prepare.               |

<!-- END GENERATED PUBLIC ACTION CONTRACT -->

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
- A repository config file may set `true`, but cannot set `false` to lower the pull-request safety
  floor. Only a direct workflow input can make that explicit trusted-workflow choice.
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

- Default: `buildish-mammoth-cache-`
- Must start with an alphanumeric character.
- Remaining characters may only be letters, numbers, `.`, `_`, or `-`.
- Changes only the namespace prefix. The action always appends build tool, schema, Java, runner,
  partition, ref-lineage, and immutable-generation identity.

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
- Enables restore cleanup and timestamp garbage collection. When `false`, both are skipped even if
  their individual modes request cleanup.

### `cache-gc-mode`

- Default: `timestamp`
- Supported values: `off`, `timestamp`
- Controls best-effort garbage collection of managed cache files before standalone or
  distributed-aggregator jobs save the base cache.
- `timestamp` deletes a managed file only when both its modification time and effective access time are older than `cache-gc-older-than-days`.
- Effective access time is evaluated conservatively as the newer of access time and modification time.
- Set `off` when jobs must retain rarely used old cache entries, for example offline-style builds that cannot redownload pruned dependencies.

### `cache-gc-older-than-days`

- Default: `14`
- Minimum: `2`
- Age threshold for `cache-gc-mode: timestamp`.
- The minimum is intentionally above 24 hours because common runner filesystems may defer or coalesce access-time updates.
- Increase this value if your Gradle or Maven build uses a large dependency set with artifacts that are valid but touched infrequently.

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
- When `true`, the aggregator resolves non-identical overlapping worker paths by newest modification
  time.
- Exact same-content overlaps merge safely without this option.
- When `false`, non-identical path conflicts are errors.
- Only relevant for distributed aggregator jobs.

### `github-token`

- Default: unset (falls back to `GITHUB_TOKEN` when available)
- Used for authenticated requests to the configured GitHub API host. The Gradle action uses these
  headers for authenticated wrapper downloads; provider integrations may also use them.
- Direct-only: config files reject this secret-bearing input.
- Never written to summaries or persisted post-action state.

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

## Outputs

Both actions expose the same cache lifecycle outputs after prepare:

| Output                           | Meaning                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `cache-family-key`               | Structural compatibility family, without ref or generation identity             |
| `cache-lineage-prefix`           | Current-ref prefix used for newest-generation restore                           |
| `base-cache-restore-status`      | `feature-unavailable`, `miss`, `current-lineage-hit`, or `fallback-lineage-hit` |
| `restored-cache-key`             | Exact immutable generation restored, or an empty string when there was no hit   |
| `read-only`                      | Effective write policy as `true` or `false`                                     |
| `job-mode`                       | Effective standalone or distributed mode                                        |
| `dependent-delta-status`         | `not-configured`, `applied`, or `skipped-read-only`                             |
| `dependent-delta-artifact-count` | Number of worker artifacts applied during prepare                               |

Generation keys are finalize outcomes and are intentionally not planned prepare outputs. The job
summary and finalize log report the exact key only after a successful publication.

---

## Gradle-only inputs

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

### `maven-user-home`

- Default: `$MAVEN_USER_HOME` when set, otherwise `$HOME/.m2`
- Accepts an absolute path or a path resolved from the action process working directory.
- The managed root contains both the Maven local repository at `repository/` and Maven Wrapper
  distributions at `wrapper/dists/`; do not pass the `repository/` directory itself.
- Operators are responsible for ensuring a custom user home contains only intended Maven cache
  state and is not shared across trust zones.

---

## Distributed mode wiring example

The snippets below show the minimum input wiring needed to connect two worker jobs to an
aggregator. The `github-job-name` input gives each job a stable, human-readable name that is
independent of matrix labeling; the aggregator's `dependent-jobs` must list exactly those names.

See [Distributed Multi-Job Builds](../distributed-jobs/) for a full explanation of how the
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
      - uses: buildish-tooling/buildish-mammoth-cache/actions/github/gradle@<commit-sha>
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
      - uses: buildish-tooling/buildish-mammoth-cache/actions/github/gradle@<commit-sha>
        with:
          job-mode: distributed-worker
          github-job-name: worker-b
          cache-key-prefix: my-project-gradle-
      - run: ./gradlew :module-b:build

  aggregator:
    needs: [worker-a, worker-b]
    if: ${{ always() && github.event_name != 'pull_request' && github.event_name != 'pull_request_target' }}
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@dded0888837ed1f317902acf8a20df0ad188d165
        with: { distribution: temurin, java-version: '21' }
      - uses: buildish-tooling/buildish-mammoth-cache/actions/github/gradle@<commit-sha>
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
      - uses: buildish-tooling/buildish-mammoth-cache/actions/github/maven@<commit-sha>
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
      - uses: buildish-tooling/buildish-mammoth-cache/actions/github/maven@<commit-sha>
        with:
          job-mode: distributed-worker
          github-job-name: worker-b
          cache-key-prefix: my-project-maven-
      - run: mvn -pl module-b verify

  aggregator:
    needs: [worker-a, worker-b]
    if: ${{ always() && github.event_name != 'pull_request' && github.event_name != 'pull_request_target' }}
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@dded0888837ed1f317902acf8a20df0ad188d165
        with: { distribution: temurin, java-version: '21' }
      - uses: buildish-tooling/buildish-mammoth-cache/actions/github/maven@<commit-sha>
        with:
          job-mode: distributed-aggregator
          dependent-jobs: worker-a, worker-b
          github-job-name: aggregator
          cache-key-prefix: my-project-maven-
```
