---
title: Cache Partitions
weight: 40
description: Built-in partitions, customization, glob rules, and restore cleanup for Apache Buildish Mammoth Cache for Gradle.
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

## Built-in partitions

The action resolves the Gradle user home into ordered logical partitions:

| Partition             | Contents                                                  | Default  |
| --------------------- | --------------------------------------------------------- | -------- |
| `modules`             | Dependency artifacts, JARs, and resource stores           | enabled  |
| `transforms-metadata` | Artifact transforms and related metadata                  | disabled |
| `kotlin-dsl`          | Compiled Kotlin DSL scripts and generated Gradle API JARs | enabled  |
| `build-cache`         | The local Gradle build cache                              | enabled  |
| `wrapper-dists`       | Wrapper-downloaded Gradle distributions                   | enabled  |

See [Gradle cache internals](../architecture/gradle-cache-internals/) for details on what each partition covers
and why certain directories are excluded.

Built-ins keep a deterministic order. Custom partitions are appended after the active built-ins in the order
supplied by `cache-partitions`.

The resolved partition order plus each partition's include/exclude set is hashed into `partitionFingerprint`,
which is part of the base cache key. Changing the active partition layout produces a different cache key lineage.

## Include and exclude semantics

- Includes define the files the action manages for a partition.
- Excludes remove files from that partition after includes are matched.
- Overriding a built-in replaces its built-in include/exclude lists.
- Built-in overrides with `includes: []` disable that built-in.
- Custom partitions with `includes: []` are rejected.
- If the same file matches more than one active partition, manifest capture fails instead of guessing an owner.

Hard safety excludes are always applied to every active partition and cannot be removed:

| Pattern                     | Reason                                                                  |
| --------------------------- | ----------------------------------------------------------------------- |
| `**/configuration-cache/**` | May contain encrypted secrets; volatile by nature                       |
| `**/*.lock`                 | PID-bearing files that cause hangs if restored on another runner        |
| `caches/*/cc-keystore`      | Configuration-cache encryption key material                             |
| `caches/journal-1/**`       | Gradle's local-only file-access journal; migrating it causes corruption |

## Supported glob subset

All partition globs are relative to the Gradle user home.

- Absolute paths are rejected.
- `..` traversal is rejected.
- Negated globs are rejected.
- Supported wildcards: `*` within a single path segment; `**` as a whole path segment.
- Include globs must end in `/**` and may not use `**` anywhere except the final segment.
- Exclude globs may use `**` as a whole path segment anywhere in the pattern.
- Other glob operators (`?`, character classes, braces, extglobs) are rejected.

Examples:

| Glob                             | Valid | Type                                 |
| -------------------------------- | ----- | ------------------------------------ |
| `caches/*/kotlin-dsl/**`         | ✓     | include                              |
| `caches/modules-*/metadata-*/**` | ✓     | exclude                              |
| `**/*.lock`                      | ✓     | exclude                              |
| `/home/runner/.gradle/caches/**` | ✗     | absolute path                        |
| `caches/**/tmp/**`               | ✗     | `**` not allowed mid-path in include |
| `!caches/foo/**`                 | ✗     | negated globs not supported          |

## Partition customization example

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

This example: overrides `modules`, disables `kotlin-dsl`, and adds a custom partition. The
`partitionFingerprint` changes, so it uses a different base cache key than the default layout.

## Restore cleanup behavior

`restore-cleanup-mode: prune-managed` is the safe, narrow cleanup mode supported today.

- It only runs after a base-cache hit.
- It only deletes files currently matched by the active managed partitions.
- After pruning, it restores the matched base cache again before the build starts.
- It does not delete unmanaged files elsewhere in `GRADLE_USER_HOME`.
- If you disable a partition, files from that now-disabled partition are no longer considered
  action-managed and are left untouched.
- If the follow-up restore misses after pruning, the action fails rather than continuing with a
  partially pruned managed cache space.

This is intentionally narrower than "delete everything outside the include patterns" because the
action does not own all of `GRADLE_USER_HOME`, especially on long-lived self-hosted runners.
