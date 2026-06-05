# Repository Instructions

This file contains repository-wide guidance for coding agents working in this
component repository. Keep instructions factual, tool-neutral, and scoped to
rules that should apply across code, tests, docs, and release work.

## General

- Preserve existing project style and structure unless a task explicitly asks for
  a broader refactor.
- Do not edit generated outputs unless the task is specifically about generated
  artifacts.
- Prefer small, reviewable changes with matching tests or validation commands.
- Do not revert user or maintainer changes unless explicitly asked.

## Code Style

- Follow the language and formatter conventions already used in the touched
  files.
- Keep comments concise and focused on non-obvious behavior.
- Prefer existing helper functions, build scripts, and project conventions over
  introducing parallel mechanisms.

## Testing And Validation

- All changes should pass `make check` before they are treated as complete.
- Run the narrowest relevant checks first while iterating.
- For changes that affect Buildish site content or routing, run
  `make site-check-local` from the Buildish repository `site/` directory.
- If a relevant check cannot be run, state that explicitly in the final response.

## Site Pipeline Content

This repository is consumed by the Buildish Site Pipeline as one component.

Authored inputs:

- `site/component.yaml` defines the component identity and content roots.
- `site/pages/` contains static, non-versioned component pages.
- `docs/` contains development or version-specific documentation.
- `site/assets/`, when present, contains component-owned static assets.

Use relative pretty-route links within this component:

- Do not use `.md` suffixes for page links.
- Do not include source directory names such as `site/pages/` or `docs/` in links.
- From a `_index.md`, link to a sibling page or section as `sibling/`.
- From a non-index page, link to a sibling page or section as `../sibling/`.
- From deeper pages, add enough `../` segments to reach the target route.

Static pages in `site/pages/` publish at the component mount path:

- Keep links between static pages relative.
- Treat `development/` routes as unreleased, in-development documentation.
- Link to `development/` only when the link text or surrounding prose clearly
  identifies the target as unreleased development documentation.
- Do not label `development/` links as `latest`, `current`, `stable`, `release
  docs`, or generic `docs`.
- Public/static pages may link to `development/` before the first ASF release
  only when no released docs target exists.
- After the first ASF release, public/static pages must link to released docs
  or release-derived aliases instead of `development/`.

Docs in `docs/` publish under the moving development route and may later be
copied under a release-version route:

- Keep links within `docs/` relative so the whole docs tree remains relocatable.
- From `docs/_index.md`, link to `reference/` or `getting-started/`.
- From `docs/reference/page.md`, link to another reference page as
  `../other-page/` and to a top-level docs page as `../../top-level-page/`.
- Avoid root-absolute component links inside `docs/`; they hard-code the current
  development publication location and will not survive release-version copies.
- Do not link from release-version docs to `development/`; released docs must
  link to released docs or release-derived aliases.

Links to another component may use that component's public catalog mount path,
for example `/components/site-pipeline/`.

## Security issues

Before reporting or fixing security issues, read
[docs/threat-model.md](docs/threat-model.md) to determine
whether a finding is a Buildish vulnerability, a deployment responsibility,
a dependency issue, or a false positive. Use [`SECURITY.md`](SECURITY.md)
reporting process and disclosure handling.

ASF severity, advisory status, and CVE candidacy are non-authoritative triage
estimates. Do not infer them from `docs/threat-model.md` alone.

Do not treat a test as proof of a vulnerability unless it demonstrates that the
stated actor can cross a real trust boundary without already-authorized access,
privileged fixtures, mocked trust decisions, or protected information.

Do not include private vulnerability details, exploit payloads, reporter names,
private mailing-list content, secrets, or non-public infrastructure details in
code, comments, tests, documentation, commit messages, or PR descriptions.
