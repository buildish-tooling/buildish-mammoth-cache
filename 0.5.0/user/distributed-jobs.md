---
title: Distributed Multi-Job Builds
weight: 30
description: How to use the distributed worker/aggregator mode to cache builds that run as multiple parallel jobs.
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

## Why distributed mode exists

When multiple build jobs run in parallel and each publishes an independent full-cache generation,
those generations diverge. Restoring only the newest one loses dependency downloads and other cache
changes that exist solely in the other workers' generations.

Distributed mode solves this with **delta exchange**:

- Each **worker job** uploads assumed changed files and path-only activity observations for aggregate
  partitions, plus complete snapshots for any single-writer partitions it owns. It does not write
  the base cache directly.
- An **aggregator job**, which waits for all workers to complete, downloads every delta, merges
  them, and saves the merged result as the new base cache entry.

Observed parallel changes in aggregate partitions are combined. Single-writer partitions use
only their designated writer's complete snapshot. On the next run, all workers start from a cache that
reflects the combined output of every job from the previous run.

```mermaid
sequenceDiagram
    participant BC as Base cache
    participant WA as Worker A
    participant WB as Worker B
    participant AG as Aggregator

    BC-->>WA: restore
    BC-->>WB: restore
    WA->>WA: build + compute delta
    WB->>WB: build + compute delta
    WA-->>AG: upload Δ-A artifact
    WB-->>AG: upload Δ-B artifact
    AG->>AG: download Δ-A + Δ-B
    AG->>AG: merge deltas
    AG->>BC: save merged cache entry
```

## How delta exchange works

1. Worker prepare restores the base and records a cutoff after its own reads/writes.
2. The build runs normally.
3. Worker finalize scans metadata before its own content reads and uploads selected upserts/usage.
   Empty observation sets still produce completion envelopes. Workers never save the base.
4. Aggregate prepare validates and applies selected envelopes and retains upstream activity
   before recording its own cutoff.
   Used-only paths do not recreate absent files.
5. Aggregate finalize performs eligible GC and requires successful publication for upserts, GC
   removal or a nonempty miss. A successful sweep also publishes its completion timestamp.
   Usage alone does not require a generation. Base reuse follows
   observed metadata and may miss byte rewrites with identical metadata. Aggregate partitions exchange no deletion tombstones. A
   single-writer snapshot replaces its complete configured membership, including removals, and
   metadata-only changes independently require publication.

On pull-request events, read-only mode performs no exchange: workers upload nothing, and an
aggregator returns `skipped-read-only` without listing, downloading, validating, applying, or
deleting artifacts. This makes a static topology safe, but a workflow should avoid allocating the
aggregator runner when it can express the writable-event condition directly.

## Gradle metadata writer

Gradle's `dependency-metadata` partition is enabled by default and uses `single-writer`
publication. Choose one existing worker as its metadata writer and pass the **same** partition
configuration to every worker and the aggregator. The writer is identified by Mammoth's producer
job identity, which defaults to the workflow job ID. If you set `github-job-name` for a matrix or
reusable workflow, use that exact identity for `writer` and `dependent-jobs` too. Matrix producers
must have distinct identities; a writer designates one producer, not the entire matrix.

Only that job's complete configured metadata set replaces the previous snapshot. Other workers'
artifact downloads still aggregate normally; their local dependency-metadata updates do not.
Choose a writer whose build resolves the dependencies you want covered. Metadata learned only by
other jobs may need resolution again later. A validated snapshot qualifies even if its build failed.

An aggregator owns the complete snapshot when no `writer` is configured or when it names itself.
In either case its own post-build metadata wins. If another job is named, that job's snapshot or
the prepared fallback remains authoritative despite the aggregator's local changes.

### Complete workflow with an existing worker as writer

The following workflow is also available in the repository as
`examples/gradle-distributed.yml`. Adapt the module tasks and replace `<commit-sha>` with the
Mammoth version you deploy.

```yaml
name: Gradle distributed cache
on: [push, pull_request, workflow_dispatch]

permissions:
  contents: read

env:
  MAMMOTH_CACHE_PARTITIONS: '[{"id":"dependency-metadata","writer":"worker-a"}]'

jobs:
  worker-a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@be666c2fcd27ec809703dec50e508c2fdc7f6654
        with:
          distribution: temurin
          java-version: '21'
      - uses: buildish-tooling/buildish-mammoth-cache/actions/github/gradle@<commit-sha>
        with:
          job-mode: distributed-worker
          cache-partitions: ${{ env.MAMMOTH_CACHE_PARTITIONS }}
      - run: ./gradlew :module-a:build

  worker-b:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@be666c2fcd27ec809703dec50e508c2fdc7f6654
        with:
          distribution: temurin
          java-version: '21'
      - uses: buildish-tooling/buildish-mammoth-cache/actions/github/gradle@<commit-sha>
        with:
          job-mode: distributed-worker
          cache-partitions: ${{ env.MAMMOTH_CACHE_PARTITIONS }}
      - run: ./gradlew :module-b:build

  aggregator:
    needs: [worker-a, worker-b]
    if: ${{ always() && github.event_name != 'pull_request' && github.event_name != 'pull_request_target' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@be666c2fcd27ec809703dec50e508c2fdc7f6654
        with:
          distribution: temurin
          java-version: '21'
      - uses: buildish-tooling/buildish-mammoth-cache/actions/github/gradle@<commit-sha>
        with:
          job-mode: distributed-aggregator
          cache-partitions: ${{ env.MAMMOTH_CACHE_PARTITIONS }}
          dependent-jobs: worker-a, worker-b
```

This chooses `worker-a` without an extra job. Because both workers are also listed in
`dependent-jobs`, both ordinary completion envelopes remain required. `needs` ensures their
post actions finish before aggregate prepare performs artifact discovery.

### Optional metadata writer that can be skipped

A writer reference is optional snapshot discovery. To permit a metadata-only job to be skipped,
include it in `needs` for ordering, but omit it from `dependent-jobs`. The ordinary build worker
remains required. This example is available as `examples/gradle-optional-metadata-writer.yml`.
It runs a second build to populate the writer's metadata; use an existing suitable worker when
that extra work is unnecessary.

```yaml
name: Gradle cache with optional metadata writer
on:
  push:
  pull_request:
  workflow_dispatch:
    inputs:
      run_metadata:
        description: Run the metadata writer
        type: boolean
        default: true

permissions:
  contents: read

env:
  MAMMOTH_CACHE_PARTITIONS: '[{"id":"dependency-metadata","writer":"metadata"}]'

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@be666c2fcd27ec809703dec50e508c2fdc7f6654
        with:
          distribution: temurin
          java-version: '21'
      - uses: buildish-tooling/buildish-mammoth-cache/actions/github/gradle@<commit-sha>
        with:
          job-mode: distributed-worker
          cache-partitions: ${{ env.MAMMOTH_CACHE_PARTITIONS }}
      - run: ./gradlew build

  metadata:
    if: ${{ github.event_name != 'pull_request' && github.event_name != 'pull_request_target' && (github.event_name != 'workflow_dispatch' || inputs.run_metadata) }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@be666c2fcd27ec809703dec50e508c2fdc7f6654
        with:
          distribution: temurin
          java-version: '21'
      - uses: buildish-tooling/buildish-mammoth-cache/actions/github/gradle@<commit-sha>
        with:
          job-mode: distributed-worker
          cache-partitions: ${{ env.MAMMOTH_CACHE_PARTITIONS }}
      - run: ./gradlew build

  optional-aggregator:
    needs: [build, metadata]
    if: ${{ always() && github.event_name != 'pull_request' && github.event_name != 'pull_request_target' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@be666c2fcd27ec809703dec50e508c2fdc7f6654
        with:
          distribution: temurin
          java-version: '21'
      - uses: buildish-tooling/buildish-mammoth-cache/actions/github/gradle@<commit-sha>
        with:
          job-mode: distributed-aggregator
          cache-partitions: ${{ env.MAMMOTH_CACHE_PARTITIONS }}
          dependent-jobs: build
```

On a manual run with `run_metadata: false`, the aggregator still runs and imports the required
`build` envelope. The missing metadata contribution leaves the previous snapshot unchanged and
produces a warning and GitHub summary entry. If no previous snapshot exists, metadata remains
absent. If the metadata job does run, only its metadata snapshot is imported; its ordinary artifact
updates are ignored because it is not in `dependent-jobs`.

If that job is also required for ordinary cached files, list it in `dependent-jobs`; skipping it
will then fail aggregation as a missing required worker. A malformed, ambiguous, corrupt, or
incompatible writer contribution fails validation rather than silently falling back. An explicit
empty snapshot is valid and clears the configured partition; it differs from an absent snapshot.

### Defaults and operational behavior

With no writer configured, distributed mode preserves the previous metadata, warns, and explains
how to select a writer in the GitHub summary. Configure the same writer everywhere: writer and
publication policy affect the cache family, so changing them starts a cold cache. Existing cache
families are cold misses after this protocol update too.

The metadata partition must start without managed files. A miss leaves it empty at
restore time. Excluded files remain. Explicit include/exclude overrides are allowed,
and their effect on Gradle's internal metadata relationships is the user's responsibility.

Authoritative snapshot bytes may be held independently of a job's mutable Gradle
data. An assigned writer uploads its complete managed snapshot. Standalone jobs
normally publish their own observed snapshot. Snapshot partitions skip Mammoth's per-file GC. Artifact GC
continues independently, so metadata can refer to evicted artifacts and offline completeness is
not guaranteed. See [Cache partitions](../cache-partitions/#publication-policies) and
[Gradle cache internals](../../architecture/gradle-cache-internals/).

## Maven workflow example

```yaml
jobs:
  worker-a:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@be666c2fcd27ec809703dec50e508c2fdc7f6654
        with:
          distribution: temurin
          java-version: '21'
      - uses: buildish-tooling/buildish-mammoth-cache/actions/github/maven@<commit-sha>
        with:
          job-mode: distributed-worker
      - run: mvn -pl module-a verify

  worker-b:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@be666c2fcd27ec809703dec50e508c2fdc7f6654
        with:
          distribution: temurin
          java-version: '21'
      - uses: buildish-tooling/buildish-mammoth-cache/actions/github/maven@<commit-sha>
        with:
          job-mode: distributed-worker
      - run: mvn -pl module-b verify

  aggregator:
    needs: [worker-a, worker-b]
    if: ${{ always() && github.event_name != 'pull_request' && github.event_name != 'pull_request_target' }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@be666c2fcd27ec809703dec50e508c2fdc7f6654
        with:
          distribution: temurin
          java-version: '21'
      - uses: buildish-tooling/buildish-mammoth-cache/actions/github/maven@<commit-sha>
        with:
          job-mode: distributed-aggregator
          dependent-jobs: worker-a, worker-b
```

## Periodic GC

Workers and aggregators check `dependency-gc-due` during prepare. Each job discovers its own
generation in the shared cache family. While GC is fresh, eligible workers can use OverlayFS or
the Gradle read-only seed. Due writable jobs use the ordinary writable capture path to observe
dependency access times. An aggregator may still publish ordinary changes when coverage is
insufficient for a sweep.

The aggregator checks full coverage against its effective `dependent-jobs` list. Include every
worker whose workload you expect to count, including conditional workers and the metadata writer
where applicable. Each listed worker must provide usable sweep evidence from the current run and
attempt for the exact generation the aggregator restored. If workers restore different generations,
Mammoth warns and excludes the mismatched evidence from sweep coverage. A snapshot writer discovered
outside the list can still supply usable activity. A subset passed to `dependent-jobs` is the subset
the aggregator checks. An empty list cannot establish full coverage.

Coverage uses Mammoth job names, which default to workflow job IDs. If you set `github-job-name`,
use those exact names in `dependent-jobs`. Mammoth does not expand a matrix job name into its cells
or infer which cells ran. Matrix contributions count by their distinct configured producer names.

With the defaults, GC is due three days after the last completed sweep. An aggregator can sweep
with incomplete coverage after one more day, provided it can still prepare and publish under the
ordinary artifact rules. A required envelope missing from `dependent-jobs` still fails ordinary
prepare. A generation with no recorded sweep is due immediately, and forcing is immediately eligible
when enabled. See [`dependency-gc-interval-days`](../configuration/#dependency-gc-interval-days)
and [`dependency-gc-force-grace-days`](../configuration/#dependency-gc-force-grace-days).

Access evidence is best effort. A Gradle or Maven build-cache hit can skip work that would have read
a dependency. A worker can complete capture even if its build step was skipped. An old dependency
can then be evicted and downloaded again on a later build.

### Use the due hint with conditional jobs

Workflows that already run their full worker set can keep their existing job graph. If you select
workers using change detection, you can add an earlier job with `job-mode: prepare-only`. Use the
same cache-family inputs and ref settings that the workers and aggregator use. This mode reads the
generation record and emits `dependency-gc-due`. It skips restoring partitions and provisioning the
build tool. Expose the step output as a job output and let an explicit `'true'` run all worker jobs
that contribute to the full set. Keep your existing gates for `false` and `unknown`, including any
trusted event or ref conditions.

For example, add this job alongside an existing `changes` job and add the planner to each gated
worker's `needs`. This excerpt shows one worker gate. Keep each worker's normal prepare, build, and
post lifecycle.

```yaml
jobs:
  cache-plan:
    runs-on: ubuntu-latest
    outputs:
      dependency-gc-due: ${{ steps.mammoth.outputs.dependency-gc-due }}
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: buildish-tooling/buildish-mammoth-cache/actions/github/gradle@<commit-sha>
        id: mammoth
        with:
          job-mode: prepare-only
          config-file: .github/buildish-mammoth-gradle.yml

  worker-a:
    needs: [changes, cache-plan]
    if: ${{ needs.cache-plan.outputs.dependency-gc-due == 'true' || needs.changes.outputs.run-worker-a == 'true' }}
    # Keep the existing runner and worker steps here.
```

Each job still performs its own lookup. The planner output is a scheduling hint. The aggregator
checks the artifacts it actually admits before deciding whether to sweep. If your aggregator also
runs after some workers were skipped, pass the effective producer list for that execution. Pass the
full list when the due hint opens all gates.

## Requirements and constraints

Upgrade all workers, snapshot writers, aggregators and cache readers together
when changing incompatible Action versions. The native v2 and worker TAR-v2
profiles use a new family, so older base objects produce cold misses.
Start each worker and aggregator with an empty managed cache area and run Mammoth
before other restores or build-tool invocations. Keep the roots exclusive through
prepare, build and post. Read-only jobs restore base files under the same admission
rules. See [restore admission failures](../troubleshooting/#restore-admission-failures).

**Job names must be unique within the workflow run.** Delta artifacts are identified by job name.
Two worker jobs with the same name would produce the same artifact name and the aggregator would
only see one of them.

**The aggregator must declare `needs` for every consumed worker and optional metadata writer.** This ensures all deltas are uploaded
before the aggregator starts and consumes them during prepare.

**Choose whether aggregation should run after worker failures.** Use `if: always()` together with
trusted event/ref conditions when you want to consume valid envelopes from failed builds or report
missing envelopes. A skipped worker or a missing post upload, including after cancellation, leaves
a required envelope absent. Pull-request aggregators may be omitted entirely; if they do run, their
read-only result is the explicit no-op described above.

**Workers do not need the aggregator in their `needs`.** Workers are independent of each other;
only the aggregator depends on all workers.

**Re-runs reuse retained worker envelopes.** For each worker, the aggregator selects the highest available producer
attempt that is not newer than its own attempt. A full rerun uses every new worker envelope; a
failed-job rerun safely mixes rerun workers with retained earlier attempts; and an aggregator-only
rerun reuses retained worker envelopes. Selection never crosses workflow run IDs.

Mammoth retains worker envelopes after failed and successful aggregation, including when no new
cache generation is needed. Workers request seven days of artifact retention by default. Set
`worker-artifact-retention-days` on either action to request a shorter period, for example one day
to reduce artifact residence:

```yaml
- uses: buildish-tooling/buildish-mammoth-cache/actions/github/gradle@<commit-sha>
  with:
    job-mode: distributed-worker
    worker-artifact-retention-days: 1
```

Shorter retention narrows the selective or aggregator-only retry window and can require rerunning
expired workers. Base cache expiry and timestamp GC are independent. Retry availability
ends when the backend expires or removes the artifacts, the workflow run is deleted, or a user or
administrator removes them. Repository, organization, and backend limits can shorten the requested
period; availability for the full period is not guaranteed. Retention uses
temporary artifact storage until removal. Normal completion retires known
operation-local staging. Failed or unconfirmed worker uploads can leave an
immutable package at a reported path.

If a required envelope is missing or expired, aggregation fails with the worker name even if a base
cache was restored. Rerun the affected worker and then the aggregator within the same workflow run.
Use fresh dedicated roots for the affected invocations. Retained remote artifacts
remain eligible for selection under the workflow/run and cache family rules.
Mammoth does not resume local staging or attempt to salvage interrupted uploads.

**A successful writable worker always uploads one envelope.** This includes workers that changed no
managed cache files: their explicit empty envelope is proof of participation and is distinct from a
missing or failed worker.

## Sharing across Java versions, operating systems and architectures

Gradle and Maven workers can share with an aggregator using another Java version, OS or architecture when their
family inputs match. Platform information remains in producer diagnostics. Same-path different
contents still conflict under strict policies, including inconsistent Maven directories. Equal
ordinary worker files can coalesce across permission differences. Native base permissions depend
on the restoring host and SDK. Windows cannot reconstruct Unix execute bits that were lost.

Use a workflow input such as `cache-key-prefix: project-${{ runner.os }}-${{ runner.arch }}-` to
isolate platforms, or include `${{ matrix.java }}` for explicit Java separation. All jobs in a sharing
group must resolve the same prefix. Gradle task inputs
must account for platform-sensitive outputs; Maven platform artifacts and environment-dependent
local installs need distinct coordinates/classifiers or explicit namespace isolation.

## Using a config file

Repeat inputs can be moved to a shared config file. The file format is identical for both build
tools — use the config keys matching your tool's action.

```yaml
# .github/buildish-mammoth-gradle.yml  (Gradle example)
cache-key-prefix: my-project-gradle-
wrapper-properties-files: gradle/wrapper/gradle-wrapper.properties
cache-partitions:
  - id: dependency-metadata
    writer: worker-a
```

```yaml
# Each worker job
- uses: buildish-tooling/buildish-mammoth-cache/actions/github/gradle@<commit-sha>
  with:
    job-mode: distributed-worker
    config-file: .github/buildish-mammoth-gradle.yml

# Aggregator job
- uses: buildish-tooling/buildish-mammoth-cache/actions/github/gradle@<commit-sha>
  with:
    job-mode: distributed-aggregator
    dependent-jobs: worker-a, worker-b
    config-file: .github/buildish-mammoth-gradle.yml
```

## Gradle dependency layer

The Gradle dependency layer is enabled by default. An eligible writable distributed worker can
consume an invocation-owned read-only dependency seed while keeping misses in its writable user
home. Eligible Linux workers try OverlayFS first while GC is fresh. Due runs use ordinary writable
capture. Standalone jobs and aggregators publish to the same family, and the designated writer keeps
authority over the complete dependency metadata snapshot.

Keep the same setting across cooperating jobs. To use the ordinary cache family, set
`dependency-cache-layer: false` on every publisher and worker.

```yaml
- uses: buildish-tooling/buildish-mammoth-cache/actions/github/gradle@<commit-sha>
  id: mammoth
  with:
    job-mode: distributed-worker
    wrapper-properties-files: gradle/wrapper/gradle-wrapper.properties
- run: ./gradlew build
```

Use a selected Gradle wrapper that supports the read-only dependency cache. Mammoth restores
`modules-2/files-2.1` and the restored `modules-2/metadata-*` directories into the seed. Gradle
chooses its own metadata format and writes misses to the writable cache. The seed output reports
that the layer is available. Offline builds still need usable metadata and artifacts for their dependencies.

Activation requires both restored dependency partitions in the supported layouts, writable worker
mode, `restore-cleanup-mode: none`, and no selected single-writer partition owned by that worker.
Missing partitions, unsupported layouts, jobs without a selected wrapper, read-only jobs, and other
roles use the complete ordinary installation before any seed roots are detached.

The default exports `GRADLE_RO_DEP_CACHE` for subsequent steps and emits the same absolute path as
`steps.mammoth.outputs.gradle-ro-dep-cache`. With `export-layer-environment: false`, set that
variable yourself for every consumer. An existing nonempty value conflicts with eligible prepare.
Keep all consumers inside the prepare/post lifetime; do not save the path for another job. Post
settles registered Gradle processes, captures only writable state, then retires the owned seed.
Once advertisement is attempted, even a failed or interrupted prepare retains the path until its
owning post, covering later `always()` or `continue-on-error` consumers. Incomplete activation
runs cleanup only and publishes no worker envelope. Uncertain ownership or quiescence retains
reported diagnostic state rather than deleting a potentially live or replaced path.

Inherited dependency bytes still download and extract once into the seed. They avoid writable
capture and worker-delta upload. New dependencies use the writable cache. Publisher sweeps apply
to aggregate dependency partitions in this family. Metadata retains its complete snapshot and
designated-writer semantics. Gradle workflows moving from the ordinary family start the layered
family cold unless a previous opt-in has already populated it.
