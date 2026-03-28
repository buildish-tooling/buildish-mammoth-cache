---
title: "[FROM README] Cache partitions and restore cleanup"
description: Temporary home for cache-partition guidance moved from the project README.
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

## Built-in partitions

The action resolves the Gradle user home into ordered logical partitions:

- `modules` — dependency artifacts, jars, and resource stores
- `transforms-metadata` — artifact transforms and related metadata; disabled by default
- `kotlin-dsl` — compiled Kotlin DSL scripts and generated Gradle API jars; enabled by default
- `build-cache` — the local Gradle build cache
- `wrapper-dists` — wrapper-downloaded Gradle distributions

See [The Gradle User Home Caches Directory](./gradle-cache-contents/) for more details on what each partition covers.

Built-ins keep a deterministic order. Custom partitions are appended after the active built-ins in the order supplied by
`cache-partitions`.

The resolved partition order plus each partition's include/exclude set is hashed into `partitionFingerprint`, which is
part of the base cache key. Changing the active partition layout therefore produces a different base cache lineage
instead of reusing an incompatible one.

## Include and exclude semantics

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

## Supported glob subset

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

## Partition customization example

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

## Restore cleanup behavior

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
