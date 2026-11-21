---
title: Local Cache Lifecycle Protocol
weight: 17
description: Draft exact local state, stream, intent, cursor, identity, receipt and crash-recovery schemas for streaming caches.
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

## Status and reference rules

**Draft version 1; codecs and an isolated native persistence/install/recovery engine
are implemented.** This is the local part of the [streaming cache protocol](../cache-protocol/),
paired with the [native-base and generation schemas](../native-base-protocol/).
These are local records, never worker payload members or cached generation data.
The released Action lifecycle does not use this engine yet. Producer integration,
Gradle shutdown, native save relocation, full scale/runner memory qualification and
activation remain later work. Implementation comments cite this file and its relevant
heading. No serialized flag restores a process-local verification proof.

Use the parent's canonical `J`, framed `A(domain)`/`H(domain,tuple)`, scalar types,
paths and portable metadata. Each JSON tuple/NDJSON record is bounded to 64 KiB;
streams have no total-byte/record admission limit. Unknown versions/tags/fields,
noncanonical numbers/encoding and unsafe arithmetic fail validation. Bounded arrays
below contain model partitions/producers, never file/unit/root inventories.

All paths below are **relative to the actual managed root**, except explicitly
marked `nativePath` fields. Owned state lives under `.mammoth/v1/<invocationId>/`.
The reserved directory is excluded unconditionally from managed custom partitions.
This protocol requires **one active Mammoth lifecycle per actual managed root**
through prepare, build and post, as on a dedicated job root. Two jobs/prepares sharing
a root, or an old process resuming concurrently with recovery, are unsupported.
The existing per-job invocation guard does not provide cross-job/root locking.
Root-local records/locator are crash-discovery bindings, not an atomic exclusion
claim or lease; reject concurrent ownership when detected, but do not claim every
race is detectable. A caller must establish that the old lifecycle is no longer
running before fresh recovery/supersession.
Canonicalize/bind the managed root before use; reject an unexpected root identity,
escaping path, symlink traversal or an unrelated invocation's scratch ownership.
rootBinding's locator compares the same canonical native path and stable directory
kind/device/file ID (and birth identity when reliably available), not full N equality.
Ordinary builds or creating owned metadata can legitimately change root size/mtime/
ctime; those fields are not root-replacement evidence. Later frozen managed subtree
evidence has its own observation boundary. Native evidence for actual
managed subtrees keeps the stricter mutation rules below. Use same-filesystem native rename only; no copy-fallback record variant exists.
A `nativePath` is a validated absolute platform path, used only locally and never
formed by interpreting a worker logical path as an executable or authority.

### Native identity and evidence

```text
N = ["native",1,kind,device,fileId,size,mode,atimeNs,mtimeNs,ctimeNs,birthNs]
rootBinding = [nativePath,N]
```

`kind` is `file` or `directory`. Device/file ID/size are canonical unsigned decimal
strings; times are canonical signed decimal nanosecond strings (no leading zeros
or negative zero); birthNs may be `null` when unavailable or not reliably distinguishable from a
platform fallback. The Node adapter uses Windows native creation time; it omits
Unix birth identity because the stat interface can substitute ctime. Other N fields
retain full native precision. Mode is the full native
integer mode, not portable normalized mode. Preserve actual native precision;
portable millisecond truncation is not valid for source-stability checks. A platform
adapter must supply consistent stable identities or reject the mutating operation,
not fabricate a successful rename proof from zero/unknown IDs.

Frozen identities include atime for activity decisions. Subsequent content reads
attributable to Mammoth may ignore atime only; size/mode/mtime/ctime and file ID
remain checked. A known rename can change the moved root's ctime; on Windows, native filename
tunneling can also adjust that root's creation/birth timestamp. A live guarded
operation bridges exactly the observed transition, retaining kind/device/file ID,
size/mode/mtime. Ordinary identity comparisons and the root locator keep their
birth checks. See [Microsoft file-time documentation](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfiletime). It cannot excuse changed descendants.
For an ancestor whose children Mammoth deliberately changes, compare stable kind/
device/file ID and the exact attributed child projection; do not accept its current
timestamps as a new blanket baseline. Record the affected ancestor facts through
ordered traversal/operation evidence, not a global path set.

On reload, serialized before/after identities are bindings to revalidate, not proof
that a past process performed a trusted syscall. Ambiguous moved roots require
complete frozen membership and content-hash verification before adoption/return.
Same-size changes remain detectable against the frozen expected bytes. No old live
path retains authority after its native object is moved elsewhere.

### Immutable references and append prefixes

```text
Q = ["ref",purpose,path,bytes,sha]
P = ["prefix",purpose,path,bytes,records,sha]
span = ["span",streamSha,startByte,endByte]
```

`Q` binds exact complete file bytes (including LF), purpose and an owned path under
the invocation root. A referenced local stream's header must independently match
invocation/model/family/partition. Binary artifact refs bind the opaque immutable
file and its expected artifact identity from bindings. Only declared references may
be reopened; a matching filename alone is insufficient. A `span` is a half-open
range of whole validated records in the referenced immutable stream, at known
file/subtree/unit boundaries, not an arbitrary payload byte extent.

Standalone Q purposes are explicit: `generation` for record.json, `envelope`
for envelope.json, `native-tree` for tree.ndjson and `worker-archive` for opaque
worker TAR/gzip bytes. Local standalone document refs use their document tag
(`bindings`, `publication`, `quiescence`, `gc-progress`, `install-progress`).
Complete local stream refs use the stream's purpose. Reference purpose is checked
against the decoded document tag/header, never inferred from its filename.

`P` binds an immutable **prefix** of an owned append-only evidence file, not a new
whole-file copy at every checkpoint. Its byte count ends at an LF; records excludes
the stream header and counts complete data records in that prefix. Validate prefix
hash/grammar once on reload and reconstruct the incremental hasher in that linear
read. Normal appends keep hasher state and commit a new prefix without rehashing the
entire prefix per batch. Uncommitted owned tail is not accepted evidence; recovery
may truncate/rebuild it under its still-live intent. This is not permission to
truncate an unowned, referenced immutable or unexpected file.

A completed stream has these framing records:

```text
["local-stream",1,purpose,invocationId,modelId,familyId,partition]
... purpose-specific records ...
["local-end",dataRecords,eventSha]
```

Partition is `null` for global streams, otherwise its model ID. `eventSha` is
`A("local-" + purpose)` over header and preceding data records, excluding local-end.
`Q.sha` additionally covers all exact bytes including local-end. A live prefix lacks
local-end until sealed; a prefix is allowed only where explicitly declared below.
Empty complete streams still have header/end. No closed stream is mutated later.

### Durable replacement and cursors

Write an owned candidate, sync its complete bytes, atomically rename it into place,
then sync the containing directory under the platform's supported durability
contract. Publish a reference/pointer only after its evidence is durable. Do not
promise power-loss survival beyond the platform's actual sync/rename guarantees;
if required durable ownership cannot be established, do not begin destructive work.
The POSIX implementation syncs both file bytes and the containing directory; any
required sync failure is fatal. The Windows Node/libuv implementation syncs file
bytes with FlushFileBuffers and completes the same-filesystem native replacement.
It provides process-termination/restart recovery while Windows and the filesystem
remain running. It makes no directory-namespace persistence promise across an OS
crash, reboot or power loss; directory sync is not silently treated as successful.
This explicit Windows profile leaves evidence/intent/mutation/progress/pointer/
retirement ordering unchanged. Actual process-restart tests qualify those code
paths, not power-loss survival. See the
[libuv Windows implementation](https://github.com/libuv/libuv/blob/v1.x/src/win/fs.c).

Keep at most current plus one candidate for a replaced checkpoint, not retry history.
For every replaced **Q-referenced** record/stream, write to a new unique immutable
owned pathname, sync it, atomically commit the root state's new Q pointer, and only
then retire the old Q file. Never overwrite bytes at a still-referenced Q.path and
leave its old hash live, even temporarily. Fixed mutable state/intent/locator files
replace at reserved paths under their distinct mutable-record rules. A P may append
without changing its committed prefix; sealing it as its first Q is allowed, but
that complete Q's bytes never change afterward. GC/install cursor advancement means
both a new immutable progress Q **and the root pointer replacement** are durable
before clearing the destructive intent or retiring evidence.

```text
cursor = ["cursor",streamSha,nextByte,nextRecord,boundary,stackRef]
frame = ["frame",depth,path,phase,lastFile,lastDirectory,unit]
```

A cursor identifies the next complete record/unit boundary, with checked byte and
record positions; boundary is completed unit/root count for that stream. `stackRef`
is a `Q` of purpose `cursor-stack`, or `null` at an empty stack. Frames are streamed
in ancestor order, depth starting at zero; phase is `files` or `directories`, last
names are a component or `null`, and unit is `null` or `[kind,root,scope]`.
A cursor-stack has at most the admitted depth; decode/name budgets still apply.

Do not embed all ancestor paths in one potentially huge checkpoint tuple. Validate
stack/path/ordering against the referenced stream boundary once on reload, then
resume sequentially. A cursor is not permission to seek into an arbitrary line or
skip the active intent. Replacement stacks are owned by current/candidate pointers;
no per-boundary stack history is retained. A destructive batch cursor advances only
at a complete semantic unit boundary, never midway through a workspace.

## Invocation bindings and operational capture

The immutable bindings document is:

```text
["bindings",1,invocationId,context,nonce,rootBinding,modelRef,familyProjection,
 policy,baseline,producerSetRef,prepareSourcesRef,activityRef]
baseline = null | ["baseline",recordKey,recordRef]
producer = [artifactName,artifactId,transportSha,context,archiveRef]
snapshotSource = [partitionId,sourceKind,identity,metadataRef,nativeRoot]
```

Context/nonce/model/family and all identities follow the base specification.
`recordRef` is a `Q` of the pinned generation bytes, not a historical-chain pointer.
ModelRef is a complete purpose `model` stream containing one
`["model-header",buildTool,hardExcludes]` and model-order
`["partition",id,includes,excludes,publication,writer,conflict]` rows. These reconstruct
the native-base model hash projection; it is not one potentially oversized model JSON
record. ProducerSetRef binds purpose `producers` with `["producer",producer]` rows,
sorted by the parent's job-name ordering, unique, with nonempty service IDs and
immutable downloaded archive refs; admission bounds their count. PrepareSourcesRef
binds purpose `prepare-sources` with `["snapshot-source",snapshotSource]` rows.
These sets are streamed by bounded records rather than embedding up to 64 repeated
native paths/refs in one 64-KiB bindings tuple.
Prepare snapshot sources are in model order and include only already sealed
baseline/incoming-worker views. `activityRef` binds the complete prepare-time selected
worker activity stream, including imported usage, and is nonnull at build-ready
(an empty stream is valid). Final local-writer post-build views are **not** captured
in prepare bindings. The shared snapshotSource tuple's source kind is `baseline`, `local-writer` or
`worker-writer`; identity is `[kind,originId]`, where originId is its pinned object
key, this invocation ID or the selected artifact ID respectively. Metadata ref
binds the exact source's validated tree/activity and nativeRoot is an owned native
staging path under the same managed root. Retained snapshot nativeRoot rejects the
first-component `install` subtree, including native case/trailing-dot/space aliases;
`VerifiedIncoming` instead requires exactly `install/<partition>`. A consumable root
cannot also be the retained authoritative snapshot. No-link/nlink guards complement
this namespace separation. Never store file lists in bindings.

```text
policy = ["policy",1,role,access,restoreCleanup,gcMode,gcCutoffMs,cutoffMs,
          duplicatePolicy,maxDirectoryEntries,ordinaryOrder]
policyId = H("policy",policy)
producerSetSha = producerSetRef.sha
snapshotSourcesSha = postSourcesRef.sha
```

Role is `standalone`, `distributed-worker` or `distributed-aggregator`; access is
`writable` or `read-only`; restoreCleanup is `none` or `prune-managed`; gcMode is
`off` or `timestamp`; gcCutoffMs is `null` only for off. Cutoff is a `uint`, set only
after successful prepare (never reconstructed from a later clock). Duplicate policy
is `strict` or `newer-mtime`, with the exact fold in the parent specification.
OrdinaryOrder is the validated configured dependent-jobs list after stable first-
occurrence deduplication, in declaration order and empty when none; it excludes jobs added solely for snapshot discovery.
Keep it separately from the sorted producer inventory and bind it into policyId so
retries cannot reorder an order-sensitive reduction. Directory
entry allowance is positive. GC cutoff is fixed for the attempt, not recomputed on
retry. For prepare-pending bindings only, cutoffMs may be `null`. At build-ready,
seal final bindings with that cutoff and freeze them thereafter. The root state
changes its bindings ref atomically; older unreferenced prepare candidate is retired.

Snapshot source sets may be empty. Prepare sources are immutable; local-writer
capture for a **base publisher** happens only after observations commit and GC
completes, while content reads are permitted. Freeze the final source set as a complete purpose `post-sources`
stream containing `["snapshot-source",snapshotSource]` rows in model order, choosing
one authorized source per contributed partition. Source metadataRef is a `Q` of
`native-evidence` at its owned nativeRoot; baseline hashes retain trusted-base status
and worker/local hashes retain their guarded capture evidence. Never alias a mutable
live cache as a sealed snapshot. An unavailable optional writer inherits its prepared
baseline/worker source according to the existing snapshot policy; a required absent
producer remains an error.

Atomically install postSourcesRef in gc-complete state only after every complete
post-source capture/ref is durable; null means not finalized, while a sealed empty
stream means intentionally no sources. Decision/key derivation then binds that exact
ref's sha. It cannot derive keys before a local-writer's post-build source exists,
mutate prepare bindings or substitute a pre-build snapshot. Once base publication freezes, neither postSourcesRef nor its sources change. A failed uncommitted capture
can discard its owned candidate and retry under the same frozen observations; after
source-set commit, changes invalidate the frozen attempt. Local native paths in this
invocation-local digest do not enter portable family compatibility.

For **distributed workers**, postSourcesRef instead binds a purpose `worker-sources`
stream with `["worker-snapshot",partitionId,observationsRef]` rows, in model order,
only for this worker's authorized complete snapshot contributions. It describes
frozen live partition scope, not a sealed native shadow tree. Commit this membership
selection after observations/GC and before package creation, then guarded-stream each
complete live snapshot directly into its TAR channel, hashing the same bytes once.
No native snapshot copy/native-evidence prehash is required for worker creation.
Source/tree stability must still match the frozen observations. At package-frozen,
the immutable archive plus workerRef is retry authority; do not reread live bytes or
refreeze the snapshot. Base publication consumes only the native `post-sources`
variant, never this worker-only source selector.

### Gradle installation registration

Each real build initialization writes an owned atomic registration document:

```text
["gradle-installation",1,invocationId,gradleHome,gradleVersion,gradleUserHome,javaHome]
```

Home fields are nativePath; version is a nonempty string. Register before summary
skip/Test/parent/version/service or failure/completion filters. Included or repeated
builds using the same tuple can share a filename equal to
`H("gradle-installation",tuple) + ".json"`; compare the full record on an existing
name. Registration is not performed by Mammoth's own stop commands. No summary
result array or version-only record substitutes for this location/runtime inventory.

Enumerate registrations incrementally without retaining/sorting a global installation
list. Seal the encountered validated tuples in purpose `installations` as
`["installation",registrationTuple]` records. It need not be cross-run sorted;
its frozen order/ref is retained for this attempt. Stop clients run with bounded
concurrency and deadlines through those existing compatible installations, with
explicit Gradle user home and Java runtime. Keep wrapper/dists and needed runtimes
accessible until every stop client exits and native process verification succeeds.
A quiescence document is:

```text
["quiescence",1,invocationId,installationsRef,"all-exited",checkedAtMs]
```

This records the completed gate, not a reusable lock. Missing/failed capture,
unknown relevant daemons, inaccessible process details or a timeout yields
`skipped-not-quiescent` before relocation. No launcher sweep/download/OS-kill fallback.
On a later process/retry, re-establish the exclusive window before new mutations;
never trust checkedAtMs as proof that no daemon restarted. Read-only does not stop
processes. This does not authorize stopping unrelated shared-machine processes.

## Mutable root state and partition cells

The fixed managed-root locator `.mammoth/v1/current.json` is:

```text
["current",1,invocationId,statePath]
```

StatePath is exactly `.mammoth/v1/<invocationId>/state.json`. Recover the prior
locator's pending fixed GC/install/relocation markers before superseding it. Create
new prepare state and bindings durably, commit this locator, then permit any new
intent/mutation. A crash before locator commit cannot have new destructive work;
after commit, fixed markers are discoverable even if their refs have not reached
state yet. Reject detected concurrent owners/unsupported legacy intents; do not select a
newest-looking directory by name. An abandoned unreferenced candidate is not an
authorized recovery owner.

Fixed owned `state.json` is:

```text
["local-state",1,invocationId,revision,phase,bindingsRef,observationsRef,postSourcesRef,
 publicationRef,partitionStateRef,gcProgressRef,installProgressRef,
 workerRef,quiescenceRef,outcome]
```

Revision starts at zero and advances on each atomic replacement. References are
`Q` or `null` as phase permits. `workerRef` is `null` or
`[archiveRef,artifactName,transportSha,receipt]`; receipt is `null` or
`["artifact-receipt",artifactId,artifactName,transportSha]`. Outcome is `null` before
completion, otherwise `read-only`, `no-change`, `published`, `worker-uploaded`,
`skipped-not-quiescent` or `abandoned`. Required worker completion rules still apply;
a failed required producer cannot report a successful empty artifact.

`partitionStateRef` is a `Q` of purpose `partition-state`, containing at most P rows:

```text
["partition-state",partitionId,baseline,adjustmentRef,snapshotSource,
 objectReceipt,relocationMarker]
baseline = ["baseline-partition",status,objectRef]
```

Rows occur exactly once per model partition, in model order. Status is `restored`,
`empty` or `missing`; objectRef is nonnull only for restored. Adjustment ref is the
one current `Q` of purpose `adjustments`, or `null`. Snapshot source is that
partition's sealed source tuple or `null`. Relocation marker is a reserved owned
relative path or `null`; validate it if present. Object receipt is defined below.
No unbounded object list is embedded in state or partition cells. Replacing this
P-bounded stream plus root pointer is not copying all file descriptors per checkpoint.
The fixed marker paths must also be checked at recovery startup; a crash cannot make
an unreferenced durable destructive intent invisible just because a state replacement
had not yet installed its pointer.

### State phases and prerequisites

| Phase                  | Required evidence and permitted next transition                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare-pending`      | Recover prior root-local destructive markers first; bind selected generation/producer IDs, validate all inputs, then guarded install. No successful build cutoff yet.         |
| `build-ready`          | Install intents reconciled; final bindings/cutoff and worker activity durable. Read-only may complete; writable post establishes quiescence where needed.                     |
| `quiescent`            | Required stop/process gate succeeded in the current exclusive window; metadata-only freeze may begin.                                                                         |
| `observations-frozen`  | Complete observations and initial GC progress refs are durable before any content/hash/report/GC work.                                                                        |
| `gc-complete`          | All selected GC batches reconciled and completed cursor durable; retained-source evidence still matches. Capture/seal postSourcesRef here before decision/key/package freeze. |
| `objects-frozen`       | Immutable publication plan, keys, trees/envelopes and move plans are sealed. Worker mode instead goes to package-frozen.                                                      |
| `relocating`           | Partition-wide marker exists before first outbound move; no receipt yet.                                                                                                      |
| `staged`               | Outbound plan complete, sealed stage evidence matches all frozen bytes/membership.                                                                                            |
| `object-saved`         | SDK returned or outcome is ambiguous; stage post-barrier still required, sources not yet declared returned.                                                                   |
| `returning`            | Return every evacuated root, including ambiguous active outbound range; no next partition.                                                                                    |
| `sources-returned`     | Locations reconciled, adjustment state committed, marker cleared/retired; only now accept object receipt and advance partition.                                               |
| `final-source-barrier` | All P choices/receipts match immutable plan; no pending markers; retained projection and deleted-target absence verified.                                                     |
| `record-saved`         | Exact record confirmed; complete publication atomically.                                                                                                                      |
| `package-frozen`       | Worker archive complete and source-stable; no base relocation path.                                                                                                           |
| `worker-uploaded`      | Exact artifact identity/digest receipt confirmed; worker may complete.                                                                                                        |
| `completed`            | Outcome fixed; cleanup only unreferenced owned state with no destructive intent.                                                                                              |

`phase` is exactly one listed tag. Partition progress also binds phase/epoch in the
relocation marker, so root state cannot forget earlier moved batches. Sources-returned
may loop to relocating for the next changed partition. A writable worker uses
build-ready → observations-frozen → gc-complete → package-frozen; it does not
need the Gradle base-relocation shutdown gate. A non-Gradle base publisher enters
quiescent only after its own cache consumers have finished. Read-only completion
performs no post-build tree/hash traversal. No-change requires validated observation/
GC/publication decisions, not a fabricated hit. Any actual failure returns sources
under outstanding intents first or leaves recoverable state blocking prepare.

## Frozen observation and GC schemas

Purpose `observations` contains one balanced managed tree. Records are:

```text
["dir-open",path,N]
["child",name,type,device,fileId]
["file",name,partition,N,baseline,activity,decision]
baseline = null | ["portable",size,mode,mtimeMs,contentSha]
["unit-open",kind,root,scope,activity,decision,unitEvidenceSha]
["unit-close",kind,root,unitEvidenceSha]
["dir-close",path]
```

After each dir-open, emit its complete immediate `child` projection in sorted
non-directory then directory name order, before the managed file/unit/subtree body.
It includes enumerated excluded/unsupported children, using lstat IDs without
following them; unsupported managed members still fail admission. Type is `file`,
`directory`, `symlink` or `other`; device/file IDs are native decimal strings.
Reuse these frozen rows for GC parent projections; do not invent a fresh post-unlink
child list as the original projection. The additional metadata calls for excluded
child IDs are part of the one preflight inventory and must be counted.

Activity is `none`, `used` or `upsert`; decision is `retain` or `delete`.
Ordinary file activity/GC eligibility follows frozen native timestamps/cutoff and
validated imported activity. An explicit unit's decision covers all managed members;
its file records must agree. Compute unit membership/eligibility with bounded
metadata-only spooling before emitting summary-first unit-open. No payload reads
precede the committed full observation ref. `unitEvidenceSha` is `A("observation-unit")` over normalized
`["directory",path,N]`, `["child",parentPath,name,type,device,fileId]`, and
`["file",fullPath,partition,N,baseline]` facts in observation order, excluding asserted
unit headers/closes and activity/decision fields. It requires no new file-body hash;
any baseline contentSha is already pinned metadata. A subtree initializes with its
already-open root N/child projection and covers all descendants. A direct Maven
unit includes its parent N/child projection and direct file facts only, not descendants.
Full-stream Q hashing binds the frozen activity/decision fields separately.
GC must be off/retain for unsupported units and obey existing complete-workspace/
Maven coordinate policy; never freshly reclassify by timestamps after capture.
A deleting recognized workspace must satisfy its metadata marker requirements;
incomplete retained observations may still be recorded. Activity stream framing
and unit membership alone do not establish complete imported content: prepare must
bind that stream to already validated selected worker units. Timestamp/cutoff policy,
referenced frozen observations and source provenance remain required preflight inputs.

Purpose `activity` records imported selected worker facts with these exact ordered
tuples, without file hashes:

```text
["dir-open",path]
["unit-open",kind,root,scope,activity]
["upsert",name,partition] | ["used",name,partition]
["unit-close",kind,root]
["dir-close",path]
```

Here activity is `upsert` or `used`; direct file records use one component name.
Files/used names share one sorted sibling category, no duplicate path or mixed
representation for an indivisible unit. Units retain subtree/direct boundaries.
A complete activity stream has a balanced empty root even when no facts exist.
The same purpose can encode per-source upsert membership for the parent's usage-
exclusion join, then retire it; bindings.activityRef instead pins selected prepare
activity needed by post. Purpose `cursor-stack` uses frame tuples. These streams retain necessary sequential evidence,
not a searchable global index. Baseline file facts can be co-read from pinned tree
metadata rather than materialized in a map.

```text
["gc-progress",1,invocationId,observationsRef,completedCursor,activeMarker]
["gc-intent",1,invocationId,observationsRef,startCursor,endCursor,evidenceRef]
```

GC progress is a small `Q` referenced from root state; activeMarker is the fixed owned
`gc-intent.json` path or `null`. Purpose `gc-evidence` brackets complete semantic units:

```text
["gc-unit-open",kind,root,scope]
["target",path,partition,N]
["parent-child",parentPath,name,type,device,fileId]
["gc-unit-close",kind,root,projectionSha]
```

Ordinary one-file units use kind `file`, scope `file`; existing unit kinds/scopes
are otherwise unchanged. `projectionSha` is `A("gc-unit")` over unit-open and **all** preceding target,
directory and parent-child rows in this unit, excluding close. Workspace evidence
includes `["directory",path,N]` facts in traversal order. Direct Maven evidence
includes its parent directory N and one parent-child row for **every immediate child**,
sorted non-directories then directories by the common name order, including unmanaged siblings
and child directories. Type is `file`, `directory`, `symlink` or `other`, and IDs use
native canonical decimal strings from lstat without following links. No child-directory
descendant is recursively inventoried for this parent projection.

Compare recovery's immediate children against that frozen projection minus planned
targets already absent; all surviving identities/types must agree, and unexpected
children fail. Own unlink may change parent ctime, never its stable ID or permission
to hide another child. Preserve child directories/unmanaged entries. Every target has a preceding native directory projection and matching immediate
parent-child type/device/file ID; subtree directory targets match their own explicit
directory identity. Direct units cannot include descendant directory evidence.
Directory cleanup targets are declared after their descendant evidence/targets,
in postorder; they permit only guarded empty-directory removal.
Workspace scope instead compares complete descendants using directory/target rows
and the complete immediate child projection for each traversed directory, including
existing protected/excluded children too. Those
protected rows are evidence, never implicit deletion targets: preserve existing lock/
bookkeeping files and leave directories nonempty when they contain them. Unknown new
members still block. Never recursively unlink the whole workspace merely to satisfy
its deletion decision. Evidence for
every file/tree actually deleted is explicit; optional empty-directory cleanup must
itself be an expected directory target and must not sweep unknown children.

Group consecutive complete units into one evidence file, candidates 16,384 targets
or 8 MiB encoded evidence, closing at unit boundaries. One larger indivisible unit
may use its own streamed batch; this is not a unit/cache byte quota. Sync evidence
and intent before deletion; only one active GC batch. Delete origin markers last
inside a Maven direct unit and preserve child directories/unmanaged siblings.

Replay accepts an absent planned target or its exact expected native object;
a recreated/replaced target, unexplained child or type change blocks recovery.
After deletion, durably replace the progress Q and root pointer with the advanced
completedCursor, then clear intent and retire evidence.
Crash after cursor advance but before cleanup completes the same cleanup idempotently.
A fresh prepare recovers active batch ownership first; it need not finish all future
GC batches of an abandoned attempt. Final publication still validates absence of
completed deletion targets: do not prune their paths from replay and miss recreation.

## Frozen publication and native transfer plans

The publication document is:

```text
["publication",1,invocationId,decision,decisionSha,postSourcesRef,partitionsRef,recordRef,recordKey]
partition = ["reuse",partitionId,objectRef]
          | ["empty",partitionId]
          | ["new",partitionId,objectIdentity,objectKey,envelopeRef,treeRef,movePlanRef]
```

Decision and all key/ref derivations follow the native-base specification.
`partitionsRef` binds a complete purpose `publication-partitions` stream of the listed
reuse/empty/new rows, exactly once in model order. It must not be an embedded array:
64 ordinary new-partition rows with keys and three refs already exceed a 64-KiB
record. Stream the rows with bounded parser state, not all file descriptors. `recordRef` is the complete candidate generation
bytes, already frozen; it may be uploaded only after all objects and source barriers.
Native source-free empty/reuse choices need no move plan. Changed-partition trees and
content hashes are produced in one retained-source traversal routed to at most P
sinks, not one full-cache walk per partition. Producer/snapshot set digests and
observation hash and finalized postSourcesRef are fixed before deriving keys.
The publication source ref must equal root state's committed postSourcesRef.

Purpose `move-plan` contains:

```text
["move-unit-open",kind,root,scope]
["move",index,sourceSpace,sourcePath,logicalPath,kind,treeSpan,sourceEvidenceSpan]
["move-unit-close",kind,root,rootCount]
```

Index starts at 1; moves and units follow canonical hierarchical order. Unit kinds
are `file`/scope `file`, existing recognized kinds/scopes, or the local-only
`directory`/scope `subtree` move group. A directory group contains exactly one
`move` whose kind is directory and logicalPath equals the group's nonempty root.
This transfer grouping may contain several ordinary files or complete recognized
units; frozen referenced projections must prove all selected contents belong to
this partition and no indivisible unit straddles its boundary. It does not alter
worker conflict units or introduce a GC/install directory-group descriptor.
Maximality applies within these admitted move groups. An ordinary file unit moves
one file, never a directory disguised as a file. A direct Maven unit may move its
own directory root only when its complete frozen projection proves no child directories,
unmanaged entries or other-partition members would be carried along. Source space is `live`
or `owned`; sourcePath is logicalPath for live, or the exact sealed snapshot/staging
path under this invocation for owned. LogicalPath maps to
`.mammoth/v1/<invocationId>/objects/<partition>/payload/<logicalPath>`. Return to the
same original source even for an owned source, preserving its required lifetime.
Tree span binds exact portable member facts/hashes; evidence span binds the frozen
native projection. Ref streams/ancestors are retained until all returns reconcile.

Move roots are maximal fully selected, nonoverlapping files/directories; no root
contains another. A directory root must contain only that partition's selected
members, no unmanaged/excluded/reserved siblings or nested mount. Never move the
managed root, enclosing homes or `.mammoth` itself. Shared/mixed directories instead
use smaller eligible roots; source parents remain in place. A complete workspace may
need multiple roots, all under the same semantic move unit. Maximality and boundary
summaries use bounded spools, not an array of every root.

`sourceEvidenceSpan` refers to the frozen observation for live sources or to a sealed
purpose `native-evidence` tree for owned sources. Its records are
`["directory",path,N]` and `["file",path,N,contentSha]`, in hierarchical order; a
span cannot change the frozen expected content hash. Owned source admission validates
membership/hash once under its guarded lifetime. Same-invocation rename evidence
then permits reusing that proof; recovery without the transition proof rehashes.

### Partition-wide relocation marker

Fixed `relocation/<partition>.json` remains durable throughout the entire operation:

```text
["relocation",1,invocationId,partitionId,epoch,planRef,inputAdjustmentRef,phase,
 outbound,returned,active,outEvidence,returnEvidence,adjustmentCandidate,stageRef]
active = null | [direction,startCursor,endCursor]
```

Epoch is positive and increases for each new evacuation attempt under the same
immutable plan/key. Phase is `outbound`, `staged`, `saving`, `returning` or
`sources-returned`. Outbound/returned are independent move-plan cursors; returned
cannot exceed the reconciled owned high-water boundary. Active direction is `outbound` or `return`.
Evidence fields are `P` or `null`, purpose `outbound-evidence`/`return-evidence`.
Adjustment candidate is `null`, a live `P` or a sealed `Q` of purpose `adjustments`.
Stage ref is `null` or a complete `Q` of purpose `stage-evidence`.

Durably install this marker before the first move, including full plan binding and
zero cursors. Every batch installs its active range before its first rename. Batch
bounds match GC's root/evidence grouping and preserve semantic unit boundaries;
a large unit remains streamable, not rejected. The marker—not merely the active
batch—owns the entire outbound prefix until all sources return. Never retire prior
ownership when moving to the next active range or clear the marker after evacuation.

Purpose `outbound-evidence`/`return-evidence` records are:

```text
["transition",index,epoch,direction,before,after,treeSpan]
```

Before/after are native root identities observed immediately around the guarded
rename. Revalidate every descendant against frozen/effective evidence; this root
row does not authorize adopting modified descendant bytes. Source and destination
parents/devices/types are checked, but actual rename still decides whether a mount
crossing is supported. EXDEV fails with no alternate copy operation.

Seal the batch's transfer-output prefix before advancing its completed cursor;
update evidence-prefix and cursor atomically in the marker, then clear active range.
Missing/ambiguous evidence after a crash requires hash/membership reconstruction;
never bless a current identity solely because the expected root name exists.
Recovery covers outbound-completed prefix **plus** ambiguous active outbound range,
minus reconciled returns, not just the last active batch. If a crash interrupted a
multi-root semantic unit, atomically replace the marker to switch to returning and
normalize outbound to that active range's complete end boundary, retaining its active
range binding until reconciliation completes. In returning phase this cursor is the
owned/reconciled **high-water boundary**, not an assertion that every root was moved.
Return walks the whole owned range: expected original-only roots are already safe;
staged-only roots must return. It may then checkpoint a complete semantic boundary
without inventing an illegal mid-workspace cursor. Transition evidence can have gaps
for never-moved indices; it cannot invent rename proofs for them. The unattempted
suffix beyond the active range is not owned by this normalization. A normalized
aborted evacuation cannot go back to staged/saved; finish recovery, then start a new
epoch with zero move cursors under the same immutable plan/key if retry is valid. One linear reconciliation
pass is allowed on reload, not a full-plan scan before every batch.

### Stage barrier, return and adjustments

Purpose `stage-evidence` has `["directory",path,N]` and
`["file",path,N,contentSha]` in payload order. Build it only after comparing the
actual native payload against exact portable membership and expected effective
native descendants from frozen source plus valid transitions. Synthetic structural
directories are allowed only where the tree requires them. Record their identities
for the before/after barrier, never synthesize proof for changed file bytes.

Native SDK TAR is recursive. Compare sealed stage evidence before **and after**
the SDK call/readback, including directory ctime: transient add-then-remove members
must reject, even when final names match. Ignore only attributable access-time
changes. On success, ambiguous outcome or exception, return all moved sources first.
A wrong uploaded immutable object or failed stage barrier is not a receipt.

Return roots in plan order, preserving source parents. Verify expected staged source
and absent original endpoint; never overwrite/merge an unexpected live destination.
A return batch seals its evidence and adjustment prefix before advancing returned.
The marker survives every batch and SDK error until all locations are reconciled.

Purpose `adjustments` is a canonical current stream per partition:

```text
["adjust",path,epoch,N,sourceEvidenceSpan,treeSpan]
["ancestor-effect",path,device,fileId,projectionSha]
```

Adjust rows replace only attributable moved-root native facts; unchanged descendants
remain bound to frozen observations. Ancestor-effect identifies stable ancestor
identity and expected managed child/type projection after attributed operations;
projection is `A("ancestor-children")` over sorted `[name,type]` facts, not a timestamp
exemption or permission to ignore unexpected children. Rows follow tree order,
with at most one effective adjust/effect per path and epoch. Shared ancestor effects
are reconciled against all recorded operations, not an earlier partition's stale time.

Co-read at most P current partition adjustment streams with the frozen observation.
Do not concatenate A's `a,c` with B's `b` and pretend it is globally ordered. On retry,
join the same frozen source plan with current effective adjustments, not original
pre-first-rename ctime. Produce one new canonical candidate merging prior still-valid
adjustments with this epoch's changes. No append-only retry history.

After every planned source is verified back, finish/sync adjustment candidate, then
atomically replace the partition-state catalog/root pointer to reference it. Keep
old current plus candidate until that pointer commits. Mark sources-returned and
retire marker/evidence only after this binding is durable. Crash between pointer
commit and marker retirement recognizes the exact old/new adjustment pair and
finishes cleanup; a third unexpected ref/epoch blocks. Then old adjustment and
unreferenced evidence can retire. A returned root's new ctime is not newly observed
build activity. Final source barrier also checks completed GC target absence.

### Object and worker receipts

```text
["object-receipt",1,partitionId,objectKey,envelopeSha,decisionSha,confirmation]
confirmation = ["save",serviceId] | ["readback",objectKey]
```

ServiceId is a nonempty provider confirmation string. Receipt may enter partition
state only after valid post-stage barrier, all source returns and adjustment commit.
An ambiguous save uses exact-key readback; ordinary trusted-base restore is not enough
to rescue an invalid archive attempt. Readback after a stage-barrier failure must
check full payload membership/content hashes under the planned envelope. Wrong immutable
bytes invalidate that key/attempt; never overwrite or derive a new retry key.

Worker archive/source evidence is frozen at package-frozen. Its artifact receipt
must match name/ID/transport hash from the same frozen archive, not a new scan. A
worker receipt does not imply base publication. Final generation save confirms exact
record bytes/key, after final-source-barrier and no pending destructive markers.

## Install batches and recovery

If an overwritten destination has no already trusted content hash bound to its
current native identity/projection, create its destination native-evidence by reading
and hashing that **preimage** before committing the install intent. Otherwise reuse
valid existing evidence. Account explicitly for these conditional old-byte reads in
addition to incoming worker hashes; this is not a second archive pass or a universal
no-extra-hashing claim. Normal base transport restore still does not hash incoming
trusted-base bytes. Recovery may hash old/desired native staging to re-establish an
ambiguous transition. A missing preimage digest is not silently treated as proof.

Purpose `install-current` freezes the complete physical current-root projection
needed by admission, shared across all selected units and snapshot partitions:

```text
["dir-open",path,N]
["file",path,N]
["parent-child",parentPath,name,type,device,fileId]
["dir-close",path,N]
```

Its stream partition is `null`. The empty root is balanced even for an empty cache.
Regular files and opened directories supply their own immediate child kind/ID facts.
A `parent-child` row supplies that fact instead for a protected/pruned child, with
`type` and canonical decimal IDs as in GC evidence. It does not open or follow that
child; metadata directory variants and unsupported objects can be protected facts.
All immediate children share files/non-directories-first then directories ordering
and the physical breadth limit. A protected child is counted exactly once. Protected
subtrees can be pruned only when all requested evidence excludes their descendants;
unknown ownership is not sufficient proof for pruning a directory. Directory close
retains its open identity except attributable read effects. All active frames and
reader records share the existing working budgets.

The native installer rejects hardlinked selected files and cross-device source,
backup or mutation parents. Unselected current aliases remain protected/preserved
according to ownership. Final merged immediate-child names share the configured
physical breadth cap. Native name comparison conservatively folds case on Windows
and folds normalized Unicode names on macOS; layouts distinguishing those aliases
may be rejected even on a case-sensitive volume. These checks fail before ordinary
execution admission and never grant a copy fallback.

This inventory carries no body hashes or GC/activity decisions, and does not assert
that every enumerated child is managed or eligible for replacement. In particular,
untouched aggregate bodies are not read. The later selected-source/current join
proves ownership and derives required old preimage native-evidence/hashes, preserving
protected children. Presence of an unsupported child is evidence to preserve it,
never authority to consume it. Snapshot planning must use the complete current owned
projection from this shared traversal, not a caller's partial destination list.
Complete the Q hash/EOF gate before treating the inventory as frozen; abandon or
failure cannot grant installation authority. The inventory is sequential operation
metadata, not an in-memory searchable file catalogue.

Initial input preflight completes for **all required inputs** before first live
install. V2/V3 producers apply selected portable mode/mtime (including merged execute
bits or the chosen header timestamp) before sealing incoming native-evidence and
creating `VerifiedIncoming`. The evidence binds the resulting full native identities.
V4a freezes and renames those objects; it performs no portable metadata repair on
staging or live destinations. Repair after sealing invalidates the receipt and needs
new evidence/verification. Purpose `install-plan` contains complete semantic units with records:

```text
["install-context",installCurrentQ]
["install-unit-open",kind,root,scope]
["install-parent",index,logicalPath,ownedEmptySourcePath,N]
["install",index,logicalPath,sourcePath,sourceEvidenceRef,destinationEvidenceRef,
 operation,backupPath]
["install-unit-close",kind,root]
evidence = ["evidence",nativeEvidenceQ,span]
```

Exactly one `install-context` is required as the first data row, in both plan and
batch evidence. It binds the complete frozen `install-current` projection, including
existing-parent identities and protected child IDs needed even by ordinary inserts.
Batch evidence must repeat the plan's exact context Q; tuple validity alone is not
that cross-reference proof. Retain this Q while any dependent plan/intent can need
it. The initial cursor is immediately after context (including for an empty plan),
not after the header. Later cursors remain complete-unit boundaries.

Install plans list aggregate semantic units in canonical hierarchical order first,
then each authoritative snapshot partition once in model order. Operations within
each unit follow canonical files-first hierarchy and have no ancestor/descendant
overlap. This preserves complete snapshot units when partition paths interleave;
there is no single global logical-path sort across snapshot units. Since install
rows omit member kind, ordering uses independently validated referenced native
member kind. Source/destination evidence slots bind `evidence` or `null`, not a
bare Q. The span SHA equals Q.sha and its end is within Q.bytes. A file span contains
exactly its one matching file record. A directory span starts at its matching
directory record, contains every contiguous descendant record, and ends immediately
before a checked outside-subtree record or local-end. Canonical LF boundaries and
header/end exclusion must be checked; arbitrary tuple-valid offsets are insufficient.

Validate/hash each distinct evidence Q once per stable phase and bind shared
positional readers to that exact Q, purpose/partition and native metadata-file
identity. Bounded span reads then permit different source/destination physical orders:
old a=directory,b=file and desired a=file,b=directory cannot both be co-read in the
same physical order. Do not rescan a complete Q or revalidate all ancestors for
each member, or create one Q per file. Per-side member spans are nonduplicated and
nonoverlapping; include bounded outside-record lookahead, seeks and range bytes in
aggregate work. Derive offsets through checked LocalRows and bounded sequential or
per-directory metadata spooling, never a global resident offset index. A complete
partition-projection span still does not establish complete physical ownership.
Serialized Q+span cannot recreate the reader or native execution capability after
restart; recovery re-establishes the required native/content proof. An ordinary file unit requires file kind. Cross-unit alias/overlap,
complete directory ownership and retained snapshot separation remain mandatory
referenced-evidence preflight checks before live installation.

Structural `install-parent` rows and content `install` rows share one contiguous
index starting at 1 in a full plan. A batch evidence stream may start at the
positive global index of its validated plan range, then remains contiguous; admission
binds its exact rows/first index to that intent range. A parent row creates only an absent ancestor needed by a later
content operation in the same complete unit. Before intent publication, create an
empty native directory in the owned staging namespace, capture its directory N,
and freeze its source path/N in the plan. This is metadata preparation, not a live
mkdir. Execute parent rows before dependent content by guarded same-filesystem
rename. Inline N is bounded native evidence; it avoids a per-directory reference or
misrepresenting an unowned structural ancestor as meaningful managed content.

Admission proves the source empty, its identity unchanged, the destination absent,
and the existing ancestor chain guarded. Each parent is created once; later units
reuse its frozen binding through ordered plan/evidence traversal. Parent rows count
in batch work, but structural ancestry is exempt from the content-operation overlap
ban. They cannot alone satisfy a nonempty ordinary unit. Recovery after the rename
must prove the parent identity and exactly the descendants attributable to this
batch or the committed plan prefix. It must not demand that the now populated
parent stay empty, adopt an unrelated same-name directory, or hide unexpected
children. There is no unrecorded live mkdir exception.

Local install-only `empty-directory`/scope `subtree` is a presence unit for a
standalone meaningful empty aggregate directory outside recognized Gradle units.
Empty Maven repository directories may use this presence-only unit without implying
a complete direct-file coordinate upsert; they do not replace coordinate contents. Its
verified desired source must be empty. It permits at most one content operation,
at exactly the root with directory kind: insert when absent, or replacement of an
exact owned file preimage. An existing directory is an overlay-preserving no-op
(zero content rows allowed), retaining all its children. It never authorizes deleting
a nonempty directory to force emptiness, widening a workspace, or using V4b's
whole-directory move group. Snapshot directory outcomes stay in snapshot units.

Content operation is `insert`, `replace` or `delete`:

- Insert requires desired sourcePath/sourceEvidenceRef, an expected absent destination,
  and null destinationEvidenceRef/backupPath.
- Replace requires desired sourcePath/sourceEvidenceRef, an exact expected old
  destinationEvidenceRef and a fixed owned backupPath.
- Delete requires null sourcePath/sourceEvidenceRef, exact old destinationEvidenceRef
  and a fixed owned backupPath. It means authoritative planned absence, not an
  unspecified optional source.

For snapshot file operations, logicalPath must be owned by that partition. A
nonempty structural directory root need not itself match a file-only include glob:
directory operations instead require admission to prove the full physical source
and/or preimage subtree contains only that partition's meaningful members and no
protected/mixed/unknown descendants. Directory kind alone is insufficient. Retain
ordinary empty-leaf ownership rules and forbid managed-root operations.

Snapshot installation uses one complete `["install-unit-open","snapshot",partitionId,
"partition"]` through corresponding close. This local-only unit kind/scope is distinct
from worker workspace selection. Generate desired insert/replace **and stale managed
delete** operations by co-reading the complete snapshot and current owned projection.
An explicit empty snapshot still has this unit and deletes stale managed members.
Whole-subtree replacement is allowed only when fully owned; mixed/excluded roots
use guarded smaller operations preserving unrelated siblings. The whole snapshot
unit can occupy its own streamed batch regardless of total size. Build-ready/cutoff
is forbidden until this complete authoritative outcome, not merely its surviving
files, is installed. Ordinary aggregate units retain overlay behavior.

Source/backup paths are owned root-local native staging paths. Consumable install
staging must be distinct from every retained authoritative snapshot nativeRoot.
If a snapshot must serve both live install and later exact post/publication retry,
materialize an independent install copy under guarded evidence and rename that copy.
This intentional snapshot/live copy is ordinary accounted I/O, never an EXDEV fallback;
install cannot consume the only snapshot tree while its sealed source ref remains live.
destination is derived
from logicalPath under managed root. Source evidence is verified desired member/type/
portable content evidence and guarded native identity; destination evidence is the
exact old owned projection, not merely a filename. `native-evidence` records define
their shapes. Baseline install uses trusted-base hashes; worker install uses verified
body hashes. Unknown native changes invalidate the proof. Move a subtree whole only
when fully owned; granular operations otherwise preserve unmanaged/excluded siblings.
Operations have no ancestor/descendant overlap; all operations for one indivisible
unit occur in the same batch before any successful prepare/build is advertised.

```text
["install-progress",1,invocationId,planRef,completedCursor,activeMarker]
["install-intent",1,invocationId,planRef,startCursor,endCursor,evidenceRef]
```

Purpose `install-evidence` repeats the active range's install-unit/install-parent/install rows, bound
to their complete source/destination refs. Publish immutable evidence then fixed
`install-intent.json` before the first rename. For replacement, rename expected old
target into its exact backup first; then rename desired staged source into target.
For insert, only the latter move is required. For delete, move the exact expected
old target into backup and leave its destination absent. No cross-device copy fallback.

Replay checks source/target/backup against expected native/content evidence. Desired
source present + expected target means not yet moved; source present + old backup +
absent target means finish new move; source absent + verified desired target means
new move finished. For insert, source present + absent target is pending. Both desired
source and desired target present, a missing desired source/target, unexpected old
preimage, backup alias or unknown descendants block instead of overwrite/cleanup.
For delete, expected old target + absent backup is pending; absent target + expected
backup is the completed rename pending cursor/cleanup. Both absent before a committed
cursor is missing preimage evidence and blocks; both present conflicts. After the
cursor commits, an absent target and absent backup may mean finished cleanup; a
recreated target still blocks. Never reinterpret a delete as a missing insert.
After a native ambiguity/reload, hash desired data as needed to re-establish its
binding; trusted-base policy does not allow adopting an unrelated native object. The
current restart engine rehashes installed roots in the committed plan prefix as well
as active ambiguous roots: exact observed post-rename root identities are process-local,
so prefix recovery re-establishes those bindings. Include these restart-only bytes
in I/O accounting. Normal uninterrupted prepare still reuses verified incoming hashes.
Even when an intent was already retired, a noninitial install progress cursor retains
its frozen prefix projection until prepare clears that progress; validate created and
existing parents and reject unknown children before discarding it. For active moves
observed complete on reload, sync their source and destination containing directories
before advancing the cursor: endpoint completion alone does not prove that the lost
process completed its namespace barrier.

Group consecutive complete ordinary units into batches by the same candidate
16,384 operation/8 MiB evidence thresholds as GC, not one durable cycle per one-file
unit. Close only at a complete unit boundary; a larger workspace/snapshot may occupy
one streamed batch. Count actual evidence/intent/progress/pointer/fsync work explicitly.

After the batch is reconciled, persist a new progress Q **and its root-state pointer**
with completedCursor, then retire old backups under
owned projection guards, clear marker and retire evidence. Backup cleanup may itself be interrupted. With
that committed cursor and still-live intent, co-read the frozen old backup projection
against remaining backup members: absent planned members are already retired;
identity-matching survivors may be deleted. Reconcile only attributed parent timestamp
changes structurally; reject replacements/recreated targets or unknown children.
Do not require an already partially retired backup to equal its original complete
tree. Keep marker/evidence until this cleanup finishes, without per-file checkpoints.
A crash after cursor commit still requires marker/backup cleanup; cursor alone cannot discard ownership.
Only one install batch is active. No per-file fsync cycle is required; evidence and
cursor commits occur per complete-unit batch. On fresh prepare, resolve any active
batch first or block. It need not complete all future old-plan batches, but cannot
claim the abandoned invocation was build-ready. Already installed complete units
are ordinary live cache state for the new prepare's own guarded restore/preflight;
there is no promise to restore a byte-identical pre-prepare cache after abandonment.

## Owned metadata retirement

One lifecycle owner exclusively controls the dedicated managed root. Old consumers
and retained readers must be closed before completion or metadata retirement; these
guards are not a cross-process lock. Native cache directories remain outside this
private garbage lifecycle.

Unpublished planning spools and admission/mutation lookup directories are disposable
process state. Close their handles and retire their exact owned containers without
following links; they never become restart authority. Parent lookup ledgers can retire
after plan sealing, while the separately staged parent objects remain available to
pending install rows. Superseded progress Qs retire only after the replacement pointer
is durable. Batch evidence retires only after its fixed intent is cleared. After clean
finish/abandon and reader closure, retire the consumed plan/current/preimage Qs.
Borrowed upstream source evidence is not consumed by this metadata cleanup.

Unused consumable sources, retained authoritative snapshots, unreferenced failed-attempt
Qs and crash-orphan lookups remain owned by their invocation. They can be required
through post/publication retry. Their final retirement occurs when a completed invocation
is superseded, rather than through a transitive reference collector or a global file map.
All live local Q/P references and retained native source roots are restricted to their
own invocation. The reserved `retired/` subtree is forbidden to those references.

The fixed record `.mammoth/v1/<current>/retirements/<old>.json` is:

```text
["retirement",1,currentInvocationId,oldInvocationId,oldNamespaceN,oldStateSha,managedRootN]
```

IDs must differ; both N values describe same-device directories. Paths are derived:
source `.mammoth/v1/<old>`, target `.mammoth/v1/<current>/retired/<old>`.
`oldStateSha` hashes the exact canonical completed old state bytes including LF.
This record authorizes retirement of a wholly detached private namespace; it grants
no install, source-return or live-cache mutation permission.

`OwnedStore.initialize` validates the old completed state and root binding, checks
that no destructive intent remains, and drains old retirement records. It writes
new bindings/state and the retirement record durably **before** publishing the new
locator. Only the matching current locator may replay the record. On interrupted
initialization, its owner calls `resumeRetirements` before continuing; installation
admission also drains those records. Completion drains pending retirements, preventing
`retired/A/retired/B/...` nesting across repeated interruptions.

Replay uses these cases:

| Source  | Target  | Required action                                                                                                                                                         |
| ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Present | Absent  | Require exact old namespace N (apart from own read atime), unchanged completed state digest, stable managed-root binding and no intents; rename into target.            |
| Absent  | Present | Require the bound directory identity/mode; permit attributed rename/deletion size/time changes and the documented Windows rename birth-time exception; resume disposal. |
| Present | Present | Block; do not choose or merge containers.                                                                                                                               |
| Absent  | Absent  | Re-establish containing-directory barriers and retire the record idempotently.                                                                                          |

Sync both rename parents before deleting target contents, including on restart after
an observed completed rename. The exact reserved target is action-owned disposable
storage: its whole contents can retire without retaining old state/bindings or
opening a per-file catalogue. Stream one directory entry at a time under the shared
working budget. Guard root/container identities, stay on the same device, reject
links/unsupported objects and preserve ambiguous paths. Keep the record through partial
deletion and the final target-parent barrier; remove it last. A replaced container or
unrecorded target blocks. Directory/state deletion followed by an abrupt exit remains
recoverable because the independent current-owner record survives.

For example, after `A` completes and `B` commits its locator, a crash before the rename
leaves B's record plus source A; B verifies and detaches A on retry. A crash halfway
through deleting `B/retired/A` instead leaves that target and the same record, so B
continues disposing it without requiring A's already deleted state file. B cannot
complete until this retirement finishes.

A crash **before locator publication** can leave an unpublished initialization
namespace/record. It cannot have new live mutations and matching-current replay
intentionally ignores it. This isolated engine does not claim to collect all such
bootstrap orphans; broader abandoned-bootstrap housekeeping remains an integration
responsibility. Published invocation retirement and ordinary attempt cleanup above
are implemented; native I/O or ownership failures remain explicit, never copy fallback.

## Recovery location matrix and worked examples

For each relocation plan root, inspect both planned locations and frozen/effective
evidence, not presence alone:

| Original source                 | Owned payload    | Result                                                                                                                 |
| ------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Expected present                | Absent           | Unmoved or returned. Verify expected/effective identity, or reconstruct content proof if the transition was ambiguous. |
| Absent                          | Expected present | Verify full projection/hash as required, then rename back under marker.                                                |
| Present                         | Present          | Conflict: do not overwrite either, even if bytes appear equal. No copy-in-progress interpretation exists.              |
| Absent                          | Absent           | Lost expected source: block; never publish completion.                                                                 |
| Unexpected identity/type/member | Any              | Block, retain marker/evidence and diagnose; no recursive cleanup of unknown state.                                     |

### Crash across two outbound batches

Suppose a partition plan contains 30,000 ordinary roots. Batch 1 covers roots
1–16,384 and its output prefix/cursor is committed. Batch 2's active range covers
16,385–30,000; a crash occurs after 100 of these renames but before its output prefix
commit. Marker state still owns all 16,384 completed roots **and** the active range.
Recovery makes one ordered location/evidence pass over that prefix/range, discovers
the additional 100 moved roots, reconstructs ambiguous hashes and returns every moved
root. The remaining suffix stays live. It must not return only the last 100 or forget
batch 1 because its active range was retired. No generation receipt exists yet.

### Retry with interleaved partition paths

Partition A has moved roots `a,c`; B has `b`. A's current adjustment stream contains
its returned effective identities in `a,c` order; B's contains `b`. Final replay
co-reads both to yield `a,b,c`. A retry epoch 2 validates A against its epoch-1 effective
ctime and writes one replacement stream; it does not compare against original ctime
or append another complete retry history. If a crash follows catalog-pointer commit
but precedes marker removal, recover the exact committed candidate and retire the
old stream, preserving at most current plus candidate.

### Empty snapshot and worker snapshot capture

A base publisher's designated writer produces an empty single-writer snapshot while
the live partition still has stale managed files beside excluded siblings. The
install plan contains one snapshot unit with delete rows for those managed files,
not an empty overlay plan. Each old target is renamed to owned backup under intent;
only after the entire snapshot unit's cursor/root-pointer commit can backups retire
and prepare advertise its cutoff. Excluded siblings remain. Retain the authoritative
snapshot independently from consumable install staging.

A distributed worker that owns the same snapshot instead seals worker-sources against
its frozen observation and emits its full live snapshot directly to TAR. File hashes
are computed in that write, not by copying/hashing an intermediate native tree. The
completed archive is its upload retry authority. This worker branch cannot be used
as the base publisher's retained native source set.

### Interrupted workspace replacement

A complete transform workspace is one install unit. Old expected target has been
renamed to the owned backup; new expected source remains staged when the process
stops. No build-ready cutoff has been committed. Recovery verifies old backup and
new source against the intent, finishes the rename into the absent destination,
commits the completed unit boundary, then guardedly retires backup. An unrelated
process creating that destination blocks recovery; never merge it with the workspace.
A crash before cursor commit but after new move can verify the desired target and
finish the same batch without reinstalling an unrelated tree.

## Failure cases and validation obligations

| Failure                                                     | Required result                                                                                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Registration suppressed by Test/summary filtering           | Capture is incomplete; unknown relevant daemons prevent relocating save. Fix capture, do not sweep retained launcher trees or force-kill. |
| Stop returns but daemon remains/restarts                    | No quiescent claim or source move. A saved timestamp is not an exclusive lock.                                                            |
| Observation candidate incomplete before pointer commit      | Discard owned candidate and restart metadata-only preflight; no content/hash/GC work was authorized.                                      |
| Crash after GC intent, before cursor                        | Replay exact frozen batch; absent targets allowed, replacement/unknown children block.                                                    |
| Deleted target recreated after completed GC                 | Final replay rejects publication; do not prune the deleted unit from validation.                                                          |
| Outbound cursor advanced without durable output evidence    | Invalid marker transition; reconstruct hashes under still-live ownership or block, never trust stale prehash.                             |
| Same-size edit to moved descendant after prehash            | Reject stage comparison; root rename cannot bless descendant changes.                                                                     |
| Add/remove transient extra stage file during SDK archive    | Directory ctime barrier rejects; recover sources and reconcile backend bytes before any receipt.                                          |
| Upload fails or is ambiguous                                | Return sources first; receipt remains absent until exact valid confirmation.                                                              |
| EXDEV after several successful roots                        | Return all previously moved roots under full marker; no copying helper or alternate record variant.                                       |
| Return blocked by new live destination or nested mount      | Preserve sources/markers/evidence and block prepare. Never treat as harmless skipped save.                                                |
| Crash after adjustment pointer, before marker retirement    | Match exact candidate/epoch and finish idempotent cleanup; do not revert to original identities.                                          |
| Install destination/backup unexpected or desired bytes lost | Block; do not overwrite, silently accept partial unit, or recursively delete unknown contents.                                            |
| Crash after all sources return, before generation save      | Live sources remain intact; exact frozen receipts/keys may be retried after current-window/source revalidation.                           |
| Runner loss removes all root-local evidence                 | No exact across-runner replay guarantee. Start a fresh invocation from available backend generations and actual cache state.              |
| Legacy copy-fallback intent detected                        | Block explicitly; never reinterpret, execute or silently discard it under local-v1.                                                       |

Prove count/byte work across multiple units, not just success on one tiny fixture.
Include 64 ordinary all-new publication choices and prepare binding sets, verifying
that refs/streamed rows never become an oversized single checkpoint. Exercise
cursor/intent/evidence/pointer/retirement crash boundaries, large indivisible
units, unknown descendants, native identities, platform durability, daemon coverage
and EXDEV on Linux/macOS/Windows. Measure active names/records, stream buffers and
SDK children under representative hosted-runner memory load. These schemas do not
claim qualification has already happened or introduce total-byte/disk admission.
