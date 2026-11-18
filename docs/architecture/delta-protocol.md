---
title: Delta Exchange Protocol
weight: 35
description: How Mammoth Cache packages, names, and exchanges per-worker cache deltas between distributed jobs.
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

Workers exchange assumed changed files and path-only usage. The active implementation is
`src/delta/cutoff-service.ts`, `cutoff-apply.ts` and `discovery.ts`.

## Completion and selection

Every writable worker uploads a completion envelope, even with no observations. Names bind
producer/run/attempt, family and manifest digest. Envelopes request seven-day retention and remain
after successful/failed aggregation, subject to expiry, external removal or workflow-run deletion.
The aggregate selects one envelope per requested producer, preferring the latest eligible attempt
no newer than its own. Missing required producers and ambiguous/incompatible producers fail prepare.
An optional partition writer may be absent; only its snapshot partitions are imported unless it is
also declared in `dependent-jobs`. Read-only jobs skip
artifact lookup, download, application and upload.

## Package 5 and manifest 4

The flat package contains `delta-package.json`, `delta-manifest.json` and numbered `payload/*.bin`.
Metadata binds producer repository/workflow/job/run/attempt/source, runner/ref, family/lineage/restored
key, partition fingerprint and manifest SHA-256. No pre-build digest or old-target precondition exists.

Each partition has sorted unique disjoint lists. Ordinary partitions use cutoff observations:

- `upserts`: normalized relative path, payload locator, SHA-256, size, mode and mtime.
- `usedPaths`: normalized relative paths with no payload, checksum, timestamp or mode.

A single-writer contribution adds `snapshot: true`; its `upserts` are complete membership, including
an intentional empty list, and `usedPaths` must be empty. Only the configured producer may declare
this marker. Other jobs leave the partition empty without the marker. A complete snapshot replaces
old managed members; it is never combined with another writer's binary indexes. User overrides
define the eligible set. Missing snapshots preserve the inherited selection.

Paths must belong to the declared managed partition and avoid reserved metadata. Old schemas and
unknown fields are rejected. Sources are copied once and hashed in that pass, with no-symlink and
native stability checks before/open/after. Manifest/package identity is sealed before upload;
retry must regenerate the same identity, name and payload bytes.

## Validation and application

Listing/discovery and selected compressed size are bounded (2 GiB per envelope). Expanded packages
are limited to 4 GiB and 200,000 observations. JSON, structure, provenance, unexpected files,
ownership, payload checksums/size and aggregate local-state bounds are checked before mutation.
ZIP need not preserve source mode/mtime: application restores these fields explicitly.

All target ownership is validated before writes. A payload is copied to excluded scratch on the
target filesystem, receives mode/mtime, then replaces its target after native recheck. Old targets
are not hashed. Used paths do not recreate missing files or select content. Missing-at-apply usage
is forwarded until final presence filtering, including through worker chains.

Same SHA-256, size and mode merge despite differing mtimes, choosing maximum mtime. Different
material fails by default. Explicit duplicate-path permission chooses strictly newer mtime;
different material at a tied canonical mtime fails. These rules govern aggregate partitions.
Single-writer snapshots propagate removals through complete membership, without individual tombstones.
Checksums establish package integrity, not producer trust or authorization.

See [Base cache design](../base-cache/) for bounded local recovery, GC and publication. Fresh
aggregator replay can rewrite identical upserts and save redundant complete generations.
Read-only tracking (#6) and publication optimization (#7) remain separate follow-ups.

## Snapshot base transport and recovery

Base cache family 5 and CI lifecycle 4 use journal schema 2. Snapshot bytes live under the fixed
reserved `.mammoth/partition-snapshots-v1/<partition>/` path: `snapshot.json` and numbered payload
files. Backend save/restore patterns are identical across owners and modes; live snapshot paths
are omitted from the archive. Exact membership and payload hashes are verified on restore and
before publication. Preexisting managed snapshot files are cleared before restore; a miss starts
empty. Other partitions retain their ordinary archive globs.

The journal binds the baseline content digest, selected snapshot digest/source, membership counts,
and material replacement decision. Local writer capture copies all frozen members, including old
unchanged files. An interrupted first install can regenerate from frozen live sources until its
record is durable; a selected snapshot must then retain its identity. Nonwriter local changes never
replace the retained archive projection. Deletion-only and last-file removals independently qualify
for publication. GC cannot delete individual snapshot files. Standalone uses the same staged
transport and pays a full snapshot copy/hash cost; workers also stage the complete snapshot payload
for upload. No pre-build ordinary content inventory is added.
