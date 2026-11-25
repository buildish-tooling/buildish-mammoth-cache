---
title: GitHub Dependency Submission
weight: 45
description: Pair Mammoth Cache with existing Gradle and Maven dependency submission actions.
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

Mammoth manages build caches. To populate GitHub's dependency graph, pair it with an existing
dependency submission action for your build tool. Submitted dependencies can contribute to
Dependabot alerts, dependency review, and SBOM exports. See
[GitHub's dependency graph documentation](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependency-graph).

> [!IMPORTANT]
> Compatibility between Mammoth and the submission actions below has not been integration-tested.
> These recipes are based on their documented interfaces; validate the combination in your workflow.

## Shared setup

Enable the dependency graph in the repository settings and enable Dependabot alerts if you want
vulnerability notifications. The examples submit on pushes to `main`; replace that branch with
your default branch. Each submission job needs `contents: write` for GitHub's
[dependency submission API](https://docs.github.com/en/rest/dependency-graph/dependency-submission).
Ordinary Mammoth build jobs can retain `contents: read`.

Replace `<published-ref>` with an exact Mammoth release or candidate ref containing `dist/`;
ordinary source branches such as `main` are not installable action refs. See
[Getting Started](../getting-started/#workflow-shape). The submission action versions below identify
the documented interfaces; pin third-party actions to reviewed commit SHAs in your workflow.

Keep Mammoth as the cache owner. Do not enable `cache: gradle` or `cache: maven` on
`actions/setup-java`. These standalone submission jobs resolve dependencies in an additional
build-tool invocation and may download artifacts before Mammoth's post step saves the cache.
They do not replace your build and test jobs.

## Gradle

Run Mammoth before Gradle's submission action so dependency resolution can use the restored cache
and any provisioned wrapper JAR. Use `cache-provider: external` to leave Gradle User Home caching
to Mammoth, and `cache-cleanup: never` to leave cleanup to Mammoth as well.

```yaml
name: Gradle dependency submission
on:
  push:
    branches: [main]

jobs:
  dependency-submission:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@be666c2fcd27ec809703dec50e508c2fdc7f6654
        with:
          distribution: temurin
          java-version: '21'
      - uses: buildish-tooling/buildish-mammoth-cache/actions/github/gradle@<published-ref>
      - uses: gradle/actions/dependency-submission@v6
        with:
          cache-provider: external
          cache-cleanup: never
          additional-arguments: --no-configuration-cache
          dependency-graph: generate-and-submit
```

The submission action invokes its dependency-resolution task itself. The
[underlying Gradle plugin](https://github.com/gradle/github-dependency-graph-gradle-plugin#gradle-compatibility)
does not generate a new graph when configuration state is loaded from the configuration cache;
`--no-configuration-cache` avoids that case for this invocation. `generate-and-submit` submits
the graph without also storing it as a workflow artifact.

For a build outside the repository root, set `build-root-directory` on the submission action and
configure Mammoth's `wrapper-properties-files` for that build. Supply any relevant Gradle
properties or other resolution arguments through `additional-arguments`, keeping
`--no-configuration-cache`. See the upstream
[submission documentation](https://github.com/gradle/actions/blob/main/docs/dependency-submission.md)
and [v6 action inputs](https://github.com/gradle/actions/blob/v6/dependency-submission/action.yml).

## Maven

The Maven submission action invokes a dependency-graph plugin and submits the resulting snapshot.
It supports multi-module builds and uses the Maven wrapper when present, otherwise `mvn` on
`PATH`. It does not provide a competing cache lifecycle.

```yaml
name: Maven dependency submission
on:
  push:
    branches: [main]

jobs:
  dependency-submission:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@be666c2fcd27ec809703dec50e508c2fdc7f6654
        with:
          distribution: temurin
          java-version: '21'
      - uses: buildish-tooling/buildish-mammoth-cache/actions/github/maven@<published-ref>
      - uses: advanced-security/maven-dependency-submission-action@v6.0.1
```

Use the same repository settings, credentials, active profiles, and local repository location as
your build. Pass a custom settings file through `settings-file` and profiles or properties through
`maven-args`. For a custom local repository, ensure `-Dmaven.repo.local` points to the
`repository/` directory under the Maven user home managed by Mammoth. Setting Mammoth's
`maven-user-home` alone does not configure Maven's local repository.

For a build outside the repository root, set the submission action's `directory` to the directory
containing the reactor's root `pom.xml`. If multiple matrix jobs submit different dependency
sets, give them distinct, stable `correlator` values. See the upstream
[Maven submission documentation](https://github.com/advanced-security/maven-dependency-submission-action).

After a successful submission, inspect **Insights → Dependency graph** in GitHub to check the
reported dependencies. Graph coverage depends on the configurations and profiles resolved by the
submission invocation; it is not an inventory of every file in Mammoth's cache.
