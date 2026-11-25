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

| Partition              | Contents                                                  | Default |
| ---------------------- | --------------------------------------------------------- | ------- |
| `dependency-artifacts` | External artifacts in `caches/modules-2/files-2.1/**`     | enabled |
| `module-support`       | Top-level `caches/jars-*/**` and `caches/resources-*/**`  | enabled |
| `dependency-metadata`  | Complete dependency-resolution metadata snapshots         | enabled |
| `transforms-metadata`  | Complete artifact-transform workspaces                    | enabled |
| `kotlin-dsl`           | Compiled Kotlin DSL scripts and generated Gradle API JARs | enabled |
| `groovy-dsl`           | Complete compiled Groovy DSL workspaces                   | enabled |
| `build-cache`          | The local Gradle build cache                              | enabled |
| `wrapper-dists`        | Wrapper-downloaded Gradle distributions                   | enabled |

See [Gradle cache internals](../../architecture/gradle-cache-internals/) for details on what each
partition covers and why certain directories are excluded.

The built-in `dependency-artifacts` partition covers the exact `modules-2/files-2.1` store.
`dependency-metadata` separately covers every `caches/modules-2/metadata-*/**` version with
single-writer publication. Other `modules-*` and `files-*` roots require explicit custom includes.
Both dependency partitions default to `read-only-layer: true` to mark them as eligible. The
Gradle-only `dependency-cache-layer` input controls the family's layering and retention policy.
`module-support` remains writable.

The retired `modules` preset is rejected with a migration diagnostic. Replace writer or other
overrides with the appropriate new partition IDs. To disable its former artifact and support
coverage, set `includes: []` on both `dependency-artifacts` and `module-support`. This layout and
the partition protocol change start a new cache family; old generations are not migrated.
`transforms-metadata` covers derived transform workspaces, not dependency resolution.

The transform partition defaults to `choose-worker-directory` and captures complete
`caches/transforms-4/<32-hex-key>/` and `caches/<version>/transforms/<32-hex-key>/`
units, including `metadata.bin`, `results.bin`, outputs and empty directories.
Unknown/incomplete layouts and mandatory-excluded outputs are skipped with bounded
warnings; partial user ownership fails. Nested output `gc.properties` files are retained.
Its selection, replacement and GC semantics match the DSL complete-workspace rules below.
Set `includes: []` on `transforms-metadata` to disable it or
`conflict-handling: default` to reject differing same-key workspace views.

Direct capture includes outputs of non-build-cacheable transforms. These may contain
private dependency content or data written by build logic: cache and artifact readers
must be allowed to see those contents. Worker validation, native staging and transfer add I/O. Transform output can also
duplicate bytes stored in the Gradle build-cache partition. The current storage and
worker profiles start new families for Gradle and Maven.

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
and unprotected. Base publication archives native files and directories in changed partitions.
Unaffected partition objects are reused.
Set `includes: []` on `groovy-dsl` to disable it, or set `conflict-handling: default`
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

The resolved partition order, include/exclude sets, publication policies, and writer identities are bound into
the model identity, which is part of the cache family. Changing the active partition layout
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
- `read-only-layer` is a boolean, defaulting to false for custom partitions. It participates in
  family identity. Only the built-in dependency artifact and metadata layouts qualify for the
  initial Gradle layer; custom remapping falls back to ordinary writable installation.
- If the same file matches more than one active partition, ownership validation fails instead of guessing an owner.

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
Standalone jobs own their snapshots automatically, regardless of the configured writer. In
distributed mode, the aggregator owns snapshots with no configured writer or with itself named as
writer. An ordinary worker exports a snapshot only when explicitly named. All jobs can restore
snapshots and modify their local copies. A validated snapshot can be published even if its build failed.

```yaml
cache-partitions:
  - id: dependency-metadata
    writer: worker-a
```

This is config-file YAML. For a direct action input, pass the equivalent JSON string:

```yaml
cache-partitions: '[{"id":"dependency-metadata","writer":"worker-a"}]'
```

If a different job is named as writer and contributes no snapshot, the previous snapshot survives
unchanged. A warning and GitHub summary explain the fallback. A corrupt or incompatible contribution fails;
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
    "id": "dependency-artifacts",
    "includes": ["caches/modules-2/files-2.1/**"],
    "read-only-layer": false
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

This example: overrides `dependency-artifacts`, disables `kotlin-dsl`, and adds a custom partition. The
model identity changes, so it uses a different cache family than the default layout.

## Timestamp garbage collection

`cache-gc-mode: timestamp` is the default. Eligible writable post operations can
remove regular managed files with an mtime older than the age threshold (14 days by
default, minimum two) when current local or upstream activity does not protect them. Prepare records C after its own work; finalize uses ctime/mtime >= C for assumed
upserts and atime >= C for access-only observations.

No historical last-use grace is stored. `noatime`, `relatime`, coalesced timestamps and clock changes
can hide use, causing useful old files to be removed and redownloaded or recomputed.
Read-only jobs skip GC. Writable workers can run timestamp GC before packaging. `cleanup-enabled: false` and `cache-gc-mode: off` disable deletion, retaining
writable tracking and exchange costs. Read-only post skips activity capture and
publication. Prepare still validates snapshots and installs their files into the
initially empty managed area.

Aggregate partitions exchange no tombstones: locally deleted paths can return after restore
until GC. Single-writer snapshots replace membership, so their deletions propagate without tombstones.
These partitions skip per-file GC; ordinary artifact GC still runs independently.
The internal namespace `.mammoth`, including case/portable aliases and names beginning `.mammoth.`
or `.mammoth `, is reserved at every path component.

Use `cache-gc-mode: off` or increase grace when old dependencies must remain available offline.

## Restore cleanup behavior

Prepare requires all enabled partitions to start without managed files. A
single-writer partition installs the admitted snapshot and starts empty on a
miss, including with `cleanup-enabled: false`. Excluded files survive. Snapshots
that must survive a mutable build may need independent local copies.

For ordinary partitions, `restore-cleanup-mode: prune-managed` is opt-in.
It acts after a base hit within the managed scope of validated objects. A
missing partition object supplies no prune authority. Disabling a partition
leaves its previously managed paths outside the current cleanup scope.

Maven origin markers (`_remote.repositories`) remain cached. Worker upserts include
the complete managed directory. Different required worker views fail aggregation
under the strict policy. Target validation prevents replacing a marker over an
excluded artifact sibling. GC preserves a coordinate with a protected sibling.
Use whole-directory exclusions to keep specific local artifacts out of publication.
See [Maven caching patterns](../maven-caching-patterns/).

The explicit Maven `conflict-handling: choose-worker-directory` partition policy
can instead select one complete producer view per immediate directory. It keeps
the winning marker with that worker's bytes and discards losing contributions;
it does not parse or union origin claims. This can lose offline availability or
local installs. Target completeness, excluded-sibling checks, and package
verification remain enforced. See [configuration](../configuration/).

## Cross-generation reuse and recovery

Metadata-visible changes drive reuse. Mammoth compares paths, sizes and
filesystem metadata, and can miss byte rewrites that preserve the compared
metadata. Incoming worker content still receives strict archive validation.
Empty partitions are explicit generation entries.

Restore uses exact objects from one selected generation. An expired object
can leave its partition cold while other validated partitions remain available.
Maven partitions sharing a coordinate recover together. Normal builds can
refill missing objects.

The current profiles use a new action-owned family. Upgrade cooperating jobs
together and expect old backend entries to miss. Changed base objects archive
native files and directories. The same post operation returns writable sources
after the SDK settles. Native placement and transfer use same-filesystem moves.
Allow space for extraction, independent snapshots, archives and temporary metadata.
See the [base cache design](../../architecture/base-cache/) and
[troubleshooting](../troubleshooting/#interrupted-cache-operations).

In the dependency-layer family, publishers retain aggregate partitions marked
`read-only-layer: true` instead of applying timestamp GC, even when a particular worker cannot
activate a seed. Single-writer metadata keeps its designated-writer snapshot semantics. There is
no seed sweep or capacity eviction in this release; backend retention still applies.
