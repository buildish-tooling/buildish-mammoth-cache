---
title: Cache Generations and Restore Lineages
weight: 30
description: How compatible cache families, ref lineages, and immutable generations are constructed and restored.
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

## Identity model

Mammoth Cache separates three concepts that a single stable key cannot represent safely on an
immutable backend:

```text
cache family
  + ref lineage
    + immutable generation
```

A default generation key has this conceptual shape:

```text
buildish-mammoth-cache-{tool}-v{schema}-{partitionFingerprint}
  -ref-{readableRefSlug}-{refDigest12}
  -gen-{runIdentity}-{contentDigest12}
```

The action owns every compatibility and lifecycle segment. `cache-key-prefix` changes only the
leading namespace; arbitrary key templates are not supported.

## Cache family

The family identifies states that are structurally compatible. It always includes:

- the build tool (`gradle` or `maven`);
- the internal cache schema version;
- the 16-character partition fingerprint.

The default namespace prefix is `buildish-mammoth-cache-` for both actions. The build-tool segment
is action-owned, so a custom prefix cannot make Gradle and Maven families collide.

## Ref lineage

A ref lineage is a sequence of immutable generations for one family and ref. Ref tokens contain a
readable slug and a 12-character SHA-256 prefix computed from the trimmed raw ref before lossy
slugging. Distinct refs therefore remain distinct even if punctuation replacement, case folding, or
truncation gives them the same readable slug.

Restore lookup is intentionally narrow:

1. restore the newest generation under the current ref lineage;
2. if the current ref differs from the default branch, restore the newest default-branch
   generation;
3. otherwise report a miss.

Build tool, schema, and partition dimensions are never dropped during
fallback.

For pull-request events, the resolved ref is the base ref and cache operation remains read-only by
default.

## Immutable generation

A required save combines bounded writer identity (run, attempt and job) with a frozen-decision
digest containing the invocation nonce, cutoff, policy, observations and selected producer artifacts.
It does not hash the whole cache. Local retries retain this key; a fresh prepare can produce a new
key even for identical material.

Generation keys are immutable. Newest-prefix restore selects the most recent accessible generation.
Observed local or applied worker upserts, GC removal, and nonempty misses require publication.
Access-only observations and empty pristine misses do not. Fresh aggregate replay can save a redundant
complete generation; see [Base cache design](../base-cache/).

## Partition fingerprint

The `partitionFingerprint` is a 16-character hex prefix of the SHA-256 of the ordered, serialized
list of all active partitions (including their id, includes, excludes, and hard excludes). It
changes whenever:

- A built-in partition is enabled, disabled, or overridden.
- A custom partition is added or removed.
- The include or exclude globs for any active partition change.
- The global `HARD_CACHE_EXCLUDE_GLOBS` list changes.

Because the fingerprint is part of the action-owned family, layout changes automatically create a
new family without requiring a manual schema version bump.

## Rationale for each key component

These dimensions are mandatory because omitting one can mix incompatible cache state.

**Namespace prefix**
Namespaces the cache so that unrelated workflows or projects that share a cache backend do not
collide. GitHub additionally scopes caches to a repository. Jobs that should share a family must use
the same prefix and partition policy.

**Schema version**
An internal counter that is incremented whenever the structure of what gets cached changes in a
way that could cause a stale restore to break a build (for example, if a previously cached file
is now in a different location). This is distinct from the partition fingerprint: the schema
version protects against internal format changes that users do not control; the fingerprint
protects against user-controlled partition changes.

**Partition fingerprint**
Ensures that adding, removing, or adjusting a cache partition immediately produces a new key
lineage rather than restoring an entry that was built with a different partition layout and might
therefore contain stale or missing files. See the [Partition fingerprint](#partition-fingerprint)
section above.

**Java versions**
Java versions do not split cache families. Mammoth does not detect Java or invoke `java -version`.
Gradle and project-declared task inputs determine task-output reuse, including compiler and test
JVM differences. Runtime JVM and task toolchains can differ. Projects requiring stricter isolation
can include their chosen Java identity in `cache-key-prefix`, for example
`project-java${{ matrix.java }}-`. All sharing jobs must resolve the same prefix.

Maven repositories include downloaded artifacts and local installs. Environment-dependent local
installs must have distinct coordinates or use explicitly isolated namespaces; sharing an archive
cannot establish whether those bytes suit another build. Strict merge conflicts remain enforced.

**Runner OS and architecture**
OS and architecture do not split cache families. Downloaded platform artifacts should have distinct
identities, and cacheable tasks must declare platform inputs when their outputs depend on them.
Maven local installs can contain different bytes at the same coordinates: distinguish coordinates
or opt into isolation with `cache-key-prefix: project-${{ runner.os }}-${{ runner.arch }}-`.

GitHub archives use cache-root-relative paths and cross-OS archive support. Self-hosted Windows
runners need GNU tar and zstd for interoperable archives. Worker merges compare content, tolerate
permission differences and retain executable bits from either equal-content producer. Restored
worker and snapshot files receive ordinary read/write permissions plus recorded executable bits;
Gradle and Maven distribution launchers are made executable on POSIX after base restore. Exact source
permissions are not a portability contract.

The shorter family key starts a cold cache; restore does not fall back to platform-specific keys.
Producer OS/architecture remain diagnostic metadata and part of local lifecycle drift checks.

**Ref token**
Branch-scoped caching prevents long-lived topic branches from polluting the `main` cache, and
prevents ephemeral PR branches from over-writing the default-branch baseline. The default
restore sequence permits only the explicit default-branch fallback.

---

## Cache hit rate considerations

A few patterns that commonly affect hit rates in practice:

**Matrix jobs** — Java versions, OS and architecture share by default. Build-tool, schema and
partition differences still create separate families. Add environment identities to the namespace
prefix when isolation is needed.

**PR-branch caching** — the default lineage lookup lets PR branches inherit the latest
default-branch generation. Read-only PR builds do not publish generations unless a trusted workflow
operator deliberately changes that policy.

**Re-runs and attempt number** — restore searches the same lineage, while a writable rerun receives
a distinct generation identity. The delta-exchange protocol (see
[Delta Exchange Protocol](../delta-protocol/) also includes attempt identity in artifact names.

**Cold starts** — a cold start (no entry at any restore key depth) means the build downloads
everything from the network. A successful writable finalize publishes the first immutable
generation. A new branch with the same family can warm-start from the newest accessible
default-branch generation.
