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

This is split across `src/delta/discovery.ts` (bounded rerun selection), `src/delta/service.ts`
(staging, upload, download, and package verification), and `src/delta/apply.ts` (merge and apply).
The shared prepare/finalize phases call these functions at the right points in the two-phase
lifecycle.

Read-only execution deliberately does not enter this protocol. Workers upload no envelope, and an
aggregator returns `skipped-read-only` before obtaining an artifact backend or performing discovery,
download, validation, merge, apply, or deletion.

---

## Artifact naming

Every delta artifact gets a deterministic name derived from job metadata and content:

```
buildish-mammoth-cache-delta-{sanitized-job-name}-run-{runId}-attempt-{runAttempt}-{familyDigest12}-{deltaManifestDigest12}
```

- **`sanitized-job-name`** — a readable 24-character slug followed by an 8-character digest of
  the producer's exact CI job name. The digest keeps distinct long or similarly sanitized job
  names from sharing a discovery prefix.
- **`run-{runId}` / `attempt-{runAttempt}`** — the CI run ID and attempt number, which scope
  every artifact to a single workflow execution. Re-runs produce new artifacts with an
  incremented attempt number and do not collide with the previous run.
- **`{familyDigest12}`** — first 12 hex characters of the SHA-256 of the action-owned cache
  family. The complete family and lineage remain in the validated envelope.
- **`{deltaManifestDigest12}`** — first 12 hex characters of the SHA-256 of the portable delta
  manifest JSON. Makes the name content-addressable: identical builds produce identical names,
  different builds produce different names.

The full name must match `^[A-Za-z0-9._-]{1,128}$` — the character set accepted by
`@actions/artifact`.

The stable discovery prefix ends after `run-{runId}-`. The aggregator lists all artifacts for the
current run once and, for each configured worker, selects the highest producer attempt not greater
than its own attempt. This supports full reruns, failed-job reruns that mix old and new worker
attempts, and aggregator-only reruns. Two artifacts for the same worker and attempt are ambiguous
and fail aggregation. Artifacts from another run ID are never searched.

---

## Package structure

Each delta artifact is a flat directory uploaded as a single CI artifact. It always contains
exactly three kinds of entries:

| Path                     | Description                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delta-package.json`     | Version 2 envelope: producer/run/source identity, runner and ref identity, cache family/lineage/base/digest identity, partition identity, manifest digest, and payload metadata. |
| `delta-manifest.json`    | The portable cache delta manifest (see below).                                                                                                                                   |
| `payload/{sequence}.bin` | One file per changed cache entry. Generated sequential names never reuse the original cache-relative path.                                                                       |

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

1. Discovery bounds total current-run metadata, candidates per worker, and selected compressed
   artifact size.
2. The artifact digest reported by the CI artifact service is checked (when available).
3. Expanded package size and manifest entry count are bounded before use.
4. `delta-package.json` is parsed against the Zod schema and its name, repository, workflow, run,
   producer job/attempt, and source revision (when available) are checked against selection.
5. Cache family, ref lineage, ref/default branch, runner, partition fingerprint, and ordered
   partition IDs must match the aggregator.
6. `delta-manifest.json` is hashed; its SHA-256 must match `deltaManifestSha256` in the metadata.
7. Every payload file listed in `payloadEntries` is hashed; each digest must match
   `contentSha256`, and the file size must match `size`.
8. No extra files may be present beyond what is declared in the metadata.

If any check fails the entire artifact is rejected with a descriptive error before the merge
step starts.

---

## Merge algorithm

The aggregator first selects every required worker artifact, then downloads and verifies them
without mutating the cache, and finally merges them into a single
`MergedDeltaPlan` (`mergeDeltaArtifactPackages` in `src/delta/apply.ts`). Filesystem inspection and
mutation live separately in `src/delta/apply-execution.ts`; `src/delta/apply.ts` re-exports the
execution API so existing consumers retain one stable facade.

The merge is per-partition and per-relative-path:

- If a path appears in only one worker's delta it is taken as-is.
- If a path appears in two or more worker deltas with **identical** content (same SHA-256), the
  entry is deduplicated and every compatible previous state is retained as an apply precondition.
  This covers the common case where workers started from different compatible generations and
  downloaded the same dependency JAR.
- Deletions with different previous states are compatible because they share the same desired
  absent state; each declared previous state remains an accepted precondition.
- If a path appears in two or more worker deltas with **different** content, it is recorded as a
  conflict. All conflicts across all paths are collected before the error is thrown, so the
  operator can see the full picture in one go rather than re-running to discover the next
  conflict.

The `allowDuplicateDependentDeltaPaths` option relaxes conflict detection: when set, two entries
for the same path are resolved by taking the one with the newer `mtimeMs`. Use this only when
you know the conflicting files are semantically equivalent (e.g. resolver-marker files whose
content varies only by timestamp). Only the selected winner's previous state is accepted; losing
entries cannot broaden its precondition.

---

## Apply phase

`applyMergedDeltaPlan` applies the merged delta through a two-stage protocol:

1. Every target is inspected before any mutation. It must already match the desired state or one
   of the compatible workers' declared previous states. Snapshot comparison uses content SHA-256,
   size, mode, and modification time; access time is not a precondition.
2. Any mismatch rejects the complete plan before a path changes.
3. Targets already matching the desired state, including already-absent deletions, are idempotent
   no-ops.
4. Each target selected for mutation is re-inspected immediately before it changes. A concurrent
   change aborts application rather than being silently overwritten.
5. Added and modified payloads are copied through a temporary file and atomic rename, then `chmod`
   and `utimes` preserve the declared mode and timestamps. Deleted targets are removed.

Payload hashes are checked during package validation and again while copying. A mismatch is a hard
error. Once mutation begins, the cache filesystem is not globally transactional; a later I/O or
concurrency failure can leave earlier per-path mutations in place, and the enclosing lifecycle must
not publish that partial state as a new generation.

---

## Schema versioning

`DELTA_ARTIFACT_PACKAGE_SCHEMA_VERSION` (currently `2`) is embedded in every
`delta-package.json`. The Zod validator requires that exact version, so a package
produced by a future version of Mammoth Cache that increments this field will be rejected
cleanly rather than silently misinterpreted. Increment the constant and update the schema only
when the format changes in a backwards-incompatible way.

## Resource contract and cleanup

The v2 exchange fails before cache mutation when a run exposes more than 1,000 artifact metadata
records, one configured worker has more than 100 candidate envelopes, a selected artifact reports
more than 2 GiB provider-reported size, an extracted package exceeds 4 GiB, or a delta manifest exceeds
200,000 entries. These are action-level availability limits in addition to provider limits.

Workers upload one envelope even when the delta is empty. An empty envelope proves that the worker
completed successfully; a missing envelope remains a hard aggregation failure. Staging and download
temporary directories are removed on success and on validation, download, or packaging failure.
Aggregator cleanup uses all-settled semantics so every successfully downloaded sibling gets a
cleanup attempt. Cleanup failures are reported separately and never replace the primary validation,
download, packaging, upload, or application error.
