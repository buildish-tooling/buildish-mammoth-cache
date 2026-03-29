---
title: '[FROM README] Usage examples'
description: Temporary home for usage examples moved from the project README.
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

## Standalone — single Gradle job

The minimal setup for a single-job workflow.

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      actions: write # required: cache write
      contents: read
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@be666c2fcd27ec809703dec50e508c2fdc7f6654
        with:
          distribution: temurin
          java-version: '21'
      - uses: apache/buildish-mammoth-cache-gradle/descriptors/github/internal-unreleased-consumer-path@<commit-sha>
      - run: ./gradlew build
```

## Standalone — pull-request read-only mode

The action defaults to read-only on `pull_request` events. No extra configuration is needed.

```yaml
on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@be666c2fcd27ec809703dec50e508c2fdc7f6654
        with:
          distribution: temurin
          java-version: '21'
      - uses: apache/buildish-mammoth-cache-gradle/descriptors/github/internal-unreleased-consumer-path@<commit-sha>
      - run: ./gradlew build
```

## Distributed — worker and aggregator jobs

A distributed workflow where independent worker jobs build in parallel and an aggregator merges the
resulting Gradle cache deltas.

```yaml
jobs:
  worker-a:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@be666c2fcd27ec809703dec50e508c2fdc7f6654
        with:
          distribution: temurin
          java-version: '21'
      - uses: apache/buildish-mammoth-cache-gradle/descriptors/github/internal-unreleased-consumer-path@<commit-sha>
        with:
          job-mode: distributed-worker
      - run: ./gradlew :module-a:build

  worker-b:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@be666c2fcd27ec809703dec50e508c2fdc7f6654
        with:
          distribution: temurin
          java-version: '21'
      - uses: apache/buildish-mammoth-cache-gradle/descriptors/github/internal-unreleased-consumer-path@<commit-sha>
        with:
          job-mode: distributed-worker
      - run: ./gradlew :module-b:build

  aggregator:
    needs: [worker-a, worker-b]
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
      - uses: actions/setup-java@be666c2fcd27ec809703dec50e508c2fdc7f6654
        with:
          distribution: temurin
          java-version: '21'
      - uses: apache/buildish-mammoth-cache-gradle/descriptors/github/internal-unreleased-consumer-path@<commit-sha>
        with:
          job-mode: distributed-aggregator
          dependent-jobs: worker-a, worker-b
```

## Config file — centralized configuration

Use a shared config file to avoid repeating inputs across jobs.

```yaml
# .github/buildish-mammoth-gradle.yml
job-mode: distributed-worker
cache-key-prefix: my-project-gradle-
wrapper-properties-files: gradle/wrapper/gradle-wrapper.properties
```

```yaml
steps:
  - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
  - uses: apache/buildish-mammoth-cache-gradle/descriptors/github/internal-unreleased-consumer-path@<commit-sha>
    with:
      config-file: .github/buildish-mammoth-gradle.yml
```

## Partition customization — prune kotlin-dsl, add custom partition

```yaml
steps:
  - uses: apache/buildish-mammoth-cache-gradle/descriptors/github/internal-unreleased-consumer-path@<commit-sha>
    with:
      cache-partitions: |
        [
          { "id": "kotlin-dsl", "includes": [] },
          { "id": "my-generated", "includes": ["caches/*/my-generated/**"] }
        ]
```
