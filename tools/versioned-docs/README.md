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

# Versioned documentation worktrees

These component-owned maintenance scripts use Bash, Python 3.11+ (standard library
only), and Git. Creating the first branch requires Git with `worktree add --orphan`
support. They are adapted from Release Tooling commit
`07fbbefeaf300dd12aa5734e0e4172bc0229a7a9`; the published 0.1.3 CLI does not supply them.

Both Actions share one release version and the same `docs/` tree. The snapshot uses
component slug/artifact key `mammoth-cache`, provider `mammoth-cache-tags` of type
`git-tags`, and Mammoth Cache GitHub URLs. `site/component.yaml` owns the shared
artifact definition and static development/tag stream. Gradle and Maven are consumers,
not separate independently versioned documentation artifacts.

The independent `versioned-docs` branch contains one inventory and one directory per
imported stable version:

```text
provider-snapshot.json
release-notes/
  1.2.3.md
1.2.3/
  _index.md
  ...
```

The default checkout is `docs/releases/`, while development docs stay on the source
branch. Import reads docs from the exact final `vX.Y.Z` tag and records its resolved
commit. Under the accepted Mammoth Cache contract this is materialized Action commit
M; it is not
silently substituted with the original reviewed source S. Docs bytes and relative
links are copied unchanged. Candidate tags are excluded.

Release notes come from the same tag, at
`buildish-release-tooling/release-notes/X.Y.Z.md` (Release Tooling's
`release_notes.path_template`). Import copies them to `release-notes/X.Y.Z.md` and sets
the record's `releaseNotes.path`; Site Pipeline publishes them as the version's
release-notes page. The only change to the bytes is that one leading top-level
heading is dropped, because the site generates the page title and older tags still
contain one. A tag without notes gets no `releaseNotes`. Hidden, withdrawn and
tombstoned releases never gain notes. Notes should use fully qualified URLs for
links; repository-relative links do not resolve on the website.

## Checkout and update

Run from any directory; defaults are relative to this source checkout:

```sh
tools/versioned-docs/checkout.sh
tools/versioned-docs/update.sh
```

Checkout attaches an existing local branch without fetching. If missing locally, it
fetches only `versioned-docs` from
`https://github.com/buildish-tooling/buildish-mammoth-cache.git`, then creates its
local branch/worktree. Update explicitly fetches that branch and fast-forwards the
clean worktree. A local branch ahead of the remote is retained; divergent histories
fail. No remotes or tracking configuration are installed.

For the first creation, after separate authorization:

```sh
tools/versioned-docs/checkout.sh --create
```

This creates an empty orphan branch/worktree, sharing no ancestry or files with main.
It does not fetch, populate, commit, or push. Omit `--create` for an existing branch.
A branch already checked out elsewhere is refused by Git. An unborn branch must be
populated and committed, after review/authorization, before it can be updated.

All commands accept `--source PATH`, `--worktree PATH`, and `--branch NAME`. The
worktree defaults to `<source>/docs/releases` and must belong to that repository.
Checkout/update also accept `--remote URL_OR_NAME`; import deliberately does not.
Only run commands whose branch creation, network acquisition, or filesystem effects
have the applicable authorization.

## Manual post-release import

After successful release completion, acquire the exact final tag through the
approved Git process. Then, in a clean docs worktree:

```sh
tools/versioned-docs/import.sh --post-release --version 1.2.3
```

This mode queries the public GitHub API. It checks that the
exact tag has a published final Release and that the hosted tag resolves to the
same commit as the local tag. It then imports the docs and records `publishedAt`,
`publicationState: published`, and the exact `docsSource`. It assigns the version
to its `X.Y` release line, creating the line if needed, and advances that line's
`latest` and the artifact's `latestStable` when the imported version is newer.
Existing newer pointers and curated exclusion decisions are preserved.

Use the same command to complete metadata for a version previously imported from
its tag. Existing docs are reused, and a repeat of a completed import leaves the
inventory unchanged. A failed verification leaves the docs worktree unchanged.

## Tag-only import

Use tag-only imports for historical inventory work, including incomplete attempts:

```sh
tools/versioned-docs/import.sh
tools/versioned-docs/import.sh --version 1.2.3
```

Default discovery scans all local stable `vX.Y.Z` tags without a cutoff. Optional
`--minimum-version X.Y.Z` narrows discovery; repeatable `--version X.Y.Z` selects exact
versions and overrides that floor. Tag-only imports use local Git data.
New records contain Git identity and a canonical release URL, with no publication
timestamp or successful-publication assertion. New inventories include an owned
`artifacts[]` identity for `mammoth-cache`, with no release lines, exact release policy,
or latest designation inferred from tag discovery. Existing records-only inventories
remain valid and unchanged on a no-op import; the identity section is added on their
next import/rebuild write when absent. Explicit existing `artifacts: []` is preserved. Provider `fetchedAt` records the local
inventory observation time, not a hosted release event.

Incremental import appends new docs/records, preserves all existing docs and curated
metadata, and leaves a no-op inventory byte-for-byte unchanged. It also adds missing
notes to existing records whose tags contain them, without touching their docs. Both modes reject a
moved selected tag. Unselected records and records without local tags are retained;
if no tags match an existing inventory, that inventory remains unchanged.

Curate component release policy under the matching scoped `artifacts[].releases[]`
entries: incomplete attempts use `publicationState: hidden`, retracted releases use
`withdrawn`, and removed content uses `tombstoned` as appropriate. Existing per-record
curation is retained; explicit scoped and provider-record states must agree. Keep their records so
future discovery cannot reintroduce them. Their original docs may be absent during
incremental import. Missing ordinary published/unspecified docs fail with instructions
to rebuild. These states concern documentation publication, not remote deletion or
package retraction; operators must review hosted facts before committing inventory.

Review the unstaged docs and inventory using `git -C docs/releases status` and
`git -C docs/releases diff`. Inspect new untracked files directly; `git diff` omits
them. `python3 -m json.tool docs/releases/provider-snapshot.json` displays the inventory.
Commit and publish only with separate authorization.
These scripts never stage, commit, push, sign, dispatch workflows, or change Git
configuration. Normal source builds do not need a released-docs checkout.

## Full rebuild and recovery

```sh
tools/versioned-docs/import.sh --full-rebuild --version 1.2.3
```

Rebuild reconstructs selected docs and notes from their immutable tags while preserving complete
existing records, curated URLs, publication/support state, unselected versions, and
records whose tags are absent. It does not prune history. It replaces manual changes
committed inside selected managed docs directories, including ignored files there.
It may restore stored docs for excluded records; Pipeline must still exclude those
records from ordinary original-doc publication according to their curated state.

Dirty/foreign worktrees, symlinked snapshots, docs or notes, unowned destination paths,
`releaseNotes` paths other than `release-notes/X.Y.Z.md`,
foreign/duplicate inventory records, and tags without `docs/_index.md` are rejected.
All selected exports are validated and staged before existing docs are replaced.
Filesystem failures during final replacements can leave partial changes: preserve
wanted work, inspect the diff, and recover using ordinary authorized Git operations.
No reset, automatic commit, rollback, or destructive history repair is attempted.

## Source and website integration

`docs/releases/` is excluded from source tracking, ESLint, Prettier, and RAT (including RAT's
filesystem traversal). Source archives built from ordinary source commits do not
include that ignored worktree; imports also reject accidentally tagged historical
`docs/releases/` trees. TypeScript/esbuild inputs and the Action distribution check
do not include documentation history. Do not force-add the nested worktree to main.

The separately owned aggregate website acquires source and docs branches independently
and consumes inventory and docs from the same docs-branch commit. Pipeline does not
fetch branches. Its implemented contract accepts an explicit binding like:

```yaml
components:
  - slug: mammoth-cache
    content:
      source: mammoth-cache
    providerSnapshot:
      source: mammoth-cache
      path: docs/releases/provider-snapshot.json
      requirement: publication
```

The component metadata owns artifact definitions, docs roots, and static versioning.
The snapshot's matching `artifacts[]` entry owns `releaseLines`, exact `releases[]`
policy, and explicit `latestStable`. Post-release import updates the designated
pointers for the verified version. Tag-only import and rebuild preserve these scoped
blocks, including ancestry, withdrawal decisions, support facts, and records whose
tags are absent locally. Support windows require explicit curation.

The helpers check scoped ownership, container shape, unique identities, stable
versions, and conflicting publication states before writing. Site Pipeline remains
the authority for complete schema, graph/ancestry, latest membership, and selection
validation; run those checks before publishing a curated inventory. The aggregate
catalog owns source/layout bindings and publication selection, not a second version
registry. It may bind the component-defined artifact; it does not redeclare its
version facts. Native and container publication must
pass `--profile publication`; normal developer checks keep the local profile. Local
absence is allowed, required publication absence fails, and present malformed or
incomplete inventory must still fail. Hidden/withdrawn/tombstoned records must not
publish original docs or receive ordinary latest links. Development staging must
exclude historical docs, the inventory JSON, and the worktree `.git` file. Those
consumer changes and aggregate checks remain separately owned.

No real docs branch, release inventory, or snapshots are populated by this adoption
slice. Do not invent a successful first release. A manual post-release update is
sufficient initially; any later publication automation needs its own permissions
and failure/recovery contract.

## Checks

```sh
make versioned-docs-test
make check
```

The standard-library tests use disposable local repositories, fixture-only commits
and refs, and local repositories standing in for remotes. No network, installed
Python packages, configured identity, signing key, or real component branch is needed.
`make test` (and therefore `make check` and the CI unit-test step) includes this suite.
