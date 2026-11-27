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

The Actions use separate prepare and post entrypoints for Gradle and Maven. The
GitHub adapters read inputs, normalize configuration and construct the host and
build-tool adapters. Shared orchestration lives in `src/phases/streaming/`.

## Prepare

Prepare claims one owning invocation and resolves the cache root, partitions and
family. It checks the dedicated root for interrupted owners and known legacy
mutation intents. Gradle validates and provisions its wrapper. The cache lifecycle
validates and installs the selected base and any admitted worker contributions
before enabling build hooks. Prepare then records the activity cutoff, model,
selected cache evidence and invocation policy in its local-v2 handoff.

Cache-disabled prepare records a disabled invocation and still checks an existing
root for unsafe state. It provisions the build tool and sets up reporting hooks.

## Post

Post checks its CI ownership state before opening the local handoff. The handoff
binds the original root, tool, configuration and cutoff. Removing or altering
configuration for the post step does not change its policy. Duplicate or
non-owning posts skip lifecycle work.

Read-only and disabled post perform the applicable hook cleanup and build
reporting. Writable standalone and aggregator posts require the exclusive
runtime window, then observe metadata, apply GC where enabled and publish
any changed cache objects. Writable workers publish one validated archive.
Provider SDK operations run only when the selected route needs them.

A normal fresh post process receives the successful prepare handoff. Work
interrupted after the owner starts a mutation is preserved for inspection.
Use a fresh dedicated root for another invocation. See
[Base cache design](../base-cache/) and [Delta protocol](../delta-protocol/).
