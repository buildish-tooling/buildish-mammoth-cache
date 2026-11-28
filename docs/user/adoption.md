---
title: Adoption and Migration
weight: 15
description: Choose a cache topology, preserve workflow ownership and write policy, and evaluate Mammoth with a controlled pilot.
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

Start with one workflow and an isolated cache namespace. Choose who publishes cache state before
replacing the existing cache steps; keep the setup and services the build still needs.
[Getting Started](../getting-started/#workflow-shape) covers executable release/candidate refs and
the initial action wiring.

## Allow the actions in restricted organizations

Repositories and organizations that allow only specified actions must list each Mammoth action
by its full path:

```text
buildish-tooling/buildish-mammoth-cache/actions/github/gradle@*,
buildish-tooling/buildish-mammoth-cache/actions/github/maven@*
```

Pin the actions to full-length commit SHAs in workflows, as the examples do. An allow-list entry
that names a SHA instead of `@*` must be updated on every Mammoth upgrade.

See GitHub's
[allowing and blocking actions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#allowing-select-actions-and-reusable-workflows-to-run)
for the pattern syntax.

Apache Software Foundation projects use the allow-list maintained in
[`apache/infrastructure-actions`](https://github.com/apache/infrastructure-actions), which approves
actions per commit SHA.

## Choose a topology and owner

| Workflow need                                              | Starting choice                                                          | Coverage tradeoff                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| One representative build can populate the shared cache     | One writable [standalone job](../single-job/), with other jobs read-only | Simplest setup; readers' new downloads and task-cache entries are not published.                           |
| Independent jobs or runs may publish their own views       | Standalone writers sharing a namespace                                   | Valid, but their generations can diverge. Restoring the newest does not union their contributions.         |
| Distinct worker contributions should be collected together | [Distributed workers and an aggregator](../distributed-jobs/)            | Combines aggregate partitions, subject to conflict policies; adds worker artifacts and an aggregation job. |

A Java matrix alone does not require distributed mode. Choose it when the additional coverage
justifies the exchange and aggregation work. Participants must share compatible namespace and
partition settings. Java, OS and architecture do not isolate families automatically; use explicit
namespaces where the build needs isolation. See
[sharing across environments](../distributed-jobs/#sharing-across-java-versions-operating-systems-and-architectures).

For Gradle, standalone mode owns the complete `dependency-metadata` snapshot automatically.
To publish metadata updates in distributed mode, designate a writer: prefer an existing worker
whose dependency resolution is representative, and use matching partition settings everywhere. Its snapshot covers that
worker's resolution view, not a union of all workers' metadata indexes. Other workers' downloaded
artifacts can aggregate while their metadata still needs online refill. With no writer configured,
the aggregator publishes its own complete snapshot. Follow the
[metadata writer and optional-writer examples](../distributed-jobs/#gradle-metadata-writer).

## Preserve write policy and participation

Keep the workflow's existing trusted event/ref restrictions. The default read-only policy for
pull-request events does not restrict every other event to your intended writers; set explicit
gates or `read-only` inputs where needed. Give Mammoth sole cache ownership of each managed root,
including disabling overlapping caching in setup actions while retaining their tool setup. Run
Mammoth before any Gradle or Maven invocation in the job.

In distributed mode, assign stable, unique producer names to matrix jobs. Align `github-job-name`,
`dependent-jobs`, the metadata writer identity and the aggregator's `needs`, as in the
[matrix example](../distributed-jobs/#matrix-jobs). Listed producers
that do not upload an envelope are reported and prevent full sweep coverage, or fail aggregation
with `allow-missing-dependent-jobs: false`. A skipped worker or a missing post upload, including after
cancellation, differs from a failed build whose post action produced a valid envelope.

Decide whether aggregation should run after failures. `always()` combined with trusted event/ref
gates permits that recovery or missing-worker reporting; it is a deliberate failure-handling
choice. A metadata-only writer can be optional under the
[documented optional-writer contract](../distributed-jobs/#optional-metadata-writer-that-can-be-skipped).
See [participation and retry requirements](../distributed-jobs/#requirements-and-constraints) before
copying a topology.

## Prepare for an incompatible upgrade

Use one Action revision across participating workers, aggregators and readers.
An older family starts cold under the new profiles. Prepare now rejects prewarmed
files selected by any enabled partition, even on a cache miss or in a read-only job.
Remove competing restores and give each invocation a fresh dedicated home on persistent
runners. Copy or generate only the settings the build needs, outside the enabled
partition selections. Preserve interrupted roots for inspection. See
[restore admission failures](../troubleshooting/#restore-admission-failures).

## Account for costs and recovery

Unchanged partition objects are reused across generations; changed partitions upload in full.
That is partition reuse, not exact content deduplication. Validation/hashing, complete metadata
snapshot capture, worker payload uploads/downloads, backend requests/storage and aggregator time
still cost work. Measure the complete workflow rather than inferring savings from archive reuse.
See [partition reuse and recovery](../cache-partitions/#cross-generation-reuse-and-recovery).

Three lifetimes are independent:

- **Worker artifacts:** `worker-artifact-retention-days` requests 7 days by default, configurable
  from 1–400 days. Shorter retention reduces artifact residence but narrows selective and
  aggregator-only retries; expired required workers must be rerun. Backend limits can shorten
  availability, and successful aggregation retains the envelopes. See the
  [retention input](../configuration/#worker-artifact-retention-days).
- **Managed files:** default timestamp GC uses a 14-day file-mtime threshold and current-build
  activity protection, not historical LRU. `cache-gc-mode: off` disables GC deletion while tracking
  and snapshot work remain; storage may grow. See [timestamp GC](../cache-partitions/#timestamp-garbage-collection).
- **Backend cache objects:** eviction can make partitions cold independently of worker retention
  or GC. Normal builds can refill missing data when its source remains available; cached metadata
  and artifacts do not guarantee offline completeness.

## Keep Maven's scope clear

Mammoth caches Maven's repository and wrapper downloads. Keep JDK/Maven bootstrap, any goal or
build-output cache extension, scans/token services, and delivery of freshly built artifacts as
separate workflow responsibilities. Repository caching does not replace those mechanisms.

Preserve `_remote.repositories` origin markers and compatible repository/mirror configuration.
Snapshots and local installs are included by default; exclude complete coordinate/version
directories when they should be rebuilt, keeping markers with the managed artifacts. The strict
default rejects inconsistent worker directory views. Explicit
`conflict-handling: choose-worker-directory` selects one complete view and can lose other workers'
classifiers, local installs or origin entries. Generic duplicate-path overrides do not bypass
Maven consistency checks. Use [Maven Caching Patterns](../maven-caching-patterns/) for exclusions,
seeding and conflict-policy details.

## Run a small pilot

1. Pin an executable release or candidate ref tied to the source revision being evaluated, using
   the [packaging guidance](../getting-started/#workflow-shape). Ordinary source HEAD without
   bundles is not a remote-action installable ref. Check applicable organization deployment
   approvals and the [tested scope](../../dev/contributing/#github-integration-graph); fixture
   success does not certify every Gradle/Maven version, OS pair or alternative backend.
2. Use a separate `cache-key-prefix`, one cache owner per root, and the consumer's actual tool
   versions, runners and backend. Preserve necessary setup, credentials/services and write gates.
3. Record the baseline workload and flags, then keep them identical during comparison. Establish
   a new baseline after unrelated build changes. Define success and rollback criteria before
   measuring, such as correct builds, useful reuse and acceptable total time/storage.
4. Observe a cold seed and representative warm runs, including post actions and aggregator cost.
   Check useful dependency/task reuse, conflicts and backend storage as well as elapsed time.
   A few comparable runs give an initial signal, not statistical performance proof.
5. If the pilot misses its criteria, restore the previous workflow cache setup and stop using the
   pilot namespace. Keep artifact-delivery and other required services in place throughout.
