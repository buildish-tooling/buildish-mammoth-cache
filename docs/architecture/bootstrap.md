---
title: Bootstrap Process
weight: 40
description: How the action initializes configuration, the cache model, and the build tool adapter (Gradle or Maven) before handing off to the build.
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

Prepare and post share provider-neutral bootstrap and build-tool adapters. Gradle provisions verified
wrapper JARs and installs result hooks; Maven requires no wrapper provisioning. Orchestration lives
in `src/phases/prepare/cutoff-flow.ts` and `src/phases/finalize/flow.ts`.

## Prepare

The single-run guard claims ownership. Bootstrap derives configuration, Java identity, partitions
and model, then writes a pending local journal before provisioning/restore. Optional cleanup pins
re-restore to the matched key; validated worker envelopes are applied. After all prepare reads and
writes, it records C. No upfront cache inventory/content hashes are captured.

Successful cache-disabled prepare writes an explicit disabled CI record. Failed prepare establishes
no valid cutoff; the post guard skips publication. Superseding prepare invalidates older journals.

## Finalize read boundary

Post first checks duplicate, owner and prepare-failure CI state. Skipped invocations do not inspect
the journal/configuration or initialize providers. Enabled invocations load recorded identity and
bounded journal, scan metadata and durably freeze upsert/used/GC decisions. Only then are SDKs,
config resolvers, adapters and orchestration dynamically imported. This covers import-time event
reads when event/config/Java files overlap a custom cache partition.

Finalize consumes a one-use receipt, bootstraps and reconciles full model, execution and policy.
Direct core callers preflight before bootstrap too. Drift fails before reports, deletion or upload.
Reporting can read content after freeze; transient Gradle scripts and report scratch are excluded.

Replay permits Mammoth's own atime changes while checking other native metadata. Finalize executes
frozen GC, publishes a sealed worker completion envelope or eligible immutable generation, and
replaces the summary with upsert/used/GC and save results. Adapters retain build failures/scan links.
`src/phases/finalize/reporting.ts` remains side-effect-free and creates no content inventory.

See [Base cache design](../base-cache/) and [Delta protocol](../delta-protocol/) for details.
