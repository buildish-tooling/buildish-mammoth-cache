---
title: Cache Generations and Restore Lineages
weight: 30
description: How compatible cache families, ref lineages, and immutable generations are constructed and restored.
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

## Identity model

Mammoth separates the cache family, ref lineage and immutable generation. A
generation references one exact object key for every nonempty partition in its
view. A positive object save alone is insufficient to publish a generation.

## Cache family

The family is an opaque identifier beginning with `mammoth-s1-gradle-` or
`mammoth-s1-maven-`. The digest binds the configured `cache-key-prefix`, internal
cache schema, resolved partition model and storage, wire and local profiles.
The partition model binds ordered includes, exclusions, purge rules, publication
policies and writer identities. It excludes the local path, Java version and
runner platform.

Changes to the model or incompatible profiles start a new family. All cooperating
workers and aggregators must use compatible Action revisions and partition inputs.
An upgrade to the native v2 and worker TAR-v2 profiles starts cold against old
backend objects. Keep the package version and the on-wire profile names distinct
when planning an upgrade.

## Ref lineage

The exact ref identity is hashed into its lineage. A prepare can search the
current ref and then the configured default ref within the same family.
`cache-family-key`, `cache-lineage-prefix` and `restored-cache-key` expose the
selected identities for diagnostics.

## Immutable generation

The generation and partition keys bind their lineage and writer and include the
decision identity. The published record controls which exact refs are restored.
Restore can admit a partial view if some objects have expired, subject to
complete-unit and snapshot requirements. Reusing an exact generation requires
the observed base to remain unchanged. A lineage-only record can reuse existing
partition refs.

See the [native base protocol](../../dev/native-base-protocol/#model-family-and-key-identities)
for the canonical tuples, hashing and key formulas.
