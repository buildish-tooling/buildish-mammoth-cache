---
title: Cache Partitions
weight: 40
description: Built-in partitions, customization, glob rules, timestamp garbage collection, and restore cleanup for Apache Buildish Mammoth Cache for Gradle and Maven.
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

The action splits the build tool's cache directory into logical **partitions** — independently
versioned slices of the cache keyed and saved separately. This keeps entries lean, avoids
cross-contamination between unrelated file sets, and lets you enable, disable, or replace
individual partitions without invalidating the rest.

## Built-in partitions

### Gradle

The Gradle action resolves `GRADLE_USER_HOME` into these ordered partitions:

| Partition             | Contents                                                  | Default  |
| --------------------- | --------------------------------------------------------- | -------- |
| `modules`             | Dependency artifacts, JARs, and resource stores           | enabled  |
| `transforms-metadata` | Artifact transforms and related metadata                  | disabled |
| `kotlin-dsl`          | Compiled Kotlin DSL scripts and generated Gradle API JARs | enabled  |
| `build-cache`         | The local Gradle build cache                              | enabled  |
| `wrapper-dists`       | Wrapper-downloaded Gradle distributions                   | enabled  |

See [Gradle cache internals](../../architecture/gradle-cache-internals/) for details on what each
partition covers and why certain directories are excluded.

### Maven

The Maven action resolves the local repository (`~/.m2` by default) into these partitions:

| Partition       | Contents                               | Default |
| --------------- | -------------------------------------- | ------- |
| `repository`    | Cached Maven artifact repository       | enabled |
| `wrapper-dists` | Wrapper-downloaded Maven distributions | enabled |

See [Maven cache internals](../../architecture/maven-cache-internals/) for details on what each
partition covers and why certain files are excluded.

---

Built-in partitions for both tools keep a deterministic order. Custom partitions are appended after
the active built-ins in the order supplied by `cache-partitions`.

The resolved partition order plus each partition's include/exclude set is hashed into
`partitionFingerprint`, which is part of the base cache key. Changing the active partition layout
produces a different cache key lineage.

## Include and exclude semantics

- Includes define the files the action manages for a partition.
- Excludes remove files from that partition after includes are matched.
- Overriding a built-in replaces its built-in include/exclude lists.
- Built-in overrides with `includes: []` disable that built-in.
- Custom partitions with `includes: []` are rejected.
- If the same file matches more than one active partition, manifest capture fails instead of guessing an owner.

Hard safety excludes are always applied to every active partition and cannot be removed:

**Gradle**

| Pattern                     | Reason                                                                  |
| --------------------------- | ----------------------------------------------------------------------- |
| `**/configuration-cache/**` | May contain encrypted secrets; volatile by nature                       |
| `**/*.lock`                 | PID-bearing files that cause hangs if restored on another runner        |
| `caches/*/cc-keystore`      | Configuration-cache encryption key material                             |
| `caches/journal-1/**`       | Gradle's local-only file-access journal; migrating it causes corruption |

**Maven**

| Pattern                         | Reason                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `**/*.lastUpdated`              | Stale remote-check markers; cause silent re-resolution when shared across runners                               |
| `**/resolver-status.properties` | Maven Resolver group-level remote-check status; per-runner state and a common distributed-merge conflict source |
| `**/_remote.repositories`       | Records which remote a file came from; not portable across different CI environments                            |
| `**/*.lock`                     | PID-bearing resolver lock files that cause hangs if restored on another runner                                  |

## Supported glob subset

All partition globs are relative to the build tool's cache root (`GRADLE_USER_HOME` for Gradle,
the Maven local repository for Maven).

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

## Timestamp garbage collection

`cache-gc-mode: timestamp` is enabled by default to prevent managed cache partitions from growing
without bound, especially Maven local repositories. GitHub Actions cache storage is finite, and a
cache entry that only ever accumulates artifacts eventually becomes less useful or impossible to
save.

Timestamp GC runs during finalize before standalone or distributed-aggregator jobs save the base
cache. A file is eligible only when all of these are true:

- The file is matched by exactly one active cache partition.
- The file is not excluded by partition excludes or hard safety excludes.
- Its modification time is older than `cache-gc-older-than-days`.
- Its effective access time is older than `cache-gc-older-than-days`.

The effective access time is the newer of the file's access time and modification time. This keeps
newly written files even when access time data is stale or unavailable. The default threshold is
`14` days, and the minimum accepted threshold is `2` days because common Linux, macOS, and Windows
runner filesystems do not provide precise "updated on every read" access-time behavior.

Distributed-worker jobs skip timestamp GC because they upload delta artifacts instead of saving the
base cache. The GC pass deletes eligible files and then removes empty parent directories. It does
not delete unmanaged files elsewhere in the build tool cache directory. To disable it:

```yaml
cache-gc-mode: off
```

Use `cache-gc-mode: off` or a larger `cache-gc-older-than-days` value for jobs that intentionally
rely on old, rarely touched artifacts and cannot redownload them.

## Restore cleanup behavior

`restore-cleanup-mode: prune-managed` is the safe, narrow cleanup mode supported today.

- It only runs after a base-cache hit.
- It only deletes files currently matched by the active managed partitions.
- After pruning, it restores the matched base cache again before the build starts.
- It does not delete unmanaged files elsewhere in the build tool cache directory.
- If you disable a partition, files from that now-disabled partition are no longer considered
  action-managed and are left untouched.
- If the follow-up restore misses after pruning, the action fails rather than continuing with a
  partially pruned managed cache space.

This is intentionally narrower than "delete everything outside the include patterns" because the
action does not own the entire build tool cache directory, especially on long-lived self-hosted runners.
