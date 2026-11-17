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

- Replace pre-build content inventories with post-prepare cutoff activity. Worker envelopes carry
  assumed changed upserts and path-only usage, with no tombstones or historical last-use manifest.
  Timestamp GC uses old mtime plus current-build protection; filesystem/clock misses may cause
  useful artifacts to be redownloaded or recomputed. `off` disables deletion only.
- Migrate to cache family 4, manifest 3, package 4 and CI lifecycle 3. Old families are cold misses.
  Freeze retry decisions in bounded local journals, retire obsolete checkpoints, and publish a
  constant empty-generation marker when GC removes the last managed file.
- Defer read-only tracking optimization to #6 and full-generation publication optimization to #7.
  No inexpensive bypass or storage redesign is introduced.

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
