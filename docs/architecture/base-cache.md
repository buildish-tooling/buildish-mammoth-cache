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

The base cache is a generation record and independently stored native partition
objects. A generation identifies a logical view and explicitly records empty
partitions. A nonempty object contains a bounded identity descriptor and literal
native payload. Build-tool homes contain temporary operation-local indexes for
validation and one small main-to-post handoff.

## Lifecycle

Prepare selects the newest eligible generation from the current ref lineage,
then the default branch lineage if needed. It restores the generation's exact
object keys. Unavailable objects leave their partitions cold. A declared empty
partition cannot silently select an older nonempty object. Maven partitions that
share one coordinate are validated together.

Worker contributions use a separate archive format. The aggregator validates
all required contributions before installing the selected native contents. Each
single-writer partition uses its assigned snapshot owner. Prior snapshot
evidence can supply the fallback when an optional remote writer is absent.

Post uses the recorded prepare cutoff and a current metadata observation.
Writable standalone and aggregator jobs publish eligible changes after
consumers finish. A read-only job can restore and report build results without
publishing or scanning the post-build cache.

## Change detection and timestamp GC

The observation uses paths, native types, sizes and available metadata including
mtime and ctime. Access-only evidence can protect old files from GC. Same-metadata
byte rewrites may be missed, including worker upserts that produce no visible
base change. Incoming worker archive bodies still receive strict content
validation. Base archives contain no per-file hash catalogue.

Writable jobs with timestamp cleanup enabled may delete old, unprotected
managed content. An eligible worker applies GC before packaging its contribution. Maven coordinates and Gradle workspaces use
complete-unit decisions. Gradle complete workspace limits protect metadata,
members and meaningful empty directories. Read-only jobs skip GC. Explicit purge rules apply to writable base posts.
Access timestamps and time resolution depend on the filesystem.

## Immutable generations

Post reuses exact refs for unaffected partitions, and skips a new generation when
the existing view can be reused unchanged. When publication is needed, save
the changed native objects before publishing the new generation record. A
confirmed empty view can consist of a record alone. Only positive, direct
backend confirmations count toward a completed publication.

SDK calls may hold native sources for the duration of a transfer. Mammoth moves
eligible sources into owned staging and returns them within the same operation
after the SDK settles. Failed or ambiguous publication stops the attempt. Local
source-return and cleanup errors remain visible. Snapshots that must survive a
mutable build window may require independent local copies.

## Restore cleanup and resource limits

The optional `prune-managed` policy applies to eligible managed entries covered by
validated restored objects. Local state for missing objects stays outside that
prune authority. Single-writer managed contents are replaced by the admitted
snapshot and start empty on a miss. Excluded files are preserved.

Native placement uses guarded same-filesystem moves. Plan disk capacity for
SDK archives, extraction, selected snapshots and temporary metadata. The
[configuration reference](../../user/configuration/#cache-max-directory-entries)
describes the per-directory limit and independent memory bounds.

An interrupted owner or known legacy destructive intent rejects admission.
Preserve the old root and inspect reported paths. Start a new invocation with a
fresh dedicated root. See the [lifecycle protocol](../../dev/cache-lifecycle-protocol/)
for implementation details.
