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

## Artifact transforms

[Artifact transforms](https://docs.gradle.org/current/userguide/artifact_transforms.html) adapt
resolved dependencies before tasks consume them, for example by unpacking a JAR or rewriting its
bytecode. Gradle stores their derived outputs in transform workspaces. Their location varies by
Gradle version; layouts include `caches/transforms-*/` and `caches/<version>/transforms/`.

Transform outputs are not inherently non-portable. Gradle supports caching reproducible, relocatable
transforms through
[`@CacheableTransform`](https://docs.gradle.org/current/javadoc/org/gradle/api/artifacts/transform/CacheableTransform.html).
Reuse depends on the transform's implementation and correctly declared inputs and normalization.

Mammoth's optional `transforms-metadata` preset is disabled by default and currently matches only
`caches/transforms-*/**`. Direct workspace transport, restoration and distributed conflict handling
have not yet been qualified. This conservative default does not disable Gradle's artifact transforms
or establish that all transform workspaces are unsafe to relocate.

Cacheable transforms can also store their outputs in Gradle's build cache. Mammoth's enabled
`build-cache` partition can carry those entries independently of the disabled transform-workspace
preset.

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

Independent builds can write different origin metadata into archives with the
same key. Mammoth's built-in `build-cache` partition therefore selects one
producer's whole, unchanged archive per direct 32-hex key. The smallest producer
job name wins; distinct keys remain additive. This also resolves differing output
bytes under the same key, assuming correctly declared, reproducible work. Mammoth
does not unpack or normalize these archives. Set `conflict-handling: default` to
reject differing duplicates instead.

## Version-specific caches: `caches/<version>/`

For each Gradle version used, a dedicated directory records the operational state of that build tool
version. Some subtrees describe local execution state and are excluded:

| Pattern                               | Reason to exclude                                         |
| ------------------------------------- | --------------------------------------------------------- |
| `caches/[version]/execution-history/` | Stores local file-system timestamps and absolute paths    |
| `caches/[version]/file-hashes/`       | Index of file content signatures, keyed by absolute paths |
| `caches/[version]/java-compile/`      | Incremental compilation analysis data                     |

## Kotlin DSL workspaces

Independent producers can generate the same workspace key with different origin
metadata. The built-in `kotlin-dsl` partition captures complete immutable units
under `caches/<version>/kotlin-dsl/` and selects one producer per root with
`choose-worker-directory`. It retains all metadata, files and empty directories.
The supported layouts are:

- `scripts/<32-hex>/`: nonempty `metadata.bin`, `classes/` and
  `instrumented/classes/` directories, with other outputs such as `reports/`.
- `accessors/<32-hex>/`: nonempty `metadata.bin`, `classes.jar` and `sources.jar`.
- `accessors/<32-hex>/` with directory outputs: nonempty `metadata.bin`,
  `classes/` and `sources/`, as declared by the
  [Gradle 9.6.1 accessor implementation](https://github.com/gradle/gradle/blob/v9.6.1/platforms/core-configuration/kotlin-dsl/src/main/kotlin/org/gradle/kotlin/dsl/accessors/AccessorsClassPath.kt).
- `accessors/<32-hex>-PS/`: nonempty `metadata.bin`, `classes/` and `sources/`
  directories.

The JAR and `-PS` layouts were observed with Gradle 9.8.1;
the unsuffixed directory variant also has synthetic coverage based on the source above; unknown or incomplete modern
layouts are skipped with bounded warnings. Partial ownership fails capture.
Required directories may be empty. Legacy `caches/<version>/scripts/` content and
generated Gradle API JARs retain ordinary strict handling in the same partition.
Native references carry workspace roots and exact ordinary-file paths so both
surfaces survive publication and restore. The guarded replacement, recovery and
whole-unit GC mechanics are shared with Groovy below. `default` retains complete
capture but rejects conflicting views, including origin-only differences.

## Groovy DSL workspaces

The default `groovy-dsl` partition covers completed
`caches/<version>/groovy-dsl/<32-lowercase-hex-key>/` workspaces. The outer
`metadata.bin` records build origin and output information; it is distinct from
`metadata/metadata.bin`. Removing it can force recompilation or fail older Gradle
loaders. Both files travel with `classes/`, `instrumented/` and other workspace
outputs. Empty output directories matter: losing an empty `instrumented/` directory
caused Gradle 9.8.1 to invalidate a restored workspace in local qualification.

Mammoth checks structural completeness, file membership, directory topology and
payload integrity. It does not decode Gradle binary metadata or prove semantic
compatibility for every Gradle release. Unknown roots and incomplete source layouts
are skipped with bounded diagnostics. Partial configured membership fails capture.
Cleanup state, locks and temporary roots are excluded.

Workers upload complete changed workspaces. `choose-worker-directory` selects the
smallest producer job name for overlapping views, preserving metadata and outputs
from one producer together. Distinct workspace keys can come from different workers.
Unused keys from another project may remain cached. No hash of `GRADLE_USER_HOME`
is added to the family. Incoming units replace only managed workspace contents,
with guarded staging and recoverable replacement intent. GC uses whole units.

Each Groovy partition has an immutable base object containing native workspace paths
and a family-bound descriptor. References carry the accepted workspace roots to keep
SDK path versions consistent. Empty directories are reconstructed from validated
metadata. Changed partitions are hashed/archived directly without payload staging
copies; unchanged objects are reused. Restore moves disposable extracted inputs
into guarded workspace staging, with verified cross-filesystem fallback where needed.
Workers continue to stage full changed units for envelope upload. Missing base objects
start their partitions cold without discarding unrelated validated cache partitions.

Local Linux qualification covered Gradle 8.7 and 9.8.1, relocation, and Java 21/25.
The end-to-end Mammoth regression uses Gradle 9.8.1 with Java 21/25 and a Kotlin DSL
control. Gradle 8.14.6 and 9.9.1 source inspection informs the metadata requirement;
those versions were not runtime-qualified here. Native Windows/macOS and hosted
artifact-action parity remain unqualified. These results establish reuse for the
tested fixtures, with no general performance or universal compatibility claim.

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

Compiled Kotlin DSL scripts and generated Gradle API JARs are also included by the
`kotlin-dsl` partition; recognized Kotlin and Groovy workspaces use the complete-unit
transport above.

**Always excluded:**

| Pattern                     | Reason                                      |
| --------------------------- | ------------------------------------------- |
| `**/configuration-cache/**` | May contain secrets; volatile               |
| `**/*.lock`                 | PID-bearing; causes hangs on restore        |
| `caches/*/cc-keystore`      | Configuration-cache encryption key material |
| `caches/journal-1/**`       | Local-only; propagates corruption           |

**Omitted by defaults, but configurable through custom partitions:**

| Pattern                                 | Reason for default omission                               |
| --------------------------------------- | --------------------------------------------------------- |
| `caches/transforms-*/**`                | Disabled preset; direct workspace reuse not yet qualified |
| `caches/[version]/execution-history/**` | Local execution history and timestamps                    |
| `caches/[version]/file-hashes/**`       | Local absolute-path indexes                               |
| `daemon/**`                             | Local PIDs and ephemeral logs                             |
| `native/**`                             | Platform-specific; regenerated on demand                  |

Dependency metadata is cached separately as complete `dependency-metadata` snapshots under
`caches/modules-*/metadata-*/**`. It is relocatable with compatible Gradle cache formats; locks and
`caches/modules-*/**/gc.properties` are omitted.
