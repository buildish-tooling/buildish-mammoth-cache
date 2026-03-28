---
title: Apache Buildish Mammoth Cache for Gradle
description: Documentation for workflow usage, configuration, cache behavior, security, maintenance, and portability planning.
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

Apache Buildish Mammoth Cache for Gradle provides secure Gradle wrapper provisioning plus local and distributed cache
management for GitHub Actions today, prepared for Codeberg/Forgejo and GitLab CI in the future.

The shared core is structured so future provider integrations can target GitHub, Codeberg/Forgejo, and GitLab without
rewriting the wrapper, cache, or distributed-delta logic.

## Pages migrated from the README

- [[FROM README] Usage in GitHub workflows and runtime requirements](./from-readme-usage-and-runtime/)
- [[FROM README] GitHub action configuration](./from-readme-github-action-configuration/)
- [[FROM README] Cache partitions and restore cleanup](./from-readme-cache-partitions-and-restore-cleanup/)
- [[FROM README] Usage examples](./from-readme-usage-examples/)
- [[FROM README] Permissions, security, maintenance, and current status](./from-readme-security-and-maintenance/)

## Existing design and implementation docs

- [Wrapper provisioning](./wrapper-provisioning/)
- [Gradle cache contents](./gradle-cache-contents/)
- [Artifact exchange](./artifact-exchange/)
- [Bootstrap process](./bootstrap-process/)
- [Base cache design](./base-cache-design/)
- [Cache key generation](./cache-key-generation/)
- [CI abstraction boundary rules](./ci-abstraction-rule/)
- [CI abstraction](./ci-abstraction/)
- [Implementation plan](./implementation-plan/)
- [Provider portability implementation plan](./provider-portability-implementation-plan/)
- [Codeberg CI support evaluation](./codeberg-ci-support-evaluation/)
- [GitLab CI support evaluation](./gitlab-ci-support-evaluation/)
- [Release legal notes](./release-legal/)
