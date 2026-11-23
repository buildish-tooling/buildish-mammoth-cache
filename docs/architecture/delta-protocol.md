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

## Completion and selection

A writable distributed worker uploads one immutable archive after its build.
An archive can contain an empty contribution and still confirm participation.
Mammoth requires a positive upload receipt. The artifact identity binds the
producer job, workflow run, attempt, source revision and compatible family.
An aggregator requires the latest eligible artifact for each named worker and
deduplicates repeated names. Optional snapshot writers have separate policy.

A failed or unconfirmed upload retains its immutable package at the reported
path. A fresh workflow invocation follows normal producer discovery. An
interrupted owner never resumes an earlier upload or publication.

## Worker TAR-v2

The artifact is a gzip-compressed TAR. An aggregate channel carries changed files
and complete upsert units, a usage channel carries protection facts, and isolated
snapshot channels carry designated writers' native contents. Empty directories
inside selected units are explicit. Usage structure carries no file bodies.
TAR headers and following file metadata establish path, size, permissions and
content SHA-256. Final counts, event seals and EOF close the archive.

An aggregator validates every required stream, including losing file bodies. It
stages only selected payloads. Invalid ownership, inconsistent units, missing
controls or incomplete framing reject the merge before live installation.

## Complete workspaces and Maven directories

Gradle Groovy, Kotlin and transform workspaces travel as complete managed units.
Whole-directory winner policies select one producer. The strict policy requires
compatible views. The Gradle build-cache entry policy applies to qualifying
task-cache archive paths.

Maven worker upserts carry the whole managed coordinate directory. Default
strict merge checks complete views, including origin markers. Explicit
`choose-worker-directory` selects one producer's complete directory.
Ordinary newest-mtime handling does not override complete-unit rules. The
existing aggregator target is checked for protected artifact siblings before
installation. See [Maven cache internals](../maven-cache-internals/).

## Base publication after merge

After the build, the owning base post observes the working cache. It can reuse
unchanged generation refs even after incoming content validation. A change
that preserves the metadata used for base comparison may be missed. Locally
retained source data and required returns stay under the owning operation.

For wire details see the [cache protocol](../../dev/cache-protocol/). For
workflow inputs and retry behavior see [distributed jobs](../../user/distributed-jobs/).
