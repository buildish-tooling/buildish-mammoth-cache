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

# Mammoth Cache release contract

Status: accepted initial contract, 2026-11-17. Audience: Mammoth Cache maintainers
and release operators. This records the accepted candidate/promotion, signing,
artifact, alias, approval, source, legal, and docs recommendations. It supersedes the
open policy choices in the earlier preparation assessment. Implementation and live
release readiness remain separate. The component configuration, exact installed-
package launcher and modern workflows use published 0.1.4. Local installed-wheel
qualification is complete; deployment/signing and live workflow verification remain pending.

## Release identity and lifecycle

Gradle and Maven Actions share one semver `X.Y.Z` and docs history. The first version
is chosen for RC1; this contract does not assign it. GitHub Releases and refs in
`buildish-tooling/buildish-mammoth-cache` are authoritative. No npm, PyPI, or other
registry publication is required by this contract.

Use public GitHub prereleases named `vX.Y.Z-rcN`, starting at RC1. Candidate tags are
immutable. Increment N for a new reviewed candidate and retain published candidates,
including rejected/superseded ones. Promotion selects an exact candidate tag and
its independently retained `candidate-manifest.json` SHA-256, never the newest RC.

Resolve one reviewed source commit S and build its generated Action payload into
materialized commit M. Candidate and final `vX.Y.Z` Action tags resolve the approved M;
S remains the source identity for source authorization, notes, and source artifacts.
Trusted workflow/tooling revision W supplies code executed with signing/publication
authority. Selected-source builds run without that authority. The candidate workflow's
source override is optional: omission selects the freshly fetched main HEAD, resolved
once to exact S. An explicit override must be a full commit ID. Both paths apply the
same main ancestry, trusted push-CI and source-note requirements.

Initially publish only immutable candidate and exact-version tags. Do not publish
moving major/minor tags, `latest` tags, or other Action aliases. Any later moving-tag
policy requires an explicit contract change. Documentation latest designations below
are a separate reader-navigation policy.

## Required signed deliverables

Build these primary archives once for the candidate. The component-owned
[archive packager](ARCHIVE-PACKAGING.md) produces and validates the unsigned inputs:

| Archive              | Identity and content                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Source `.tar.gz`     | Tracked source tree S, with its source/legal files; no untracked generated `dist/` or nested historical-docs worktree.               |
| GitHub Action `.zip` | Materialized tree M, with both Action descriptors, all four executable main/post bundles, and the required root/bundled legal files. |

Both primary archives exclude the dormant internal graph at
`test/qualification/distributed-correctness/`. The packager compares the full
committed trees S and M outside `dist/` before applying that exclusion to the
archives.

Use detached ASCII-armored OpenPGP signatures over each archive's exact bytes, plus
SHA-256 and SHA-512 checksum sidecars for each archive. Record the complete inventory,
names, sizes, digests, and signature identity in candidate evidence. The chosen candidate and its
final publication reuse the same primary archives and sidecar bytes; do not rebuild,
re-sign, rename, or regenerate them during promotion.

Implementation naming defaults use the final version even for candidates, allowing
unchanged promotion:

- `buildish-mammoth-cache-{version}-src.tar.gz`, rooted at
  `buildish-mammoth-cache-{version}-src/`;
- `buildish-mammoth-cache-{version}-github-action.zip`, rooted at
  `buildish-mammoth-cache-{version}-github-action/`.

These filename/root defaults make the accepted two-archive contract concrete; no
actual version or release files are created by this document. Different RC Releases
may carry different bytes under these same version-stable filenames; never replace
an asset already attached to a retained candidate Release. The supplemental `materialized.bundle` is retained as a ninth candidate asset,
bound by the materialization/candidate-manifest SHA-256, and reused unchanged on
promotion. It transports the approved Git objects and is not a third primary archive
or separately signed deliverable. Hosting-generated
candidate/final source downloads are supplemental, not substitutes for the retained
signed archives. A source archive from S must not be relabeled as an executable M
Action distribution.

Signing inputs match Release Tooling's `release-candidate` environment:

- secret `BUILDISH_RELEASE_GPG_SECRET_SUBKEY` → `BUILDISH_GPG_PRIVATE_KEY`;
- secret `BUILDISH_RELEASE_GPG_PASSPHRASE` → `BUILDISH_GPG_PASSPHRASE`.

The expected full fingerprint is pinned in the trusted component configuration at
`artifacts.signing.expected_fingerprint`. Release Tooling validates the imported key
against that value directly; no duplicate GitHub variable is required.

Verify actual key/passphrase/fingerprint usability in an approved isolated check
before a live candidate. Do not print secret material or modify the normal keyring.
Signing both archives is required, and a valid signature alone is not promotion
approval.

## Source, CI, notes, and legal gates

S must be reachable from protected `main` and have successful trusted CI. Bind
`Required Checks` to the exact S and its `push` producer in `.github/workflows/ci.yml`
on `main`. Same-name checks from another workflow/event are insufficient; essential
jobs must actually succeed.

Version-specific release notes are mandatory, read from S, and retained with their
exact bytes/path/digest through candidate review and promotion. The implementation
path default is `buildish-release-tooling/release-notes/{version}.md`. Missing or
empty notes fail preparation. Changed source, notes, archives, signatures, or M
require a new reviewed candidate; no existing immutable identity is overwritten.

Adopt the existing conservative dependency-license gate and bundled LICENSE/NOTICE
verification as the initial release policy, detailed in
[Release Legal Policy](../docs/dev/release-legal.md). Before a candidate, both
`make release-legal-incompatible-license-check` and `make release-legal-check` must
pass for S's source/dependencies. Retained legal output must match what ships in M.
The distribution validator checks executable layout and legal-file presence; it does
not replace attribution analysis or the dependency-license gate.

## Approval, promotion, and completion

Promotion follows an explicit dispatch by the maintainer authorized through GitHub
repository/workflow permissions. The dispatch itself records the decision to promote
the supplied version, exact candidate tag and manifest SHA-256; retain those values
and the original dispatch actor in the sealed manifest.
GitHub permissions also govern reruns; retain the original dispatch actor/decision
when another authorized operator reruns a failed job. A separate actor allow-list is
not required. Restrict repository access to intended release operators.

Verify the `release-candidate` environment/mutation settings before live promotion.
The chosen solo-maintainer environment has no required reviewers; keep its main-only
deployment restriction. The explicit promotion dispatch supplies the approval,
without a second-person/deployment gate. Its decision record is bound to the exact
tag/digest. No external decision page or approval URL input is required.
No foundation vote, fixed vote duration, or additional quorum is introduced.

A workflow-only fix can reuse approval only while the complete reviewed candidate
identity/bytes remain unchanged; start a fresh authorized dispatch to use new W.
Every privileged handoff verifies producer-bound digests. Serialize mutations for
the same repository/version and reject conflicting preexisting state.

Stage the final tag on approved M and the final GitHub Release as a draft. Attach
all required signed archives, checksums, retained Git bundle, durable verification
evidence, and sealed
`release-manifest-v1.json` before publication. Approval and successful Node 24 final-tag/ZIP consumer records
are embedded inline in the final manifest's verification claims. Full CI logs remain
separate supporting evidence. Require the producer's exact sealed
manifest digest with `publish-github-final-release --require-manifest-digest`.
Publish GitHub last and verify the locked release, refs, notes, and complete inventory
without additional uploads. A successful command or overall green run is insufficient;
all essential jobs and required readback must succeed. No secondary registry is part
of the initial completion gate.

## Released documentation

Group releases by `X.Y` in scoped snapshot release-line metadata; keep original docs
under exact version directories such as `docs/releases/X.Y.Z/`. Component metadata
owns the shared artifact/static stream, and the component snapshot owns exact release
policy, line `latest`, and overall `latestStable` designations. Catalogs own source,
layout, and publication selection.

After successful promotion, maintainers explicitly curate line/latest recommendations
in the versioned-docs branch, verify facts/content, and publish through the separately
authorized docs process. Neither a newly discovered tag nor the numerical highest
version automatically changes a recommendation. No support window, maintenance
promise, or end-of-life date is implied; add such policy only by explicit decision.
Hidden/withdrawn/tombstoned records remain retained and excluded as appropriate.

Docs maintenance is a separate post-release operation. Its failure does not authorize
rebuilding immutable release artifacts or declaring an incomplete release successful.

## Rationale and remaining checks

Candidate review binds approval to testable executable bytes. Keeping S and M distinct
preserves source review and executable Action refs. Two signed archives serve source
review and direct distribution; retaining their bytes avoids promotion rebuild drift.
Immutable-only Action refs avoid an unapproved moving-reference policy. Existing legal
gates provide the selected initial fail-closed baseline. Explicit docs curation avoids
turning tag discovery into a publication or support decision.

The selected exact Release Tooling dependency is now **0.1.4**, as approved after
the upstream S/M changes were committed and pushed. The published wheel is now
locally qualified and modern workflows are implemented. Before execution, finish
workflow/deployment qualification; local fixture evidence is not live publication
or signing proof. Verify repository/workflow permissions, environment
policies, fingerprint/key usability, and live permissions. The first version is a
release input. Revisit this contract before adding registries, moving aliases,
independent artifact versions, changed approval rules, or support commitments.

Use the [operator guide](RELEASE-PROCESS.md) for phase/recovery procedures and current
readiness limitations. Contract acceptance does not authorize installs, signing,
workflow dispatches, commits, pushes, settings changes, or publication.
