---
title: Kotlin Multiplatform Evaluation
weight: 40
description: Assessment of Kotlin Multiplatform as a way to share code between a GitHub Actions Node.js entrypoint and a JVM Jenkins plugin.
---

<!--
Copyright 2026 The Apache Software Foundation

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

This page records the evaluation of Kotlin Multiplatform (KMP) as a way to write the cache
orchestration logic once in Kotlin and compile it to both JavaScript (for GitHub/Forgejo Actions)
and JVM bytecode (for a Jenkins plugin or GitLab runner). The conclusion is that KMP is
*architecturally coherent* with this codebase's design but is not the right tradeoff at this time.

## What Kotlin Multiplatform can target

KMP compiles a single Kotlin codebase to multiple output targets:

| Target            | Output                                     | Relevant here for              |
| ----------------- | ------------------------------------------ | ------------------------------ |
| `jvmMain`         | JVM bytecode (JAR)                         | Jenkins plugin, GitLab runner  |
| `jsMain`          | JavaScript bundle (Node.js or browser)     | GitHub Actions, Forgejo Actions |
| `nativeMain`      | Native binary via LLVM                     | Alternative to GraalVM native-image |

Platform-specific code lives in source sets named after the target (`jsMain`, `jvmMain`); shared
code lives in `commonMain` and is compiled for all targets. The `expect`/`actual` mechanism
provides a compile-safe way to declare platform-specific implementations of common abstractions.

## Architectural coherence

The existing codebase already has the right shape for KMP. The core phase logic
(`src/phases/`, `src/cache/`, `src/delta/`) has no CI platform dependencies — it operates
entirely through injected interfaces. The CI adapter implementations (`src/ci/github/`) are the
only platform-specific code. This maps directly onto `commonMain` (core) + `jsMain` (GitHub
adapter) + `jvmMain` (Jenkins adapter), with the eight seam interfaces becoming `expect`
declarations or common interfaces implemented per target.

## Why KMP is not recommended

### Kotlin/JS for Node.js is not a primary JetBrains target

JetBrains has shifted focus toward Kotlin/Wasm for web-facing use cases. Kotlin/JS targeting
Node.js works but is not where tooling investment is going. Documentation, community resources,
and upstream bug-fix priority for the Node.js target are thinner than for Kotlin/JVM or even
Kotlin/Wasm.

### npm package interop requires manual external declarations

The GitHub/Forgejo adapter layer depends on npm packages with no Kotlin wrappers:
`@actions/core`, `@actions/cache`, `@actions/artifact`. In Kotlin/JS these require handwritten
`external` interface declarations, or the use of `dynamic` typing — which largely defeats the
purpose of choosing a statically typed language. Every upstream API change in these packages
requires updating the declarations manually.

### The platform-specific adapter layer does not shrink

The motivation for KMP is to share code. But the code that *cannot* be shared — the CI adapter
implementations — accounts for a significant fraction of the non-test source. The `commonMain`
core would be shared, but:

- The GitHub/Forgejo adapter (`jsMain`) must be written in Kotlin/JS against the npm toolkit.
- The Jenkins adapter (`jvmMain`) must be written in Kotlin/JVM against the Jenkins Java API.

Both must be written from scratch. KMP does not reduce this work; it only avoids duplicating the
core orchestration logic, which in TypeScript is already clean and well-isolated.

### Build and test complexity doubles

The current build pipeline is: TypeScript → esbuild → single `.cjs` bundle, tested with Vitest.

Under KMP the pipeline becomes: Kotlin `commonMain` + `jsMain` → Kotlin/JS compiler → webpack
→ `.cjs`, AND `jvmMain` → fat JAR, tested with `kotlin.test` + Karma/Jest (JS) + JUnit (JVM).
The Kotlin/JS webpack integration is less flexible than the current esbuild setup, error messages
from the KMP Gradle plugin are harder to diagnose, and every CI matrix run must build and test
both targets.

### Contributor pool and long-term maintenance

"Kotlin Multiplatform targeting Node.js" is a narrower skill set than either "TypeScript" or
"Kotlin/JVM". Attracting contributors who are comfortable with KMP's `expect`/`actual` mechanism,
the Kotlin/JS webpack integration, and the npm interop model is harder than attracting TypeScript
or Kotlin/JVM contributors separately.

## What KMP would look like (for reference)

If the tradeoffs were judged acceptable, the migration path would be:

1. Introduce a KMP Gradle build alongside the existing TypeScript build.
2. Port `src/phases/`, `src/cache/`, `src/delta/` to `commonMain` Kotlin, keeping the same
   interface boundaries. This is largely mechanical given the clean TypeScript interfaces.
3. Write `external` declarations for `@actions/core`, `@actions/cache`, `@actions/artifact` in
   `jsMain`; implement the CI adapter interfaces against them.
4. Write the Jenkins adapter in `jvmMain` using the Jenkins Java API.
5. Configure the `jsMain` webpack output to produce a bundle compatible with `using: node24`.
6. Retire the TypeScript source once the KMP output passes all existing integration tests.

## Conclusion

KMP is not recommended for this project in its current stage. The right architecture for
multi-platform support is:

- **GitHub / Forgejo**: the existing TypeScript/Node.js codebase.
- **Jenkins**: a Jenkins Shared Library (or thin plugin) wrapping the Node.js scripts as the
  fast path; a separate Kotlin/JVM port of the core as the long-term option if a zero-Node.js
  Jenkins plugin becomes a hard requirement.
- **GitLab**: the same Node.js scripts invoked from `script:` blocks, with a purpose-built
  GitLab adapter layer in TypeScript.

See [Jenkins Support](./portability/jenkins/) for the Jenkins-specific implementation options
and [Provider Portability](./portability/) for the overall CI platform status.

