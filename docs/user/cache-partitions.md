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
cache generation. Each nonempty partition is saved as an independent immutable backend entry;
a small generation record selects the complete logical view. If only A changes, Mammoth uploads
A and the record while reusing existing B/C objects. Changed partitions are uploaded in full.

## Built-in partitions

### Gradle

The Gradle action resolves `GRADLE_USER_HOME` into these ordered partitions:

| Partition             | Contents                                                  | Default |
| --------------------- | --------------------------------------------------------- | ------- |
| `modules`             | Dependency artifacts, JARs, and resource stores           | enabled |
| `dependency-metadata` | Complete dependency-resolution metadata snapshots         | enabled |
| `transforms-metadata` | Complete artifact-transform workspaces                    | enabled |
| `kotlin-dsl`          | Compiled Kotlin DSL scripts and generated Gradle API JARs | enabled |
| `groovy-dsl`          | Complete compiled Groovy DSL workspaces                   | enabled |
| `build-cache`         | The local Gradle build cache                              | enabled |
| `wrapper-dists`       | Wrapper-downloaded Gradle distributions                   | enabled |

See [Gradle cache internals](../../architecture/gradle-cache-internals/) for details on what each
partition covers and why certain directories are excluded.

The built-in `modules` partition covers dependency artifacts. `dependency-metadata` separately
covers `caches/modules-*/metadata-*/**` with single-writer publication.
`transforms-metadata` covers derived transform workspaces, not dependency resolution.

The transform partition defaults to `choose-worker-directory` and captures complete
`caches/transforms-4/<32-hex-key>/` and `caches/<version>/transforms/<32-hex-key>/`
units, including `metadata.bin`, `results.bin`, outputs and empty directories.
Unknown/incomplete layouts and mandatory-excluded outputs are skipped with bounded
warnings; partial user ownership fails. Nested output `gc.properties` files are retained.
Its selection, replacement and GC semantics match the DSL complete-workspace rules below.
Set `enabled: false` on `transforms-metadata` to disable it or
`conflict-handling: default` to reject differing same-key workspace views.

Direct capture includes outputs of non-build-cacheable transforms. These may contain
private dependency content or data written by build logic: cache and artifact readers
must be allowed to see those contents. This partition adds scans, hashing, archive and
transfer I/O, and may duplicate build-cache output bytes. No speedup is guaranteed.
Cache schema 8 intentionally starts new Gradle and Maven families, including previously
configured transform partitions; old file-only captures are not promoted to complete units.

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
and unprotected. Base publication hashes and archives native files in each changed Groovy partition;
unchanged partition objects are reused. Empty directories travel as validated metadata, without
another archive layer or base-upload payload staging copy.
Set `enabled: false` on `groovy-dsl` to disable it, or set `conflict-handling: default`
to reject conflicting complete workspace views. Single-writer publication is unsupported.

The `kotlin-dsl` partition uses the same whole-workspace transport for recognized
`caches/<version>/kotlin-dsl/scripts/<32-hex-key>/` and
`accessors/<32-hex-key>/` or `accessors/<32-hex-key>-PS/` roots. Supported scripts
contain `metadata.bin`, `classes/` and `instrumented/classes/`; accessor workspaces
contain metadata plus either `classes.jar`/`sources.jar`, or `classes/`/`sources/`
for directory-based accessors, including `-PS`. Empty output directories are preserved. Unknown or incomplete modern
layouts are skipped with warnings, and partial configured ownership fails.
Legacy `caches/<version>/scripts/` files and generated Gradle API JARs remain
ordinary strict files in this partition. Set `conflict-handling: default` to
reject conflicting complete workspace views while retaining whole-unit capture.

The `build-cache` partition defaults to `choose-worker-entry`: one unchanged
archive is selected per direct 32-hex key under `caches/build-cache-<number>/`,
using the smallest producer job name. Disjoint keys are retained. Explicit
`default` rejects differing duplicate archives. These policies select a winner
even if actual outputs differ under one key; they do not prove reproducibility.

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

## Purgeable files (unreleased streaming lifecycle)

The existing `cache-partitions` entries accept `purgeableGlobs`. Omit the field to
inherit preset defaults, use `[]` to disable purging, or supply a list to replace
defaults. Custom partitions can supply rules too; their default is no purging.
For example, `{"id":"build-cache","purgeableGlobs":[]}` disables its default rules.
A custom partition can use `{"id":"scratch","includes":["scratch/**"],
"purgeableGlobs":["scratch/**/*.tmp"]}`. These are explicit disposable-file rules;
ordinary `excludes` preserve files locally. Purgeable files are excluded from uploads.

Deletion is available only to the unreleased streaming lifecycle's explicitly gated
pre-capture primitive, after all consumers are excluded; it is not enabled in released
Action prepare/post paths. Rules remain confined to the managed root, cannot delete
another partition's nonconsenting payload, follow links or delete reserved metadata.
Only files encountered by the existing traversal qualify. Hard-pruned directories,
including Gradle configuration-cache and journal subtrees, remain opaque: rules aimed
there are unsupported, and broad rules do not cause extra traversal. Effective rules
are frozen for retry; changing current defaults cannot change an existing attempt.

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

## Cross-generation reuse and recovery

Reuse follows existing cutoff and snapshot change decisions, with membership comparison for
removals. It does not hash every managed ordinary file before and after a build. Empty partitions
are explicit generation entries, so an older nonempty object is never fetched as fallback.

Restore uses exact objects from one selected generation. An expired object makes its partition
cold while other validated partitions remain available; logs distinguish complete hits, partial
hits and misses. Missing snapshot partitions start empty. Maven partitions sharing a coordinate
directory recover together to keep artifacts and origin markers coherent. Corrupt metadata or
payloads fail validation. Normal builds can refill missing caches; no recovery command is required.

The storage format changes the action-owned family, so old monolithic caches start cold. Expect
more backend requests, independently evictable objects and extraction staging space. Changed ordinary
and Groovy files are hashed and archived at native paths; existing snapshot payloads are archived
directly. Base uploads create no extra payload copies or hardlinks. Restore normally moves verified
files from root-local staging; cross-filesystem moves use a verified, recoverable copy fallback.
Snapshot ownership/capture retains its existing separate snapshot representation and copy cost.
Partition transfers are sequential, with the backend SDK handling concurrency inside each archive.
No end-to-end speed or wire-byte saving has been measured. See
[base cache design](../../architecture/base-cache/) for publication ordering and retry behavior.
