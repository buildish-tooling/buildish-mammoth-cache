---
title: '[FROM README] GitHub action configuration'
description: Temporary home for configuration details moved from the project README.
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

## `config-file`

- Default: unset
- Optional workspace-relative `.json`, `.yml`, or `.yaml` file containing a top-level object.
- Config-file keys use the same kebab-case names as the action inputs.
- Direct action inputs override values loaded from the file.
- `dependent-jobs` and `wrapper-properties-files` may be either strings or arrays in the file.
- `cache-partitions` may be expressed as a native YAML/JSON array in the file instead of a serialized JSON string.
- `github-token` is intentionally rejected in config files; pass secrets directly via action inputs or environment
  variables.
- The resolved file must remain inside the workspace after symlink resolution.

## `base-directory`

- Default: `.`
- Repository-relative base directory for wrapper discovery and other project-relative paths.
- Windows-style relative paths using `\` are accepted and normalized to internal POSIX-style paths.
- Absolute/rooted paths are rejected, including `C:\repo`, `\Windows\System32`, and `\\server\share`.
- Must remain inside the repository workspace.

## `cache-enabled`

- Default: `true`
- Accepted values: `true`, `false`
- Enables or disables cache orchestration.

## `read-only`

- Default: event-dependent
- Accepted values: `true`, `false`
- Defaults to `true` for `pull_request` / `pull_request_target`.
- Defaults to `false` for other events.
- Use this to prevent cache mutation.

## `job-mode`

- Default: `standalone`
- Supported values:
  - `standalone`
  - `distributed-worker`
  - `distributed-aggregator`
- Controls cache coordination behavior.

## `dependent-jobs`

- Default: empty
- Comma- or newline-separated job names.
- Only valid with distributed job modes.

## `cache-key-prefix`

- Default: `buildish-mammoth-gradle-cache-`
- Must start with an alphanumeric character.
- Remaining characters may only be letters, numbers, `.`, `_`, or `-`.

## `cache-key-template`

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

## `cache-partitions`

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

## `process-all-wrapper-files`

- Default: `false`
- Accepted values: `true`, `false`
- Scans for every matching wrapper properties file under `base-directory`.
- Cannot be combined with `wrapper-properties-files`.

## `wrapper-properties-glob`

- Default: `**/gradle/wrapper/gradle-wrapper.properties`
- Repository-relative discovery glob used beneath `base-directory`.
- Windows-style relative paths using `\` are accepted and normalized before evaluation.
- Absolute/rooted paths are rejected, including drive-prefixed, rooted, and UNC paths.

## `wrapper-properties-files`

- Default: empty
- Comma- or newline-separated explicit `gradle-wrapper.properties` files.
- Paths are relative to `base-directory`.
- Windows-style relative paths using `\` are accepted and normalized to internal POSIX-style paths.
- Absolute/rooted paths are rejected, including drive-prefixed, rooted, and UNC paths.
- Entries must be explicit file paths, not globs.

## `cleanup-enabled`

- Default: `true`
- Accepted values: `true`, `false`
- Enables the later cleanup-trigger flow used by cache management.

## `restore-cleanup-mode`

- Default: `none`
- Supported values:
  - `none`
  - `prune-managed`
- `prune-managed` only acts after a base-cache hit.
- It deletes files currently matched by the active managed partitions, then restores the matched base cache again.
- It never deletes files outside the action-managed partition space.
- It is intentionally an opt-in because it is more destructive and may increase restore time.

## `gradle-user-home`

- Default: `$GRADLE_USER_HOME` when set, otherwise `$HOME/.gradle`
- In v1, only the default Gradle user home is supported.
- Non-default values fail validation intentionally.

## `setup-java`

- Default: `false`
- Accepted values: `true`, `false`
- Reserved compatibility flag.
- In v1, setting `true` fails intentionally.
- Run `actions/setup-java` before this action instead.

## `github-token`

- Default: unset
- Optional GitHub token used only for authenticated wrapper JAR downloads against the GitHub API.
- When omitted, the action uses `GITHUB_TOKEN` from the runner environment if available.
- Helps reduce throttling when fetching `gradle-wrapper.jar` from the Gradle source repository.
- Downloaded wrapper JARs are accepted only after detached-signature and SHA-256 verification.
- Gradle signing keys are pinned in-source as an allowlist so old and new keys can overlap during rotation.
- Never written to summaries or persisted post-action state.
