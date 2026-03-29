---
title: '[FROM README] Usage in GitHub workflows and runtime requirements'
description: Temporary home for usage and runtime guidance moved from the project README.
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

This page currently carries content moved from the project README. It will likely be reorganized later.

## Usage in GitHub workflows

Until the first public release exists, use a repository ref you control for testing.

```yaml
steps:
  - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
  - uses: apache/buildish-mammoth-cache-gradle/descriptors/github/internal-unreleased-consumer-path@<commit-sha>
```

## Runtime and toolchain requirements

- GitHub Action runtime: Node 24
- Local development baseline: Node `24.13.0`
- Expected npm version for repository tooling: `11.6.2`
- Java `21+` for Apache RAT license-header checks

The repository pins these versions so local development, CI, and the published action runtime stay aligned.

For Java installation and switching, we recommend [SDKMAN!](https://sdkman.io/). Install at least Java 21 before running
the RAT checks locally.
