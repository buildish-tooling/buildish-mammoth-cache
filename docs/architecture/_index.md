---
title: Architecture & Background
weight: 20
description: Design documents covering the internal architecture of Apache Buildish Mammoth Cache for Gradle and Maven.
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

These documents describe the internal design of Mammoth Cache — intended for contributors,
maintainers, and anyone who wants to understand why the action behaves the way it does.

The core model is shared between Gradle and Maven: the same two-phase lifecycle, cache model,
key generation, delta exchange protocol, and CI abstraction layer underpin both. Build-tool-specific
behaviour is isolated behind a `BuildToolAdapter` interface so the shared phase logic never imports
tool-specific code.
