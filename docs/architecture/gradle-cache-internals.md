---
title: Gradle Cache Internals
weight: 10
description: What lives inside the Gradle user home, what is portable across machines, and what must be excluded.
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

Understanding which parts of the Gradle user home (`~/.gradle`) are safe to cache across CI runners
and which parts cause corruption or non-determinism is the foundation of this action's partition design.

## Gradle user home structure

| Directory        | Purpose                                                    | Cache for CI?    |
| ---------------- | ---------------------------------------------------------- | ---------------- |
| `caches/`        | Central repository for all cached resources                | Yes, selectively |
| `daemon/`        | Registry and logs for long-running Gradle daemon processes | No               |
| `wrapper/`       | Downloaded Gradle distributions and metadata               | Yes              |
| `native/`        | Platform-specific native binaries (regenerated on demand)  | No               |
| `notifications/` | Internal notification state                                | No               |

## Dependency store: `caches/modules-*/`

**`files-2.1/`** — Content-addressable storage for external JAR and POM files. The path encodes
the artifact coordinates and checksum of the file:

```
caches/modules-2/files-2.1/<group>/<module>/<version>/<checksum>/<filename>
```

Because the path is derived solely from content, `files-2.1/` is fully portable across machines.

**`metadata-*/`** — Gradle's binary dependency-resolution cache. It records resolved module
descriptors and dependencies, dynamic-version results, artifact-file references, missing modules
or artifacts, repository identity, and cache timestamps used for expiry. Downloaded POM and Ivy
files are stored separately in `files-2.1/`.

Dependency caches populated by Gradle 6.1 or later are relocatable, including metadata; see the
[Gradle 6.1 release notes](https://github.com/gradle/gradle/blob/v6.1.0/subprojects/docs/src/docs/release/notes.md#gradles-dependency-cache-can-be-relocated).
Gradle documents relative paths for both stores. Preserve the `caches/modules-<version>/` structure,
use compatible cache formats, and omit `*.lock` and `gc.properties` when copying; see
[Copying and reusing the cache](https://docs.gradle.org/current/userguide/dependency_caching.html#sec:copying_and_reusing_the_cache).

Mammoth caches artifact files in `modules` and resolution metadata in the separate,
enabled-by-default `dependency-metadata` partition. In standalone mode, the current job owns
metadata publication. Distributed mode accepts one complete snapshot from the partition's
configured `writer`; other jobs' local updates are omitted. If the writer contributes no snapshot,
Mammoth carries forward the previous snapshot. With no writer configured, it also emits a warning
and explains the retained metadata in the GitHub summary.

A snapshot replaces the entire configured metadata file set, including removals. An explicit empty
snapshot clears it; an absent contribution preserves it. Before restore, Mammoth removes preexisting
managed metadata and reports that replacement in a warning and summary. A miss starts the managed
metadata partition empty, even on a self-hosted runner and with `cleanup-enabled: false`.
User-excluded files remain unmanaged. Explicitly narrowing the definition is supported; the user
is responsible for any effect on Gradle's ability to use the remaining metadata.

Snapshots use excluded local staging and fixed archive transport paths. Capturing a standalone
snapshot also copies and hashes the complete configured partition; a distributed writer additionally
uploads it in its worker envelope. Mammoth does not merge binary indexes or apply per-file timestamp
GC to these snapshots. Gradle can clean its local copy, and its writer's next snapshot reflects that.
Ordinary artifact GC continues independently, so retained metadata does not guarantee offline
completeness. Different Gradle cache formats can coexist; use Gradle's compatibility table above.

See [Distributed multi-job builds](../../user/distributed-jobs/#gradle-metadata-writer) for writer
configuration and skipped-writer examples.

## Artifact transforms: `caches/transforms-*/`

Artifact transforms (used by plugins such as the Android Gradle Plugin) convert dependencies from one
form to another. Results are stored under `caches/transforms-3/` (or `transforms-4` in newer Gradle).

Transforms are non-portable for three reasons:

1. Transformed outputs often embed absolute paths back to the source artifact location.
2. Many transforms depend on the JDK version; a result from JDK 11 may be invalid under JDK 17.
3. Each `transforms-*/` directory contains a `results.bin` index that is sensitive to the local
   file-system layout and corrupts easily across machines.

This action excludes transforms from all cache partitions.

## Build cache: `caches/build-cache-1/`

The Gradle build cache stores task output snapshots keyed by a hash of task inputs. When a task
runs with `PathSensitivity.RELATIVE` or `NAME_ONLY`, the cache entry is portable across machines.

| Sensitivity level | Key dependency                | Portable? |
| ----------------- | ----------------------------- | --------- |
| `ABSOLUTE`        | Full local file path          | No        |
| `RELATIVE`        | Path relative to project root | Yes       |
| `NAME_ONLY`       | Filename only                 | Yes       |
| `NONE`            | File content only             | Yes       |

`caches/build-cache-1/` is a good candidate for caching provided build authors have configured
task inputs to be path-agnostic.

## Version-specific caches: `caches/<version>/`

For each Gradle version used, a dedicated directory records the operational state of that build tool
version. These directories are almost entirely non-portable:

| Pattern                               | Reason to exclude                                         |
| ------------------------------------- | --------------------------------------------------------- |
| `caches/[version]/execution-history/` | Stores local file-system timestamps and absolute paths    |
| `caches/[version]/file-hashes/`       | Index of file content signatures, keyed by absolute paths |
| `caches/[version]/kotlin-dsl/`        | Compiled build scripts; sensitive to classpath and JVM    |
| `caches/[version]/java-compile/`      | Incremental compilation analysis data                     |

## Journal and lock files

**`caches/journal-1/file-access.bin`** — A B-Tree database tracking the last access time of each
cache entry, used by Gradle's cleanup service. This file is local-only. Sharing it across machines
can propagate corruption and is the most common cause of `CorruptedCacheException`.

**`*.lock` files** — Gradle uses lock files to coordinate access across processes. Lock files often
contain the PID of the owning process. Restoring a stale lock file on a new runner causes Gradle to
hang waiting for a process that does not exist.

Both `journal-1/**` and `**/*.lock` are unconditional hard excludes in this action.

## Configuration cache

The Gradle configuration cache saves the project configuration phase to disk. The encryption key
for the configuration cache lives in `caches/*/cc-keystore`. Sharing this key material across
runners is a security risk and is explicitly excluded.

A significant vulnerability (CVE-2023-30853) showed that environment variables containing secrets
could be inadvertently persisted into the configuration cache. Current best practice is to treat
the entire configuration cache as local-only data.

## Portability summary

**Safe to cache:**

| Pattern                         | Role                            |
| ------------------------------- | ------------------------------- |
| `caches/modules-*/files-2.1/**` | Immutable external artifacts    |
| `caches/jars-*/**`              | Cached plugin JARs              |
| `caches/build-cache-1/**`       | Task output snapshots           |
| `wrapper/dists/**`              | Downloaded Gradle distributions |

**Always excluded:**

| Pattern                     | Reason                                           |
| --------------------------- | ------------------------------------------------ |
| `**/configuration-cache/**` | May contain secrets; volatile                    |
| `**/*.lock`                 | PID-bearing; causes hangs on restore             |
| `caches/*/cc-keystore`      | Configuration-cache encryption key material      |
| `caches/journal-1/**`       | Local-only; propagates corruption                |
| `caches/transforms-*/**`    | Absolute path dependencies; environment-specific |
| `caches/[version]/**`       | Local execution history and timestamps           |
| `daemon/**`                 | Local PIDs and ephemeral logs                    |
| `native/**`                 | Platform-specific; regenerated on demand         |

Dependency metadata is cached separately as complete `dependency-metadata` snapshots under
`caches/modules-*/metadata-*/**`. It is relocatable with compatible Gradle cache formats; locks and
`caches/modules-*/**/gc.properties` are omitted.
