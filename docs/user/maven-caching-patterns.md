---
title: Maven Caching Patterns
weight: 60
description: How to get the most out of Maven caching — what is portable in the local repository, why certain files are excluded, and how to structure workflows for maximum cache effectiveness.
---

<!--
Copyright 2026 The Apache Software Foundation

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

The local repository is content-addressed: each artifact sits at a path derived from its group ID,
artifact ID, and version, and the file content is identical regardless of which runner downloaded
it. This makes it straightforwardly portable across runners, operating systems, and
architectures — a cache entry saved on one runner is fully usable on another.

## Default timestamp garbage collection

Maven local repositories tend to grow monotonically because old dependency versions remain valid
even after the project stops using them. The action therefore enables `cache-gc-mode: timestamp` by
default for both Maven and Gradle.

For Maven this means managed local-repository files are pruned before standalone or
distributed-aggregator jobs save the base cache when both their modification time and effective
access time are older than `cache-gc-older-than-days` (`14` by default). This keeps GitHub Actions
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

Four categories of file are unconditionally excluded from every cache partition because they carry
per-runner or per-session state that corrupts the build when shared:

**`**/\*.lastUpdated`\*\* — written by Maven each time it checks a remote repository for an artifact
or metadata update. The file records the timestamp of the check and the outcome. When restored on a
different runner, Maven skips the remote check because the file is present, potentially missing a
newer version that has since been published. Always excluding these files forces Maven to perform
fresh remote checks rather than relying on stale markers.

**`**/resolver-status.properties`** — written by Maven Resolver (Aether) at the group/artifact
metadata level (e.g. `org/apache/maven/plugins/resolver-status.properties`) to track which remote
repositories have been contacted and what status each returned. It has the same per-runner semantics
as `.lastUpdated`. In distributed multi-job builds it is particularly problematic: every worker job
that invokes any Maven goal also resolves Maven plugins, so every worker writes its own version of
this file for the plugins group. Because the files differ in content across workers, the aggregator
cannot merge them safely — they appear as a conflict. Excluding them prevents the conflict from
arising.

**`**/\_remote.repositories`** — records, for each artifact in the local repository, which remote
repository it was originally resolved from. If the new runner's `settings.xml` references different
repositories, the marker can cause Maven to silently skip re-resolving an artifact it would
otherwise re-download from the correct source. Excluding these markers keeps resolution honest.

**`**/\*.lock`\*\* — transient file locks used by the Maven resolver to serialize concurrent access.
A lock file restored from cache references a stale PID and will cause hangs or silent failures
when the resolver tries to acquire it.

## Maximizing cache hit rates

### Commit your POM files and nothing else

The cache key includes a fingerprint of the active partition layout. The content of your POMs
does not factor into the key (unlike Gradle's dependency locking files). This means:

- Cold starts occur only when the partition layout changes, not on every dependency update.
- Warming the cache is fastest when the first run resolves all dependencies end-to-end.
- Running `mvn dependency:go-offline` as a dedicated pre-build step is **not needed** and slows
  down the first run unnecessarily — let the build resolve naturally and the action will cache
  whatever lands in the local repository.

### Use `mvn verify` or `mvn install`, not lifecycle fragments

Maven's build lifecycle writes many artifacts to the local repository only during specific phases.
Running `mvn compile` alone will not populate the repository with as many artifacts as `mvn verify`
or `mvn install`. Use the same goal in your caching workflow that you would use locally to ensure
the cache is populated completely on the first warm run.

### Multi-module projects and parallel goals

For multi-module projects, the entire local repository is captured as a single delta after the
build completes. You do not need to structure goal invocations specially — just ensure the final
invocation runs all modules (`mvn -T 1C verify` or similar) so every module's output reaches the
local repository before the finalize step runs.

If you use the distributed multi-job mode (separate modules in separate jobs), each worker captures
only the repository changes it produced. The aggregator merges all worker deltas into the next
cache entry, so every module's downloaded dependencies are available on the next run regardless of
which worker downloaded them.

### Structuring staged workflows

Some projects run goals in stages — for example, build and test in parallel, then deploy
separately. A typical pattern:

```yaml
jobs:
  build-and-test:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@be666c2fcd27ec809703dec50e508c2fdc7f6654
        with:
          distribution: temurin
          java-version: '21'
      - uses: apache/buildish-mammoth-cache/actions/github/maven@<commit-sha>
      - run: mvn verify

  deploy:
    needs: build-and-test
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@be666c2fcd27ec809703dec50e508c2fdc7f6654
        with:
          distribution: temurin
          java-version: '21'
      - uses: apache/buildish-mammoth-cache/actions/github/maven@<commit-sha>
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
