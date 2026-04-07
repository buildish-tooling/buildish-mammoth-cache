---
title: Release Legal Files
weight: 30
description: Legal files required in the action distribution and how they are generated.
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

Apache software releases must include specific legal files. This document explains what is required,
why the action distribution has a different structure from a typical source tarball, and how the
required files are generated.

## The problem

GitHub Actions are distributed by committing compiled output to a Git repository and referencing
a specific SHA or tag. The action runtime fetches that repository at the referenced commit.

This means the action distribution is a Git tree, not a tarball, and the standard Apache release
process (source tarball + binary convenience zip) does not directly apply. However, the Apache
legal requirements still apply to the distributed artifact — the committed Git tree.

## Required files in the distribution

Every Apache software distribution must include:

| File        | Purpose                                                      |
| ----------- | ------------------------------------------------------------ |
| `LICENSE`   | The full text of the Apache License 2.0                      |
| `NOTICE`    | Copyright attribution and third-party notices                |
| `licenses/` | Individual licenses for all bundled third-party dependencies |

The `LICENSE` and `NOTICE` files must be at the root of the distributed tree. For a GitHub Action,
this means the root of the repository (or the root of the descriptor directory that is referenced).

## Bundled dependencies

The compiled action output (`dist/`) is a self-contained bundle produced by a bundler (esbuild or
similar). The bundle includes code from npm dependencies. The `licenses/` directory must contain the
license files for all npm packages whose code appears in the bundle.

The `scripts/release-legal.mjs` script produces `legal/github/LICENSE` and `legal/github/NOTICE`
by:

1. Building the action entry points with esbuild metafile output to determine exactly which npm
   packages are bundled.
2. Reading each bundled package's metadata and any `LICENSE` / `NOTICE` files from `node_modules/`.
3. Appending grouped per-dependency sections to the repository-root `LICENSE` and `NOTICE` and
   writing the combined result to `legal/github/`.

Run the script in write mode whenever bundled dependencies change:

```sh
make release-legal-write
```

Verify that the generated files are up to date with:

```sh
make release-legal-check
```

## NOTICE file

`legal/github/NOTICE` is generated automatically by `scripts/release-legal.mjs`. The repository-root
`NOTICE` file requires human review before each release; it must credit the original authors of any
bundled third-party code that requires attribution:

- MIT and BSD-2-Clause licenses generally require reproduction of the copyright notice.
- Apache 2.0 dependencies require reproduction of any `NOTICE` file they ship with.
- ISC licenses generally require only the copyright notice.

## Compatibility constraints

All bundled dependencies must be license-compatible with the Apache License 2.0. The following
license categories are **not** compatible with Apache 2.0 distribution:

| License family               | Reason                                  |
| ---------------------------- | --------------------------------------- |
| GPL / LGPL / AGPL            | Copyleft — incompatible with Apache 2.0 |
| CDDL / MPL                   | Weak copyleft — incompatible            |
| Non-commercial / proprietary | Not open-source                         |

Before adding a new npm dependency, verify its license is on the
[Category A](https://www.apache.org/legal/resolved.html#category-a) or
[Category B](https://www.apache.org/legal/resolved.html#category-b) approved list.

## Release checklist

1. Run `make release-legal-write` to regenerate `legal/github/LICENSE` and `legal/github/NOTICE`.
2. Review the repository-root `NOTICE` for any new dependencies requiring attribution.
3. Confirm no new dependency introduces a license incompatibility (`make release-legal-check`).
4. Commit the updated `legal/github/` files and root `NOTICE` to the distribution branch.
5. Tag the release commit with a version tag.
6. Publish the release following the
   [Apache release process](https://www.apache.org/dev/release-publishing.html).
