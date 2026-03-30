---
title: User Guide
weight: 10
description: How to use Apache Buildish Mammoth Cache for Gradle and Maven in your workflows.
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

This section covers everything you need to integrate Mammoth Cache into your GitHub Actions
workflows — from a first working snippet to distributed multi-job topologies, full configuration
reference, cache-partition tuning, and security considerations.

The action ships in two build-tool-specific flavours that share the same two-phase
prepare/finalize design and most configuration options:

- **Gradle** — adds secure wrapper JAR provisioning and caches `GRADLE_USER_HOME`.
- **Maven** — caches the Maven local repository (`~/.m2` by default).

Start with [Getting Started](getting-started/) if you are new to the action, or jump directly to
[Configuration](configuration/) for a full input reference.
