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
Each nonempty partition is an independent immutable backend object; a small generation record
selects their exact identities. Unchanged partition payloads are reused across generations.

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
possible. Successfully restored object descriptors supply portable membership; writable finalize
compares that membership with its frozen post-GC projection, so disappearance-only changes also
require publication. There is no historical access manifest or unconditional before/after content
hash pass. Complete single-writer snapshots propagate removals through replacement membership;
an absent writer contribution preserves the successfully restored snapshot.

## Groovy workspace units

The default Gradle `groovy-dsl` partition retains complete hashed workspaces.
Changed files or directory topology select the whole unit; usage protects all members.
Whole-workspace conflict selection chooses one producer per root, without a designated
partition writer. Complete unit replacement propagates removals within that root.

Base objects carry a partition-scoped descriptor under `.mammoth/partition-objects-v1/<partition>/`
and archive accepted workspace files at their native paths. References include the accepted workspace
roots so save and restore use identical SDK path specifications; incomplete and unknown roots are
omitted, and bookkeeping exclusions remain enforced even with custom excludes. Empty directories
are reconstructed from validated metadata. Only changed Groovy partitions are hashed and uploaded. Prepare verifies
incoming units before guarded managed replacement. A durable replacement intent supports
discarding recorded partial contents on next prepare; unknown descendants block recovery.
File and directory native identities bind writable retries. See [delta protocol](../delta-protocol/)
for worker-envelope validation and recovery details.

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

Writable finalize publishes on a nonempty partition miss, material local/applied worker changes,
GC removal, disappearance from restored membership, or a material single-writer replacement.
Usage-only observations and unchanged selected snapshots do not require publication. A cold,
entirely empty cache, including a layout with zero active partitions, remains a no-op.

The authoritative archive contains only `.mammoth/generations-v1/record.json`. It binds the
family/layout, exact generation identity, and an ordered object reference or explicit empty
entry for each active partition. Empty entries supersede older payloads without an empty-object
upload. Ordinary existing runner files still follow default overlay semantics; an empty entry
does not authorize sweeping local cache content.

Each partition object contains a reserved `object.json` descriptor plus its native managed files.
Single-writer objects use their existing frozen snapshot payload paths directly.
The descriptor binds object identity, ownership, portable membership, sizes, modes, mtimes and
payload hashes, plus complete Groovy workspace metadata where applicable. Changed partitions
are hashed and archived directly in full; unchanged partitions are not staged or uploaded.
Snapshot owners still capture their complete local snapshot to determine material changes.
Ordinary aggregate partitions do not inherit the worker-envelope expanded-byte ceiling.

Restore selects a current-ref record before default-branch fallback, then requests only its exact
objects. It validates isolated staged transports before installation. Missing/evicted objects
are cold partitions with no reusable reference or inherited membership. Available objects remain
usable: outcomes distinguish complete hit, partial hit and all-partitions miss. Explicit empty
entries count as successful restores; a valid zero-partition record is a complete hit. Malformed
records or corrupt payloads fail validation rather than masquerading as eviction.

Maven coordinate siblings can span aggregate partitions. Connected owners form bounded recovery
groups recorded with the generation: if any member is unavailable, the entire group starts cold.
Unrelated partitions still restore. No partition falls back to an older generation after the
record was selected. Default-branch object references retain their original identities and remain
subject to backend branch visibility; writing a ref name into a key grants no additional access.

Finalize freezes the record, object decisions and immutable keys locally before the first upload.
Changed objects are saved first; reused objects and prior successful upload receipts are checked
with exact version-aware lookup-only requests where supported. Ambiguous saves require isolated
full readback and validation. The record is saved last, so one successful object cannot count as
complete publication. Required aggregator publication failures retain worker envelopes and fail
aggregation; standalone failures warn and retain retry intent. Eviction after publication can
still occur, and restore handles it per partition. Orphan backend objects expire normally.

The action-owned `partitioned-v2` family discriminator prevents old monolithic archives from
matching, even when a consumer pins its schema input. Cache schema **6**, package **6**, worker
manifest **5**, CI lifecycle **6** and journal **4** are distinct contracts. Migration starts cold;
worker-envelope semantics are unchanged by the base-storage split.

## Recovery and bounds

`.mammoth/cutoff-state-v2/` contains a root-local journal and `current.json` pointer. It is never
cached or sent to workers. It binds the full model/policy/execution, C, observations, native retained
fingerprint, frozen GC plan, package seal, publication intent and local receipts. Journal schema 4
also binds baseline and selected snapshot digests, source, counts, and replacement decisions.
Verified selected snapshots are reconstructed locally under
`.mammoth/partition-snapshots-v1/<partition>/` before existing replacement initialization.
Full restored descriptors and frozen publication plans stay in the journal; the 64 KiB CI-state
envelope carries compact status and a digest binding the baseline to its invocation.
The fingerprint
excludes atime for Mammoth's own reads and planned deletions for partial-GC recovery. For writable retries, changed retained
native metadata, new files, or replaced targets require a fresh prepare. Read-only journals retain
prepare identity and per-partition snapshot summaries, with no per-file finalize decisions.

Worker canonical manifest/package identity is sealed before upload; regeneration must match it.
Base retries reuse their frozen keys and record; ambiguous remote success is confirmed by exact
readback. Locally recorded complete success can be reused. Retained worker envelopes permit fresh aggregate recovery.

GC records deletion intent before the sweep and checkpoints progress once after it finishes,
keeping complete-journal writes constant per sweep. An interruption can leave uncheckpointed
deletions: replay accepts already-absent planned targets and rechecks remaining targets against
their frozen native metadata. Recreated or changed files fail closed.

Journals are bounded to **200,000 records and 64 MiB**, reserving seal/progress growth before payload
reads or mutation. After durable replacement+pointer publication, obsolete owned regular journals
and superseded invocation publication-staging directories are retired. Failed staging remains
available for the current invocation retry. Pre-write orphan cleanup bounds repeated pointer failures to current plus one candidate.
A corrupt pointer conservatively preserves unknown journals until successful replacement, an
explicit retention exception. Unknown files, directories and symlinks are not silently removed.

Reserved metadata is `.mammoth` case-insensitively plus names beginning `.mammoth.` or `.mammoth `
at any path component. This covers portable aliases and target-local atomic-write scratch.

## Restore cleanup and costs

Opt-in `restore-cleanup-mode: prune-managed` runs only after a hit, prunes regular managed files with
native checks, then re-restores the exact record and original available partition set. Loss of a
previously available object or a different generation fails prepare; originally missing partitions
remain cold during this pinned replay.
That optional traversal is cleanup, not a baseline inventory. Single-writer partitions independently
clear preexisting managed members before restore and validate/restore their staged authoritative
snapshots, including when ordinary cleanup is disabled.

Prepare verifies downloaded payload hashes in isolated extraction roots under the cache root's
reserved metadata, then renames ordinary files into place. Groovy application consumes disposable
extracted inputs by moves into its existing guarded workspace staging. Snapshot transport trees
are renamed into the existing local snapshot representation; its original replacement/capture
copying remains. No new payload copy or hardlink staging is required for base uploads: ordinary
and Groovy files are archived natively, and selected snapshot payloads are archived where they
already reside. Source identity is rechecked after uploads, including ambiguous-save readback,
before the generation record may be published. Hardlinks would share mutations and alter ctime.

A nested destination mount can require verified copying on EXDEV. Reserved destination-local
scratch and a durable root-local cleanup intent preserve the old target until copy completion;
prepare recovers interrupted fallback scratch before observations. New prepares also discard only
owned abandoned extraction roots. Normal same-filesystem restores use moves with no byte copies.
Read-only finalize still does no publication scan, hashing, plan construction or save.

Partition calls remain sequential because the GitHub adapter serializes cwd/workspace changes;
the SDK retains concurrency within each archive. There are more backend requests, extraction staging
space and independently evictable objects. No net speed or measured wire-byte saving is promised.
There is no new consumer tool, configuration requirement, backend cleanup service or per-file store.

Local Linux archive/ZIP/native tests and real Gradle/Maven reuse establish correctness, not
multi-gigabyte affordability. Native Windows/macOS timestamp and replacement validation remains open.
