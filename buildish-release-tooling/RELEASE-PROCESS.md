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

# Mammoth Cache Release Process

This draft applies the Buildish release architecture to `buildish-mammoth-cache`.

## Special rule for this component

The runnable GitHub Action payload lives under `dist/`, and `dist/` is excluded from normal source
commits. Because of that:

- the source release archive remains source-only
- the RC tag points at a detached materialization commit derived from the exact source commit under
  vote
- the final exact tag should point at the same detached materialization commit as the released RC
  tag
- that detached commit must never enter `release/<line>` history

## Release branches

Use the Buildish standard release branches:

- `release/1.x`
- `release/1.2.x`

## Draft workflow set

### `Create release branch`

Inputs:

- `release_line`
- `source_ref`

### `Prepare RC`

Inputs:

- exact `version`
- optional `source_sha`

Behavior:

- resolve the source from `source_sha` if provided
- otherwise prefer `release/1.2.x`, then `release/1.x` for version `1.2.3`
- hard-gate the workflow on successful or skipped GitHub checks for the resolved source commit
- derive the next RC number after the highest existing RC for the version, or `0` if none exists
- clean pre-existing RC staging directories for this version from ASF SVN before staging the new RC
- rely on release-branch CI instead of rerunning tests in the draft `Prepare RC` job
- build the reproducible source archive from Git using the shared `buildish-release-tooling`
  component
- build the normally git-ignored `dist/` payload from the resolved RC source commit in a detached
  worktree, `git add` it there for later convenience-artifact materialization, create the RC tag on
  the resulting detached commit, and keep that state out of `release/<line>` history
- sign the source archive with `gpg` using `BUILDISH_GPG_PRIVATE_KEY`
- stage the source archive, `.sha512`, and `.asc` into ASF SVN using
  `BUILDISH_SVN_DEV_USERNAME` / `BUILDISH_SVN_DEV_PASSWORD`
- create or re-create the draft GitHub Release for the final exact version
- emit GitHub Summary blocks for:
  - vote email templates
  - source artifact SHA512
  - source artifact detached ASCII-armored signature
  - RC verification commands

### `Verify RC`

This is authored as a bash script for trusted local Linux/macOS execution and may also be used from
a manual workflow.

### `Release version`

Inputs:

- exact `version`

Behavior:

- resolve the latest RC for the version
- promote the exact source release from Apache `dist/dev` to `dist/release`
- prune older releases from the same release line out of Apache `dist/release` so they disappear
  from `downloads.apache.org` and remain available from `archive.apache.org`
- for Mammoth Cache, resolve the detached commit referenced by the released RC tag and create the
  final exact tag on that same commit
- finalize the draft GitHub Release
- if moving aliases are enabled, derive `v1` and `v1.2` from the final version and move them after
  the final exact tag is live
- emit GitHub Summary blocks for:
  - source artifact SHA512
  - source artifact detached ASCII-armored signature
  - archived same-line releases
  - final action-release URLs

This draft does not use a `latest` alias for GitHub Actions.

## Files in this draft

- `buildish-release-tooling/release-config.yaml`: component policy consumed by
  `buildish-release-tooling`
- `buildish-release-tooling/release-tooling.sh`: a thin bash dispatcher that locates the component
  policy and runs `uv run --project <resolved-tooling-checkout> --frozen buildish-release-tooling
  <command> ...`
- `workflows/`: draft workflow YAML showing job boundaries and retries; the jobs install `uv`,
  fetch full Git state, and invoke the component wrappers
- `../buildish-release-tooling/tests/`: shared Python unit and integration tests that load this
  component's real `buildish-release-tooling/release-config.yaml` and smoke-test
  `buildish-release-tooling/release-tooling.sh`
