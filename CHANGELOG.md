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

- Enable the Gradle dependency layer by default. Set `dependency-cache-layer: false` across
  cooperating jobs to keep the ordinary cache family and its timestamp GC policy.
- Let Gradle select among the metadata layouts in the read-only dependency seed, removing the
  exact Gradle 9.6.1 requirement.

- Switch Gradle and Maven to partition v2 and generation v3, with an appended
  nullable generation slot reserved for future sweeps. Local handoffs use v4;
  worker TAR remains v2. Upgrade cooperating jobs together; older families start cold.
- Split Gradle dependency artifacts (`modules-2/files-2.1`) from writable JAR and
  resource support. Keep all `modules-2/metadata-*` snapshots under their existing
  designated writer. Retired `modules` overrides require explicit migration.
- Add opt-in Gradle dependency layers for qualified 9.6.1 wrapper workers. Owned
  seeds stay outside writable capture and retire after registered consumers stop.
  Publishers retain eligible partitions; sweeps and Maven layering are deferred.
  Add a seed-path output and optional environment export, with ordinary fallback
  for unsupported or incomplete cohorts. Main-branch CI qualifies warm writable
  workers on Linux, Windows and macOS.
- Publish changed native partition objects before the immutable generation.
  Reuse exact refs for unaffected partitions, including when only lineage
  metadata changes. Base change detection uses filesystem metadata and can
  miss byte rewrites that preserve it. Incoming worker bodies and complete
  units still receive strict validation.
- Use dedicated cache roots and an exclusive prepare/post window. Gradle writable
  publication verifies consumer quiescence. Transfers require source return
  after SDK settlement in the owning operation. Interrupted owners are rejected.
  Failed worker uploads may retain immutable packages at reported paths.
- Configure `cache-max-directory-entries` for either Action. It defaults to
  `100000` direct entries per managed directory. The working-memory bounds
  remain independent and the Action log identifies the phase and directory.
- Preserve complete Gradle Groovy, Kotlin and transform workspaces and
  designated dependency-metadata snapshots. Use per-entry selection for
  eligible Gradle task-cache archives. Maven retains origin markers and supports
  opt-in complete-directory selection alongside the strict default.
- Share compatible cache families across Java versions, operating systems
  and architectures. Build tools still determine reuse, and native permissions
  depend on the restoring host. Use `cache-key-prefix` to separate incompatible
  workloads deliberately.
- Worker artifact retention is configurable with `worker-artifact-retention-days`
  from 1 to 400, defaulting to 7. Backend retention and workflow lifetime
  determine actual availability. Successful aggregation retains worker artifacts.
- Use post-prepare timestamp and activity evidence for GC. Read-only post skips
  activity capture and publication.

- Rename verified Gradle wrapper metadata to `gradle-wrapper-<version>.jar.sha256`
  and `gradle-wrapper-<version>.jar.asc`. The checksum filename lets custom launchers
  retain Mammoth's verified wrapper JAR. Scripts consuming the previous
  `gradle-wrapper-<version>.sha256` or `gradle-wrapper-<version>.asc` files must use
  the new names. Provisioning no longer writes the previous names; existing files
  at those paths are left in place.
