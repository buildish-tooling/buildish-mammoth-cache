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

# Mammoth Cache Release Process

Status: implemented candidate/promotion workflows for Release Tooling **0.1.4**,
2026-11-17. Local tests and installed-wheel qualification are available; live release
readiness still depends on the deployment/signing/approval checks below. No live
workflow dispatch, signing-key use, tags, Releases, or docs-branch publication was
performed during implementation.

Use `release-candidate.yml` and `release-promote.yml`, dispatched from **main**.
The four obsolete `releasey-*` entry points have been removed. The accepted policy
is defined in the [release contract](RELEASE-CONTRACT.md). Implemented workflows do
not establish credential usability, environment protection, or live status propagation.

## Release identity and accepted contract

The existing component process distinguishes:

- **S — source commit:** the exact reviewed source selected for the release, with
  required CI and mandatory version-specific release notes bound to that commit.
- **M — materialized Action commit:** a detached direct child of S containing
  generated `dist/` files. Both descriptors and all four Gradle/Maven main/post
  bundles must be present. Builds stay component-owned.
- **W — trusted workflow/tooling revision:** code and configuration executed in jobs
  with signing or publication authority. Selected source S is built in an isolated
  job without those credentials; privileged jobs do not check out S or M to execute
  their code.

Preserve source → build → commit generated files → tag M. Release Tooling's pushed
source at `410c8b375c769b9544a3de19f553c5487e4de634` declares version 0.1.4 and
supports this contract through `bind-materialization` and `import-materialization`.
The selected package pin is **buildish-release-tooling==0.1.4**. It is published
on PyPI and has passed local installed-wheel qualification. Version 0.1.3 is
incompatible with this modern S/M lifecycle. Do not substitute M for the reviewed source identity.

The [accepted release contract](RELEASE-CONTRACT.md) fixes the following terms:

| Area             | Accepted policy                                                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle        | Public candidate prereleases `vX.Y.Z-rcN`, starting at RC1; retain published candidates and promote only an approved exact candidate tag plus manifest SHA-256.                                |
| Deliverables     | GitHub-authoritative signed source tarball from S and signed Action ZIP from M, each with SHA-256/SHA-512 checksums; exact archive/sidecar bytes reused on promotion. No registry publication. |
| Tags             | Immutable exact `vX.Y.Z` and candidate tags on M. No moving major/minor/other Action aliases initially.                                                                                        |
| Source and notes | S reachable from main, successful trusted push CI, and required notes read from S at `buildish-release-tooling/release-notes/{version}.md`.                                                    |
| Approval         | Manual approval by an authorized maintainer, recorded against exact candidate tag/digest; GitHub repository/workflow permissions authorize dispatch and reruns.                                |
| Legal            | Existing conservative dependency-license gate plus bundled LICENSE/NOTICE verification form the initial release policy.                                                                        |
| Docs             | Group by `X.Y`; run the verified post-release import after successful promotion. Support windows require explicit curation.                                                                    |

The first version remains a dispatch input. Approver identities, deployment settings,
actual signing usability, hosted workflow/environment behavior, and deployment bindings
still need qualification. Those are prerequisites to execute the accepted contract.

The Apache-2.0 license and checkout location do not imply ASF voting, distribution,
or governance requirements. Foundation-specific profiles apply only when selected
by an established component policy.

Signing uses the shared `release-candidate` secrets
`BUILDISH_RELEASE_GPG_SECRET_SUBKEY` and `BUILDISH_RELEASE_GPG_PASSPHRASE`, mapped to
`BUILDISH_GPG_PRIVATE_KEY` / `BUILDISH_GPG_PASSPHRASE`. The expected full fingerprint
is pinned once in `release-config.yaml` under `artifacts.signing.expected_fingerprint`.
Release Tooling validates the imported key against that configuration; no duplicate
GitHub fingerprint variable or runtime override is required. Actual key/passphrase
usability still requires verification.

The ordinary push/PR CI also packages real built bundles in disposable commits and
runs Gradle/Maven main/post from the unpacked Action ZIP under Node 24. The
[archive-consumer check](ARCHIVE-PACKAGING.md#consume-the-packaged-action-in-ci)
requires no release credentials and is mandatory in `Required Checks`. It exercises
archive consumption; candidate-specific provenance, signing, approval, and release-ref
readback remain separate release gates.

## First-release prerequisites

Complete this checklist once, then recheck affected items after workflow, policy,
package, or deployment changes:

1. Use the published **0.1.4** wheel pinned by `requirements.txt` and
   `tooling-wheel.sha256`. Its checked SHA-256 is
   `1e0e11073500facbc6c758fc13d5582cd6aff6b2581fb176144992efd04e139e`.
   The setup action downloads that exact wheel, verifies its digest before installing
   it and dependencies in runner temp, then reports version/origin. Python must be
   3.11+. Requalify after package/configuration/launcher changes; source-only tests
   do not replace installed-wheel testing.
2. Keep the component configuration, exact dependency, and modern candidate/promotion
   workflows under review; commit the complete implementation and required notes
   before selecting a release source. The launcher selects an
   already installed interpreter, verifies the exact wheel version/origin, and
   supplies this component's configuration. It never searches sibling checkouts,
   installs packages, or executes `uv run --project`.
3. Bind source authorization to exact S, protected-main ancestry, and the trusted
   push CI producer on main, including the intended
   `.github/workflows/ci.yml` `Required Checks` result. A same-name check alone is
   insufficient. Separately verify the quality and required status of essential
   build/integration jobs; an overall green run is not enough.
4. Review hosted branch/tag rules, allowed Actions and immutable action pins,
   workflow activation, environments and deployment branch policies, and secret
   names/scopes. Align actual environment names with every job that needs one.
   Verify the intended GitHub release-immutability setting and token permissions;
   inaccessible settings remain manual checks, not assumed configuration.
   Use `release-candidate` with **no required environment reviewers** and main-only
   deployments. GitHub repository/workflow permissions authorize dispatch and reruns;
   the explicit promotion dispatch records the maintainer's decision against an
   exact candidate tag/digest. No separate actor allow-list or
   second-person/deployment approval is required. Restrict repository access to the
   intended release operators.
5. Verify the actual exported key, complete expected primary
   or signing-subkey fingerprint, and matching passphrase through an explicitly
   approved isolated check. It must not print secret material or alter the normal
   keyring. Restrict signing credentials to the trusted signing job.
6. Scope `contents: write` to required mutation jobs, and OIDC/registry permissions
   only if a future explicitly approved destination needs them; none is required initially. Draft-release verification may
   need job-scoped write-capable credentials even when its commands only read.
   Serialize competing mutations for the same repository/version with non-cancelling
   concurrency, including equivalent protection for any maintainer-shell procedure.
7. Prove producer-bound digests for release-critical state/artifact handoffs, exact
   tag/source/materialization verification, identical partial-state recovery, and
   finalization after an intentionally skipped optional upload. Cancellation or a
   failed essential verifier must prevent publication. Check essential jobs
   individually; local rehearsal cannot prove GitHub's status propagation.
8. Exercise the installed-package path without an undeclared sibling checkout.
   Record distribution version and execution origin, static/workflow-policy checks,
   isolated rehearsal, and consumer tests as separate evidence. Confirm local runner
   mappings and that required jobs actually executed. Keep live credential/settings
   validation distinct from local rehearsal.

After an approved installation, these read-only commands identify the package used
by that Python environment; compare it with the CLI executable selected by the job:

```sh
command -v buildish-release-tooling
python3 -c 'from importlib.metadata import distribution; d = distribution("buildish-release-tooling"); print(d.version); print(d.locate_file("buildish_release_tooling"))'
```

These commands do not install a package. A missing package is a failed prerequisite.
Do not treat the presence of a CLI name on PATH as proof of its version or origin.

## Implemented 0.1.4 integration

`release-config.yaml` expresses the accepted candidate lifecycle: resolved S
reachable from main, trusted push `Required Checks`, mandatory version notes, source
archive built from S, two signed archive families, SHA-256/SHA-512, GitHub-only
publication, immutable tags targeting M, and permitted generated path `dist`.
The expected signing fingerprint matches Release Tooling's reviewed configuration
because the signing inputs are shared. Verify it against the actual imported
signing key before use. Artifact families describe policy; workflows enforce the exact two-archive inventory,
six required sidecars, and supplemental `materialized.bundle` transport asset. The
bundle is bound by the materialization SHA-256 and candidate manifest; it is not a
third primary archive and is not signed separately. All nine retained candidate
assets are reused unchanged on promotion.

`release-tooling.sh` invokes `run.py` with Python's isolated import mode. Select an
already approved/provisioned Python environment explicitly when needed:

```sh
BUILDISH_RELEASE_TOOLING_PYTHON=/path/to/approved/venv/bin/python \
  bash buildish-release-tooling/release-tooling.sh --package-info
```

This only reports the selected package version and CLI origin. Missing/wrong-version
packages, editable installs, missing wheel records, imported CLI location mismatches,
and the old `BUILDISH_RELEASE_TOOLING_DIR` source override fail explicitly. Commands
run in the caller's working directory, using the configuration beside the trusted
launcher; an extra `--component-config` argument is rejected. Use the launcher from W
when operating in a separate build/object repository. It is an invocation check,
not proof that the installed wheel came from the public registry: published-wheel
acquisition, digest verification, and qualification remain separate requirements.

The modern job sequence follows the
[0.1.4 source reference](https://github.com/buildish-tooling/buildish-release-tooling/blob/410c8b375c769b9544a3de19f553c5487e4de634/docs/materialized-actions.md):

| Phase                 | Component/workflow responsibility                                                                                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trusted resolution    | Resolve the candidate from explicit S with trusted policy/CI/notes; retain the resolved-state digest as a producer job output.                                                                                                                       |
| Unprivileged build    | Build S, run checks, commit generated `dist/` as the sole child M, package archives from exact S/M, and run the unpacked-ZIP consumer checks.                                                                                                        |
| Bind and retain       | `bind-materialization --candidate-state ... --materialized-commit M --bundle-output ...` exports a bundle and bound state. Retain the original resolution state, exact bundle, bound state, archives, and independent build-job digest outputs.      |
| Trusted import        | Verify the resolution/build handoff digests, then `import-materialization --candidate-state ... --source-state ... --bundle ... --bundle-sha256 ...`. Validate objects/config without checking out or executing S/M with credentials.                |
| Candidate publication | Sign the exact archives, retain sidecars/manifests, and create/stage/verify the candidate from imported state. Tagging publishes a create-only internal materialization ref before the GitHub tag.                                                   |
| Promotion             | Select exact candidate tag/manifest digest, retain approved M and bytes, and import the original bundle using `--promotion-state` in fresh runners. This import must omit `--source-state`. Seal and publish only after required verifiers/approval. |

The internal namespace is
`refs/heads/buildish-internal/materialized/<full-M-commit-sha>`. Its creation is a
privileged Git push performed by Release Tooling, and needs explicit repository
credentials and namespace permission in the mutation job. It is retained recovery
transport, not release authority; cleanup is a separately authorized operation.
Missing retained bundle data fails instead of rebuilding a replacement M. Workflows
must carry the exact approved commit, not merely an equivalent generated tree.

The isolated installed-wheel qualification covers bind/import/promotion with fresh
shallow checkouts, changed bundle/original-state rejection, configured path and
sole-parent limits, unchanged trusted HEAD, and exact M/inline verification records
in the final manifest. Its stage/candidate records are synthetic local fixtures;
it performs no GitHub lifecycle, signing, or publication. Static workflow-policy
checks and actual packaged/ref consumer checks provide separate evidence.

`setup-release-tooling` is an ordinary composite CI action that installs a verified
wheel and binary dependencies into runner temp. `workflow.py` handles only bounded
transport inventories, safe data downloads/extraction, approval records, and
component-owned verification records. CLI commands own source resolution,
materialization, signing, tags, Releases and manifests. No new release service is
introduced. The unprivileged candidate job builds/tests S and also builds W's test
bundles for installed-package qualification; signing/publication jobs never execute
S/M code.

Each artifact consumer verifies a transport inventory against the intended producer's
independent job-output digest, then verifies every file and rejects missing, extra,
or symlink content. Original resolution state is separately bound to its producer.
Promotion downloads the exact candidate manifest and nine assets, checks all sizes/
digests, and verifies the bundle against its materialization binding. There is no
latest-RC discovery or promotion rebuild/re-sign operation.

Promotion stages the final tag/draft first. An unprivileged Node 24 job fetches the
exact final tag, checks M, and runs Gradle/Maven main/post from both that tag and the
retained ZIP. Only success permits publication. The trusted sealing job appends
component-owned approval and consumer `verification_results` to the otherwise
unchanged promotion state; complete canonical records are embedded inline in the
sealed final manifest's claims. They retain the dispatch actor and exact version /
candidate tag/digest alongside S/M/tree, final tag, Node major and executed scenarios. Full CI
logs are separate supporting evidence, retained according to Actions policy; the
inline records remain with the immutable manifest. The explicit promotion dispatch
is the maintainer decision; no external approval URL is requested.

No registry is a publication target for Mammoth Cache. All signing and write jobs
use `release-candidate` with main-only deployments and no required reviewers. Verify
its branch restriction, shared signing inputs, repository permissions and immutable-release
setting before use. A solo maintainer can review a candidate and dispatch promotion;
the exact candidate tag/digest identify the promotion decision. The original dispatch
actor is captured automatically; no additional approval reference is required. No second-person approval is introduced.

## Local preparation available now

From a trusted source checkout with the repository's selected Node/npm versions:

```sh
make check
make release-legal-check
```

`make check` cleans
outputs and `node_modules`, installs locked npm dependencies, builds, and runs tests,
format/lint, the selected dependency-license gate, and RAT. It needs the applicable installation
authorization. `make release-legal-check` compares attribution against this checkout's
source/dependencies. Neither result from W substitutes for the release's checks on S.

Keep retained materialized trees separate from this checkout's cleaned outputs.
After local checks, set `MATERIALIZED_TREE` to the exact existing generated tree:

```sh
: "${MATERIALIZED_TREE:?Set the exact existing materialized tree to inspect}"
make distribution-check DISTRIBUTION_ROOT="$MATERIALIZED_TREE"
```

`distribution-check` does not build the supplied tree. It validates descriptors,
four bundles, and required legal-file presence, then copies the distribution and
consumer fixtures into isolation and executes main/post without inherited credentials.
Cache orchestration is disabled; Gradle wrapper provisioning still uses canonical
network endpoints and signature verification. See
[distribution validation](DISTRIBUTION-VALIDATION.md) for effects, prerequisites,
Node 24 execution, time limits, and coverage boundaries. Legal-file presence alone
does not establish correct attribution for S/M or satisfy the complete selected legal gates.

Unsigned archive production is now available through `make release-archives` for
explicit S/M commit IDs and a final version. See [archive packaging](ARCHIVE-PACKAGING.md)
for commands, output names, exact-tree checks, and no-clobber recovery. It does not
create M, validate CI/approval, sign, or implement the release lifecycle.

## First release: authorized dispatch sequence

Complete the deployment checklist, commit/review the implementation, and obtain
separate authorization before executing the remote commands below. Source S must
contain nonempty notes at `buildish-release-tooling/release-notes/{version}.md` and
have successful trusted push CI on main. W is the selected workflow commit on main,
which can differ from S. Record W, S, exact inputs and run URLs.

For a candidate, supply the final version. The default source is main's HEAD after
the workflow fetches origin. It is resolved once and reused as exact S for trusted
push-CI checks, notes and builds. W remains the workflow's dispatch revision.
The trusted component configuration keeps explicit source selection because the
workflow always supplies that resolved commit to Release Tooling.

```sh
: "${RELEASE_VERSION:?Choose the final X.Y.Z version}"
gh workflow run release-candidate.yml --repo buildish-tooling/buildish-mammoth-cache \
  --ref main -f version="$RELEASE_VERSION"
```

To select another reviewed main commit, add `-f source_commit="$SOURCE_COMMIT"`
with its full lowercase SHA. The same ancestry and successful trusted push-CI gates
apply. The resolved source identity is retained in state and candidate evidence.

The workflow allocates the next public `vX.Y.Z-rcN`, signs the two archives, retains
all nine assets plus `candidate-manifest.json`, and reports the manifest SHA-256 in
its summary/output. Retain the exact tag and independently checked digest outside
the candidate artifact. Review the exact executable bytes and record the maintainer
approval against both. A rejected candidate remains published; a changed S/M or
artifact requires a new candidate.

For promotion, supply the exact candidate and independently retained manifest digest.
Submitting this dispatch is the maintainer's decision to promote those bytes. GitHub
provides the original actor identity; no separate approval URL is needed.

```sh
: "${RELEASE_VERSION:?Set the final X.Y.Z version}"
: "${CANDIDATE_TAG:?Set the exact vX.Y.Z-rcN to promote}"
: "${CANDIDATE_MANIFEST_DIGEST:?Set the independently retained lowercase SHA-256}"
gh workflow run release-promote.yml --repo buildish-tooling/buildish-mammoth-cache \
  --ref main -f version="$RELEASE_VERSION" -f candidate_tag="$CANDIDATE_TAG" \
  -f candidate_manifest_digest="$CANDIDATE_MANIFEST_DIGEST"
```

Both workflows share non-cancelling repository/version concurrency. Promotion
rechecks the main-only dispatch context and exact retained decision record before
publication, imports the retained M, stages exact
candidate bytes, requires the final-tag consumer job, and attaches the sealed
manifest before `publish-github-final-release --require-manifest-digest`. Final
readback must pass; no Release asset is uploaded after publication. Inspect every essential job
rather than inferring completion from a green dispatch or upload.

| Phase                 | Operator action and retained evidence                                                                                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolve               | Select exact version and authorized S once; retain W, state bytes/producer digest, successful trusted CI, and mandatory source-bound notes/digest. Reject conflicting existing state.                                                                           |
| Build/materialize     | Build/test S without signing/publication authority and pass its legal gates. Create the source tarball from S, materialize/validate M, and create the Action ZIP from M using version-stable names. Retain build/tree/artifact evidence and the S-to-M binding. |
| Sign                  | Verify the producer-bound inventory in trusted code. Sign both primary archives and prepare SHA-256/SHA-512 sidecars. Retain the exact complete candidate inventory and signing fingerprint.                                                                    |
| Candidate             | Publish/revalidate the exact immutable RC tag on M as a public prerelease with both signed archives, checksums, and candidate manifest. Retain tag/digest independently for manual maintainer approval, then verify the candidate.                              |
| Promotion             | Require recorded maintainer approval of the exact candidate tag and manifest digest. Reuse its materialized identity and all approved archive/signature/checksum bytes without rebuilding or re-signing. Never discover the newest candidate.                   |
| Stage and verify      | Create/revalidate the final tag on approved M, stage a draft final Release, and verify exact refs, both signed archives/checksums, and mandatory notes. Initial publication is GitHub-only.                                                                     |
| Seal                  | While GitHub remains a draft, attach durable evidence and `release-manifest-v1.json` without clobbering. Retain the producer's exact sealed-manifest SHA-256. Reuse matching sealed bytes during recovery.                                                      |
| Publish and read back | Finalize with the exact sealed digest using publish-github-final-release --require-manifest-digest. Publish GitHub last; verify the locked inventory, notes, and immutable refs on M without further uploads. Do not create moving Action aliases.              |
| Record completion     | Retain version, S, M, W, candidate tag/digest, final tag, asset inventory/digests, release IDs/URLs, sealed manifest/digest, verification results, and approval evidence in the approved durable location. Then perform the separately authorized docs update.  |

All privileged consumers verify digests against the producer's retained values before
using downloaded state/artifacts. Merely downloading an object and its checksum from
the same mutable location does not establish the required producer binding.

## Local release preparation

For the requested final version `X.Y.Z`, prepare the source changes for review:

1. Set `version` in `package.json` and both the top-level `version` and
   `packages[""].version` in `package-lock.json` to `X.Y.Z`.
2. Add `buildish-release-tooling/release-notes/X.Y.Z.md`. Use the preceding
   version's notes for structure and describe the changes in this release.
3. Check that the version fields agree, the note describes the intended release,
   and the lockfile diff contains only the two version fields. Run
   `make release-workflow-test` and review the local diff.

Local preparation ends with reviewable source changes. Commit only when separately
requested. Human maintainers cut release candidates and promote final releases.
Import [versioned documentation](../tools/versioned-docs/README.md#manual-post-release-import)
after successful final publication, using the exact final tag.

## Subsequent releases

Repeat the chosen execution sequence with a new exact version and reviewed S; do not
overwrite an existing immutable tag or a Release asset with changed bytes. Different
RC Releases for one version may use the same version-stable filenames with different
reviewed bytes; promotion reuses the selected candidate's exact inventory. Recheck source CI,
release notes, dependency attribution, destination state, and settings affected since
the preceding release. Reuse only unchanged deployment prerequisites, with current
evidence for configuration or permission changes.

A workflow-only orchestration fix can use the same approved
candidate only while source, materialized identity, artifacts, signatures, and notes
remain unchanged. Changed reviewed inputs require a new candidate; retain prior
published candidates. Reuse archive/sidecar bytes exactly during promotion.

Release Tooling's Python/PyPI self-release demonstrates its own deliverables; it does
not establish Mammoth Cache publication readiness or require an npm/PyPI publisher.

## Partial-failure recovery

First retain the run URL, W, exact release identities, state/manifest bytes and producer
digests, and observed remote objects. Inspect before retrying. Do not delete or recreate
immutable history to turn a conflicting or incomplete attempt into an apparent success.

| Observed state                                               | Recovery rule                                                                                                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transient service/check failure                              | Retry using retained exact inputs after inspecting current state. Re-run the required readback; upload/command success alone is not completion.                                                   |
| Matching partial draft/assets                                | Reuse matching state and bytes, complete only missing declared work, then verify and seal. A different filename, digest, size, source, note, or target is a conflict.                             |
| M or approved build outputs lost                             | Do not silently rebuild into a different M or new bytes. Restore the retained identity/evidence or obtain a new reviewed release identity; keep existing published objects intact.                |
| Wrong/moved tag, mismatched asset/manifest                   | Stop, preserve evidence, and resolve the conflict explicitly. Do not force-update immutable tags, clobber assets, or delete/recreate Releases.                                                    |
| Optional upload intentionally skipped                        | Require its matching-existing-state verification to succeed and ensure essential seal/final jobs still execute. Skipped optional work must not bypass verification or skip required finalization. |
| Verification failed or run cancelled                         | Final publication stays blocked. Check already-created objects; resume only through reviewed convergence/recovery logic, with required verifiers successful.                                      |
| Workflow fix needed                                          | Start a fresh authorized dispatch from reviewed W. Retrying old jobs keeps their old workflow revision. Retain the same approved candidate only if its complete reviewed contract is unchanged.   |
| Published immutable Release missing required evidence/assets | Record the attempt as incomplete; preserve locked objects and use the approved correction/new-version process. Do not attempt uploads after locking or delete history to bypass the conflict.     |
| Release succeeds, docs update fails                          | Keep release artifacts unchanged and recover docs separately. Optional docs maintenance must not rebuild immutable artifacts or conceal a failed release.                                         |

Same-run workflow transport artifacts may be overwritten by their producing job on
a rerun; consumers still require that producer's current output digest. This does
not overwrite candidate/final Release assets or manifests. An overwrite deletes the
old same-name transport before uploading its replacement; same-run artifacts are
not permanent recovery storage. Workflow artifacts retain
resolution, build/bundle, signed assets, promotion inputs,
stage results, consumer records and sealed state/manifest for 90 days. Cross-run
promotion uses candidate Release assets, including the retained bundle, rather than
assuming same-run artifact availability forever. Back up release evidence according
to the component's retention requirements.

For a failed job, prefer rerunning only failed jobs so successful build/sign outputs
are reused. Rebuilding M or re-signing after candidate publication can produce a
conflict and must not overwrite published bytes. A fresh candidate dispatch allocates
a new RC. Candidate/final jobs detect existing manifest assets and reuse their exact
bytes, then invoke strict attachment verification; they never regenerate an existing
manifest. The final inline records are canonical and omit timestamps/run IDs, so the
same actor/candidate identity and successful scenarios can converge. Different
approval/consumer claims conflict with a previously sealed manifest; recover retained
exact state/evidence or obtain an explicit correction plan instead of replacing it.
A readback failure after publication requires investigation, not a second upload.

A shallow runner may lack a tag that GitHub or another job can see. The following
local-ref acquisition template is for a trusted recovery job after approval for the
fetch, using exact values from checksum-verified retained state. It does not check out
selected-source code or mutate remote state:

```sh
: "${FINAL_TAG:?Read the exact final tag from verified release state}"
: "${MATERIALIZED_COMMIT:?Read the expected tag target from verified release state}"
git check-ref-format "refs/tags/$FINAL_TAG"
release_workflow_head="$(git rev-parse HEAD)"
git fetch --no-tags --depth=1 origin "refs/tags/$FINAL_TAG:refs/tags/$FINAL_TAG"
test "$(git rev-parse --verify "refs/tags/$FINAL_TAG^{commit}")" = "$MATERIALIZED_COMMIT"
test "$(git rev-parse HEAD)" = "$release_workflow_head"
```

Use the repository's actual reviewed remote and ephemeral read credentials where
needed; never print credentials. Existing conflicting local tags are not overwritten.
The publication CLI must still verify local and hosted identity; GitHub
`target_commitish` metadata alone does not prove a tag target. Jobs creating annotated
tags need a process-local Git committer identity rather than changes to Git configuration.

## Manual documentation update after successful release

Follow [the versioned-docs procedure](../tools/versioned-docs/README.md) only after
release completion and the applicable branch/worktree/import authorization:

```sh
: "${RELEASE_VERSION:?Set the successfully completed stable version}"
# First creation only; creates an empty orphan branch/worktree.
tools/versioned-docs/checkout.sh --create
# For an existing published branch instead, use checkout.sh without --create,
# followed by update.sh when an explicit fetch/fast-forward is intended.
tools/versioned-docs/import.sh --post-release --version "$RELEASE_VERSION"
git -C docs/releases status --short --untracked-files=all
git -C docs/releases diff
python3 -m json.tool docs/releases/provider-snapshot.json
```

Set `RELEASE_VERSION` to the completed stable version. Acquire its exact final tag
separately before import. The post-release mode checks the published GitHub Release
and matches the hosted tag commit to the local tag. Docs come from that final tag's
`docs/` tree and the snapshot records the resolved final commit M. Review all generated
records and copies; inspect untracked files directly because `git diff` omits them.
Then commit and publish the docs branch only with separate
authorization. A tag is not proof of publication. Retain incomplete attempts as hidden
and retracted/removed records as withdrawn/tombstoned as appropriate, rather than
deleting records and allowing the next import to rediscover them.

Component `site/component.yaml` defines the shared `mammoth-cache` artifact and its
static version stream. The snapshot's scoped `artifacts[]` entry owns release lines,
exact release policy, and explicit latest designations. Post-release import records
the version's `X.Y` membership and advances the line and overall pointers when
appropriate. Tag-only import and rebuild preserve prior scoped policy. Validate the complete snapshot
and its line/target relationships with Pipeline before publishing it.

The aggregate website owns source/layout bindings and publication selection, binds
the component snapshot, and acquires source/docs branches independently with inventory
and docs from one docs-branch commit. It does not maintain a duplicate release registry. Its publication
paths must pass `--profile publication`. Local absence of released docs is allowed;
present invalid inventory and missing required publication inputs must still fail.
Validate historical-content exclusion from development, release navigation, and latest
links using aggregate `make site-check-local` before deployment. No latest link may
fall back to development docs. Switch public links only after released docs are deployed.
Catalog/website changes belong in that repository and need their own authorization.

## Readiness and reference baselines

Ready local implementation includes distribution/archive/consumer checks, versioned-
docs helpers, exact 0.1.4 invocation/configuration, modern candidate/promotion
workflows, policy regression tests, and installed-wheel qualification. Remaining
first-release work is named approver/deployment/signing prerequisites, hosted
workflow/status/permission qualification, and live publication/readback under authorization. A documented
manual docs update is sufficient initially; automated docs-branch publication is later
work with its own permissions and recovery behavior.

For the full release-contract decisions and current evidence, use the local
`.agents/2026-11-17-release-tooling-adoption.md` assessment and
`.agents/release-prep-work/README.md` tracker when available. They are local execution
records; this guide does not depend on them being published.

The reference baselines are deliberately distinct:

- Selected exact dependency: **0.1.4**, released on PyPI and locally qualified from
  the installed wheel; SHA-256 is pinned in `tooling-wheel.sha256`.
  Pushed source reference: `410c8b375c769b9544a3de19f553c5487e4de634`; materialization
  feature commit `3e7fe976a4672c110e143da56274bea79f63ffe9`.
- Historical inspected published CLI/package: **0.1.3**, tag `v0.1.3`, source
  `b4542a195705c13c3806ca34fed8e821bedc20c8`.
- Reviewed workflow/recovery composition:
  `80045552b0b75f3770aa09daff6e2120a543042d` in Release Tooling. Its Python packaging,
  registry settings, signing identities, and environments are not component defaults.
- Source-only versioned-docs helper origin:
  `07fbbefeaf300dd12aa5734e0e4172bc0229a7a9`, adapted locally under
  `tools/versioned-docs/` with Mammoth Cache identities and tests. Component-owned
  artifact/version authority follows Site Pipeline commit
  `8f3dadabb898d48cd202adfe309ee4b8fbef1b2f`.

Consult the released CLI/configuration/schema and threat-model contracts for package
behavior, and the reviewed workflow commit for recovery composition. Later source
changes are diagnostic/reference evidence until verified in an explicitly selected
published distribution. Missing newer diagnostics alone is not a blocker; the concrete
S-versus-M identity failure is the compatibility issue to resolve.
