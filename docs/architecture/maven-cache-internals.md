---
title: Maven Cache Internals
weight: 15
description: What lives inside the Maven local repository, what is portable across runners, and what must be excluded.
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

Understanding which parts of the Maven local repository (`~/.m2`) are safe to cache across CI
runners and which parts cause stale-resolution or non-determinism is the foundation of this
action's partition design for Maven.

## Maven local repository structure

| Path                    | Purpose                                      | Cache for CI?    |
| ----------------------- | -------------------------------------------- | ---------------- |
| `repository/`           | Cached artifact and metadata store           | Yes, selectively |
| `wrapper/dists/`        | Maven Wrapper distribution downloads         | Yes              |
| `settings-security.xml` | Encrypted master password for `settings.xml` | No               |

## Artifact store: `repository/`

Maven's artifact store uses a fully content-deterministic layout:

```
repository/<groupId path>/<artifactId>/<version>/<artifactId>-<version>.<ext>
```

Because the path is derived solely from the artifact coordinates, the content of any given path is
identical regardless of which runner downloaded it. This makes `repository/` fully portable across
machines, operating systems, and architectures.

### What is portable

| Contents                                      | Why portable                                                 |
| --------------------------------------------- | ------------------------------------------------------------ |
| Artifact JARs, WARs, POMs, sources, javadoc   | Content-addressed; path encodes coordinates, not host path   |
| Plugin JARs and their dependencies            | Same content-addressed layout as regular artifacts           |
| Release metadata (`maven-metadata-local.xml`) | Describes locally installed artifacts; stable across runners |

### What is not portable

| Contents                     | Reason                                                                                                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `*.lastUpdated` files        | Record per-runner timestamp and remote-check outcome; cause stale cache misses                                                                                                                                                                         |
| `resolver-status.properties` | Written by Maven Resolver (Aether) at group/artifact metadata level to track which remotes were contacted; same per-runner semantics as `.lastUpdated` — a frequent distributed-merge conflict source when parallel workers both resolve Maven plugins |
| `_remote.repositories` files | Map artifacts to source remote; invalid when remotes differ across environments                                                                                                                                                                        |
| `*.lock` files               | PID-bearing resolver lock files; cause hangs or errors on restore                                                                                                                                                                                      |

All four categories are unconditional hard excludes in every active partition.

## `*.lastUpdated` in depth

When Maven contacts a remote repository to check for an artifact or metadata update, it writes a
`.lastUpdated` file recording the timestamp of the check and which remote it contacted. On the
next invocation, Maven reads this file and skips the remote check if sufficient time has not
elapsed (controlled by `updatePolicy`).

When this file is cached and restored on a different runner:

1. The timestamp appears recent, so Maven skips the remote check.
2. If a newer version has since been published, Maven silently uses the stale cached artifact.
3. If the original check was a failure (e.g. artifact not yet published), Maven continues to
   report the artifact as missing even though it now exists remotely.

Excluding `.lastUpdated` files forces each runner to perform fresh remote checks, which is the
correct behaviour for a CI environment where artifact publication is ongoing.

## `resolver-status.properties` in depth

Maven Resolver (Aether) writes a `resolver-status.properties` file in the local repository at the
group/artifact metadata level (e.g. `org/apache/maven/plugins/resolver-status.properties`). The
file records, for each configured remote repository, the timestamp of the last metadata check and
whether it succeeded or failed.

This file has the same semantics as `.lastUpdated`:

- It is per-runner state (different runners may have different remote repository configurations).
- Restoring it on another runner suppresses fresh remote checks, potentially hiding newly published
  artifacts or causing stale failure states to persist.

Additionally, in distributed multi-job builds it is a **frequent merge conflict source**: every
worker job that resolves any Maven plugin (which happens for nearly every Maven goal invocation)
writes its own version of this file for the `org/apache/maven/plugins/` path. The files differ
across workers because each worker contacts Maven Central at a different moment and accumulates
status entries for only the plugins it used. Because the files differ in content, the aggregator
cannot merge them without silently dropping one worker's view of the world.

The solution is to exclude them unconditionally so the delta never contains `resolver-status.properties`
entries and the conflict cannot arise.

## `_remote.repositories` in depth

After resolving an artifact from a remote repository, Maven writes a `_remote.repositories` file
listing the remote repository ID that served the artifact. On subsequent invocations, if the local
repository contains the artifact but `_remote.repositories` does not match the current active
remotes, Maven re-downloads the artifact.

This file is not portable because:

- Different CI environments may have different `settings.xml` configurations, different repository
  IDs, or mirror rules that map the same URL to a different logical ID.
- Restoring a `_remote.repositories` file from another runner may either suppress or trigger
  unnecessary re-downloads depending on whether the repository IDs match.

## Wrapper distributions: `wrapper/dists/`

When projects use the Maven Wrapper, the Wrapper script downloads the Maven distribution into
`~/.m2/wrapper/dists/`. The distribution is identified by its URL, making the path
deterministic and portable. This directory is covered by the `wrapper-dists` partition.

## Portability summary

**Safe to cache:**

| Pattern            | Role                                  |
| ------------------ | ------------------------------------- |
| `repository/**`    | Immutable content-addressed artifacts |
| `wrapper/dists/**` | Downloaded Maven distributions        |

**Always excluded:**

| Pattern                   | Reason                                                          |
| ------------------------- | --------------------------------------------------------------- |
| `**/*.lastUpdated`        | Stale remote-check markers; cause silent resolution misses      |
| `**/_remote.repositories` | Per-remote provenance markers; not portable across environments |
| `**/*.lock`               | PID-bearing resolver locks; cause hangs on restore              |
