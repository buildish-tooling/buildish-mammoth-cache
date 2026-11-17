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

# Mammoth Cache for Gradle® and Apache Maven™

Transparent, incremental dependency caching for Gradle and Maven builds on GitHub Actions —
from simple single-job pipelines to large parallel fan-out workflows.

One action wraps your build step. Before the build, it restores the newest compatible immutable
cache generation. After a material change, a standalone job publishes a new complete generation;
distributed workers instead exchange precise deltas through an aggregator. No manual cache-key
juggling, and unchanged standalone runs publish no duplicate generation.

> **Mammoth Cache 0.1.2 is released.** Use the `v0.1.2` tag for executable GitHub Actions.
> Ordinary source branches omit the generated action bundles.

---

{{< buildish-button appearance="primary" >}}
[Read the 0.1.2 getting-started guide](releases/0.1.2/user/getting-started/)
{{< /buildish-button >}}

{{< buildish-component-link kind="docs" label="Release documentation" appearance="primary" >}}

_Docs cover workflow usage, configuration, cache-partition behaviour, security notes, and
maintenance guidance._

## Current scope

Mammoth Cache currently targets dependency and build-tool cache orchestration on GitHub Actions;
it is not a general build-output cache, build sandbox, or dependency-provenance verifier.
Distributed use requires a dedicated aggregator job. Other CI providers remain future work.

## Highlights

🔁 **Distributed deltas** — worker artifacts package only files changed relative to their restored
base; the aggregator merges them into a complete generation for later runs.

🔒 **Secure Gradle wrapper provisioning** — wrapper JARs are checksum-validated and
GPG-verified against the official Gradle release signing key before any code runs.

🗂 **Content-fingerprinted cache keys** — changing the cache partition layout automatically
produces a new key lineage; no manual version bumps required.

🧹 **Age-based cleanup** — best-effort timestamp garbage collection removes old managed Gradle and
Maven cache entries before a changed generation is published.

🚫 **Read-only on pull requests** — PRs restore the shared cache but never write back,
keeping the main cache clean by default.

## Single-job and distributed workflows

Mammoth Cache works transparently for both simple and complex pipeline shapes.

### Single-job (standalone)

One action call is all it takes. The action runs transparently before and after your build step.

```mermaid
flowchart LR
    RC([Restore\ngeneration]) --> B([Build]) --> SD([Publish changed\ngeneration])
```

### Distributed multi-job

Worker jobs run in parallel and each publish a delta artifact. The aggregator job downloads,
merges, and applies them all into a single coherent cache that every future run benefits from.

```mermaid
flowchart LR
    WA([Worker A]) --> AG
    WB([Worker B]) --> AG
    WC([Worker C]) --> AG
    AG([Aggregator\nmerge + apply]) --> C[(Shared\ncache)]
```

## Unreleased development changes

Development now uses post-prepare timestamp cutoffs to select worker upserts and usage paths.
Default timestamp GC combines old file mtime with current-build activity protection. It stores
no historical last-use manifest; filesystem/clock misses may cause downloads or recomputation.
Frozen local journals bound recovery state and retire obsolete checkpoints. Read-only tracking
and full-generation upload optimization remain separate follow-ups.
