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
the artifact coordinates and SHA-256 checksum of the file:

```
caches/modules-2/files-2.1/<group>/<module>/<version>/<checksum>/<filename>
```

Because the path is derived solely from content, `files-2.1/` is fully portable across machines.

**`metadata-*/`** — Binary indexes that map dynamic versions and resolution results to concrete
artifacts. These indexes contain absolute file-system paths pointing back into `files-2.1/`. If the
Gradle user home is restored to a different path (e.g. `/home/runner/.gradle` vs `/Users/dev/.gradle`),
these pointers become invalid. The metadata directories should **not** be cached.

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

| Pattern                                      | Reason                                           |
| -------------------------------------------- | ------------------------------------------------ |
| `**/configuration-cache/**`                  | May contain secrets; volatile                    |
| `**/*.lock`                                  | PID-bearing; causes hangs on restore             |
| `caches/*/cc-keystore`                       | Configuration-cache encryption key material      |
| `caches/journal-1/**`                        | Local-only; propagates corruption                |
| `caches/transforms-*/**`                     | Absolute path dependencies; environment-specific |
| `caches/[version]/**`                        | Local execution history and timestamps           |
| `caches/modules-*/metadata-*/descriptors/**` | Binary pointers to absolute paths                |
| `daemon/**`                                  | Local PIDs and ephemeral logs                    |
| `native/**`                                  | Platform-specific; regenerated on demand         |
