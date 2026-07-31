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
buildish-mammoth-cache-{tool}-v{schema}-{java}-{os}-{arch}-{partitionFingerprint}
  -ref-{readableRefSlug}-{refDigest12}
  -gen-{runIdentity}-{contentDigest12}
```

The action owns every compatibility and lifecycle segment. `cache-key-prefix` changes only the
leading namespace; arbitrary key templates are not supported.

## Cache family

The family identifies states that are structurally compatible. It always includes:

- the build tool (`gradle` or `maven`);
- the internal cache schema version;
- detected Java major (`0` when Java is unavailable);
- runner OS and architecture;
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

OS, architecture, Java, build tool, schema, and partition dimensions are never dropped during
fallback.

For pull-request events, the resolved ref is the base ref and cache operation remains read-only by
default.

## Immutable generation

Every save uses a new generation key. The generation suffix combines a bounded writer identity
(workflow run, attempt, and job digest) with the first 12 characters of the canonical full-manifest
SHA-256 digest.

The canonical digest includes build tool, ordered partitions, relative path, content SHA-256, size,
mode, and modification time. It excludes access time and the machine-specific absolute cache root.

Generation keys are never overwritten. On the next run, newest-prefix lookup restores the most
recent accessible generation in the selected lineage.

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

**Java major**
Gradle and Maven both compile plugin code and resolve version constraints with the active JVM.
The internal format of some cached artifacts (for example, Gradle's daemon registry or certain
build tool resolver caches) can differ across major Java versions. Separating the cache by major
version avoids subtle compatibility problems when a project is built with Java 17 one day and
Java 21 the next.

**Runner OS and architecture**
Native binaries, platform-specific ZIP distributions, and OS-dependent path separators all mean
that a Gradle or Maven cache populated on Linux is unsafe to restore on macOS or Windows.
Separating by OS and architecture keeps the cache coherent.

**Ref token**
Branch-scoped caching prevents long-lived topic branches from polluting the `main` cache, and
prevents ephemeral PR branches from over-writing the default-branch baseline. The default
restore sequence permits only the explicit default-branch fallback.

---

## Cache hit rate considerations

A few patterns that commonly affect hit rates in practice:

**Matrix jobs** — Java, OS, architecture, and partition differences automatically create separate
families. Independent jobs share only when every mandatory dimension matches.

**PR-branch caching** — the default lineage lookup lets PR branches inherit the latest
default-branch generation. Read-only PR builds do not publish generations unless a trusted workflow
operator deliberately changes that policy.

**Re-runs and attempt number** — restore searches the same lineage, while a writable rerun receives
a distinct generation identity. The delta-exchange protocol (see
[Delta Exchange Protocol](../delta-protocol/)) also includes attempt identity in artifact names.

**Cold starts** — a cold start (no entry at any restore key depth) means the build downloads
everything from the network. A successful writable finalize publishes the first immutable
generation. A new branch with the same family can warm-start from the newest accessible
default-branch generation.
