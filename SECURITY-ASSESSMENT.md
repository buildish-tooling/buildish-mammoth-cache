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

# Security Assessment — Apache Buildish Mammoth Cache

**Initial assessment:** 2026-04-07.

---

## Scope

Seven areas examined:

1. **Injection surface** — env vars, action inputs, and event payload fields that influence
   security-sensitive decisions (read-only mode, cache key derivation, Groovy code generation,
   cache-key template literals).
2. **Output safety** — HTML and Markdown rendering in job summaries.
3. **Wrapper supply-chain integrity** — JAR download, checksum, and PGP signature verification.
4. **Subprocess isolation** — child-process environment, GPG command resolution.
5. **Path safety** — workspace-traversal guards, symlink checks, atomic file operations,
   cache-partition glob validation.
6. **CI workflow posture** — `permissions:`, `persist-credentials`, action SHA pinning.
7. **Availability posture** — per-request timeouts, response-body size limits, retry caps.

---

## Findings

No findings.

---

## Areas Examined

| Area                            | Mechanism                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Groovy injection                | Single-quoted string literals via `toGroovySingleQuotedString`; `validateCaptureRootPath` defence-in-depth rejects shell-expansion markers and control characters in `RUNNER_TEMP`                                                                                                          |
| Cache key template validation   | `validateCacheKeyTemplate` restricts literal characters to `[A-Za-z0-9._:-]` and only permits declared placeholders; enforced at config-parse time before any cache key is derived                                                                                                          |
| Cache partition glob validation | `normalizeCachePartitionGlob` rejects `..` path-traversal segments, `~` home-directory expansion, absolute paths, negated globs, and unsupported wildcard syntax at config-parse time before any filesystem access                                                                          |
| GPG command validation          | On Windows, when `BUILDISH_MAMMOTH_CACHE_GRADLE_GPG_COMMAND` is set, `validateAbsoluteExecutablePath` requires an absolute path, resolves all symlinks via `realpath`, and verifies the result is a regular file; the canonical symlink-free path is used for `spawn()` to eliminate TOCTOU |
| Subprocess environment          | `buildMinimalChildEnv` strips the parent environment to a POSIX or Windows platform-specific allowlist (HOME, PATH, LANG, locale, temp, and DLL-loading variables only) before every GPG invocation; CI tokens and application secrets are never inherited                                  |
| Wrapper checksum integrity      | SHA-256 downloaded from `services.gradle.org` over HTTPS and verified against the downloaded JAR bytes before any write                                                                                                                                                                     |
| Wrapper signature integrity     | PGP detached signature verified against a pinned key allowlist; each key's fingerprint is validated at import via `gpg --show-keys --with-colons`; a fresh ephemeral GPG home is created per verification call so no mutable keyring state is shared                                        |
| Wrapper properties enforcement  | `validateDistributionUrl=true` must be present in `gradle-wrapper.properties` or the action rejects the file; this enables Gradle's own native URL validation in addition to the action's checks                                                                                            |
| Distribution URL pinning        | `distributionUrl` must be `https://services.gradle.org/distributions/gradle-<version>-{bin,all}.zip` exactly; non-HTTPS scheme, non-canonical host, port, credentials, query parameters, and fragment are all rejected                                                                      |
| Download size caps              | `readBodyWithSizeLimit` applies a `Content-Length` pre-check and a streaming byte counter; limits are 64 KiB for checksums, 64 KiB for signatures, 10 MiB for wrapper JARs; an adversarial server cannot exhaust memory by omitting `Content-Length`                                        |
| Per-request network timeout     | `AbortSignal.timeout(requestTimeoutMs)` is created fresh per individual fetch attempt (default 30 s, configurable up to 300 s via `validateRequestTimeout`); a hanging server cannot block an action run indefinitely                                                                       |
| Path traversal in delta apply   | `validateNormalizedRelativePosixPath` + `resolveNormalizedPathWithinRoot` on every payload path; checked at both staging and apply time                                                                                                                                                     |
| Symlink attacks                 | `lstat` + `isSymbolicLink()` checked before every file read and write in the delta pipeline; `walkDirectory` rejects symlinks during the initial directory scan of extracted artifact packages                                                                                              |
| Workspace escape                | `path.resolve` + `path.relative` containment check; `realpath` + containment check post-resolution for config files read from the workspace                                                                                                                                                 |
| Cache artifact integrity        | SHA-256 of every payload file re-verified on download and again on apply against the value recorded in the delta manifest                                                                                                                                                                   |
| Delta artifact poisoning        | Strict Zod schema on `delta-package.json` (sorted unique paths, lowercase SHA-256 pattern, portable cache root sentinel); manifest digest verified before any extraction; unexpected files rejected after directory walk                                                                    |
| Single-run guard                | `claimSingleRunPrepareExecution` writes a guard file with `O_EXCL` (`wx`) semantics; concurrent action invocations racing within the same CI job cannot both claim ownership                                                                                                                |
| SafeHtml enforcement            | `createHtmlTable` requires `SafeHtml` cells; `escapeHtml` and `createHtmlLink` return `SafeHtml`; `safeHtml()` carries explicit caller responsibility; enforced at compile time with no runtime overhead                                                                                    |
| Auth headers host-scoped        | Auth headers keyed by exact HTTPS hostname; never sent to unrelated hosts                                                                                                                                                                                                                   |
| HTTPS enforcement               | All external downloads enforce `https:` scheme and reject non-canonical host, port, credentials, query parameters, and fragment                                                                                                                                                             |
| Atomic file writes              | `O_EXCL` flag (`wx`) + `rename()` used for wrapper JARs, delta payload files, GPG temp files (trusted-keys, payload, signature), and the single-run guard file; a partially written file is never exposed to consumers                                                                      |
| GitHub token not logged         | Diagnostics record only presence/absence of the token, never its value; the token is applied per-host and never written to summaries, log output, or post-action state                                                                                                                      |
| CI workflow permissions         | `permissions: read-all` at top level; per-job escalation only where needed; `persist-credentials: false` on all checkouts; third-party actions pinned by SHA                                                                                                                                |
