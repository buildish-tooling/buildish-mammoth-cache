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

Mammoth targets CI execution with rebuildable local cache data. Its local recovery
contract covers interruption and restart of a Mammoth process while the operating
system and filesystem remain running. It does not guarantee local cache contents,
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
  lifecycle state available across supported process restarts.
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
before its reference is published. A discoverable intent precedes destructive
moves, and progress pointers follow the changes they describe. Source return and
its committed evidence precede acceptance of an upload receipt.

Removing storage flushes does not remove atomic replacement, error propagation,
native checks, cancellation or recovery of ambiguous transitions. In the local
protocol, committed or durable state means completed publication under this
process-restart contract; it is not a promise of physical-storage persistence.
Process-termination tests exercise this contract and do not qualify host-crash or
power-loss recovery.

See the [local lifecycle protocol](../../cache-lifecycle-protocol/) for exact
publication, intent, cursor and recovery ordering.
