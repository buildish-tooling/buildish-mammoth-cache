---
title: Release Legal Policy
weight: 30
description: Initial dependency-license and attribution gates for Mammoth Cache releases.
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

The initial Mammoth Cache release policy, accepted on 2026-11-17, adopts the
existing conservative dependency-license gate and bundled LICENSE/NOTICE verification.
The source-checkout `buildish-release-tooling/RELEASE-CONTRACT.md` records the complete
candidate/promotion contract. Release execution still requires implemented workflows
and deployment qualification.

Before preparing a candidate, run both checks against its reviewed source commit S
and locked dependencies in the unprivileged selected-source build:

```sh
make release-legal-incompatible-license-check
make release-legal-check
```

The first rejects the incompatible expressions recognized by the existing
`scripts/release-legal.mjs` conservative rule set. The second uses the actual bundle
analysis and required package attribution metadata to verify `legal/github/LICENSE`
and `legal/github/NOTICE`. Both must pass; success of the dependency gate alone is
insufficient. Existing script names/messages may still call the rule set
“provisional”; it is now the selected initial technical release gate.

Preserve the verified legal files in the shipped materialized Action tree M and its
archive. The signed source archive comes from S. The distribution layout check only
checks legal-file presence; it does not replace dependency analysis or verify that
M's attribution matches the selected-source analysis.

Missing or stale attribution, incomplete required metadata, or a rejected dependency
blocks candidate preparation. Correct the source/dependency/attribution inputs and
review the resulting changes before creating a new candidate. Do not bypass a failure
by editing generated legal output alone or regenerate signed candidate bytes during
promotion. Retain prior published candidates and their exact evidence.

This policy selects fail-closed project checks; it does not assert that their automated
result is a comprehensive legal determination. Changing the accepted gate or granting
an exception requires an explicit policy decision. No ASF-specific classification,
approval process, or distribution infrastructure is implied by the license.
