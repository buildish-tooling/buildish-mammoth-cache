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

# Distributed correctness graph

With the existing checkout dependencies, run the helper tests locally:

```sh
node --test test/qualification/distributed-correctness/helpers.test.mjs
```

The tests use local control-file fixtures and never call the hosted services.
The workflow recipe is outside GitHub workflow discovery and every job is disabled.
Both primary release archives omit this directory.

A hosted exercise requires separate admission for one exact revision, fresh run,
repository and branch. Review the disabled recipe and its Node 24 Action before
admission. It allows three matrix entries each for worker, aggregator, and consumer,
with 20-minute jobs, 15-minute Action steps, a 10-minute admission window and no
automatic cancellation. Reruns are rejected. The same real run identity scopes all
jobs and each producer keeps its own artifact identity.

The graph checks both tools' positive worker receipts, post outcomes, offline builds,
writable source returns and exact warm/changed cache reuse. A failed or skipped
stage gives no evidence for its downstream stages. The standard actions do not
load the graph or alter their behavior for it.
