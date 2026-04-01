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

**Date:** 2026-04-01

---

## Scope

Six areas examined:

1. **Injection surface** — env vars, action inputs, and event payload fields that influence
   security-sensitive decisions (read-only mode, cache key derivation, Groovy code generation).
2. **Output safety** — HTML and Markdown rendering in job summaries.
3. **Wrapper supply-chain integrity** — JAR download, checksum, and PGP signature verification.
4. **Subprocess isolation** — child-process environment, GPG command resolution.
5. **Path safety** — workspace-traversal guards, symlink checks, atomic file operations.
6. **CI workflow posture** — `permissions:`, `persist-credentials`, action SHA pinning.

---

## Findings

No findings.

---

## Areas Examined

| Area                          | Mechanism                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Groovy injection              | Single-quoted string literals via `toGroovySingleQuotedString`; `validateCaptureRootPath` defence-in-depth                                                   |
| GPG command validation        | `validateAbsoluteExecutablePath`: must be absolute, `realpath`-resolved, regular file; canonical path used for `spawn()`                                     |
| Subprocess environment        | `buildMinimalChildEnv` strips everything except a minimal POSIX/Windows allowlist before GPG is invoked                                                      |
| Wrapper checksum integrity    | SHA-256 from `services.gradle.org` verified against downloaded JAR before write                                                                              |
| Wrapper signature integrity   | PGP detached signature against pinned key; fingerprint validated at import via `gpg --show-keys --with-colons`                                               |
| Download size caps            | `Content-Length` pre-check + streaming byte counter; 64 KiB / 64 KiB / 10 MiB limits                                                                         |
| Distribution URL pinning      | `distributionUrl` must be `https://services.gradle.org/distributions/gradle-<version>-{bin,all}.zip` exactly; credentials, query, and fragment all rejected  |
| Path traversal in delta apply | `validateNormalizedRelativePosixPath` + `resolveNormalizedPathWithinRoot` on every path                                                                      |
| Symlink attacks               | `lstat` + `isSymbolicLink()` guard before every file read and write                                                                                          |
| Workspace escape              | `path.resolve` + `path.relative` containment check; `realpath` + containment check post-resolution for config files                                          |
| Cache artifact integrity      | SHA-256 of every payload file re-verified on download and on apply                                                                                           |
| Delta artifact poisoning      | Strict Zod schema + manifest digest verification + unexpected-file check                                                                                     |
| SafeHtml enforcement          | `createHtmlTable` requires `SafeHtml` cells; `escapeHtml` and `createHtmlLink` return `SafeHtml`; `safeHtml()` carries explicit responsibility               |
| Auth headers host-scoped      | Auth headers keyed by exact HTTPS hostname; never sent to unrelated hosts                                                                                    |
| HTTPS enforcement             | All external downloads enforce `https:` scheme and reject port, credentials, query, and fragment                                                             |
| Atomic file writes            | `O_EXCL` flag (`wx`) + `rename()` used throughout                                                                                                            |
| GitHub token not logged       | Diagnostics record only presence/absence, never the token value                                                                                              |
| CI workflow permissions       | `permissions: read-all` at top level; per-job escalation only where needed; `persist-credentials: false` on all checkouts; third-party actions pinned by SHA |
