---
title: Cache Partitions
weight: 40
description: Built-in partitions, customization, glob rules, timestamp garbage collection, and restore cleanup for Buildish Mammoth Cache for Gradle and Maven.
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

The action splits the build tool's cache directory into logical **partitions**. Partitions define
which files are captured, compared, cleaned, and reported together inside one complete immutable
cache generation. They keep unrelated file sets and ownership rules explicit; they are not saved as
separate backend entries.

## Built-in partitions

### Gradle

The Gradle action resolves `GRADLE_USER_HOME` into these ordered partitions:

| Partition             | Contents                                                  | Default  |
| --------------------- | --------------------------------------------------------- | -------- |
| `modules`             | Dependency artifacts, JARs, and resource stores           | enabled  |
| `dependency-metadata` | Complete dependency-resolution metadata snapshots         | enabled  |
| `transforms-metadata` | Artifact transforms and related metadata                  | disabled |
| `kotlin-dsl`          | Compiled Kotlin DSL scripts and generated Gradle API JARs | enabled  |
| `groovy-dsl`          | Complete compiled Groovy DSL workspaces                   | enabled  |
| `build-cache`         | The local Gradle build cache                              | enabled  |
| `wrapper-dists`       | Wrapper-downloaded Gradle distributions                   | enabled  |

See [Gradle cache internals](../../architecture/gradle-cache-internals/) for details on what each
partition covers and why certain directories are excluded.

The built-in `modules` partition covers dependency artifacts. `dependency-metadata` separately
covers `caches/modules-*/metadata-*/**` with single-writer publication. The disabled
`transforms-metadata` preset covers artifact transforms and their metadata, not dependency resolution.

The `groovy-dsl` partition captures complete hashed workspaces under
`caches/*/groovy-dsl/<32-hex-key>/`, including both metadata files, compiled classes,
instrumented outputs and empty directories. It defaults to aggregate publication
with `conflict-handling: choose-worker-directory`: one producer supplies each
whole workspace; different workspace keys can come from different producers.
It requires no designated writer. Partial-workspace include/exclude overrides fail
capture. Unknown or incomplete source layouts are skipped with bounded diagnostics;
locks, temporary workspaces and cleanup bookkeeping are excluded.

Changed members select the whole workspace for upload; any observed usage protects
the whole workspace from GC. GC removes a workspace only when every member is old
and unprotected. Base publication stages and hashes all retained Groovy workspaces,
including in standalone mode. This adds local copy/hash I/O. Empty directories travel
as validated metadata alongside flat file payloads, without another archive layer.
Set `enabled: false` on `groovy-dsl` to disable it, or set `conflict-handling: default`
to reject conflicting complete workspace views. Single-writer publication is unsupported.

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

The resolved partition order, include/exclude sets, publication policies, and writer identities are hashed into
`partitionFingerprint`, which is part of the cache family. Changing the active partition layout
produces a different family and therefore starts a cold lineage for the complete managed state.

## Include and exclude semantics

- Includes define the files the action manages for a partition.
- Excludes remove files from that partition after includes are matched.
- Each supplied built-in `includes` or `excludes` list replaces that list; omitted lists inherit
  the preset. This permits a writer-only override.
- Built-in overrides with `includes: []` disable that built-in.
- Custom partitions with `includes: []` are rejected.
- If the same file matches more than one active partition, manifest capture fails instead of guessing an owner.

Hard safety excludes are always applied to every active partition and cannot be removed:

**Gradle**

| Pattern                             | Reason                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `**/configuration-cache/**`         | May contain encrypted secrets; volatile by nature                       |
| `**/*.lock`                         | PID-bearing files that cause hangs if restored on another runner        |
| `caches/*/cc-keystore`              | Configuration-cache encryption key material                             |
| `caches/modules-*/**/gc.properties` | Gradle dependency-cache cleanup markers; omit when copying              |
| `caches/journal-1/**`               | Gradle's local-only file-access journal; migrating it causes corruption |

**Maven**

| Pattern                         | Reason                                                                  |
| ------------------------------- | ----------------------------------------------------------------------- |
| `**/*.lastUpdated`              | Artifact failure/check state that can suppress retries after restore    |
| `**/resolver-status.properties` | Metadata update-check timestamps and errors; omit to allow fresh checks |
| `**/*.lock`                     | Transient Resolver synchronization state                                |

## Publication policies

Each partition resolves a `publication` policy and an optional distributed `writer` job name:

| Field         | Values and default                                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publication` | `aggregate` for ordinary partitions; `single-writer` for the Gradle `dependency-metadata` preset. Overrides inherit the built-in policy; custom partitions default to `aggregate`. |
| `writer`      | Optional producer job identity for `single-writer`. Use the same value in every participating job. It is invalid with `aggregate`.                                                 |

`aggregate` preserves the existing cutoff upsert/usage exchange and conflict checks.
`single-writer` captures and replaces the complete configured file set, including deletions.
Standalone jobs own their snapshots automatically. In distributed mode only the named writer's
snapshot qualifies; all jobs can restore it and modify their local copies. A validated snapshot can
be published even if its build failed. The aggregator can itself be explicitly named as writer.

```yaml
cache-partitions:
  - id: dependency-metadata
    writer: worker-a
```

This is config-file YAML. For a direct action input, pass the equivalent JSON string:

```yaml
cache-partitions: '[{"id":"dependency-metadata","writer":"worker-a"}]'
```

If no writer is configured or it contributes no snapshot, the previous snapshot survives unchanged.
A warning and GitHub summary explain the fallback. A corrupt or incompatible contribution fails;
it is not treated as missing. A writer's explicit empty snapshot clears the configured set.

Snapshot completeness follows the user's include/exclude definition, with required hard excludes.
Explicitly excluding related Gradle indexes is allowed and its effect on Gradle is the user's
responsibility. Replacement leaves excluded files untouched. Generic ownership validation still
rejects files claimed by multiple partitions. Maven coordinate directories cannot span distinct
partitions when one uses single-writer publication, preserving Maven's directory consistency rule.
File-to-directory or directory-to-file replacements fail safely rather than removing unmanaged
structure. See [Distributed multi-job builds](../distributed-jobs/#gradle-metadata-writer).

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
`partitionFingerprint` changes, so it uses a different cache family than the default layout.

## Timestamp garbage collection

`cache-gc-mode: timestamp` is the default. Writable standalone/aggregate jobs remove regular managed
files with mtime older than grace (14 days, minimum two), unless current local/upstream activity
protects the path. Prepare records C after its own work; finalize uses ctime/mtime >= C for assumed
upserts and atime >= C for access-only observations.

No historical last-use grace is stored. `noatime`, `relatime`, coalesced timestamps and clock changes
can hide use, causing useful old files to be removed and redownloaded or recomputed. Workers and
read-only jobs skip GC. `cleanup-enabled: false` and `cache-gc-mode: off` disable deletion, retaining
writable tracking/exchange costs. Read-only finalize skips publication-only scans, snapshot capture
and replay checks; activity counts are unavailable. Prepare still verifies restored snapshots and
replaces their managed live files. #7 tracks full-generation upload costs.

Aggregate partitions exchange no tombstones: locally deleted paths can return after restore/replay
until GC. Single-writer snapshots replace membership, so their deletions propagate without tombstones.
These partitions skip per-file GC; ordinary artifact GC still runs independently.
The internal namespace `.mammoth`, including case/portable aliases and names beginning `.mammoth.`
or `.mammoth `, is reserved at every path component.

Use `cache-gc-mode: off` or increase grace when old dependencies must remain available offline.

## Restore cleanup behavior

Single-writer partitions always replace preexisting managed files before restore, with a warning
and GitHub summary when files are displaced. A miss starts them empty. This applies even with
`cleanup-enabled: false`; excluded files survive. Retained seed snapshots are independent of local
build changes. Complete snapshot copy/hash staging adds local I/O in standalone mode too.

For ordinary partitions, `restore-cleanup-mode: prune-managed` is the optional narrow cleanup mode.

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

Maven origin markers (`_remote.repositories`) remain cached. Changed files under `repository/`
carry their complete managed directory in worker packages; different worker views of the same
directory fail aggregation by default, even with duplicate-path overrides. GC retains a managed directory
while any sibling survives. Partial-directory exclusions cannot leave excluded artifact bytes
beside a replaced or deleted marker: source capture, aggregation, and GC reject such directories,
and custom-exclusion restores validate the existing tree before extraction. Whole-directory
exclusions remain supported. See [Maven caching patterns](../maven-caching-patterns/) for topology,
snapshot/local-install exclusions, and cold-seeding guidance.

The explicit Maven `conflict-handling: choose-worker-directory` partition policy
can instead select one complete producer view per immediate directory. It keeps
the winning marker with that worker's bytes and discards losing contributions;
it does not parse or union origin claims. This can lose offline availability or
local installs. Target completeness, excluded-sibling checks, and package
verification remain enforced. See [configuration](../configuration/).
