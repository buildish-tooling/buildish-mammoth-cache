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

**Draft version 1; native-base/generation acquisition and publication are
implemented within the streaming lifecycle selected by unreleased Action source delegates.** This is the native-base and
generation part of the [streaming cache protocol](../cache-protocol/). The internal
implementation includes native payload membership validation, recovery-group
admission and rename-only evacuation/return around SDK storage. Existing release tags retain their published lifecycle; incompatible release
exposure remains pending. The parent protocol's integrated review, full-pipeline
resource/platform qualification, release cleanup and final cutover review gates
still apply. This specification defines serialized fields, not released behavior.
Serializer, validator, key derivation and restore/publication code comments must
cite this file and its relevant heading. Schema changes require an explicit
compatibility decision and corresponding documentation.

Use the parent specification's canonical UTF-8 JSON tuple encoding `J`, `uint`,
`positive`, `sha`, partition IDs, paths, portable file modes/timestamps and framed
hash accumulator `A(domain)`. Define `H(domain,tuple)` as an accumulator containing
one `Frame(tuple)`. A JSON document is exactly `J(tuple)` plus one LF. A stream is
one such tuple per line; hashes of exact file bytes include every LF. Each serialized tuple
or standalone document is at most 64 KiB before decoding; hash projections over
bounded configuration sets may be encoded incrementally rather than serialized as
one local record. An NDJSON stream has no
total-byte or total-record admission limit. Arrays below range over bounded model
partitions or producers, never cache files. Reject unknown tags/versions/fields,
noncanonical encoding and arithmetic overflow.

`context` has the exact shape defined by the worker identity. `nonce` is 32 lowercase
hex digits from a fresh invocation's random 128-bit value, generated once and then
persisted. Post retries retain it. Absolute native paths never enter wire metadata.

## Model, family and key identities

The ordered resolved model tuple is:

```text
["model",1,buildTool,hardExcludes,partitions]
partition = [id,includes,ordinaryExcludes,publication,writer,conflict,purgeableGlobs?]
```

`buildTool` is `gradle` or `maven`; glob lists are ordered unique nonempty strings,
except excludes may be empty. Include lists are nonempty. `publication` is
`aggregate` or `single-writer`; writer is a job name or `null`, and is permitted
only for single-writer. Conflict is `default`, `choose-worker-entry` or
`choose-worker-directory`, restricted to supported build-tool unit kinds.
Ordinary excludes include resolved hard excludes. `purgeableGlobs` is an optional,
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
                    "worker-tar-v1","native-tree-v1","generation-v1","local-v1",
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

A frozen publication decision supplies:

```text
["decision",1,invocationId,modelId,familyId,policyId,observationSha,
 baselineGenerationKey,producerSetSha,snapshotSourcesSha]
```

`baselineGenerationKey` is the exact pinned baseline key or `null`. `policyId`,
observation and source-set digests are defined by the local lifecycle specification.
`decisionSha = H("decision", decision)`. The decision is fixed before object keys
or envelopes are written; a retry cannot refreeze changed inputs under that key.
Capture prepared source N/hash evidence before identity derivation, so authoritative
single-writer sources can commit postSourcesRef first. Then render the keyed portable
tree/envelope from checked metadata spools and that same original evidence without
another capture body read. Aggregate prepared-source evidence is bound by the exclusive
prepared-source move-plan variant in the local lifecycle contract, not by broadening
single-writer source tuples. SDK native archiving still reads the payload separately.

```text
lineagePrefix = familyId + "-r-" + lineageId + "-g-"
objectKey = familyId + "-r-" + lineageId + "-w-" + writerId
            + "-p-" + partitionId + "-d-" + decisionSha
recordKey = lineagePrefix + writerId + "-d-" + partitionDecisionSha
```

Use full hex digests, not truncated display digests. The maximum partition ID and
these fixed components fit the existing 512-character backend key bound. A backend
key/path representability failure is an error, not a reason to truncate identity.
Current-ref lookup uses its lineage prefix; configured default-ref fallback uses
its independently derived lineage. Choose once and pin the exact matched record
and exact object references before any restore cleanup or application. Do not do
fresh latest-generation discovery halfway through a retry.

Object identity is the tuple:

```text
[familyId,modelId,partitionId,lineageId,writerId,decisionSha]
```

The `objectKey` must recompute from it. Reused objects retain their original identity
and key, including writer/lineage; never relabel their bytes as newly produced.
A publisher may reuse exact refs from its pinned baseline even when their origin
lineage differs; it verifies byte-for-byte provenance against that frozen local
baseline. A restorer treats the refs in its **selected validated generation** as the
authorized pinned set. It checks their own family/model/partition/key/envelope and
allows their recorded original writer/lineage without fetching older generations.
Do not recursively retrieve a predecessor to prove reuse: it may have been evicted,
and history lookup would introduce unbounded restore work. This does not authorize
fresh arbitrary object discovery or relabeling refs.

## Native object layout and envelope

The SDK input root contains exactly:

```text
envelope.json
tree.ndjson
payload/
```

Call the cache SDK with those three literal relative paths. Its native TAR recursion
archives `payload/`; no descendant globs or per-file SDK list. No local lifecycle
state, worker controls or unexpected root member is accepted. Native extraction
lands under the managed root's `.mammoth/`, never directly into the live cache.

The envelope is:

```text
["envelope",1,"native-tree-v1",objectIdentity,"partition-projection",
 treeBytes,treeSha,counts,semanticSha]
```

`treeBytes` is the exact NDJSON byte length; `treeSha` is raw SHA-256 of those bytes.
`counts` is the parent's `[files,directories,units,used,bodyBytes]`, with `used = 0`.
`semanticSha` equals the checked tree end. The envelope's own raw byte hash is bound
by its generation object reference. Nothing in the envelope hashes itself or its
outer SDK archive. The object key is derived before the envelope, without an
envelope digest in that derivation.

A partition projection contains exactly its owned files and structural ancestors,
plus meaningful empty directories. It may contain part of a Maven direct-file unit,
but must label that projection; its local digest cannot claim a complete coordinate.
A Gradle complete workspace cannot be split across ownership partitions. Whole
single-writer objects are complete configured partition views, including deletions;
they contain no usage-only facts.

## Native tree grammar

The first line is `["tree",1,"native-tree-v1",objectIdentity,"partition-projection"]`.
It is followed by one root directory and its balanced hierarchical traversal:

| Tuple                                                                                   | Meaning                                                                          |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `["dir-open",path]`                                                                     | Open root `""` or the next sorted child directory.                               |
| `["file",name,size,mode,mtimeMs,contentSha]`                                            | One direct owned regular file under the current directory.                       |
| `["unit-open",kind,root,scope,"partition-projection",counts,semanticSha,comparisonSha]` | Summary-first projected unit metadata; known before this stream body is emitted. |
| `["unit-close",kind,root,counts,semanticSha,comparisonSha]`                             | Check the corresponding independently accumulated unit facts.                    |
| `["dir-close",path]`                                                                    | Close the current directory after files then child subtrees.                     |
| `["end",counts,semanticSha,eventSha]`                                                   | Final tree seal, only after root/unit closure.                                   |

Paths/names, workspace kinds, scopes, ordering, required structure and boundaries are
as specified for workers. Ordinary files remain implicit units. A Maven direct unit
closes before child directories; a workspace closes before its root's dir-close.
Counts use the worker rules, including subtree unit root initialization and explicit
unit counts. Unit-open summaries may require a disk-backed metadata spool to place
computed values before the body; no unit member array or extra payload read.

Derive full file paths from the stack; partition ownership must equal object identity.
No payload path or offset field can override `payload/<logical-path>`. No used records,
unknown records, duplicate siblings, trailing records or unbalanced units are allowed.
An empty root is structurally legal; publication uses an explicit empty decision
instead of saving an object when it contains no files or meaningful directories.

### Tree and unit digest projections

`base-tree-events` appends every preceding tree tuple, including the opening tree
and checked unit-open/unit-close records, but excludes `end`. Exact raw tree hashing
is separate and includes `end` and all newlines.

`base-tree-semantic` appends directory facts `["directory",path,"open"|"close"]`,
verified portable file facts `["file",path,partitionId,size,mode,mtimeMs,contentSha]`,
normalized `["unit",kind,root,scope,"partition-projection",partitionId]` at unit-open,
and `["unit-end",kind,root]` at unit-close, in actual traversal order. It excludes
transport positions, native identities, writer/lineage and summary assertions.

A projected unit uses `A("base-unit-semantic")`, initialized with that same normalized
unit tuple. For subtree units, append its already-open root directory fact, member
facts and root-close fact; for direct Maven units append file facts only. Finish
with its unit-end fact, excluding unit-close. Directory facts and file facts are
interleaved in traversal order. `A("base-unit-compare")` follows the parent's
unit-comparison projection, prefixed instead by
`["unit",kind,"partition-projection",partitionId]`. No input-local channel ID enters
these projections. Summary headers and closes must agree with recomputed results.

`end.semanticSha` is `base-tree-semantic`; `end.eventSha` is `base-tree-events`.
Counts cover actual tree members, not the sum of overlapping unit counts.
Recompute these metadata projections on restore, even though base body hashes are
trusted rather than read again. A metadata hash is not proof of native membership.

### Payload validation and installation

Validate envelope/ref/context, then read bounded tree records and traverse native
staging in the same order. Require exact logical membership, types, file lengths,
portable modes/times for regular files and meaningful empty directories; reject extra native members,
links and unknown descendants. Native file mode may be repaired to its declared
canonical form under guarded evidence; compare its normalized portable form first.
Do not claim raw mode 0600 and wire mode 0644 are an unexplained content difference.
Directory tree records bind structure, not source directory mode/mtime; native stage
mutation evidence is separate from portable directory facts. Restore-only mode repair
uses the checked native parent and file identity, changes only the supported permission
representation and attributable ctime, then seals the resulting full native facts.
Windows exposes writable/read-only attributes rather than Unix executable bits; apply
its supported native permissions without claiming Unix mode equivalence. Portable
launcher normalization remains part of the tree contract.

A save stage evacuated from live aggregate sources preserves their original raw
native permissions. Compare their normalized portable modes with the tree and retain
full native source/transition evidence; do not chmod live files while they are away
from their original paths. For example, raw 0600 may archive with portable 0644 and
return as the original 0600 object. This save-only validation does not authorize
repairing or rebasing source evidence. Downloaded objects still use the guarded
restore normalization above. This is distinct from the prepared source below.

An already sealed prepared snapshot/source is not a restore repair target. Its producer
must establish canonical supported permissions before source-set commit; later native
changes invalidate that proof. Capture retains the original full native identities
that bound its computed/reused hashes through metadata publication and final sealing.
Fresh stats after hashing cannot rebase changed ctime into authority for an old hash.
Publishing evidence Q is a metadata-only handoff and does not itself require a
second payload traversal. Original native facts remain binding at the consuming
boundary. An own guarded payload-root rename may transfer a genuine admitted base
projection into incoming staging by changing only the root's attributable native
identity; descendants retain their original facts. The installer still checks each
selected file/subtree before its live mutation. Cold or untrusted inputs cannot
obtain this authority from serialized fields. SDK exposure and final source guards
remain mandatory; these native checks do not imply body rehashes.
Base restore does not rehash file bytes, preserving the trusted-base policy. Worker
content verification remains mandatory and is unaffected by this distinction.

Use operation-local guarded evidence; validate all available objects/groups before
first live installation. Whole-workspace and authoritative snapshot replacement
obligations still apply. The [local lifecycle specification](../cache-lifecycle-protocol/) defines install
batches and recovery. Await completed extraction and close payload writers before
granting incoming install receipts under checked native evidence. The
[filesystem and recovery requirements](../portability/filesystem/) specify process
restart rather than host-crash persistence; no extracted-payload storage-flush sweep
is performed. Independent selected snapshot copies finish writes and retain their
own full native evidence. Ordinary
aggregate staging has no payload-copy fallback.
Do not create a new global extracted-file inventory or rerun the full scan per unit.

## Generation record

A canonical standalone `record.json` contains:

```text
["generation",1,"generation-v1",familyId,modelId,lineageId,writerId,
 decisionSha,entries,recoveryGroups,partitionDecisionSha,recordKey]
entry = ["empty",partitionId]
      | ["object",partitionId,objectRef]
objectRef = ["object-ref",objectIdentity,objectKey,envelopeBytes,envelopeSha]
```

`envelopeBytes`/`envelopeSha` bind exact envelope bytes including LF. `entries` has
exactly one entry per configured partition in model order. An empty entry is an
intentional empty partition outcome, not an unavailable object. A nonempty object
may be newly produced or reused from the pinned baseline. A reused ref is byte-for-
byte unchanged. Validate each recomputed object key, partition/family/model binding,
exact envelope bytes, and tree hash/counts before use. Object refs never contain
ordinary file paths or workspace root lists.

```text
partitionDecisionSha = H("partition-decisions",
 ["partition-decisions",1,familyId,modelId,lineageId,writerId,decisionSha,
  entries,recoveryGroups])
```

The `recordKey` formula above excludes the record's own key and bytes. New object
keys depend on `decisionSha`, not on the generation record digest, so the dependency
is acyclic: frozen inputs → decision → object keys → envelope digests → partition
choices/groups → record key → record bytes. A reused object's identity can precede
this invocation. No identical-content cross-run deduplication is implied.

### Recovery groups

`recoveryGroups` is an array of nonempty arrays of partition IDs. Every configured
partition occurs exactly once, including empties. Members and groups are ordered
by the first model index they contain. Derive groups by unioning partition owners
of direct Maven managed files in the **same logical directory**, transitively;
other partitions are singletons. Use a union-find over at most P partition IDs,
not nodes for every coordinate or a global path map. Cross-partition unit summaries
are projections, not evidence that an incomplete unit is complete.

Co-read partition trees by directory before routing restore output. A group with
any unavailable object remains cold as a group; no member is partly installed as
its successful hit. Missing does not mean malformed: validate every available
transport/envelope/tree even when another member is missing. Availability is what the
backend reports, not proof of service-side nonexistence. In particular, the current
cache SDK can warn and return `undefined` for both a miss and some transport/extraction
failures. An empty destination with that result is unavailable/cold; any partial
extraction or exposed error rejects. It is never an explicit empty partition or a
successful validation. Publication readback with the same unavailable result remains
unconfirmed, not evidence that the immutable key is absent or a prior save failed. With partial availability,
observed connections must not split declared groups; fully available groups must
match derived connectivity exactly, with no invented joins. Group reconstruction
preflight finishes before any live install. No later read may silently switch refs.

### Record-last publication

Persist the immutable local publication plan, exact keys and candidate metadata
before upload. Reuse unchanged refs; record explicit empties without an object upload.
For each new partition, evacuate → validate stage → archive → validate stage again →
return all planned sources → commit effective identity adjustments → confirm object
receipt. A failed return blocks prepare/publication. Uploaded bytes alone are not
a receipt. Complete all partitions and final source barrier before saving `record.json`.

An isolated zero-transfer source is already physically at its final owned archive
root's `payload/`, with `envelope.json` and `tree.ndjson` siblings. Owning another
native root does not supply that geometry. Renaming a retained snapshot into it
is a transfer requiring return/adjustment evidence, not a zero-transfer shortcut.
There is no general save-side payload copy or alias fallback. A provisional SDK
confirmation carries no object receipt or generation publication authority. The
zero-transfer gate must check exact prepared identity/evidence and absence of
outstanding transfers; moving-source gates additionally require their real durable
return and adjustment proofs. A callback echo or serialized flag cannot supply them.

Use exact-key restore/readback to reconcile an ambiguous save. A valid expected
object can be reused; a wrong immutable object cannot be overwritten or silently
given a new key in the same frozen attempt. A save with a failed stage mutation
barrier needs exact readback including byte hashes before receipt acceptance. An
idempotent same-key retry is allowed only with the exact frozen bytes and completed
source recovery/readiness. Unavailable readback does not prove absence or save failure;
unknown backend outcome is never success. Confirm an ambiguous record by exact record-byte
comparison/readback, not latest-key discovery. Object receipts never authorize
record publication with pending relocation or unvalidated source changes.

## Worked native object example

Consider aggregate partition `data` containing only an empty `cache.bin`. Let `I`
be its complete expected object identity and `E` be SHA-256 of the empty byte string:
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
The following is an expansion recipe, not literal JSON containing symbolic hashes:

```text
C = [1,1,0,0,0]
T0 = ["tree",1,"native-tree-v1",I,"partition-projection"]
T1 = ["dir-open",""]
T2 = ["file","cache.bin",0,420,0,E]
T3 = ["dir-close",""]
S  = A("base-tree-semantic") over:
     ["directory","","open"]
     ["file","cache.bin","data",0,420,0,E]
     ["directory","","close"]
V  = A("base-tree-events") over T0,T1,T2,T3
T4 = ["end",C,S,V]
treeBytes = UTF8(J(T0)+LF+J(T1)+LF+J(T2)+LF+J(T3)+LF+J(T4)+LF)
envelope = ["envelope",1,"native-tree-v1",I,"partition-projection",
            byteLength(treeBytes),SHA256(treeBytes),C,S]
```

The native file has zero bytes and the object includes `payload/cache.bin`.
The root directory counts once; the implicit ordinary-file unit does not increment
explicit unit count. A generation with only this partition has
`entries = [["object","data",ref]]` and `recoveryGroups = [["data"]]`. Compute the
partition-decision digest from those fields, then the record key. If the partition
instead becomes empty, use `[["empty","data"]]`; do not retain the old ref merely
because no new payload bytes were produced.

For Maven `repository/org/example/lib/1`, suppose `a.jar` belongs to `artifacts`
and `_remote.repositories` to `origins`. Both projected objects contain balanced
ancestors and only their own file. Their projected unit hashes differ by definition.
The generation group is `["artifacts","origins"]` in model order. If `origins`
is missing, neither projection installs; an unrelated singleton partition can
still restore after all available inputs validate. Nested coordinate child files
form their own direct units, not members of the parent's direct unit.

## Failure cases

| Trigger                                                             | Required outcome                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Envelope key/identity mismatch or wrong family/model                | Reject the available object; never reinterpret its format or publish a hit.                             |
| Tree declares file absent from payload, extra payload file or link  | Reject preflight before any live install; no extraction inventory array workaround.                     |
| Zero-byte file with nonzero declared size or wrong tree byte digest | Reject metadata/structural integrity; do not silently correct the descriptor.                           |
| Base same-size byte corruption without metadata change              | Outside trusted-base byte detection; do not claim base restore rehashes bytes.                          |
| Cross-partition Maven unit treated as complete from one projection  | Reject that use; reconstruct ownership/groups from available trees.                                     |
| Missing group member but malformed available sibling                | Validate and reject the malformed sibling; absence is not permission to skip verification.              |
| Changed partition becomes empty                                     | Publish explicit empty entry after the normal source barrier; old object may remain unreferenced.       |
| Crash after object upload, before source return                     | Recover relocation first; no receipt or generation completion yet.                                      |
| Crash after source return/receipt, before record save               | Live source is intact; reuse only exact confirmed refs under the same frozen plan.                      |
| Ambiguous record save                                               | Exact-key readback must equal planned record bytes; never advertise partial partitions as a generation. |
| Immutable wrong object under frozen key                             | Invalidate the attempt; preserve/recover sources. Do not overwrite, relabel or pick a new key on retry. |

Keep an executable generation-size regression when implementation starts. A
synthetic record with 64 maximum-width partition IDs and full references encodes to
**65,383 bytes including LF**, only **153 bytes below 65,536**. Reproduce the exact
construction below; this is an encoding-size fixture, not a complete object-restore
fixture or evidence of actual parser qualification.

```text
h = 64 copies of "a"
F = "mammoth-s1-gradle-" + h
For n = 0..63:
  p = n as two decimal digits + 62 copies of "a"  # 64-byte valid partition ID
  I = [F,h,p,h,h,h]
  K = F + "-r-" + h + "-w-" + h + "-p-" + p + "-d-" + h
  entries[n] = ["object",p,["object-ref",I,K,65536,h]]
  groups[n] = [p]
RK = F + "-r-" + h + "-g-" + h + "-d-" + h
R = ["generation",1,"generation-v1",F,h,h,h,h,entries,groups,h,RK]
byteLength(UTF8(J(R) + LF)) = 65383
```

Hashes are fixed-width placeholders for sizing, not asserted computed identities.
Generation schema growth must revisit this margin instead of adding an accidental
partition-count restriction or silently violating the record bound. Qualification
must include all 64 partitions with maximum-width IDs and exact reference/key encodings
under the 64-KiB standalone record rule; do not qualify only
one short-name entry. Local publication choices use bounded-record streams rather
than copying this bounded generation structure together with extra local refs.
Exercise these schemas through actual SDK archives, cross-partition
Maven groups, disappearance-only changes and record-last failures. Exact field
definition is not evidence that native-platform or runner-memory tests have passed.

## Native timestamp materialization

Portable file mtimes are integer milliseconds. The actual copied/staged file MUST
normalize to that same millisecond using integer nanosecond division; its native
sub-millisecond fraction is not a portable assertion. Directly passing `mtimeMs/1000`
to native utimes can round below the boundary (for example1795305600001ms), producing
one millisecond less after normalization. Materializers choose an interior point of
the requested millisecond for fractional seconds, retaining exact whole seconds,
then verify the actual fstat nanoseconds before sealing evidence. Verification reuses
the existing post-write stat; it adds no traversal, file read or extra filesystem call.
Record the actual new native identity after repair. Original activity evidence stays
separate and unchanged.

This does not promise that every safe-integer wire timestamp is writable on every
filesystem: floating-point seconds lose precision at extreme dates, and filesystems
can clamp or coarsen timestamps. An unrepresentable requested bucket MUST reject
materialization before granting a staged/copy receipt. Multiplying floating-point
seconds back to milliseconds is not sufficient proof of the native result.
