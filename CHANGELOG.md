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

# Changelog

## Unreleased

- Add opt-in partition `conflict-handling: choose-worker-directory` for aggregate Maven repository
  partitions. Select a complete producer directory deterministically, including differing file sets,
  rather than mixing files or parsing origin markers. Losing classifiers, origin entries and local
  installs may be unavailable downstream. Preserve strict default behavior, default cache identities,
  and checks for existing or excluded target siblings absent from the winner. Opt-in families are
  isolated by the effective policy. Enable the mode explicitly in hosted Maven distributed scenarios.

- Share Gradle and Maven cache families across Java versions, operating systems and architectures by default.
  Opt into separation with `cache-key-prefix`. Remove Java detection, probing and Java-based lifecycle
  drift checks; build tools and project inputs determine output reuse. Enable
  GitHub cross-OS archives with cache-root-relative path identity and extraction. Equal-content
  worker entries tolerate permission differences and retain executable bits; restored worker and
  snapshot files receive portable permissions. Restore executable Gradle and Maven distribution launchers
  on POSIX. Preserve strict content conflicts, Maven origins/directory checks and snapshot ownership.
  Shorter family keys start cold with no fallback to the former platform-specific families.

- Skip publication-only activity scans, replay verification, snapshot capture and generation
  decisions in read-only finalize. Preserve restore validation, lifecycle identity/configuration
  checks and build reports. Report uncollected activity statistics as unavailable and label snapshot
  counts as prepare state. Read-only completion retains no per-file publication decisions.

- Cache Gradle dependency metadata in a default `dependency-metadata` partition. Add partition
  `publication` (`aggregate` or `single-writer`) and optional distributed `writer` configuration.
  Standalone jobs own their snapshots; distributed publication uses only the designated job and
  otherwise retains the previous snapshot with a warning and GitHub summary. Full configured
  snapshot replacement propagates removals and preserves user exclusions. Preexisting managed
  metadata is replaced before restore, including clearing it on a miss, even when ordinary cleanup
  is disabled. Snapshot partitions skip per-file GC. The guarded staged representation adds a full
  copy/hash cost in standalone mode too; distributed writers also upload complete snapshots.
- Migrate to cache family 5, manifest 4, package 5, CI lifecycle 4 and local journal 2. Publication
  policy and writer identity affect layout compatibility. Earlier families start cold. Add guarded
  archive transport and interruption/retry coverage; preserve existing ordinary aggregation and
  Maven consistency checks. Correct the unsupported dependency-metadata absolute-path rationale.

- Preserve Maven `_remote.repositories` origin markers. Changed repository files travel with their
  complete managed directory; aggregation rejects different worker directory views and incomplete
  updates over existing aggregator files, including when duplicate-path overrides are enabled.
  GC retains provenance with surviving siblings. Excluded artifact siblings cause source capture,
  aggregation, and GC to fail before marker changes; custom-exclusion restores validate the existing
  tree with metadata before extraction. Whole-directory exclusions remain supported. Canonically
  order usage-only paths, including mixed-case classifiers. Use a common seeded repository and one writer
  per changed directory, or standalone mode. The changed Maven partition fingerprint starts a cold
  cache family; seed from a fresh dedicated Maven user home. Snapshots and local installs remain
  included unless excluded by caller configuration. Add real Resolver regression coverage.

- Replace pre-build content inventories with post-prepare cutoff activity. Worker envelopes carry
  assumed changed upserts and path-only usage, with no tombstones or historical last-use manifest.
  Timestamp GC uses old mtime plus current-build protection; filesystem/clock misses may cause
  useful artifacts to be redownloaded or recomputed. `off` disables deletion only.
- Migrate to cache family 4, manifest 3, package 4 and CI lifecycle 3. Old families are cold misses.
  Freeze retry decisions in bounded local journals, retire obsolete checkpoints, and publish a
  constant empty-generation marker when GC removes the last managed file.
- Keep full-generation publication optimization separate (#7). No storage redesign is introduced.

- Retain distributed worker envelopes after failed and successful aggregation so aggregator-only
  retries can recover without rerunning workers. Workers still request seven-day retention, subject
  to backend expiry or removal and workflow-run deletion. This uses temporary artifact storage;
  local staging and download directories are still cleaned up.

- Rename verified Gradle wrapper metadata to `gradle-wrapper-<version>.jar.sha256`
  and `gradle-wrapper-<version>.jar.asc`. The checksum filename lets custom launchers
  retain Mammoth's verified wrapper JAR. Scripts consuming the previous
  `gradle-wrapper-<version>.sha256` or `gradle-wrapper-<version>.asc` files must use
  the new names. Provisioning no longer writes the previous names; existing files
  at those paths are left in place.
