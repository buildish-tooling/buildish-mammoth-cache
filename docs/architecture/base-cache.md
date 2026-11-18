---
title: Base Cache Design
weight: 20
description: Base cache restore/save lifecycle, timestamp garbage collection, prune-managed cleanup, and the distributed delta exchange model.
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

Mammoth restores immutable cache generations and observes activity using a cutoff recorded after
prepare. Ordinary aggregate partitions need no upfront artifact inventory or content-hash baseline.
Single-writer partitions instead retain a complete authoritative snapshot for replacement.

## Lifecycle

1. Prepare validates configuration and creates a pending local journal before provisioning/restore.
   It clears preexisting managed snapshot files, restores their authoritative transport, optionally
   prunes/re-restores ordinary files, then applies worker envelopes and selected writer snapshots.
2. After all prepare reads/writes, it records cutoff **C**.
3. The owning post action checks its pure CI-state guard and validates the lifecycle journal.
   Writable jobs capture managed file metadata before
   importing provider SDKs, resolving config files, discovering Java, or collecting reports.
4. For aggregate partitions, `ctime >= C` or `mtime >= C` selects an assumed changed upsert. Otherwise `atime >= C` selects
   path-only usage. Equality admits false positives on coarse clocks. Imported upserts and usage
   explicitly protect paths before applying the aggregate cutoff.
5. Writable decisions are durably frozen before Mammoth reads content. Workers copy/hash selected
   payloads. Snapshot owners capture every configured member, including unchanged files;
   nonowners retain the selected snapshot despite local changes. Eligible writers execute frozen
   GC for ordinary partitions and publish a complete generation if required.

Read-only jobs validate prepare completion, execution identity and model/policy consistency, then
collect build reports and record local completion. They skip post-build activity selection, replay
checks, snapshot capture, GC, generation decisions and publication. Repeated finalize validates the
lifecycle again without freezing per-file decisions or checking publication-only transport changes.
Activity statistics are unavailable, not measured zero; snapshot counts describe the prepare state,
not final local contents. Read-only workers upload no envelope, and read-only aggregators skip
dependent artifact discovery/import. Provisioning, hooks and restore validation remain active.

An added file with preserved old mtime is selected when its ctime crosses C. Metadata misses remain
possible. There is no previous-path inventory, deletion tombstone, old-target checksum comparison,
or historical access manifest for ordinary partitions. Their removed files can return after
restore/replay until GC removes them. Complete single-writer snapshots propagate removals through
replacement membership; an absent contribution preserves the previous snapshot.

## Groovy workspace units

The default Gradle `groovy-dsl` partition retains complete hashed workspaces.
Changed files or directory topology select the whole unit; usage protects all members.
Whole-workspace conflict selection chooses one producer per root, without a designated
partition writer. Complete unit replacement propagates removals within that root.

Base save/restore uses stable reserved flat payload paths and a family-bound catalog
at `.mammoth/groovy-workspaces-v1.json`. Live Groovy paths are omitted from backend
patterns. Empty directories are reconstructed from catalog metadata, without another
archive. Publication stages and hashes all retained units, including standalone mode.
Prepare verifies and stages incoming units before guarded managed replacement. A durable
replacement intent supports discarding recorded partial contents on next prepare;
unknown descendants block recovery. File and directory native identities bind writable
retries. See [delta protocol](../delta-protocol/) for validation and recovery details.

Groovy GC removes a workspace only when all members are old and unprotected; it never
ages out individual metadata or output files. Directory removal is guarded and replay
accepts already-absent planned targets after interruption. This unit rule is separate
from the partition-wide single-writer snapshot exemption below.

## Timestamp GC

The default is `cache-gc-mode: timestamp`, with a 14-day grace and a minimum of two days.
Only writable standalone/aggregate jobs with cleanup enabled perform GC. A regular managed file is
eligible when its **mtime** precedes finalize observation time minus grace and no local or upstream
activity protects it during this build. Single-writer partitions are exempt from per-file GC;
ordinary artifact GC can remove files referenced by retained metadata, so offline completeness is
not guaranteed.

This is artifact-age/current-lifecycle GC, not historical inactivity or LRU. Earlier builds' reads do
not restart a stored grace period. `noatime`, `relatime`, timestamp coalescing, coarse clocks and clock
changes can hide activity; useful old files may be removed and downloaded or recomputed again.
This tradeoff is accepted. `off` disables deletion only: tracking, recovery, exchange and otherwise
required publications remain active. Frozen targets are checked immediately before unlink; empty
parent directories are removed, while unmanaged/excluded files remain untouched.

## Immutable generations

Writable finalize saves on a nonempty miss, ordinary local/applied worker upserts, GC removal, or
a material single-writer snapshot replacement. Snapshot-only removals independently trigger save;
unchanged snapshot contents do not require a generation.
Access-only observations do not require a replacement base generation. Fresh aggregator replay may
reapply identical upserts and upload another complete generation. Required aggregator publication
must succeed; other outcomes fail aggregation while retaining worker envelopes. Standalone backend
failures produce warnings and preserve retry intent.

Publication after removal of the last managed file, including an empty writer snapshot, uses the constant `.mammoth/empty-generation-v1` marker so subsequent
restore does not choose the old snapshot. Its optional include is always present in the same ordered
restore/save path list, including nonempty generations, preserving the backend's path-derived
version. Local journals and nested scratch are excluded; directory entries are excluded to prevent
tar recursion bypassing file excludes. The marker authorizes no deletion of existing overlay files.

Cache family **6**, package **6**, worker manifest **5**, CI lifecycle **5** are distinct strict
contracts. Old families are cold misses; old packages/lifecycle records fail validation.

## Recovery and bounds

`.mammoth/cutoff-state-v2/` contains a root-local journal and `current.json` pointer. It is never
cached or sent to workers. It binds the full model/policy/execution, C, observations, native retained
fingerprint, frozen GC plan, package seal, publication intent and local receipts. Journal schema 3
also binds baseline and selected snapshot digests, source, counts, and replacement decisions.
Snapshot payloads are transported separately under the reserved fixed
`.mammoth/partition-snapshots-v1/<partition>/` path; only verified manifest/payload files are included
in the base archive, using stable save/restore patterns. Live nonwriter snapshot paths are omitted. The fingerprint
excludes atime for Mammoth's own reads and planned deletions for partial-GC recovery. For writable retries, changed retained
native metadata, new files, or replaced targets require a fresh prepare. Read-only journals retain
prepare identity and per-partition snapshot summaries, with no per-file finalize decisions.

Worker canonical manifest/package identity is sealed before upload; regeneration must match it.
Base retries reuse their nonce/key. Locally recorded success can be reused; remote success with a
lost local receipt remains uncertain. Retained worker envelopes permit fresh aggregate recovery.

GC records deletion intent before the sweep and checkpoints progress once after it finishes,
keeping complete-journal writes constant per sweep. An interruption can leave uncheckpointed
deletions: replay accepts already-absent planned targets and rechecks remaining targets against
their frozen native metadata. Recreated or changed files fail closed.

Journals are bounded to **200,000 records and 64 MiB**, reserving seal/progress growth before payload
reads or mutation. After durable replacement+pointer publication, obsolete owned regular journals
are retired. Pre-write orphan cleanup bounds repeated pointer failures to current plus one candidate.
A corrupt pointer conservatively preserves unknown journals until successful replacement, an
explicit retention exception. Unknown files, directories and symlinks are not silently removed.

Reserved metadata is `.mammoth` case-insensitively plus names beginning `.mammoth.` or `.mammoth `
at any path component. This covers portable aliases and target-local atomic-write scratch.

## Restore cleanup and costs

Opt-in `restore-cleanup-mode: prune-managed` runs only after a hit, prunes regular managed files with
native checks, then re-restores the exact original key. Missing/different generation fails prepare.
That optional traversal is cleanup, not a baseline inventory. Single-writer partitions independently
clear preexisting managed members before restore and validate/restore their staged authoritative
snapshots, including when ordinary cleanup is disabled.

For ordinary partitions, prepare performs no baseline artifact scan/hash. Single-writer snapshots
require transport verification at prepare and full snapshot capture/staging for publication; this
adds copy/hash I/O even in writable standalone mode. Writable finalize selects metadata and validates
replay metadata; selected worker sources are copied/hashed once. Incoming payload verification is
separate and remains required for read-only consumers. Read-only finalize performs no managed-payload
scan or hashing for publication or statistics; explicit restore cleanup and snapshot replacement
can still traverse files during prepare. `off` retains writable tracking costs. Complete generations
may be uploaded after assumed upserts even when a content diff could prove redundancy. Full-generation
publication optimization remains separate (#7). There is no new bypass or storage service.

Local Linux archive/ZIP/native tests and real Gradle/Maven reuse establish correctness, not
multi-gigabyte affordability. Native Windows/macOS timestamp and replacement validation remains open.
