---
title: Streaming Cache Protocol
weight: 15
description: Draft wire format and lifecycle contract for Mammoth's next incompatible cache format.
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

## Status and ownership

**Draft specification for an incompatible, unreleased format.** Streaming
prepare/build/post composition is implemented, including worker processing,
native-base/generation acquisition, GC, rename-only relocation/return, publication
and same-operation return, and Gradle invocation capture/shutdown with provider integration.
The unreleased Gradle/Maven Action source delegates now select this lifecycle.
Existing release tags retain their published implementation; incompatible release
exposure remains separate work.

Integrated review, complete-pipeline resource/platform qualification, release
cleanup and final cutover review remain release gates. Implementation does not
establish large-cache scale, throughput or RSS/paging qualification, or additional
platform support. This page does not describe the released worker format or
announce availability. The `v1` profile names below identify the proposed protocol,
independently of the Mammoth release number. Mixed old/new workers are unsupported;
old base caches start cold under a new cache family. All cooperating jobs must
upgrade together.

This file, `docs/dev/cache-protocol.md`, is the canonical developer reference for
the streaming wire and protocol contract. Keep it in the versioned site docs and
update it with any change to serialization, acceptance, ownership or recovery rules.
Implementation must follow the documented contract; do not leave a different format
specified only in source code, tests, investigation notes or a pull request.

Implementation comments at serializers, parsers, digest projections, merge
boundaries and publication/recovery transitions **must reference this file and the
relevant heading anchor**. For example:

```typescript
// Protocol: docs/dev/cache-protocol.md#file-metadata-pairing
// Accept the body only after its immediately following metadata verifies.
```

Use the repository-relative source path in code comments, not a moving development
site URL. Update these references when sections move. These references keep the internal implementation and its entrypoint activation tied
to the same contract.

This page and the linked [native-base/generation](../native-base-protocol/) and
[local lifecycle](../cache-lifecycle-protocol/) specifications define the reviewable
version-1 contract, including exact schemas, examples and failure cases. No format
is ready to ship until its parser, lifecycle and platform qualification passes. See also the [architecture overview](../../architecture/)
and [threat model](../../threat-model/).

## Profiles and common rules

| Profile              | Transport and source of truth                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `worker-tar-v2`      | One gzip-compressed TAR artifact; effective entry headers and bounded Mammoth controls are authoritative. No trailing per-file manifest. |
| `native-metadata-v2` | Cache SDK archive of the bounded identity descriptor `envelope.json` and literal native `payload/`; no per-file catalogue.               |
| Generation record    | A small immutable record referencing complete partition objects; published last. No per-file or workspace-root inventory.                |

A reader is supplied an independently validated model, expected cache-family
identity, producer selection and CI context. Model/family identifiers are opaque
nonempty strings, compared exactly with these inputs. Their derivation is defined by the [model/key contract](../native-base-protocol/#model-family-and-key-identities); an archive cannot redefine it. Model declaration order
fixes partition order. Partition IDs match `[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?`.
The model determines ownership, publication policy, unit classification and required
workspace markers. Unknown ownership or mixed aggregate/single-writer ownership of
one indivisible unit is invalid.

A valid digest establishes consistency, not permission to contribute. Validate the
expected repository, workflow/run, job, attempt, revision, build tool and family
before considering a contribution. A missing required completion artifact is an
error. An absent optional snapshot writer preserves the existing snapshot.

### Scalar encoding

Controls are UTF-8 JSON **tuples**, with exact arity and field types. Reject objects,
unknown tuple tags, extra fields, malformed UTF-8, byte-order marks and lone UTF-16
surrogates. Strings consist of Unicode scalar values. `null` is permitted only where
specified; boolean and floating-point values are not substitutes for integers.

Define canonical `J(value)` recursively: arrays use commas with no whitespace;
integers use ordinary base-10 digits with an optional minus sign, no exponent,
leading zeros or negative zero; strings use double quotes, escape quote/backslash
as `\"`/`\\`, encode U+0000 through U+001F as lowercase `\u00xx`, and emit other
scalars literally in UTF-8. There are no optional fields. A control body is exactly
`J(tuple)` followed by one LF, with no other bytes. Enforce canonical encoding while
parsing the bounded record. Digests below operate on tuples without that final LF.

`uint` means an integer from zero through `9007199254740991`; `positive` excludes
zero. Check additions and increments before overflow. These are representation
checks, not cache-size admission quotas. `sha` is 64 lowercase hexadecimal SHA-256
digits. `mtimeMs` is a `uint` of milliseconds since the Unix epoch. Source times must be
finite and nonnegative and are truncated to integer milliseconds; native stability
checks retain full native precision. Portable `mode` is an integer from 0 through 511, containing portable permission bits only.
Regular file modes must be canonical: `0644 | (sourceMode & 0111)`, except recognized
distribution launchers, which are always `0755`. A received regular mode must already
satisfy that normalization; do not silently accept a different value into a digest.
Recognition uses the expected build tool and these logical path patterns:

```text
gradle: ^wrapper/dists/[^/]+/[^/]+/gradle-[^/]+/bin/gradle$
maven:  ^wrapper/dists/[^/]+/[^/]+/(?:apache-maven-[^/]+/)?bin/(?:mvn|mvnDebug|mvnyjp)$
```

Directory and control modes follow the separate fixed TAR rules below. Local native
identities, atime and ctime are not transported as portable identity.

### Paths and order

Logical paths are slash-separated relative Unicode scalar components. Reject empty
components, `.`/`..`, NUL, backslash, absolute/drive/UNC paths and trailing slash.
The empty logical path is allowed only for a channel's root directory. Check full
path and target-platform representability before installation, including case,
normalization and reserved-name aliases. Do not normalize distinct input names into
one accepted destination.

Within a directory, emit direct regular files in unsigned UTF-8 component order,
then child directories in the same order, completing each subtree before its next
sibling. No locale comparison or whole-cache sort. Roots/ancestors are explicit;
reject duplicates and out-of-order siblings with bounded active directory state.
Controls do not participate in this payload name order.

## Worker transport

Create the archive with a maintained entry-stream TAR library. Mammoth supplies its
ordered entries; the library must not recursively discover the filesystem or choose
extraction destinations. Hash each guarded source body while writing those same
bytes into its TAR entry, check source identity and byte count, then write immediate
file metadata. Discard a candidate if source/tree stability fails. No prehash pass,
`payload.bin`, worker payload relocation or native shadow copy is required.

Use one gzip stream containing one TAR archive. The gzip header has no optional
fields (flags zero) and mtime zero; validate its fixed header before decompression.
This avoids unbounded filename/comment/extra-field buffering outside the TAR parser.
Check gzip CRC and size trailer under the [gzip format](https://www.rfc-editor.org/rfc/rfc1952.html)
modulo-size rules, plus actual
stream EOF; the 32-bit gzip size field is not a total payload admission limit.
Under the GitHub artifact adapter,
upload one finished immutable file with `skipArchive: true` and download with
`skipDecompress: true`. Raw upload naming uses the file's basename; discovery,
producer identity and receipts must use the same actual artifact name. Validate the
expected service digest and explicitly reject `digestMismatch`. Raw download names
may differ: accept exactly one owned regular file in isolated download staging,
then bind its native identity; do not trust a response-supplied basename as identity.

A transport download/digest pass is separate from archive parsing. Aggregation reads
and decompresses each downloaded archive **once**, forward only. A failed current
operation grants no replay/retry authority. Upload still reads the completed
compressed file.

### Worker artifact names and discovery

Use the actual immutable upload file basename:

```text
producerSha = H("worker-producer", ["producer",provider,repository,workflowName,runId,job,revision,buildTool])
decisionSha = H("worker-decision", ["decision",observationsRef.sha,workerSourcesRef.sha])
name = family + "-w" + producerSha + "-a" + decimal(runAttempt) + "-d" + decisionSha + ".tar.gz"
```

Here `H` is one framed canonical tuple under the stated digest domain. Context
fields have the same values as the worker identity; runAttempt is a positive safe
integer. Full digests keep the basename at most240 ASCII bytes, including the
maximum-width attempt. The family makes this incompatible with legacy discovery.
The decision digest identifies the frozen source selection; compressed wire SHA-256
is separately bound by Q/service receipts and never inferred from the basename.

For each configured producer, select the unique artifact at the greatest attempt
not exceeding the selected execution attempt. Listing order cannot change that
choice. A same-attempt ambiguity or malformed matching candidate rejects selection.
Optional absence applies only when no candidate exists; a producer with only future
candidates is not silently treated as absent. Validate all admitted artifacts,
including optional and snapshot-only producers. There is no total cache-byte or
legacy package/manifest-entry admission gate in this path.

Raw capability is explicit and defaults false. A supporting backend honors both
raw flags or throws; do not fall back to ZIP wrapping/extraction. Reported digests
accept bare64 hex or `sha256:` plus64 hex and normalize to lower-case SHA-256;
unknown algorithms or mismatches reject receipts. Raw download forwards the
qualified expected hash and verifies the actual compressed bytes/native identity
before exposing Q under the [filesystem recovery contract](../portability/filesystem/). This transport binding checksum pass
is separate from the one subsequent TAR/gzip parse; the SDK's computed actual hash
is not exposed by its download result.

Upload retries use exactly the frozen path/name/bytes. If upload outcome is
ambiguous, exact-name readback must match size and reported SHA-256; without a
reported digest, download/hash the raw bytes and compare with the frozen package.
Never refreeze live sources to recover an upload. The backend API has no cancellation
hook: an in-flight SDK call must settle before its local staging is retired, then
cancellation is observed. Local streams/readers remain cancellation-aware.

### TAR profile

**Selected strict physical framing.** The opt-in tar-stream profile and native-zlib
framing adapter implement the raw boundaries below. Effective-path/type/ownership
validation, immediate pairing, content hashes, complete-unit/activity checks and final
application acceptance remain mandatory above the transport layer. A different
acceptance subset requires rationale, review and updated conformance vectors.

Use USTAR headers with local PAX extensions where needed. This protocol deliberately
accepts a narrower format than a general-purpose TAR reader. The
[GNU TAR format description](https://www.gnu.org/software/tar/manual/html_node/Standard.html)
explains the underlying header, body padding and end blocks; Mammoth's stricter
application rules below still apply.

Accept effective regular-file type `0` and directory type `5` only. Reject links,
sparse files, devices, FIFOs, GNU long-name records and global PAX headers. Permit
one bounded local PAX header immediately before a payload header, with only unique
`path`, `size` and `mtime` keys. Reject unknown/repeated keys and extensions before
controls. PAX paths are UTF-8; decimal size is a `uint`. PAX mtime has at most three
fractional digits and must map exactly to `mtimeMs`. Header-only mtime is integer
seconds. Emit local PAX only where required to express the effective value. No
extension may rename an application control or change a pending metadata pairing.

Payload names are `payload/aggregate/<path>` or
`payload/snapshot/<partition>/<path>`. A directory header adds one terminal slash
to its archive name; strip exactly that slash to obtain its logical path. Channel
root directories therefore have archive names ending at their prefix slash. Reject
other spelling aliases. Do not emit separate `payload/` prefix-container entries.
Directory size is zero, mode is 493 (`0755`) and mtime is zero. Regular header mode
and mtime carry the source's portable values. UID/GID are zero; uname/gname/linkname
are empty. Controls use mode 384 (`0600`), mtime zero and no extensions.

Validate header checksums, effective sizes and zero body padding. Require two zero
end blocks after the final completion member; allow further complete zero blocks
only, then clean gzip EOF. Reject missing ends, extra application members, nonzero
trailing data, concatenated TARs and concatenated gzip streams. Parser/library APIs
must expose enough framing to enforce these rules; an entry callback alone is not
proof that oversized PAX or trailing data were checked before buffering.

### Parser enforcement interface and dependency gate

Unmodified `tar-stream` 3.2.0 callbacks cannot enforce this subset: extension bodies
are decoded before entry delivery, duplicate keys are overwritten, and padding/end
framing is normalized. Mammoth therefore pins the dependency and builds an isolated
copy with a small reproducible patch. Installed packages are not modified. Strict
extraction is opt-in per instance (`mammothStrict: true`); other consumers retain
upstream behavior. The patch/source hashes and types are maintained with the build.

The patch validates raw USTAR fields and checksum spelling before lossy normalization,
admits only one nonempty local PAX body of at most 64 KiB, and rejects unknown or
duplicate keys before decoding/storing their values. It checks effective portable
header facts, forbids control extensions/renaming and verifies zero padding and TAR
ends. Exact `mtimeMs` is exposed independently of the normalized `Date`. An extension
can already have bounded bytes in source/decoder queues when its declaration is
rejected; it must not be admitted to an oversized extension accumulator.

`src/cache/streaming/worker-transport.ts` coordinates Node's maintained raw inflater
and incremental CRC32 with the strict extractor. It validates the ten-byte fixed gzip
header before inflation, preserves unused input at the first DEFLATE boundary, checks
exactly one eight-byte CRC/ISIZE trailer and requires source EOF. Concatenated gzip
and trailing bytes are rejected, including an empty additional member. No second TAR
parser or new compression algorithm is used.

The internal transport API owns its input stream. Its byte source must have a bounded
high-water mark and emitted chunks, each at most 64 KiB; native inflation and intermediate
queues use 16-KiB chunk/high-water settings, with bounded chunk overshoot rather
than exact per-queue ceilings. These are resident-buffer contracts, not total archive-size
admission limits. Each consumer drains the entry body and honors cancellation for
its own side effects. Native output pressure propagates to compressed input; failures
abort both directions. The adapter retains only the current consumer, not a task or
abort reaction per visited file.

Transport completion proves physical framing only. Entry delivery is provisional;
the application reader must still validate this specification's model/context, grammar,
hashes, pairing, unit/channel/final seals and eligibility before live installation.
It must await successful application completion **and** TAR/native-inflater/trailer/
source completion. A final metadata member can be delivered before a bad CRC or
truncated trailer is discovered.

Raw conformance and combined flow/error tests cover the actual patched parser and
adapter, including Node24 action-runtime and Node26 development-runtime execution.
These tests do not qualify a complete worker merge, full fan-in memory envelope,
SDK behavior, native installation or lifecycle recovery. See the
[conformance vectors](../cache-protocol-vectors/) for literal application values and
raw PAX/control cases. Code and test changes at these boundaries must preserve this
contract; passing a permissive library finish event is not a replacement.

### Member grammar

The first effective member is `.mammoth-meta/identity.json`, containing:

```text
["identity",1,"worker-tar-v2","gzip",context,modelId,familyId,snapshotPartitions]
context = [provider,repository,workflow,runId,jobName,attempt,revision,buildTool]
```

Context fields are nonempty strings except `attempt`, which is `positive`;
`buildTool` is `gradle` or `maven`. IDs must match the expected context, not just
syntactic validation. `snapshotPartitions` is a bounded array of unique authorized
single-writer partition IDs in model order; it contains no member paths.

All intermediate controls have names `.mammoth-meta/<sequence>.json`, where sequence
starts at 1 and increases by exactly 1, using decimal digits without leading zeros.
Sequence counts controls, not payloads. There are no physical metadata-directory
members. The final member is `.mammoth-meta/complete.json`. Control member names are
validated from scalar sequence state; never retain a set of every control name.

Channel IDs are `0` for aggregate payload, `1` for aggregate usage, and `2 + i` for
the `i`th declared snapshot partition. Channels appear once in that order, with
explicit opens and closes even when empty. Channel IDs are **input-local bindings**,
not cross-worker merge keys. Align readers by the global model key: aggregate payload,
then usage, then snapshot partitions by their model declaration index/partition ID.
Two archives' `cid = 2` can refer to different snapshot partitions; never group them
by raw cid. An input omitting an earlier snapshot may advance to its later global key
without waiting for the omitted channel. Snapshot purpose has complete payload,
no usage events. The following table gives exact control tuples; `counts`, header
binding and digests are defined below.

| Tuple                                                           | Meaning                                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `["channel-open",cid,purpose,partition]`                        | `purpose` is `aggregate`, `usage` or `snapshot`; partition is `null` for the first two, otherwise the declared snapshot ID.                 |
| `["dir-open",cid,path]`                                         | Open a directory; payload channels require its directory TAR header immediately before this control. Usage has no TAR payload header.       |
| `["dir-close",cid,path]`                                        | Close the current directory after its files and subdirectories.                                                                             |
| `["unit-open",cid,kind,root,scope]`                             | Begin a path/model-recognized complete unit. Scope is `direct` for Maven direct files, otherwise `subtree`.                                 |
| `["file-meta",cid,ordinal,contentSha,partition]`                | Verify precisely the immediately preceding regular payload file. Ordinal is archive-wide, starts at 1 and increments once per payload file. |
| `["unit-close",cid,kind,root,counts,semanticSha,comparisonSha]` | Close an upsert unit, validating independently accumulated structure and hashes.                                                            |
| `["used",cid,name,partition]`                                   | One usage-only direct file name under the current usage directory; no body or hash.                                                         |
| `["used-unit-open",cid,kind,root,scope]`                        | Open a membership-only usage unit; cannot select a payload winner.                                                                          |
| `["used-unit-close",cid,kind,root,counts,membershipSha]`        | Close that usage unit; membership digest contains no content hashes.                                                                        |
| `["channel-close",cid,counts,eventSha]`                         | Close a balanced channel and check its accumulated counts/digest.                                                                           |

Here `cid` is a `uint`, `path`/`root` are full logical paths and `name` is one
component. Unit kinds are `maven-directory`, `artifact-transform`, `groovy`,
`kotlin-script`, `kotlin-accessor-jars`, `kotlin-accessor-directories`, and
`kotlin-plugin-spec-accessors`. Their roots and required structure must match the
validated model and build-tool classifier. A sender cannot invent a unit to bypass
conflict handling. Kind and required markers are revalidated at close.

A payload channel begins with its root directory header and `dir-open`; usage begins
with `dir-open` for the empty root without a header. Each child directory header is
immediately followed by its `dir-open`. Unit opens occur after the root's `dir-open`,
before its first managed file. A Maven unit closes after direct files and before
child directories. A workspace unit closes after its complete subtree, immediately
before that root's `dir-close`. Units do not overlap or nest within one channel;
ordinary files/build-cache entries are implicit single-file units without explicit
unit controls. Snapshot channels may contain those same recognized unit controls
for completeness validation; their channel itself is the complete partition.

### File metadata pairing

The `worker-tar-v2` profile rejects `worker-tar-v1` identities and the former
six-field file-meta tuple. There is no compatibility reader or nullable header hash.
Identity keeps structural numeric version 1; the explicit profile selects this grammar.
The worker profile also participates in family, cache-key and artifact-name identities.

For every regular payload member, the next effective member **must** be its numbered
`file-meta` control, including for empty files and losing contributions. No other
payload, directory/unit close or EOF may intervene. Approved preceding PAX is part
of the effective payload header, not a second application entry. Controls are not
payload files and do not recursively need metadata of their own.

The canonical effective header tuple is:

```text
["header",cid,path,type,size,mode,mtimeMs]
```

`type` is `file` or `directory`; `size` is the effective body length. Feed this
validated tuple to both channel and archive event accumulators; there is no
standalone header hash. Check `contentSha` against SHA-256 of
exactly the body bytes, excluding TAR padding. Derive partition ownership and unit
scope from the expected model/path before selection; metadata must agree and cannot
redirect a staged body or introduce a late policy choice.

A reader validates the effective header, streams/hashes provisionally, then checks
its next metadata against observed header/body/ordinal/channel/ownership before
advancing. Keep only current scalar file facts, its body hash and bounded parser buffers.
A missing, duplicate, reordered, orphan or mismatched pair invalidates the entire
contribution. Do not skip an invalid losing pair. No trailing per-file worker
manifest or observed-file hash/header comparison transcript is emitted or consumed.

### Digest framing

For domain `d`, define an incremental accumulator:

```text
A(d) = SHA256(UTF8("mammoth:" + d + ":1") || 0x00 || Frame(t1) || ... || Frame(tn))
Frame(t) = U64BE(byteLength(J(t))) || UTF8(J(t))
```

`U64BE` is eight unsigned big-endian bytes. Include framing lengths, not JSON-text
concatenation. Empty accumulators still hash their domain prefix. All digest output
is lowercase hex. Raw file SHA-256 has no framing or domain prefix.

| Domain             | Tuples appended, in order                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker-events`    | Identity tuple, every effective payload header tuple and every numbered control tuple. No raw bodies or completion tuple. A file's verified SHA is bound by its `file-meta`. |
| `channel-events`   | Current channel-open, payload header tuples and controls belonging to that channel, excluding its own channel-close. Includes nested unit closes.                            |
| `unit-semantic`    | Normalized unit identity, descendant/direct directory and verified file facts, then a closing structure fact as described below. Excludes unit-close itself.                 |
| `unit-compare`     | Only the policy-specific facts defined below.                                                                                                                                |
| `usage-membership` | Normalized unit identity and its ordered directory/member facts, then closing structure fact. No payload hashes.                                                             |

A verified file fact is `["file",path,partition,size,mode,mtimeMs,contentSha]`.
A directory fact is `["directory",path,phase]`, with phase `open` or `close`.
A usage member fact is `["used",path,partition]`, with the full logical path.
These facts are generated from validated events, not copied from asserted summaries.

For `unit-semantic`, append `["unit",kind,root,scope]` (without input-local cid)
and its root-open directory fact for subtree
units; append actual file and descendant directory facts in traversal order; append
the root-close fact for subtree units and finally `["unit-end",kind,root]` before
checking unit-close. A direct Maven unit has file facts only between its open and
end, without root or child directory facts. Do not include native identities,
producer identity, ordinal, TAR positions or control sequence in semantic digests.

For Maven `unit-compare`, append `["unit",kind]`, then
`["file",relativePath,size,contentSha]` for each direct member. For workspace
`unit-compare`, append `["unit",kind]`, directory facts with paths relative to the
unit root (including the root as the empty path), interleaved with
`["file",relativePath,size,mode,contentSha]` facts in the **same traversal order** as
the semantic projection: root-open, direct files, each child subtree, root-close.
Do not collect directories and files into separate sequences. Preserve meaningful
empty directories. Mtimes are not workspace equivalence facts. Required markers and unit
kind still participate in validation. Ordinary single-file equivalence uses hash,
size and the exact [ordinary-file reduction](#ordinary-file-reduction), without a
serialized unit-compare digest.

`usage-membership` uses `["unit",kind,root,scope]`, the same subtree/direct directory
projection, full-path used member facts, and `["unit-end",kind,root]`.
No content equivalence may be inferred from a usage-membership digest.

`counts` is `[files,directories,units,used,bodyBytes]`, all `uint`. Files/bytes count
regular payload bodies only. Directories count directory opens once, not both header
and control; usage directories count in the usage channel. Units count explicit
unit opens, including used-unit-open, not implicit single-file units. Used counts
`used` records only. A subtree unit initializes its own directory count with its
already-open root; a direct unit does not count that root. Unit counts include the
unit itself. Channel totals count each actual event once; final totals sum channels,
not unit summaries. All declared counts must equal independently observed counts.

A checked channel-close is appended to `worker-events` after comparing its
`channel-events` digest, so it cannot hash itself. Each channel summary is
`[cid,purpose,partition,counts,eventSha]`. Complete the archive with:

```text
["complete",1,lastSequence,lastPayloadOrdinal,totalCounts,channelSummaries,eventSha]
```

Initialize the current payload ordinal and last numbered-control sequence to zero.
`lastPayloadOrdinal` is a `uint`: zero when there are no regular payload bodies,
otherwise the last checked payload ordinal. `lastSequence` is the last checked
numbered control sequence; it excludes identity and complete. Required empty channel
opens/closes still advance that sequence. The final `eventSha` is `worker-events`
after all channel closes and before complete.
The completion tuple is excluded from its own digest. `channelSummaries` must equal
the bounded observed summaries in declared order. No open directory, unit or pending
file metadata may remain. A valid final seal is necessary but not sufficient until
TAR framing and gzip completion also validate. Do not put a hash of the full archive
inside that same archive.

### Reader state machine

| State             | Accepted next event                                                                  | Result                                                                          |
| ----------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Identity          | Fixed identity member                                                                | Validate expected context/model/family; enter channel boundary.                 |
| Channel boundary  | Next numbered channel-open                                                           | Check channel declaration/order; initialize accumulators.                       |
| Tree              | Expected directory header/open, file header, child close, permitted unit/usage event | Validate hierarchy and ordering; update bounded frames.                         |
| File body         | Exactly the declared body length                                                     | Hash all bytes; stage only a provisional winner; enter metadata-required state. |
| Metadata required | Next numbered file-meta only                                                         | Verify binding/hash/ownership/ordinal; finish file fact; return to tree.        |
| Channel ending    | Channel-close after balanced root/unit closure                                       | Check counts/digest; record bounded summary; advance channel.                   |
| Completion        | Fixed complete member after final channel                                            | Check identity bindings, final counts/sequence/digest; enter archive-end state. |
| Archive end       | Required TAR ends and clean gzip EOF                                                 | Contribution may be accepted if native staging/activity checks also pass.       |

A directory header similarly requires its own next dir-open; it cannot satisfy a
pending file-meta. Root paths, stack depth and the active unit determine legal opens
and closes. Any other transition rejects the contribution. Readers must continue to
EOF for every required input, including inputs that lost every payload decision.
A parser must not accept a partial artifact because its selected files looked valid.

### Usage validation

Emit a separate ordered usage channel, with structural directories and used-unit
membership where required. No payload files, upsert metadata or content hashes are
allowed in this channel. Usage-only presence cannot select a winner or replace a
complete upsert unit. A source cannot report a path or indivisible unit both as
upsert and usage-only.

Retain a temporary ordered membership-only projection per source for **all** its
upsert paths/units, including losers. Sequentially join it against that source's
usage projection to reject overlap. Selected application activity alone is not
sufficient for this check. No content hashes/full file records are required in this
validation spool; retire it after use. This is operation-local sequential metadata,
not a global path index or a second transported file catalogue.

Union validated usage with bounded metadata cursors. Suppress it for every selected
upsert path, selected Maven direct-file directory and workspace participating in
complete-upsert selection, including used members absent from the winning producer.
Selected native payload topology also suppresses incompatible **usage-only** shapes:
a selected ordinary file `x` suppresses usage below `x/`, and a selected directory
`x/` suppresses a usage-only file `x`. Unrelated usage below a selected directory
remains eligible. This rule never resolves conflicting selected payload shapes;
those still reject before live installation. Contradictory usage-only file/directory
shapes without selected payload authority also reject because one managed activity
tree cannot represent them. Implement the rule with a bounded immediate-directory
name/type frontier; do not create a global per-file index or replay archive payloads.

Discarded upserts do not automatically become usage. Preserve required activity in
prepare state: timestamps alone cannot reconstruct imported reads/writes later.

## Streaming merge and acceptance

Use an admitted number of archive readers, each paused at its next effective header
or unit boundary, with bounded gzip/TAR backpressure. A hierarchical k-way frontier
resolves equal paths or complete-unit roots before bodies. Advance only the readers
needed by that group. Channel/EOF progress uses the global model channel key defined above, not input-local
cid: a reader at a later global key cannot stall readers completing an earlier one.

| Policy case                         | Payload choice and outcome                                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `choose-worker-entry`               | Select the first contributing producer in deterministic job-name order for that entry. Hash all candidates; equivalent duplicates are skipped, differences select and warn. |
| `choose-worker-directory`           | Choose the first contributing producer for the complete recognized unit. Hash/validate every candidate independently; differences select the complete winner and warn.      |
| Strict equivalent contributions     | Choose a provisional payload from headers; verify content equivalence after bodies; retain one payload and required portable metadata merging.                              |
| Strict prohibited differences       | Reject the pending merge before live installation. Do not downgrade current errors to warnings.                                                                             |
| Ordinary-file newer-mtime selection | Stage the header-selected candidate provisionally, but accept only the configured-order reduction specified below; intermediate equal-time differences still fail.          |

Winner-policy producer ordering preserves current job-name ordinal comparison
(UTF-16 code-unit order), separately from UTF-8 filename ordering. Ordinary-file
reduction instead uses the explicit configured producer order below. Duplicate producer identities in a
decision group are invalid. A preferred producer wins only among contributors to
that entry/unit; its absence cannot discard unique contributions from other workers.
Gradle's existing build-cache and workspace winner defaults retain their warning
behavior. Single-writer snapshots remain authoritative complete partition views.

### Ordinary-file reduction

This rule applies only to aggregate regular files not already governed by a complete
Maven/workspace unit or `choose-worker-entry`. Inputs are the frozen `duplicatePolicy`
and `ordinaryOrder` from the [local policy](../cache-lifecycle-protocol/#invocation-bindings-and-operational-capture).
`strict` maps to existing `allow-duplicate-dependent-delta-paths = false`;
`newer-mtime` maps to true. This switch does not override Maven/workspace strictness
or winner policies.

`ordinaryOrder` is the configured `dependent-jobs` list after **stable first-occurrence
deduplication**, preserving validated declaration order, not artifact listing/completion
order and not alphabetic job order. Repeated configured names are ignored after their
first occurrence, matching current prepare behavior, rather than newly rejected. Storage of the admitted producer set may remain sorted separately.
Snapshot-writer-only producers appended for snapshot discovery are not in
ordinaryOrder: validate all their bodies and seals, but do not import their aggregate
payload or usage. A writer also explicitly listed in dependent-jobs is eligible
normally. Winner policies sort only eligible contributing producers. Snapshot
channels retain their independent authorized writer selection.

For each path, fold eligible candidates in ordinaryOrder, skipping producers without
that path. Each verified candidate is `(producer, hash, size, mtime, mode)`; retain
one accumulator R. The first candidate initializes R. For each next candidate E:

| Condition                                                   | Required reduction                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `R.hash == E.hash` and `R.size == E.size`                   | Choose E if its mtime is strictly greater, otherwise retain R's producer/payload (including ties). Set result mode to `0644 \| ((R.mode \| E.mode) & 0111)`, with launcher normalization still applied. Result mtime is the greater timestamp. |
| Different hash/size, policy strict                          | Reject the merge. A later candidate cannot rescue this conflict.                                                                                                                                                                               |
| Different hash/size, policy newer-mtime, timestamps equal   | Reject the merge. A later newer candidate cannot rescue this tie.                                                                                                                                                                              |
| Different hash/size, policy newer-mtime, timestamps unequal | Retain exactly the newer candidate/accumulator, including its mode. Do not union mode bits from the discarded different content.                                                                                                               |

Equivalent means hash **and size** equality, irrespective of initial mode/time.
Mode union accumulated for content is lost when a different newer content replaces
it; do not union all workers' executable bits against the final winner. Rejection
is sticky for this pending merge. This specifies the current cutoff merge's fold,
not the unrelated legacy delta/deletion reducer.

To stage only one payload, inspect the current equal-path headers and provisionally
choose greatest mtime, breaking header ties by earliest ordinaryOrder. Any successful
fold must select that payload: accumulator mtime is the maximum of its prefix, and
a successful maximum-time tie has equivalent content. Still hash/process candidate
facts **in ordinaryOrder**, applying the full fold above; comparing only to that
provisional final candidate changes semantics. Keep one accumulator plus the bounded
reader frontier, not an unbounded per-path history. Repair the staged file's mode
from the successful fold afterward. Any intermediate rejection discards provisional
acceptance before live install; no second archive pass or losing payload spool.

See the [normative conformance vectors](../cache-protocol-vectors/) for three-producer
rejection, order-sensitive acceptance and content-specific mode union.

### Complete-unit and final acceptance

Stage only selected bodies, and hash/discard losing bodies. Keep incremental unit
signatures rather than member arrays. Within competing whole workspaces, validate
each tree independently: a winning file `x` and a losing directory `x/child` are
an allowed unit difference under winner policy, not a synthetic output collision.
Cross-input collision tables apply where contributions actually combine and to the
selected output. Never mix partial workspaces from different producers.

All selections and the sequential local application plan remain **tentative** until
every required archive, usage check, unit, final seal, EOF and selected native
staging passes. Late failure rejects the whole merge before live installation.
Native staging evidence is valid only within its guarded mutation boundary; unknown
changes invalidate it. Serialized `verified` flags cannot recreate a process-local
proof. Metadata-only mode repair or activity joins may follow; normal archive
rewinds and independent rehashes of correctly guarded staged payload are unnecessary.

If an existing policy proves to require retaining multiple candidate bodies, record
that as an explicit design exception with bounded current-unit spooling and full
I/O accounting before implementation. Do not silently add losing writes or a second
archive pass. The winner policies above need neither.

## Native base and generation contract

The [metadata-only native-base contract](../native-base-protocol/) defines the
active `native-metadata-v2`, `generation-v2` and `local-v2` family cut. SDK objects
contain only the bounded identity descriptor and literal native payload. Original
metadata discovery feeds one active hierarchy and local metadata summary; no base
body hashes, archived file lists or main/post per-file replay recipes survive.
The strict worker v1 body/header hashes, conflicts, every losing contribution,
late seals and clean archive EOF remain mandatory.

### Save and restore lifecycle boundaries

See the [local lifecycle contract](../cache-lifecycle-protocol/) for the minimal
successful-main handoff and fresh post admission. An interrupted main/post does
not resume. Same-operation native cleanup and independent source return remain
mandatory, including after cancellation. Unknown/replaced endpoints and failed
returns are local errors with retained locations, never warning-only cache misses.

## Resource accounting

The default managed-directory breadth limit is proposed as **100,000 direct entries**,
with a positive-integer override. Count physical source entries before unbounded
allocation, and distinct children in managed input/staged/selected merged directories,
including usage projections. Apply caps per actual directory, never recursively to
a whole cache. For a selected workspace, check each input and the chosen output,
not the union of discarded alternatives. Count all enumerated source children,
including excluded/unsupported entries; a pruned unopened subtree is not enumerated.

**Exclude `.mammoth-meta/` controls and TAR/PAX framing from these breadth counters
and name/type tables.** They never become a native directory. Validate their strict
sequence/type/order/pairing with scalar state and bounded records instead. More than
100,000 controls across narrow payload directories are valid. Do not retain a global
control-name set. Unknown members are still errors, and effective payload names
provided through PAX still undergo all managed-name checks.

Working limits for the first implementation proof are listed below. They bound
active memory, not total cache size, and require actual parser/runner qualification
before release. A 100k-directory default is not a promise that every possible depth,
name length and worker-fan-in combination fits in memory.

| Resource                          | Proof limit / rule                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Model and input fan-in            | At most 64 partitions and 16 admitted worker inputs.                                                            |
| Depth / derived path              | At most 100 managed directory levels and 16 KiB UTF-8 per logical path.                                         |
| Control / local PAX body          | At most 64 KiB each, enforced before allocating/decoding that body.                                             |
| Aggregate retained sibling names  | At most 16 MiB across active frames/readers, with conservative decoded allocation accounting.                   |
| Aggregate current decoded records | At most 16 MiB across active readers/frames; no directory-width × worker-count record arrays.                   |
| Reader/copy chunks                | At most 256 KiB each, explicit backpressure; include parser, gzip, SDK and native buffers in peak measurements. |

There is **no Mammoth total-file, total-control-count, cache/partition/package/stream
byte quota or aggregate disk/free-space admission gate**. Counts/digests/EOF remain
integrity checks. Safe-integer, native filesystem and backend representability limits
still apply. Real ENOSPC, service quota, timeout and I/O failures must preserve
recovery guarantees; environmental capacity is not guaranteed by the format.

Account for compressed archives, selected native staging, snapshots and operation-local
metadata. One file-meta adds a TAR header, metadata body and padding per payload
file. Measure both small-file parser CPU/uncompressed framing and compressed wire
size; compression does not remove parser events. A virtual metadata model is not a
full-pipeline no-swap guarantee. Qualify memory with representative co-resident
build processes on public hosted runners; raising breadth does not authorize swapping.

## Qualification and change control

The [normative conformance vectors](../cache-protocol-vectors/) are fixed answers,
not just encoder/decoder round trips. Future tests must check exact canonical bytes,
header/unit/channel/final digests, empty and Unicode/PAX cases, configured-order
three-producer reduction, and negative framing/pairing cases independently. The isolated
[raw parser interface proof](#parser-enforcement-interface-and-dependency-gate) and
worker codec conformance tests cover the selected parser interface and wire rules.
Full merge, lifecycle, platform and hosted-runner qualification remains required.

Implement against these exact draft schemas only after review; reference the relevant
specification file/heading from code comments, and update it before or with changes. Before release, require these checks against the real parser/merge:

- Producer → raw SDK upload/download → one-pass reader → selected native install,
  with matching identity and explicit SDK digest-mismatch rejection.
- Empty/nonempty files, long Unicode/PAX paths, exact millisecond times and empty
  directories; every pairing/ordering/sequence and numeric-boundary failure.
- Missing/duplicate/orphan/misbound file metadata, bad losing bodies, altered unit
  counts/digests, late final-seal corruption, truncated ends and trailing data.
  Every rejection must produce zero live installation writes.
- Multiple workers with disjoint and overlapping contributions, asymmetric channels/
  EOF and different/omitted snapshot partition lists sharing input-local cid values,
  policy warnings, strict ties/conflicts and whole-workspace structural variants.
  Assert all bodies hashed, zero losing native payload writes and one archive pass.
- Usage-only workers and same-source upsert/usage overlap where the upsert loses.
  Verify bounded membership spools, suppression and later activity accounting.
- More than 100,000 numbered controls across narrow managed directories, without
  control-name accumulation or a false breadth failure. Still reject an over-width
  managed directory and malformed controls.
- Actual decoded-parser memory at wide-directory and realistic fan-in workloads,
  including long names, ancestors, SDK/gzip buffers and representative concurrent
  build memory; small-file framing/CPU and disk measurements. Count operations and
  bytes, not elapsed time alone; independent units must not trigger quadratic work.
- Native base round trips, record-last publication, daemon capture/shutdown and
  crash injection through evacuation/upload/return on Linux, macOS and Windows.
  EXDEV must never call a copy fallback; failed returns must block fresh prepare.

Changing tuple fields, canonical encoding, accepted TAR/PAX behavior, digest
projections, required completeness or compatibility semantics requires an explicit
protocol/version-family decision and matching documentation/tests. Update the spec
before or with code; do not silently accept an undocumented alternate grammar.
This draft is documentation only, not evidence that these checks have passed.

## Worker acceptance and native producer evidence

A completed worker merge still validates every required archive and contributed body,
including losers, per-file hashes/metadata, unit comparisons, final seals and EOF before
installation. Final selected mode/time materialization and native path/type/link/device
checks precede install authority. The implementation may reuse a genuine process-local
receipt from that final native discovery, provided it also binds the original completed
merge and exact original published install partition. A generic writer receipt or serialized
flag never substitutes for worker input authorization. The detailed receipt lifetime and
unchanged independent-snapshot boundary are specified in the
[worker native producer contract](../cache-lifecycle-protocol/#final-worker-native-producer-capability).
This changes neither the worker TAR grammar nor mandatory body hashing.

## Outgoing worker single-attempt confirmation

Outgoing raw worker uploads accept only a valid direct service descriptor matching
the immutable package's name, positive ID, size and any reported digest. Thrown,
missing, malformed or lost responses warn and abandon without discovery, download,
readback or retry. Retain the current immutable package and report its path when
confirmation is unavailable; SDK rejection does not establish reader closure.
Confirmed uploads permit known-file identity-checked package cleanup after SDK
settlement. Local package, filesystem and cleanup errors still fail the operation.
Required incoming workers remain fatal when missing or invalid, and all delta body
hashes, losing contributors, complete-unit checks, seals and EOF gates are unchanged.
