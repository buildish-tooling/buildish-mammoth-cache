---
title: Maven Caching Patterns
weight: 60
description: How to get the most out of Maven caching — what is portable in the local repository, why certain files are excluded, and how to structure workflows for maximum cache effectiveness.
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

## What gets cached

The Maven action caches the local repository (`~/.m2/repository` by default, covered by the
`repository` partition) and, when the Maven Wrapper is in use, the wrapper distribution downloads
(`~/.m2/wrapper/dists`, covered by the `wrapper-dists` partition).

Repository paths encode coordinates, not content hashes. Releases from different repositories,
snapshots, and locally installed builds can have different bytes at the same path. Mammoth preserves
`_remote.repositories` so Maven Resolver can distinguish downloaded content from local installs and
apply its normal origin checks. Keep repository IDs, mirror mappings, and Resolver configuration
compatible across jobs sharing a cache. A changed origin can require downloads or fail offline;
markers do not authenticate content or compensate for Resolver's same-ID URL fallback.

Use a dedicated Maven user home and cold-seed it from a fresh repository when upgrading from the
marker-excluding policy. The changed partition fingerprint starts a new cache family automatically;
old generations and worker packages are not restored through a fallback.

### Snapshots and local build outputs

Both remain included by default. Resolver controls snapshot updates; cached bytes do not guarantee
freshness. `mvn install` outputs remain local installs after restore and can satisfy resolution
independently of the active remotes. Exclude complete coordinate directories when those outputs
should be rebuilt, using the existing partition input:

```yaml
cache-partitions: |
  [
    {
      "id": "repository",
      "includes": ["repository/**"],
      "excludes": [
        "repository/**/*-SNAPSHOT/**",
        "repository/com/example/my-project/**"
      ]
    }
  ]
```

The group/artifact exclusion is an example for the project's own installed outputs. Adjust it to
your coordinates. Keep origin markers included wherever repository artifacts remain managed;
excluding those markers while retaining sibling files is rejected. Exclude whole version or
coordinate directories so artifact bytes and their marker stay together. A managed directory
containing excluded classifiers or other non-transient artifact files is rejected during source
capture, aggregation, and GC. With custom exclusions, restore also checks the existing included
trees using metadata before archive extraction; this adds traversal cost but no pre-build content
hashing. Whole-directory exclusions and the default check-state/lock exclusions remain supported.

## Default timestamp garbage collection

Maven local repositories tend to grow monotonically because old dependency versions remain valid
even after the project stops using them. The action therefore enables `cache-gc-mode: timestamp` by
default for both Maven and Gradle.

For Maven this means managed local-repository directories are pruned before standalone or
distributed-aggregator jobs save the base cache when their modification time is older than `cache-gc-older-than-days` (`14` by default) and no current local/upstream activity protects them.
A directory is retained if any managed sibling survives, so old marker timestamps cannot remove
origin evidence while artifact bytes remain. Current path-only usage also protects siblings.
No historical last-use grace is stored; `noatime`/`relatime` and clocks can hide activity. This keeps GitHub Actions
cache entries from growing indefinitely while still allowing Maven to redownload an old artifact if
the build needs it again.

If a workflow intentionally relies on a large offline-style local repository, either increase the
cutoff or disable GC:

```yaml
cache-gc-older-than-days: '30'
# or:
cache-gc-mode: off
```

## Why certain files are always excluded

Three patterns are hard-excluded from every Maven partition:

- `**/*.lastUpdated`: artifact resolution failure/check state that can suppress retries.
- `**/resolver-status.properties`: metadata update-check timestamps and errors that can suppress
  fresh checks after restore.
- `**/*.lock`: transient synchronization state recreated by the consuming job.

The first two discard check history, not artifact provenance. Maven metadata XML and
`_remote.repositories` remain cached. Resolver's update policy still applies; these exclusions do
not force every artifact or snapshot to be downloaded again. See
[Maven cache internals](../../architecture/maven-cache-internals/) for the tested behavior.

## Maximizing cache hit rates

### Commit your POM files and nothing else

The cache key includes a fingerprint of the active partition layout. The content of your POMs
does not factor into the key. This means:

- Dependency updates do not by themselves change the partition fingerprint.
- Warming the cache is fastest when the first run resolves all dependencies end-to-end.
- Running `mvn dependency:go-offline` as a dedicated pre-build step is **not needed** and slows
  down the first run unnecessarily — let the build resolve naturally and the action will cache
  whatever lands in the local repository.

### Use the lifecycle your build requires

Use `mvn verify` for verification or `mvn install` when subsequent builds need locally installed
outputs. Downloaded dependencies are cached as Maven resolves them during either lifecycle. Local
installation is a separate operation; use the exclusions above when those outputs should not be
shared.

### Multi-module projects and parallel goals

For multi-module projects, finalize observes activity across the managed local repository after
the build completes. You do not need to structure goal invocations specially — just ensure the final
invocation runs all modules (`mvn -T 1C verify` or similar) so every module's output reaches the
local repository before the finalize step runs.

In distributed mode, each changed managed file under `repository/` carries its immediate managed
directory as upserts, keeping artifacts and origin markers in the worker's complete view. Use a
common seeded repository and one writer per changed directory under the default policy. The qualified topology uses
Resolver's enhanced local repository manager, default `_remote.repositories` tracking filename,
and unsplit `repository/` layout. Different artifact/version
directories can be populated in parallel. Seed common plugins and transitives once before workers
resolve their remaining disjoint dependencies, or use standalone mode for cold seeding.

Under the default policy, different worker views of the same directory fail aggregation, including disjoint classifiers or
local installs sharing a marker. Even equal marker entries can differ in timestamp comments and
fail the byte comparison. The duplicate-path override cannot bypass this check. An aggregator also
rejects updates missing non-transient siblings already present in its repository, including
excluded artifact files. Serialize overlapping
resolution or use standalone mode rather than removing markers. Worker envelopes remain available
for retries; rerun from a fresh aggregator after a partial filesystem failure.

### Structuring staged workflows

Some projects run goals in stages — for example, build and test in parallel, then deploy
separately. A typical pattern:

```yaml
jobs:
  build-and-test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@be666c2fcd27ec809703dec50e508c2fdc7f6654
        with:
          distribution: temurin
          java-version: '21'
      - uses: buildish-tooling/buildish-mammoth-cache/actions/github/maven@<commit-sha>
      - run: mvn verify

  deploy:
    needs: build-and-test
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@be666c2fcd27ec809703dec50e508c2fdc7f6654
        with:
          distribution: temurin
          java-version: '21'
      - uses: buildish-tooling/buildish-mammoth-cache/actions/github/maven@<commit-sha>
        with:
          read-only: true
      - run: mvn deploy -DskipTests
```

The `deploy` job uses `read-only: true` so it benefits from the warm cache populated by
`build-and-test` without writing a competing cache entry.

## Goal-level incremental caching

Maven does not have a built-in equivalent to Gradle's task-output caching. Plugin-based extensions
exist that add goal-level incremental caching to Maven, analogous to Gradle's build cache. These
operate independently of this action and require separate configuration. This action is compatible
with such extensions — the files they produce in the local repository are captured and cached
alongside regular dependency artifacts.

## Selecting one worker directory on conflict

For independent cold workers, an explicit partition policy can select one
complete worker directory instead of rejecting differing marker bytes:

```yaml
cache-partitions:
  - id: repository
    conflict-handling: choose-worker-directory
```

Use the same configuration in producers and aggregators. The smallest producer
job name in JavaScript UTF-16 ordinal order wins each immediate directory after
discovery selects eligible attempts. It keeps that worker's artifacts, marker
and attributes together, without parsing Java properties. Different file sets
also trigger selection. Other workers' classifiers, local installs and origin
entries can be lost; offline resolution is not guaranteed for losing workers.
A discarded local install may not be downloadable anywhere.

This policy is optional and creates a separate cache family. Common seeding
remains supported with the strict default. Existing target siblings absent from
the winner, including excluded artifacts, still prevent application; selection
does not delete files. See [configuration](../configuration/) for constraints,
forwarding behavior and interaction with the generic duplicate override.
