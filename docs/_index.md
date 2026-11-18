---
title: Buildish Mammoth Cache for Gradle and Maven
description: Documentation for Buildish Mammoth Cache for Gradle and Maven — CI actions that cache the build tool's local artifact store across workflow runs.
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

Buildish Mammoth Cache for Gradle and Maven is a pair of CI actions that cache the build
tool's local artifact store across workflow runs:

- **Gradle** — caches `GRADLE_USER_HOME` and provisions Gradle wrapper JARs securely before the
  build starts.
- **Maven** — caches the Maven local repository (`~/.m2` by default).

Both actions share the same two-phase prepare/finalize lifecycle and support single-job and
distributed multi-job topologies.

For Gradle, Mammoth also preserves entries from Gradle's local build cache, allowing Gradle to
reuse task outputs. For Maven, Mammoth caches repository artifacts; build-output caching requires
a separately configured extension.

## Single-job mode

In the most common setup, the action wraps a single build job: it restores the newest compatible
immutable generation before the build and publishes a new complete generation after a material
change. This avoids re-downloading dependencies on every run without creating duplicate entries for
unchanged runs.

## Distributed multi-job mode

When a workflow runs multiple build jobs in parallel — for example, one job per subproject or one
job per test suite — independent full-cache generations diverge. Restoring only the newest
generation then loses the dependency downloads that exist solely in the other workers' generations.

This action solves that with a **delta exchange** model:

- Each **worker job** computes only the _difference_ between what was in the cache when it started
  and what is in the cache after the build. It uploads that delta as a workflow artifact.
- A dedicated **aggregator job**, which runs after all workers complete, downloads every delta,
  merges them, and saves the merged result as the new base cache entry.

The result: every parallel job's dependency downloads are captured in one merged generation.

```mermaid
graph LR
    BC["Base cache\n(previous run)"] --> W1 & W2 & W3
    W1["Worker A\nbuild + delta"] -- "Δ artifact A" --> AGG
    W2["Worker B\nbuild + delta"] -- "Δ artifact B" --> AGG
    W3["Worker C\nbuild + delta"] -- "Δ artifact C" --> AGG
    AGG["Aggregator\nmerge + save"] --> BC2["Base cache\n(this run)"]
```

## Licensing and maintenance independence

Mammoth's own code is [Apache-2.0 licensed](https://github.com/buildish-tooling/buildish-mammoth-cache/blob/main/LICENSE).
The same license covers its cache orchestration in public and private repositories, including
commercial builds. You can inspect and modify the implementation, maintain a fork, and redistribute
it subject to the license conditions, including applicable license, notice and change-marking
requirements. Using the caching implementation requires no separate Mammoth caching subscription.

Bundled dependencies retain their own licenses and attribution requirements; consult the
[distribution license inventory](https://github.com/buildish-tooling/buildish-mammoth-cache/blob/main/legal/github/LICENSE)
and [notices](https://github.com/buildish-tooling/buildish-mammoth-cache/blob/main/legal/github/NOTICE)
for the version you use. GitHub cache/artifact services keep their own terms, limits and charges.
Downloaded JDKs, Gradle/Maven distributions and separately used build services also retain their
applicable terms.

When choosing a cache implementation, consider the rights to inspect, fix and maintain it, any
separate provider agreements, and the effort required to migrate if its availability, terms or
pricing change. Evaluate feature coverage and measured performance separately; an open-source
license alone does not establish either.
