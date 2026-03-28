---
title: Additional Build Tools
weight: 30
description: Assessment of build tools beyond Gradle and Maven as candidates for future adapter support.
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

This page records the assessment of build tools beyond Gradle and Maven as candidates for a
future `BuildToolAdapter` implementation. The key property that determines fit is whether the
tool stores downloaded artifacts at stable, portable paths that can be snapshotted, diffed, and
restored across CI runners — and whether the layout is predictable enough to write meaningful
hard-exclude rules.

A second important dimension is whether the tool's local cache is **content-addressed**. A
content-addressed layout (where the file path is derived from the file's own hash) makes it
structurally impossible to commit a partial or corrupt download, simplifying the adapter and
removing the need for any integrity-check logic in the finalize phase.

## JVM / Apache ecosystem

### SBT (Scala)

**Priority: high.** SBT is used by several major Apache projects (Kafka, Spark, Flink) and its
user community overlaps significantly with the existing Gradle/Maven audience.

Modern SBT (1.x) uses [Coursier](https://get-coursier.io/) for dependency resolution by default.
The Coursier cache (`~/.cache/coursier/v1/`) is **content-addressed**: each artifact is stored
under a path derived from its hash, making broken downloads structurally impossible — the same
property that Gradle's files-2.1 layout provides. An SBT adapter for the Coursier cache would
have the same "no integrity check needed" characteristic as the Gradle adapter.

Older SBT releases and the legacy Ivy cache (`~/.ivy2/cache/`) use a coordinate-based layout
similar to Maven's local repository. If an adapter needs to support both, the Ivy cache would
require the same treatment as Maven (hard excludes for lock/marker files; awareness of partial
downloads, though Aether-style atomic moves apply here too via Coursier's own locking).

Hard excludes for an SBT adapter would be similar to Gradle's: `.bsp/`, build output directories
(`target/`), daemon files, and Coursier lock files.

### Bazel

**Priority: low.** Bazel has a first-class remote cache protocol (the Remote Execution API /
REAPI) and the majority of teams using Bazel at scale already configure a remote cache backend
(Buildbarn, Buildbuddy, EngFlow, etc.). Adding a Mammoth Cache adapter for Bazel's local disk
cache (`~/.cache/bazel/`) would have a narrow audience and would largely duplicate existing
tooling. The local cache is content-addressed, so the adapter itself would be simple — but the
use case is weak.

## Systems / polyglot

### Cargo (Rust)

**Priority: medium.** Rust usage is growing across the Apache ecosystem (Arrow, DataFusion) and
as a language for native extensions in JVM projects. Cargo's registry cache
(`~/.cargo/registry/`) is **content-addressed**: packages are stored by their checksum. The git
dependency cache (`~/.cargo/git/`) is also stable and portable. An adapter would be relatively
straightforward, with hard excludes for build output (`target/`) and `.cargo/bin/`.

The main challenge is that Cargo's incremental compilation cache in `target/` is
runner-specific and should never be captured; clear partition boundaries between the registry
cache (portable) and the build output (not portable) are essential.

### npm / pnpm

**Priority: medium.** Frontend components are near-universal in modern projects and npm/pnpm
dependency installation is a common CI bottleneck.

**pnpm** is the more interesting target. Its content-addressable store
(`~/.local/share/pnpm/store/v3/`) uses hard links: each unique file is stored exactly once by
hash, and project `node_modules/` directories hard-link into it. This is the same content-addressed
property as Gradle's and Coursier's caches, making an adapter straightforward and safe.

**npm**'s cache (`~/.npm/`) is less well-structured, uses a content-addressed internal layout
(`_cacache/`) but with more mutable metadata alongside it. An npm adapter would need more
careful hard-exclude work to avoid caching runner-specific state.

**yarn 1** (`~/.yarn/cache/`) and **yarn 2+** (`.yarn/cache/` in-project zero-installs) have
different tradeoffs again; yarn's various modes make a single adapter harder to design cleanly.

### Go modules

**Priority: medium.** Go is increasingly common in DevOps tooling and some Apache projects.
The Go module cache (`~/go/pkg/mod/`) is effectively content-addressed: each module version is
stored under a path that includes its version string and its hash is verified on download.
The cache is stable and portable across runners of the same OS/architecture.

Hard excludes would cover `~/go/pkg/mod/cache/download/sumdb/` (the sum database lookup cache,
which is runner-local metadata) and any lock files.

## Data science / Python

### pip, Poetry, uv

**Priority: low for this project's focus.** Python package management is extremely common in CI
generally but less central to the Apache JVM ecosystem that is this project's primary audience.

**uv** (`~/.cache/uv/`) is the most interesting Python target: its cache is content-addressed and
it is rapidly becoming the preferred tool for Python dependency management. An adapter would be
clean and simple.

**Poetry** (`~/.cache/pypoetry/`) and **pip** (`~/.cache/pip/`) use coordinate-based layouts
with more mutable metadata files scattered alongside cached packages, making adapters more complex
and the hard-exclude surface larger.

## Summary

| Tool        | Cache layout                                    | Apache ecosystem fit       | Adapter complexity | Priority |
| ----------- | ----------------------------------------------- | -------------------------- | ------------------ | -------- |
| SBT         | Content-addressed (Coursier) / coordinate (Ivy) | High                       | Low–medium         | **High** |
| Cargo       | Content-addressed                               | Medium and growing         | Low                | Medium   |
| pnpm        | Content-addressed                               | Medium (frontend)          | Low                | Medium   |
| Go modules  | Content-addressed                               | Medium                     | Low                | Medium   |
| npm         | Mostly content-addressed                        | Medium (frontend)          | Medium             | Medium   |
| uv (Python) | Content-addressed                               | Low                        | Low                | Low      |
| pip/Poetry  | Coordinate-based                                | Low                        | Medium             | Low      |
| Bazel       | Content-addressed                               | Low (has own remote cache) | Low                | Low      |
