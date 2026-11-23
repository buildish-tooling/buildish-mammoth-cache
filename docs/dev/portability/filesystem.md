---
title: Filesystem and Recovery Requirements
weight: 5
description: Filesystem ordering and process-restart requirements for Mammoth hosts.
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

## Recovery boundary

Mammoth targets CI execution with rebuildable local cache data. A fresh post may
admit a successful-main handoff while the operating system and filesystem remain
running. Interrupted main/post is retained and refused, without automatic replay.
It does not guarantee local cache contents,
ownership records or directory entries survive an operating-system crash, machine
reboot, storage failure or power loss. This contract is the same on Linux, macOS
and Windows, including persistent self-hosted runners. It also applies to original
cache-source evacuation, old-target backups and source return: their original
locations and ownership evidence are not guaranteed to survive a host crash.

Mammoth performs no explicit file or directory storage flushes (`fsync`,
`fdatasync` or their platform equivalents). There is no provider-specific no-op
adapter or stronger-durability option. Uploading an object to the provider cache
is a separate operation governed by that backend's confirmation contract.

## Host requirements

- Use a dedicated managed root containing rebuildable cache data. Keep its local
  successful-main handoff available to fresh post; interrupted operations cannot resume.
- Complete writes and truncations must be visible to subsequent reads in the same
  running operating system. Same-filesystem renames and metadata replacement must
  provide the atomic namespace behavior used by the lifecycle protocol.
- Payload, staging, backup and lifecycle paths must remain on the same filesystem.
  Cross-filesystem moves fail; there is no copy fallback.
- Preserve the exclusive-access window and native identity, ownership, membership
  and no-symlink constraints. A completed write or atomic rename is not a lock.
- A new host adapter must establish these requirements for its execution/storage
  environment; persistent storage alone does not establish compatibility.

Do not resume an in-flight local lifecycle after a host crash or reboot as though
it were a supported process restart. A persistent runner must instead start with
a fresh dedicated cache root or explicitly reconcile the old state before reuse.
Preserve an ambiguous old lifecycle for reconciliation; do not blindly delete its
state while original cache sources may still be temporarily relocated.

## Ordering remains required

Writers await completed writes, handle closure where required, and application
buffer flushes before handing data to readers. Immutable evidence must be complete
before its reference is published. A genuine process-owned operation captures source ownership before awaited mutation.
Source return follows actual SDK settlement and precedes record-last publication.
No completed reference, atomic rename or scalar success flag recreates authority.

Removing storage flushes does not remove atomic replacement, error propagation,
native checks or cancellation cleanup. Interrupted main/post does not resume or
adopt old source packages; preserve ambiguous original-source locations and use a
fresh dedicated root or deliberate manual reconciliation. Process-termination tests
exercise refusal and safe retention, never host-crash or power-loss recovery.

See the [local lifecycle protocol](../../cache-lifecycle-protocol/) for exact
successful-main handoff, current-operation ownership and source-return ordering.

## Native metadata materialization

The active incompatible `native-metadata-v2` base format preserves permissions through native archive
headers only where the current host/filesystem supports them. It has no per-file mode
catalogue. Arbitrary Unix executable bits lost during Windows materialization cannot
be reconstructed when the base later returns to Unix. Local metadata comparison uses
Unix permission bits or the Windows writable/read-only representation, and the actual
native mtime precision, as specified in the
[local metadata summary contract](../../native-base-protocol/#metadata-summaries-and-pre-overlay-pins).
Known model launcher rules remain distinct from arbitrary permission reconstruction.
Delta archives retain their per-file metadata/content hashes from their actual source
host. The current source uses this coherent v2 wire cut.

## Native root publication and SDK lifetimes

Metadata-only base publication stages and returns native directories or files under
the existing exclusive, quiescent filesystem window. Root and parent identities,
same-filesystem rules and absent destinations are checked at the actual mutations.
Controlled moves do not trigger repeated descendant verification or copying. Separate
physical snapshot sources keep their actual identities and parents. Failed returns
retain payload at the reported staging location and are hard local failures.

Foreground cancellation waits for base SDK settlement before returning sources.
Unconfirmed raw artifact uploads retain their immutable current package because the
installed public SDK does not expose closure of inaccessible readers on rejection.
No later namespace adoption, automatic deletion or retry is implied. Native archive
permissions remain limited to what the host materializes; no base mode catalogue
reconstructs Unix executable bits lost through Windows.

Operation counters include instrumented native work, application staging mkdir,
control writes and mode changes, metadata codec/scratch work and known empty-shell
cleanup. Native archive resolution, TAR/compression subprocesses and SDK internals
have additional work; application counters are not every operating-system syscall
and bounded count fixtures establish no RSS, paging or throughput guarantee.

## Native streaming buffer ownership

`NativeRoot.read` forwards each default FileHandle ReadStream `Buffer` unchanged;
it does not copy, pool or reuse emitted storage. Its consumer may retain a chunk
across later reads and must not mutate shared bytes while another consumer still
uses them. Unexpected encoded/non-Buffer chunks fail rather than introducing a
fallback copy. Async iteration retains backpressure and counts actual chunk lengths.
Final handle/name identity checks and handle closure still gate successful EOF.

The downloaded raw worker archive path uses this reader through `OwnedStore.read`.
Compressed archive length/SHA, delta body hashes, channel/archive seals and strict
transport EOF remain required. Eliminating one wrapper copy per emitted chunk does
not eliminate those passes, filesystem/SDK work or establish a throughput/RSS bound.
