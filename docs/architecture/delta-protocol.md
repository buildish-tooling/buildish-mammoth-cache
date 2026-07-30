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

Delta exchange is the mechanism that lets a distributed-aggregator job reuse the build-tool
cache populated by multiple parallel worker jobs, **without** any of them sharing a common
filesystem.

The central idea is simple: each worker captures a snapshot of its cache _before_ and _after_
the build (via `captureCacheManifest`), computes the diff, compresses the changed files, and
uploads the result as a CI artifact. The aggregator then downloads every worker's artifact,
merges the diffs, and writes the combined set of files into its own local cache.

All of this lives in `src/delta/service.ts` (staging, uploading, finding, downloading) and
`src/delta/apply.ts` (merging and applying). The shared bootstrap/finalize phases call these
functions at the right points in the two-phase lifecycle.

---

## Artifact naming

Every delta artifact gets a deterministic name derived from job metadata and content:

```
buildish-mammoth-cache-delta-{sanitized-job-name}-run-{runId}-attempt-{runAttempt}-{cacheKeyDigest12}-{deltaManifestDigest12}
```

- **`sanitized-job-name`** — the producer's CI job name, restricted to `[A-Za-z0-9._-]` and
  truncated at 48 characters. Spaces, slashes, and other characters from matrix job names are
  replaced with underscores.
- **`run-{runId}` / `attempt-{runAttempt}`** — the CI run ID and attempt number, which scope
  every artifact to a single workflow execution. Re-runs produce new artifacts with an
  incremented attempt number and do not collide with the previous run.
- **`{cacheKeyDigest12}`** — first 12 hex characters of the SHA-256 of the full cache key.
  Ensures that an artifact built with one cache key is never matched by a query for a different
  key.
- **`{deltaManifestDigest12}`** — first 12 hex characters of the SHA-256 of the portable delta
  manifest JSON. Makes the name content-addressable: identical builds produce identical names,
  different builds produce different names.

The full name must match `^[A-Za-z0-9._-]{1,128}$` — the character set accepted by
`@actions/artifact`.

The **aggregator discovery** step only needs the prefix
`buildish-mammoth-cache-delta-{sanitized-job-name}-run-{runId}-attempt-{runAttempt}-` to find
exactly one artifact per worker job. If zero or more than one artifact matches, an error is
thrown rather than proceeding with ambiguous state.

---

## Package structure

Each delta artifact is a flat directory uploaded as a single CI artifact. It always contains
exactly three kinds of entries:

| Path                  | Description                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delta-package.json`  | Top-level metadata: schema version, artifact type tag, producer job context, cache key, SHA-256 of the manifest, and one `payloadEntries` record per changed file.   |
| `delta-manifest.json` | The portable cache delta manifest (see below).                                                                                                                       |
| `payload/{uuid}`      | One file per changed cache entry. The filename is a random UUID — never the original cache-relative path — so the archive cannot be used for path-traversal attacks. |

No other files are permitted. The download-and-verify step (`verifyExtractedDeltaArtifactPackage`)
checks that the set of actual files on disk matches the declared set exactly, before any content
is read or applied.

---

## Portable delta manifest and the cache-root sentinel

The delta manifest records, for each cache partition, the set of added, modified, and deleted
files relative to the cache root. Worker absolute filesystem paths must not leave the worker
machine, because the aggregator may run on a different runner with a different home directory.

To make manifests portable, `stageDeltaArtifactPackage` replaces the worker's absolute cache
root with the sentinel string `<portable-cache-root>` (`PORTABLE_CACHE_ROOT`). The download
verifier enforces this: a package whose manifest still contains a real path is rejected.

When applying the merged delta, `applyMergedDeltaPlan` substitutes the sentinel back with the
aggregator's own cache root, resolved safely through `resolveNormalizedPathWithinRoot` to
prevent path traversal.

---

## Payload integrity verification

Before any file is written to the cache, the download step verifies each payload file
independently:

1. The artifact digest reported by the CI artifact service is checked (when available).
2. `delta-package.json` is read and parsed against the Zod schema.
3. `delta-manifest.json` is hashed; its SHA-256 must match `deltaManifestSha256` in the metadata.
4. Every payload file listed in `payloadEntries` is hashed; each digest must match
   `contentSha256`, and the file size must match `size`.
5. No extra files may be present beyond what is declared in the metadata.

If any check fails the entire artifact is rejected with a descriptive error before the merge
step starts.

---

## Merge algorithm

The aggregator downloads all worker artifacts in parallel and then merges them into a single
`MergedDeltaPlan` (`mergeDeltaArtifactPackages` in `src/delta/apply.ts`).

The merge is per-partition and per-relative-path:

- If a path appears in only one worker's delta it is taken as-is.
- If a path appears in two or more worker deltas with **identical** content (same SHA-256), the
  entry is deduplicated silently. This covers the common case where multiple workers download
  the same dependency JAR.
- If a path appears in two or more worker deltas with **different** content, it is recorded as a
  conflict. All conflicts across all paths are collected before the error is thrown, so the
  operator can see the full picture in one go rather than re-running to discover the next
  conflict.

The `allowDuplicateDependentDeltaPaths` option relaxes conflict detection: when set, two entries
for the same path are resolved by taking the one with the newer `mtimeMs`. Use this only when
you know the conflicting files are semantically equivalent (e.g. resolver-marker files whose
content varies only by timestamp).

---

## Apply phase

`applyMergedDeltaPlan` writes the merged delta to the aggregator's cache root:

- **Added / modified** entries: the payload file is copied to the target path, then `chmod` and
  `utimes` are applied to preserve the original file mode and modification timestamp. The copy
  uses a rename-from-temp strategy to avoid partial writes if the process is interrupted.
- **Deleted** entries: the target path is removed. A missing file is treated as a no-op (not an
  error) because the aggregator may have started with a partially warm cache.
- Warnings are emitted (never errors) when a delete target is missing or a copy's content hash
  does not match the manifest after writing — the latter indicating filesystem corruption.

---

## Schema versioning

`DELTA_ARTIFACT_PACKAGE_SCHEMA_VERSION` (currently `1`) is embedded in every
`delta-package.json`. The Zod validator uses `z.literal(1)` for `schemaVersion`, so a package
produced by a future version of Mammoth Cache that increments this field will be rejected
cleanly rather than silently misinterpreted. Increment the constant and update the schema only
when the format changes in a backwards-incompatible way.
