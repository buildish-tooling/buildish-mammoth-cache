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

# Contributing to Apache Buildish

Thank you for considering a contribution to Apache Buildish.

## Before opening a pull request

- Check whether an existing issue or pull request already covers the change.
- For larger changes, start a short design discussion on a GitHub issue before investing heavily in implementation.
- Keep pull requests focused; split unrelated work into separate changes.

## Pull request expectations

- Base pull requests on `main`.
- Describe the motivation and the change clearly.
- Add or update tests and documentation when applicable.
- Keep commit messages and pull request text readable for future project history.

## Security issues

Do **not** open a public issue for a suspected security vulnerability. Instead, report it to [security@apache.org](mailto:security@apache.org).

## Development

The action project provides both npm scripts and Make targets.

Use Node `24.13.0` and npm `11.6.2` for local development. The Makefile sanity check enforces those versions.

Common commands:

- `make help`
- `make build`
- `make smoke-test`
- `make integration-test-build-reporting`
- `make integration-test-distributed-reuse`
- `make test`
- `make lint-check`
- `make release-legal-category-x-check`
- `make rat-check`
- `make release-legal-check`
- `make check`

Equivalent npm script:

- `npm run rat-check`
- `npm run release-legal:check-category-x`
- `npm run release-legal:check`
- `npm run release-legal:write`
- `npm run smoke-test`
- `npm run integration-test:build-reporting`
- `npm run integration-test:distributed-reuse`

The Makefile verifies the expected `node` and `npm` versions before running user-facing targets.

`npm run release-legal:write` refreshes `legal/github/LICENSE` and `legal/github/NOTICE` for the bundled GitHub action
distribution. Those files are separate from the repository-root `LICENSE` / `NOTICE`, which remain the ASF project legal
files.

See [`docs/release-legal.md`](docs/release-legal.md) for the release-legal workflow, generation/check commands,
formatting rules, and current legal-audit status.

### Dependency warning note

If `npm install` / `npm ci` prints a deprecation warning for `glob@10.5.0`, that warning is currently
transitive and does **not** mean this project depends on `glob` directly.

Current chain:

- `@actions/artifact`
- `archiver`
- `archiver-utils`
- `glob@10.5.0`

This repository already tracks GitHub's current `@actions/artifact` release line. The warning comes from
that upstream dependency graph, and we will pick up or evaluate a cleaner fix when GitHub's dependency
stack moves off the older `glob` release.

## Local verification

Full local verification:

- `npm run verify`
- `make release-legal-category-x-check`
- `make smoke-test`
- `make rat-check`
- `make release-legal-check`
- `make check`

This runs:

- lint
- formatting checks
- unit tests
- a fresh rebuild
- bundled Category X license verification (`npm run verify`, `make release-legal-category-x-check`, `make check`, and
  the regular CI check job)
- Apache RAT license-header verification (`make check` / `make rat-check`)

`make release-legal-check` / `npm run release-legal:check` remains the broader release-preparation audit. It verifies
`legal/github/LICENSE` and `legal/github/NOTICE` against the actual esbuild bundle and fails closed on unresolved legal
blockers such as missing third-party attribution data.

`make smoke-test` / `npm run smoke-test` performs a lightweight bundled-action smoke run against a temporary copy of
`test/fixtures/smoke`, so it does not modify committed fixture files.

`make integration-test-distributed-reuse` / `npm run integration-test:distributed-reuse` stages three temporary copies
of `test/fixtures/integration/gradle-project`, runs the real worker-A → worker-B → aggregator flow locally, and asserts
that the aggregator resolves the expected jars without re-downloading those jar files. This scenario requires:

- Java 21+
- network access for the initial wrapper/dependency downloads
- a POSIX-style shell environment (`gradlew` is used, not `gradlew.bat`)

On failure, the staged temporary directory is preserved and printed so you can inspect the generated Gradle homes,
summaries, and aggregator log locally.

`make integration-test-build-reporting` / `npm run integration-test:build-reporting` stages a temporary Gradle fixture,
runs multiple Gradle invocations locally, and writes the final step-summary style build report to
`build/integration-build-reporting-*/build-reporting-summary.md`. Set `BUILDISH_MAMMOTH_CACHE_KEEP_LOCAL_IT=1` to preserve
the staged directory after a successful run for local inspection.
