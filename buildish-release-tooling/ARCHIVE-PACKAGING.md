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

# Package unsigned candidate archives

The component-owned `scripts/package-release.py` command produces the two archive
inputs required by the [release contract](RELEASE-CONTRACT.md). It uses Python 3.11+
standard-library archive readers/gzip, Git, and the trusted checkout's existing Node
static distribution validator and dependencies. It requires no Release Tooling source
checkout/package, signing credentials, network, or registry. Run it in the unprivileged
build/preparation job.

Supply complete lowercase commit IDs already present in the explicit repository:
reviewed source S and materialized Action M. The version is the final stable `X.Y.Z`,
without `v` or an RC suffix. Choose a new output directory for each preparation run:

```sh
: "${SOURCE_COMMIT:?Set the full source commit ID}"
: "${MATERIALIZED_COMMIT:?Set the full materialized commit ID}"
: "${RELEASE_VERSION:?Set the final stable X.Y.Z version}"
make release-archives \
  SOURCE_COMMIT="$SOURCE_COMMIT" \
  MATERIALIZED_COMMIT="$MATERIALIZED_COMMIT" \
  RELEASE_VERSION="$RELEASE_VERSION" \
  ARCHIVE_OUTPUT_DIR=build/release-archives/rc1-attempt1
```

`RELEASE_REPOSITORY` defaults to this checkout (`.` when invoked from the repository
root). Set it explicitly if the commit objects live in another prepared repository.
Inherited Git routing/command override environment variables do not redirect that
repository, and Git replacement refs cannot replace the requested objects. The trusted
validator comes from the packager checkout, not from S/M.
Missing objects fail; the command does not fetch them or resolve a moving ref.

The equivalent direct command, useful for an unprivileged workflow step, is:

```sh
python3 -B scripts/package-release.py \
  --repository "$RELEASE_REPOSITORY" \
  --source-commit "$SOURCE_COMMIT" \
  --materialized-commit "$MATERIALIZED_COMMIT" \
  --version "$RELEASE_VERSION" \
  --output-dir "$ARCHIVE_OUTPUT_DIR"
```

Set all five inputs before using that direct form. The Make target checks this
checkout's Node/npm versions and invokes the same Python command; neither form builds
S, creates M, installs dependencies, signs, creates checksums/manifests, allocates RCs,
creates refs/commits, or publishes. `make test` includes the regression suite, also
available as `make release-archives-test` with the existing Node dependencies installed.

## Outputs and checks

For version `X.Y.Z`, successful packaging writes only:

- `buildish-mammoth-cache-X.Y.Z-src.tar.gz`, rooted at
  `buildish-mammoth-cache-X.Y.Z-src/`;
- `buildish-mammoth-cache-X.Y.Z-github-action.zip`, rooted at
  `buildish-mammoth-cache-X.Y.Z-github-action/`.

The source archive comes from the tracked tree S and the Action archive comes
from M. The packager requires M's files, modes, and Git blob identities
outside `dist/` to match S; S must not already contain generated `dist/`. This catches
changed source or legal files hidden in materialization. Lifecycle source authorization
and the retained evidence tying S to M remain Release Tooling/workflow responsibilities.

Git creates the archive containers. Before exposing output, the packager checks their
actual entries, file sizes, executable bits, and blob bytes against the selected
commits. Export attributes that omit or substitute committed files fail.
Untracked/dirty checkout files
are not archive inputs. Tracked `docs/releases/` history is rejected in either tree.
The initial packager accepts regular files/directories and rejects Git symlinks,
submodules, absolute/traversal paths, backslashes, colons, and `.git` path segments.

The Action ZIP is unpacked into owned temporary staging using only validated entries,
then checked by `validateDistribution`: both descriptors must resolve all four nonempty
main/post bundles inside `dist/`, and required source/bundled legal files must be
present. Selected-source bundles are not executed during packaging. This static check
does not replace `make release-legal-check`, trusted CI, mandatory-note checks, or
[consumer smoke testing](DISTRIBUTION-VALIDATION.md) of the unpacked Action archive.

Source tar gzip headers omit transient timestamps/filenames. Repeated packaging with
the same commits, version, and toolchain produces matching bytes in regression tests;
no cross-toolchain reproducibility promise is made. Retain and promote the approved
candidate's exact bytes rather than rebuilding them later.

## Consume the packaged Action in CI

`make archive-consumer-check` builds the current checkout, creates disposable S/M
commits, packages both unsigned archives as synthetic version `0.0.0`, unpacks the
verified Action ZIP, and runs the existing isolated Gradle/Maven main/post smoke
scenarios against its contents. This is a CI script around the ordinary component
build, packager, and smoke checks. It needs no Release Tooling package or credentials.
The Gradle scenario can download and verify Gradle, so this runs separately from
`make check` and requires network access. Existing build dependencies must be installed
or the Make build prerequisite invokes the normal `npm ci`.

The temporary source commit snapshots current working-tree bytes for paths in the
Git index, preserving indexed executable modes. Untracked files, dependency trees,
and ignored historical docs are excluded. Missing tracked files, symlinks, submodules,
unmerged paths, tracked `dist/`, and tracked historical docs fail the check. Only the
four existing built bundles are added in temporary M. Local edits to tracked files
are exercised; untracked additions must be staged to join the source snapshot.
This fixture proves archive consumption; it does not authorize a source commit or
establish the provenance needed for a real release.

The default consumer uses `node` on PATH. To exercise an installed Node 24 runtime
while retaining the project's Node/npm build toolchain:

```sh
make archive-consumer-check ARCHIVE_CONSUMER_NODE=/path/to/node24
```

CI builds with the project's Node/npm versions, switches to Node 24, and then runs:

```sh
python3 -B scripts/archive-consumer-check.py --node node
```

The push/PR job `Consume packaged Action ZIP` has read-only repository permissions,
no persisted checkout credentials, and no release environment. `Required Checks`
requires its result to be `success`; a failed, cancelled, or skipped result fails that
gate. The job additionally rejects changes left in the checkout.

Temporary repositories, fixture commits, archives, and extraction trees live beneath
`build/archive-consumer-*` and are removed on success or ordinary exceptions. The
existing smoke runner uses a separate isolated system-temp tree, disables cache
orchestration, and removes that tree too. No original refs, index entries, Git
configuration, signatures, or release assets are changed. Abrupt process/runner
termination can leave ignored temporary outputs; disposable CI runners discard them.
`make archive-consumer-test` covers real packaging/extraction and failure cleanup
without executing bundles or downloading Gradle, and is included in `make test`.

## Filesystem effects and recovery

The output parent is created if needed. A private sibling temporary directory holds
archives and staging and is removed on success/failure. The requested output directory
is reserved only after both archives validate; any existing directory or symlink is
refused, even if empty. Existing artifacts are never overwritten or cleaned up.

A filesystem failure during the final copy can leave an owned partial new output
directory. Inspect and preserve wanted data, and use a fresh output directory for a
new attempt; this command does not repair/reuse a partial output. It does not replace
the lifecycle's matching-publication recovery protocol. Changing bytes after candidate
approval requires a new reviewed candidate, as described in the operator guide.

Signing, SHA-256/SHA-512 sidecars, producer-bound handoff digests, candidate/final
manifests, approval, and remote convergence remain Release Tooling/workflow operations.
Unsigned local archive success does not establish release readiness or authorize a
mutation. Modern 0.1.4 candidate/promotion workflows now compose these operations;
deployment, signing inputs, approval and live-service qualification remain separate
prerequisites in the [operator guide](RELEASE-PROCESS.md).
