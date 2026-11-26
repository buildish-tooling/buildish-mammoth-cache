---
title: Native Base and Generation Protocol
weight: 16
description: Draft exact native-tree, envelope, generation, key and recovery-group schemas for the streaming cache format.
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

## Status and shared types

This is the incompatible, unreleased metadata-only native base protocol selected by
the current source. The worker transport remains `worker-tar-v2`. All cooperating
jobs use the same family. Prior worker-profile and native-tree/generation/local formats start cold;
there is no old-base reader, manifest bridge or resumed old namespace execution.

Canonical scalars, framed digests, path ordering and the strict worker format are
defined in the [streaming protocol](../cache-protocol/). Control documents are
canonical UTF-8 JSON with one LF, each at most 65,536 bytes. Their SHA-256 binds
control bytes; it makes no assertion about native payload contents.

## Model, family and key identities

```text
["model",1,buildTool,hardExcludes,partitions,familyPolicy?]
partition = [id,includes,ordinaryExcludes,publication,writer,conflict,readOnlyLayer,purgeableGlobs?]
```

`familyPolicy` is canonically omitted for ordinary GC. Gradle's enabled
`dependency-cache-layer` policy appends `"retain-dependencies"`. This shared policy
changes the model and family identities with identical partition definitions;
partition seed eligibility alone never enables it. All cooperating jobs use the
same policy, including standalone/default-ref publishers and workers that fall
back to ordinary restore. It is independent of role, ref and actual layer activation.
The frozen model stream header is `["model-header",buildTool,hardExcludes,familyPolicy?]`.
Fresh post reconstructs the model from that exact modelRef and validates the model,
family projection and handoff before capture, GC or publication; current Action
inputs do not replace the persisted policy.

`buildTool` is `gradle` or `maven`; glob lists are ordered unique nonempty strings,
except excludes may be empty. Include lists are nonempty. `publication` is
`aggregate` or `single-writer`; writer is a job name or `null`, and is permitted
only for single-writer. Conflict is `default`, `choose-worker-entry` or
`choose-worker-directory`, restricted to supported build-tool unit kinds.
`readOnlyLayer` is the resolved seed-eligibility boolean encoded canonically as
`0` or `1`; it does not activate layering or publisher retention. Ordinary excludes include resolved hard excludes. `purgeableGlobs` is an optional,
nonempty ordered unique list of managed-root-relative file globs; omit the field
canonically when the resolved list is empty. This optional configuration field is
bound by the existing model hash and modelRef, not a separate policy document or
version. Content ownership/upload filters derive the union of ordinary exclusions
and purge rules. Deletion checks consult original selection before that union so a
purge exclusion cannot hide another partition's selected content. Absence of the canonical field means the resolved list is empty. Public built-in
omission inherits preset defaults; only an explicit empty override disables them.
`.mammoth` and descendants are always
reserved, regardless of custom globs. No absolute cache root, display label,
runner-local path or observed member list participates. The model bounds are those
of the parent specification; duplicate IDs and ambiguous ownership are invalid.
Glob matching keeps the existing adapter's resolved semantics; changing those or
the path/unit classifier requires a new compatibility tag below.

```text
modelId = H("model", model)
familyProjection = ["family",1,cacheKeyPrefix,cacheSchemaVersion,modelId,
                    "worker-tar-v2","native-metadata-v2","generation-v3","local-v2",
                    "path-policy-v1","unit-policy-v1","glob-policy-v1"]
familySha = H("family", familyProjection)
familyId = "mammoth-s1-" + buildTool + "-" + familySha
invocationId = H("invocation", ["invocation",1,context,nonce])
writerId = H("writer", ["writer",1,invocationId,context])
lineageId = H("lineage", ["ref",resolvedRef])
```

`cacheKeyPrefix` is the exact configured namespace string; `cacheSchemaVersion` is
the positive configured cache-schema value. `resolvedRef` is the nonempty
provider-resolved full ref, with no lossy slugging, case folding or trimming.
Runner OS/architecture are not silently added to family compatibility; operators'
existing explicit namespace/layout choices retain their role. Provider service
scope and expected context still authorize access. The model and family inputs
must be available independently of restored data. Worker model/family IDs use these
same values, replacing any earlier opaque-placeholder interpretation of the draft.

Object identity and exact immutable keys are:

```text
I = [familyId,modelId,partitionId,lineageId,writerId,decisionSha]
objectKey = familyId + "-r-" + lineageId + "-w-" + writerId
            + "-p-" + partitionId + "-d-" + decisionSha
lineagePrefix = familyId + "-r-" + lineageId + "-g-"
recordKey = lineagePrefix + writerId + "-d-" + partitionDecisionSha
```

Current/default ref selection authorizes the selected generation lineage. Reused
objects keep their original identity, lineage and writer; a selected generation
is sufficient provenance for its exact refs. Never recursively fetch predecessor
generations or rediscover a newer generation during an operation.

## Native object layout and envelope

An SDK object has exactly these two literal roots from an isolated archive root:

```text
envelope.json
payload/
```

The descriptor is `["base-object",2,"native-metadata-v2",I]`. Its reference is
`["object-ref",I,objectKey,descriptorBytes,descriptorSha]`. Neither descriptor nor
payload has an archived per-file catalogue, content hash, mode sidecar, directory
clock sidecar or unit manifest. Empty selected partitions use an explicit generation
`empty` entry rather than manufacturing an object.

SDK transport recursively archives the literal native payload. Restore validates
the bounded descriptor and isolated staged layout for every available object.
For ordinary aggregate Gradle base objects, the exact published reference and
successful SDK extraction establish the payload projection. Publication applies
ownership, exclusions and complete-unit rules. Restore checks native identities
and conflicts at selected move and merge boundaries and retains detailed
installation records only where selection descends. A directory eligible for an
intact move can stop at its checked root. Read-only jobs and distributed workers
omit the reuse summary. Writable standalone jobs and distributed aggregators
collect the consumer-native metadata summary before changing the live tree.
Maven, single-writer sources and authoritative pruning keep full discovery and
their existing detailed checks. Missing objects make their declared group cold.
Availability and exact-reference checks finish before live installation.

## Generation record

```text
["generation",3,"generation-v3",familyId,modelId,lineageId,writerId,
 decisionSha,entries,groups,partitionDecisionSha,recordKey,lastDependencyGcSweepAt]
entry = ["object",partitionId,objectRef] | ["empty",partitionId]
partitionDecisionSha = H("partition-decisions",
 ["partition-decisions",3,familyId,modelId,lineageId,writerId,decisionSha,entries,groups,
  lastDependencyGcSweepAt])
```

`lastDependencyGcSweepAt` is a nullable nonnegative safe-integer epoch timestamp
in milliseconds. Ordinary publication carries the selected base timestamp forward.
A complete or forced sweep publishes its completion timestamp with the resulting
partition references, even when all objects are reused. An abandoned publication
grants no completion receipt. Changing the timestamp changes the partition decision
and immutable generation key. The generation-v3
profile changes both Gradle and Maven discovery families; old generation-v2
records remain in their prior families. Cooperating jobs must upgrade together.

Entries follow model order exactly. Groups are complete disjoint model partitions,
ordered canonically; Maven direct coordinates spanning partitions must stay in one
group. Group formation folds already admitted native indices, including the named
metadata merge pass over independent selected sources. It is not another native
walk. Cross-unit or invented group joins reject. The generation extraction root
contains exactly `record.json`, checked while streaming its bounded root entries.

### Recovery groups

The historical name means cold-availability atomicity, never crash replay. The
current operation validates each available object and its complete cross-partition
coordinates before granting installation authority. Cold groups grant no incoming
payload; explicit empty authority remains distinct from a missing source.

### Record-last publication

Selected maximal native roots move into isolated same-filesystem payload layouts.
No copy fallback is used for aggregate evacuation or source return. SDK settlement
finishes before independent return; only successful direct confirmation and
successful returns permit the immutable generation save. An SDK error, unavailable
backend, conflict or unconfirmed result warns and abandons outgoing publication.
Local capture, planning, return, cleanup and ownership failures remain hard errors.
A stranded original source remains at its reported location; it is never concealed
as a cache miss or granted retry authority.

## Metadata summaries and pre-overlay pins

The local profile is
`["native-metadata-summary",1,permissionProfile,"native-mtime-ns","files-first-utf8-dfs"]`.
`permissionProfile` is `unix-mode-0777` (mode & 0777) or
`windows-owner-writable` (mode & 0200). In the
`partition-native-metadata` framed digest, start with that exact profile, then
ordered meaningful directory `["directory",path,permissions]` and file
`["file",path,size,mtimeNs,permissions]` rows. Root-directory metadata, scaffolding,
directory clocks, atime, ctime and device/inode do not enter the summary.
The result is `["partition-metadata",1,digest,fileCount,meaningfulDirCount,totalBytes]`.
Full original native identities still serve activity, selected mutation and cleanup
consumers within their operation; they do not cross main/post per file.

Where publishing requires a baseline, successful restore pins
`(invocation,family,model,partition,exact selected object-ref or declared-empty,profile,summary)`
before existing extras, pruning or worker application. A summary-free aggregate
restore carries the exact object reference and availability in the local handoff. Missing/cold partitions have no reusable pin. The build/post view is
compared with these original pins; never reset the pin to the final prepare view.

This is deliberately metadata equality: body changes that preserve size, native
mtime and supported permission bits may be missed. This includes controlled
aggregate worker upserts, whose mandatory delta body verification still runs.
The limitation does not permit false worker provenance for independent snapshots:
only an exact inherited base origin or exact declared-empty generation origin can
reuse its corresponding pin. Worker/local snapshot origins require new publication.

## Native timestamp materialization

Worker portable file mtimes are integer milliseconds; actual output identities
must be captured after final body, mode/time writes and close. Native OS rounding
is retained as the actual output fact, never assumed to equal a floating-point
multiplication. A copied directory's final close identity replaces its creation
identity only under the genuine producer and same-object continuity. No source
inode is rebased into copy output. Snapshot copy feeds actual output facts directly
into its index without a second native walk or unused body hash.

## Source lifetimes

Restore and final selected-worker indices are process-owned capabilities. A worker
index alone grants no verified-worker authority: the transfer also checks genuine
completed merge, every input body/loser/seal/EOF, exact original published install
parts, store/root/partition/budget/bounds and active stage lifetime. Independently
copied snapshots remain independent bytes and carry their own output identities.

An active GC survivor owner borrows the original complete capture index and a lazy
changed-parent ledger. Selected-target and parent checks, successful native deletions
and completed parent barriers establish survivor ownership without rechecking
unrelated retained trees. No full facts/index copy follows. The owner remains alive through SDK settlement and source return even after foreground
cancellation. Typed static receipt checks reject absent/copied/fabricated owners
before reading their fields or borrowing them.
