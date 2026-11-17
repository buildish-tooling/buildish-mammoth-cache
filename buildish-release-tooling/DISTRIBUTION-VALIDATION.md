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

# Validate an Action distribution

Run the component's existing smoke-test script against the tree that consumers will
receive, including generated `dist/` files:

```sh
make build
make distribution-check
```

To inspect an already materialized tree, run from this source checkout:

```sh
make distribution-check DISTRIBUTION_ROOT=/path/to/materialized-tree
```

`distribution-check` checks the repository's Node/npm versions and runs
`node scripts/smoke-test.mjs --distribution-root TREE`. It does not build or modify
the supplied tree. `make smoke-test` builds the current checkout and runs the same
validation. The script can also be invoked directly with a specific Node executable
to check the bundles under the descriptors' Node 24 runtime:

```sh
/path/to/node24 scripts/smoke-test.mjs --distribution-root /path/to/materialized-tree
```

The checker itself uses dependencies installed in this source checkout; executing
the staged bundles must succeed without them. No Release Tooling package, sibling
checkout, signing material, or publication credentials are needed.

## What the check does

1. Reads both Action descriptors from the supplied tree and requires `node24`.
   Resolves their main/post paths to four distinct, non-empty `.cjs` files inside
   `dist/`. Missing files, paths escaping the tree (including through symlinks),
   invalid paths, and directories in place of files fail validation.
2. Requires non-empty `LICENSE`, `NOTICE`, `legal/github/LICENSE`, and
   `legal/github/NOTICE` from the same tree. This checks distribution completeness;
   run `make release-legal-check` separately to compare generated attribution with
   the bundled-dependency analysis. Both checks are required by the accepted initial release legal policy.
3. Copies those descriptors, bundles, and legal files to a temporary directory
   outside the source checkout, without source files or `node_modules`. Copies the
   existing Gradle/Maven smoke fixtures into separate workspaces with isolated homes
   and temporary directories. The system temporary directory is canonicalized;
   a location within either tree or beneath an existing ancestor `node_modules` is
   rejected. Select an isolated `TMPDIR` (or `TEMP` on Windows) if this check fails.
4. Executes each declared main bundle, transfers GitHub command-file state and
   environment to its post bundle, and executes post. Requires the main phase's
   expected public outputs and a non-empty summary from each phase, so a silently
   skipped post is a failure. Each bundle has a two-minute execution limit.
5. Removes its temporary staging directory on completion or failure. It never
   generates bundles in the supplied tree, commits files, creates refs, or publishes.

Children receive controlled GitHub context, inputs disabling cache orchestration
and enabling read-only behavior, isolated user/tool homes, and a small allowlist of
system environment variables. Caller credentials, action inputs/state, and Node
module overrides are not inherited. Node's global module search paths are disabled.
The documented Windows `BUILDISH_MAMMOTH_CACHE_GRADLE_GPG_COMMAND` executable selector
is preserved and remains subject to the runtime's platform/path validation.
Execute selected-source bundles only in a job without signing/publication privileges;
this smoke runner is not a sandbox for untrusted code.

Gradle wrapper provisioning still runs. It contacts the canonical Gradle hosts to
download and verify wrapper metadata/signatures/JARs, and requires `gpg` on PATH.
Generated wrapper files stay in the copied fixture. No Gradle/Maven build or cache
service is exercised; the Maven fixture requires no dependency resolution. Network
or provisioning failures fail the check and should be diagnosed before retrying.

## Evidence and release integration

A successful check establishes local executable-layout and main/post startup
coverage for the supplied tree under the Node executable used. It does not prove
cache-service integration, source-to-bundle reproducibility, signatures on release
artifacts, tag/manifest integrity, or live GitHub publication.

In release workflows, validate the exact generated tree whose files will be
committed as materialized commit M. Keep reviewed source S and M distinct and retain
the required build evidence. Modern candidate/promotion workflows now use Release
Tooling 0.1.4 materialized-state support and require packaged/final-tag consumer
success. Deployment, signing and live workflow qualification remain separate
prerequisites; this check alone does not declare the component ready to release.
