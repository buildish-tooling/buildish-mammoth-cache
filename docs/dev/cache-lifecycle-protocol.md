---
title: Local Cache Lifecycle Protocol
weight: 17
description: Single-attempt local state, streams, native identity, handoff and receipt schemas for streaming caches.
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

This is the active incompatible, unreleased `local-v2` lifecycle. It composes the
[worker v2 wire](../cache-protocol/) with the
[metadata-only native base](../native-base-protocol/). One successful main handoff
may be admitted by a fresh post process. An interrupted main or active post is
refused; no old namespace, journal, cursor, source package or replay recipe resumes.
Same-operation native cleanup, safe partial backup retirement and independent
source return remain required. Existing release tags and platform qualification
are separate from this source change.

A dedicated root has no concurrent build/cache consumer while a mutating phase is
active. Native checks protect admitted paths, selected endpoints, ownership and
actual cleanup; repeating a full inventory cannot provide a filesystem lock.

### Native identity and evidence

```text
N = ["native",1,"file"|"directory",device,inode,size,mode,atimeNs,mtimeNs,ctimeNs,birthNs|null]
```

Decimal native fields preserve actual OS precision. Device/type/link acceptance
is part of the original producer/discovery. Full N supports activity and selected
mutation/body/cleanup guards. Summary equality uses its separate documented
normalization, never directory clocks/atime/ctime/inode as semantic change evidence.
Genuine in-process owners bind store/root/partition/index/budget/bounds and lifetime;
serialized offsets, hashes, booleans and writer receipts cannot manufacture them.

### Immutable references and append prefixes

```text
Q = ["ref",purpose,ownedPath,bytes,sha]
["local-stream",1,purpose,invocationId,modelId,familyId,null]
... ordered purpose rows ...
["local-end",dataRecords,eventSha]
```

The local-v2 family selects this canonical framing envelope (its framing version is
still 1). `eventSha` frames header and data in `local-<purpose>`; Q.sha binds exact
bytes including EOF. Strict whole-stream grammar, native continuity and raw-ref EOF
acceptance precede any admitted cleanup receipt. A receipt retains the ORIGINAL ref
object and actual N, not a parsed clone or caller flag. Fixed bounded control refs
are bindings, model, handoff, envelope and generation; opaque worker archives retain
their independent mandatory raw binding.

The only active stream purposes are model, handoff, activity, installations,
observations and install-plan. Prefix/restart/progress formats and old source,
producer, current, evidence, digest, publication and recovery package purposes are
not accepted by local-v2. Active scratch rows remain process-local real work, not
serialized restart authority.

### Durable replacement and cursors

Fixed state replacement is atomic and revision-checked. Scratch batch cursors are
operation-local whole-record/unit boundaries. They never authorize cold replay.
A first complete unit is always admitted into its batch, even when it alone exceeds
the target; header/context bytes cannot form an empty prefix batch.

## CI invocation anchor and cold reopening

```text
["streaming-lifecycle",2,absoluteRoot,rootN,context,nonce,[absoluteControlRoot,controlN]]
["streaming-lifecycle",3,absoluteRoot,rootN,context,nonce,[absoluteControlRoot,controlN],mountedRootN]
["current",1,invocationId,".mammoth/v1/"+invocationId+"/state.json"]
["bindings",2,invocationId,context,nonce,[absoluteRoot,rootN],modelRef,familyProjection,policy]
["local-state",2,invocationId,revision,status,bindingsRef,handoffRef|null,terminal|null]
status = prepare-pending | prepare-failed | build-ready | post-active | completed
terminal = ["outcome",kind,key|null,artifactId|null,artifactName|null]
```

`kind` is read-only, no-change, published, worker-uploaded,
skipped-not-quiescent, feature-unavailable or abandoned. Only completed has a
terminal. Build-ready/post-active/completed require handoff. Main persists no
intermediate source authority. Fresh post reconstructs the exact model and family,
checks root/context/nonce/bindings and exact handoff/generation, then claims
post-active BEFORE awaited capture. Only genuine `OpenedInvocation` can claim.
Pending/failed main and interrupted post reject reentry. Completed diagnostics
read bounded controls only and do not stat/read/admit retired activity or snapshots.

Gradle and Maven use a sibling `.mammoth.<id>` directory on all platforms. The
`id` is the SHA-256 of the canonical managed home path. Owned records retain
their logical `.mammoth/` paths. Prepare checks the sibling for unfinished
ownership and verifies that it shares the managed root's device using native
binding data. Post verifies the control identity separately. Persistent runners
use a fresh dedicated home for each invocation. Prepare and post use the same
action version and the current control layout.

## Invocation bindings and operational capture

```text
policy = ["policy",1,role,access,restoreCleanup,gcMode,gcAgeMs|null,cutoffMs|null,
          ordinaryPolicy,maxDirectoryEntries,ordinaryJobOrder]
["handoff",4,currentRef,defaultRef|null,captureTemp|null,retentionDays,
 cleanupEnabled,gcAgeMs|null,[exactGenerationKey,generationRef]|null,
 actualActivityRef,originalBuildCutoff,selectedWorkerCount,gradleSeedDescriptor|null]
["handoff",6,currentRef,defaultRef|null,captureTemp|null,retentionDays,
 cleanupEnabled,gcAgeMs|null,[exactGenerationKey,generationRef],
 actualActivityRef,originalBuildCutoff,selectedWorkerCount,null,overlayDescriptor]
["partition",partitionId,available|empty|cold|miss,provenance|null,snapshotDescriptor|null]
provenance = pinnedPartitionMetadata | ["restored-object",exactObjectRef]
```

`gradleSeedDescriptor` is data bound to the exact selected generation and the two
available source partitions. Only writable distributed Gradle workers with a selected wrapper,
`restore-cleanup-mode: none` and no selected snapshot ownership can activate it. The source roots
supply `caches/modules-2/files-2.1` and one or more `caches/modules-2/metadata-*` directories.
Unsupported, excluded, incomplete or missing cohorts use ordinary restore before detaching any source.

```text
["gradle-layer",1,ownedSeedRoot,rootNative,exactGenerationKey,
 artifactPartitionId,metadataPartitionId,null]
```

The owned root is `.mammoth/v1/<invocation>/seed/<uuid>`; Gradle receives its
`caches` child as the native `GRADLE_RO_DEP_CACHE` path. The reserved `.mammoth`
namespace is opaque to every ordinary capture/purge pattern. Original indexed
source receipts receive exactly one destination before the normal install plan
freezes. Guarded whole-root moves preserve source provenance and do not read
artifact bodies or rebuild their indexes. A failed private route retires only its
owned seed; the normal live install does not consume its routed receipts again.

The final descriptor slot is reserved. Earlier handoffs stored the wrapper version there.
Layered workers install operational registration before advertising any path. Gradle selects
metadata from the staged formats. Fresh worker post validates the owner, settles registered Gradle
consumers, then captures the writable head and retires the seed before completion.
A failure that cannot establish absence retains and reports the owned seed. Output-only
mode uses the same owner, registration, quiescence and retirement. Prepare emits
the path and optional environment only after successful handoff, hooks and
reporting. Once either host write is attempted, a failed prepare retains the seed
and operational hooks for subsequent always()/continue-on-error consumers. Its
owning failed-prepare post validates the frozen handoff, settles consumers, then
retires the seed and hooks without capture or publication. An invocation-bound terminal
activation marker is written only after output, optional environment export and the
last synchronous lifetime assertion. A seed-bearing handoff without that exact
marker takes the same cleanup-only post, even if interruption left only the
advertisement marker or neither host marker and no generic prepare-failed flag. Private failures before
advertisement can retire immediately.

The version 6 handoff is for eligible Linux distributed workers with an active overlay.
The build-tool-independent descriptor records the target relative to the managed
home, the mounted view, placeholder and backing directory identities, and the mount
ID and namespace. Gradle uses an empty target to mount the managed home. Its version 3 invocation
anchor carries the visible root identity alongside the original root and external
control identities. Post verifies the original home in lower separately from the
mounted view.

Post verifies the live mount, settles Gradle and removes its hook before capture.
The upper layer selects ordinary files and changed workspaces. Affected workspaces
and the complete owned metadata snapshot use the merged view. Whiteouts stay local
and affect the merged view of complete units. After capture, post unmounts,
restores the lower home, and retires the upper and work directories. A busy or
uncertain mount retains its backing state. The worker archive and aggregator
continue to use the existing payload and snapshot channels.

Maven overlays `repository/` and relies on caller exclusivity. It lists upper
directories to locate work and enumerates the merged direct files of a directory
selected by managed upper changes. This preserves inherited artifacts and origin
records without descending inherited version directories. Transient files and
removal-only directories do not produce contributions. A selected unit uses the
ordinary Maven replacement and conflict rules. Wrapper partitions remain outside
the mount.

Upper-layer workers declare incomplete usage in their worker identity. After
accepting all selected archives, aggregator prepare freezes timestamp GC as
disabled if any of those identities reports incomplete usage. Restore cleanup
and authoritative snapshot selection keep their existing policies.

The header is followed by exactly one ordered row per model partition. All bounded
controls are O(P), with P at most 64 and worker count at most 16. The exact generation
key, family, cold groups and original per-partition object refs bind pre-overlay pins.
Pin the summary before worker application and destination changes. A read-only
job or distributed worker can use an exact restored-object reference without a
summary for an ordinary aggregate Gradle partition. Main and post bind the
absence of a summary to the invocation policy and check the exact reference
against the selected generation. Only the actual imported used/upsert activity stream
crosses main/post per file. Successful main ends all native/index/install scratch
owners; no per-file current/evidence/catalogue/source-package pointer remains.

A snapshot descriptor is `["snapshot",ownedRoot,parentN,rootN,origin]` under the
current invocation's exact `snapshots/<UUID>/<partition>` container. Origin is
`["base",exactObjectRef|null]`, `["worker",producerId]`, `["local",invocationId]`
or `["empty",miss|cold|generation]`. These are data, never capability flags. Fresh
post validates exact root/parent and discovers this independent payload once under
its new owner. Output facts are actual final output N, not source inode rebasing.

## Build-tool lifecycle boundary

After guarded owner initialization, prepare resolves the bound tool lifecycle,
checks for active consumers, and inspects the enabled partition projection for
selected local files. Empty directories and unmanaged contents are allowed.
The read-only native admission walk stops at the first conflict and excludes
irrelevant subtrees. It retains only the active directory path and partition
candidates, and opens no payload bodies or scratch index. Admission precedes
install staging, provisioning, backend lookup and hooks. Rejections leave
`prepare-failed` state and preserve caller data. The existing installer still
validates destinations and applies its ownership and identity guards.

Current frozen tool identity selects capture, quiescence and known-hook cleanup. Gradle registration/stop/inspection is tool-owned; shared code
retains post admission, exclusive-window receipt and all cache mutations. Maven
uses the dedicated-root/completed-consumer lifetime. A tool returns installation
metadata. Gradle prepare uses the native inspector without installation records,
rejecting a detected daemon or uncertain evidence. The point-in-time check
applies to read-only restores too. Read-only post skips quiescence, GC and
publication. Cache-disabled prepare keeps its separate control-state checks.

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

Registrations live in the invocation's `registrations/` directory. They are atomic,
canonical UTF-8 records with terminal LF, and use the existing framed digest filename.
A registration failure cannot safely update the coordinator's mutable root state from
a Gradle process, and a filtered summary is not operational failure evidence. The one
sticky deny-only record `registrations.failed.json` is therefore:

```text
["gradle-capture-failed",1,invocationId]
```

The first failure finishes writing it without replacing existing evidence; later successful
registrations never clear it. Its presence, incomplete registration candidates or any
invalid inventory reject quiescence. If the hook cannot record failure, it fails that
initialization instead of reporting successful operational capture. This is one bounded
failure witness, not another policy, progress journal or installation catalogue.

Enumerate registrations incrementally without retaining/sorting a global installation
list. Seal the encountered validated tuples in purpose `installations` as
`["installation",registrationTuple]` records. It need not be cross-run sorted;
its frozen order/ref is retained for this attempt. Stop clients run one at a time with deadlines through those existing compatible installations, with
explicit Gradle user home and captured Java runtime. Do not inherit build JVM heaps/agents
into the stop client. An owned client is settled before cancellation returns; timeout
cleanup targets only that launched client pipeline, never enumerated daemon PIDs. A stop
acknowledgment may precede native daemon exit: allow at most a five-second bounded
settlement interval (also within the overall deadline), then fail closed if necessary.
Real process inspection occurs only at this window boundary, not per file/partition.
Keep wrapper/dists and needed runtimes
accessible until every stop client exits and native process verification succeeds.
The validated installation stream belongs only to the current window establishment
and is retired after stop clients and native exit verification finish. No persisted
quiescence tuple grants permission. Missing/failed capture, unknown relevant daemons,
inaccessible process details or timeout yields `skipped-not-quiescent` before cache
mutation. Root identity/mode and cheap lifetime assertions remain fixed phase costs.
Every fresh active post establishes its own window. Read-only does not stop daemons;
no launcher sweep, download or OS-kill fallback is authorized.

#### Native macOS process evidence

The macOS inspector reads `/bin/ps` with fixed full-width numeric effective-UID,
PID, accounting-name and argument-display columns, under a fixed locale. The
accounting name and displayed Java image must agree. Display text is not an exact
argument vector: check the complete Java record for the Gradle bootstrap marker
before interpreting any apparent argument boundaries. Marker text in a property
or application argument can conservatively deny a window. A narrow ordinary direct
Java launch with no marker can be unrelated; unsupported syntax, indirect jar/module
or `@argfile` input, unavailable arguments and escaped/quoted ambiguity remain uncertain.
No argument file or environment is read to resolve uncertainty.

Consume records incrementally with a 64 KiB per-record bound, strict UTF-8, complete
line/EOF framing and a successful child exit. Require the current observer PID and
effective UID in the table; empty or wrongly selected output is not absence evidence.
Keep no process catalogue or raw argument diagnostics. Cancellation, malformed output
or the inspection deadline terminates only the owned inspector child, awaits settlement
and denies the window. Never signal a discovered process PID.

This evidence assumes standard captured Java launchers and Gradle bootstrap processes,
not adversarial same-user processes concealing their arguments. It does not prevent a
new concurrent consumer after inspection; the dedicated-root/completed-consumer lifetime
still applies. Platform implementation and small native proofs do not establish large-cache
throughput, memory/paging guarantees or qualification of every macOS release/architecture.

## Frozen observation and GC schemas

Post imports original activity before listing/purge/body work, then ONE native
capture writes its operation-owned original hierarchy/index. Observation rows are
ordered dir-open N, complete physical child facts, managed file
`["file",name,partition,N,activity,decision]`, complete-unit controls and dir-close.
There is no previous portable/hash field. Physical protected/scaffold facts remain
available to actual GC and native guards without becoming upload contributions.

Only the genuine original capture, completed gates and active `PostAttempt` can
create `GcSurvivorOwner`; reopening observation bytes cannot recreate authority.
Original activity drives unit decisions; purge preserves original activity clocks.
Semantic units, Maven marker-last deletion, protected siblings and required Gradle
workspace markers retain their established policy. Actual deletion remains direct,
selected-target and selected-parent checked, with no intent/progress/retry format.
A failure retains actual partial effects and grants no completion/survivor owner.

A publisher in the frozen `retain-dependencies` family marks every file in a
seed-eligible aggregate partition for retention at observation. This applies to
standalone and distributed-aggregator post, including zero worker activations and
new local or worker contributions. Eligibility alone in an ordinary family does
not suppress timestamp eviction. Worker post still applies ordinary GC to its
writable head. Purge rules, unrelated aggregate partitions and authoritative
single-writer snapshots keep their existing decisions. Retention needs no per-file
seed provenance index and adds no payload walk or body read.

### Shared GC parent projections

GC transfers the original hierarchy after all selected deletions and parent barriers
complete. Actual changed-parent N remains in the existing parent ledger; unrelated
retained trees are not listed or statted again to establish survivor ownership.
Publication uses a lazy selected view over that SAME index and ledger; it does not
spool full survivor facts or build another index. A loan prevents index disposal through SDK settlement and return,
including after foreground/window cancellation. Missing/foreign/replaced endpoints
remain errors. Original observation scratch retires when its last active consumer
ends, with no main/post persistence.

## Install batches and recovery

One shared metadata-native installer uses index-backed member selectors for base
and genuine verified-worker native facts. Incoming/current roles remain distinct.
Selectors bind genuine active context, original scratch/node offset, source root,
partition, path, kind and owner mask; decoded tuples do not grant authority.

Freeze captures/indexes current state ONCE in its mutation-free phase. Admission
borrows that exact one-use frozen-plan/scratch/current-index receipt. It does not
walk current again or replay a serialized inventory. Selected old roots, paths,
kinds, ownership, ancestors and no-overwrite checks remain at mutation. Cleanup
uses the original selected current subtree and actual parent invalidation, retaining
necessary partial-survivor/native joins and deletion-order work. Unknown survivors
and replaced endpoints remain visible. No old-body hash/preimage stream remains.
Ownership is installed before awaits; cancellation/early admission/freeze errors
close/revoke contexts and dispose known declared-empty roots. Primary and cleanup
errors aggregate, preserving unresolved locations.

## Final worker native producer capability

Complete every input archive, mandatory body (including losers), conflicts, late
seal and clean EOF. Publish final install parts, then accept their native metadata
ONCE into a shared index. Make required independent selected snapshot copies from
that original topology with actual final output N. Only then fold activity from
index child pages, validate inherited snapshots and transfer install authority.
Activity union has zero native directory listings. Its index reads and group-merge
metadata pass are distinct charged consumers, not uncounted traversal.

The worker-only transfer additionally requires genuine completed merge, exact
original published part identities and active stage lifetime. A generic native
producer/index, independent snapshot copy, caller flag or arbitrary writer receipt
cannot grant worker provenance. Closing/disposing attempts revoke authority before
awaits, even when cleanup fails. Worker v2 keeps strict content SHA, effective-header channel/archive seals and EOF validation.

## Frozen publication and native transfer plans

Compare selected summaries against ORIGINAL pre-overlay exact pins and origins.
True unchanged exits before group generation, root plans, layouts, output-only
copies or generation writing. A lineage-only record can reuse exact refs and
existing groups. Same-size/mtime/mode aggregate rewrites may be missed, including
verified controlled worker upserts; snapshot origin rules are stricter.

For new objects, choose maximal native roots from existing indices. Mixed owners,
protected contents or unselected descendants split roots. Root counts and bounded
split hints come from this existing callback, with no reporting traversal. Move
only selected roots, await actual SDK settlement and return independently before
saving the generation. No body rehash, full readback, upload salvage lookup or
retry/restage cycle is permitted. A return failure stays hard and reports retained
paths. No orphan namespace scan or background cleanup service is introduced.

### Object and worker receipts

Outgoing SDK availability/capability/confirmation errors warn and abandon before
evacuation; local source errors remain hard. Direct confirmed save permits
record-last publication only after source return. Raw worker upload is attempted
once from its immutable current package; an unconfirmed response retains that file
with an actionable warning, without discovery/download/retry. Successful worker
upload retires its exact original package and stores only terminal scalars.

## Owned metadata retirement

Successful main retains only actual activity plus bounded control and independent
snapshot payload descriptors. Main releases snapshot indices for fresh post; it
retires unused/failed current-operation copies under exact owned endpoint N.
Normal post closes readers, waits for SDK/returns, retires current snapshot UUID
containers and activity under ORIGINAL admitted N, then writes terminal status.
Completed reopen never dereferences stale data refs. SDK-unavailable normal outcomes
retire known current snapshots by exact endpoints without creating unused indices.
Skipped-not-quiescent deliberately retains payload/activity and reports their absolute
paths because no safe window exists. Hard/stranded local failures retain payload.
Unknown/replaced containers remain; no generic recursive namespace cleanup occurs.

## Pre-freeze purge configuration

Resolved `purgeableGlobs` is part of the existing frozen model partition record.
Presets provide defaults; the public `cache-partitions` field inherits on omission,
disables on `[]`, and replaces on an explicit list. Custom partitions may specify
rules (omission means none); disabled partitions have none. Ordinary excludes remain
preserve-only, and purge rules also exclude uploaded content. Retain ordinary
exclusion provenance for original-ownership checks. A matching active nonclaiming
payload owner or ambiguous ownership rejects before unlink; shared claims delete
once, credited in resolved partition order. No purge-policy Q/version/journal exists.

Only an explicitly supplied current exclusive/no-consumer window may enable purge,
in writable base capture before observation commitment and without unresolved intents.
Persisted quiescence is not live permission. The active post owner establishes this window; per-candidate
checks are synchronous cheap lifetime/root/invocation assertions, not process queries.
This describes unreleased source, not existing release tags.

Purge uses the existing closed directory listing and only already traversed capture
domain. Ordinary excluded file entries can qualify. Hard-pruned descendants (including
configuration-cache/journal and reserved metadata) remain opaque: directed rules there
are rejected/unsupported and broad rules disclose that domain limit. Derived upload
exclusions never become hard discovery-prune rules. Nonmatching entries and untouched
directories incur zero added native operations. Actual candidates alone get fresh
file/nlink/device/parent checks and successful unlink plus required parent refresh.
No payload reads, survivor rescan, relisting, ancestor rewalk or process inspection.

Freeze native N and complete surviving child evidence only after authorized removals,
while retaining original activity mtime/ctime separately for the same-process unit/GC
decision. Do not change build cutoff or restore timestamps. Interrupted prepare/post cannot resume. Successful removals remain actual effects;
a failed capture grants no survivor/publication authority and preserves local errors.

Diagnostic summaries are operation-local and have no authority or persisted schema.
Capture supplies admitted/skipped status and actual removals (shared claims credited
once); the planner supplies emitted physical root counts and coarse split hints from
its existing ownership/protected state. Incomplete planning is not an upload result.
Effective configuration is the same in-memory frozen model. Retained hint examples
are limited to eight paths and 4 KiB of UTF-8 paths per partition, charged to the
working budget, with explicit truncation; opaque-scope samples have the same single
shared bound. No diagnostic reads files, relists directories or adds inventories.
The orchestration caller owns and disposes the collector, including on failure.

## Provider composition and activation boundary

Unreleased Gradle/Maven delegates select this one active coherent family. Successful
main→build→fresh post is the only process handoff. No old base/tree/digest/recovery
compatibility branch, user switch, old journal adoption or source-package replay is
present. Disabled mode makes no new owner and conservatively refuses detected
unfinished ownership; read-only validates current controls without payload capture.
Action/provider errors stay distinct from outgoing optional cache outcomes.

Focused process, integrity, lifetime, cleanup and complete-operation count tests
are required. Counts include original native work, metadata codecs, indices/scratch,
SDK controls/archives, required worker body/archive hashes, copies and actual cleanup.
Zero native-base body hashing does not mean zero SHA work. These small fixtures do
not establish large-cache scale, RSS, throughput or platform qualification.
