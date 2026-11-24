---
title: Troubleshooting
weight: 55
description: Diagnostic steps for the most common problems with Buildish Mammoth Cache for Gradle and Maven.
---

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

## Expected child-build failures in the Gradle summary

Mammoth automatically suppresses build-result capture for Gradle builds launched by `Test`
tasks, including TestKit fixtures. Tests can deliberately invoke failing builds with
`buildAndFail()`; the enclosing test task determines whether those outcomes are correct.
The enclosing build is still reported, so an unexpected test failure remains visible.

Builds launched by `Exec` and other tasks remain reportable by default. If a task deliberately
launches a failing Gradle build and checks its outcome, set
`BUILDISH_MAMMOTH_CACHE_GRADLE_SKIP_BUILD_RESULT_CAPTURE=true` in the child process environment:

```kotlin
tasks.register<Exec>("verifyExpectedFailure") {
  commandLine("./gradlew", "-p", "fixture", "someTask")
  environment("BUILDISH_MAMMOTH_CACHE_GRADLE_SKIP_BUILD_RESULT_CAPTURE", "true")
  isIgnoreExitValue = true
  doLast {
    check(executionResult.get().exitValue == 1) {
      "Expected the fixture build to exit with code 1"
    }
  }
}
```

For other process-launching tasks, pass the same variable through their process environment
API. The opt-out applies to descendants that inherit the environment and suppresses reporting
only; dependency caching remains enabled. Test code that replaces a child process environment
must preserve the variable to retain automatic suppression.

## Cache miss on every build

**Symptom:** The job summary shows "Base cache: miss" or "Base cache: partial hit" every run,
even on the same branch with no dependency changes.

**Diagnostic steps:**

1. **Check the family and lineage shown in the job summary.** The prepare step prints the current
   ref lineage and exact restored generation, when any. Search for the lineage prefix in the GitHub
   Actions cache list (`Settings → Actions → Caches`). If no generation exists, check whether a
   writable finalize completed successfully on the previous run.

2. **Check for a changed partition fingerprint.** The fingerprint segment of the cache key is the
   SHA-256 of your partition configuration. Any change to `cache-partitions` — including adding,
   removing, or reordering a partition, or changing a glob — produces a new fingerprint and
   therefore a new key lineage. This is expected and correct; after the first successful build
   on the new configuration the cache will hit again.

3. **Check explicit namespace isolation.** Java versions, OS and architecture share by default.
   If your `cache-key-prefix` includes matrix values, those values intentionally create separate
   families. Every worker and aggregator in a sharing group must resolve the same prefix.

4. **Check the cache eviction policy.** GitHub Actions caches are evicted after 7 days of
   inactivity and when the total storage cap for the repository is reached. An evicted entry
   looks identical to a new key from the action's perspective.

5. **Check the finalize save status.** `not-required` is expected after an unchanged cache hit and
   means no duplicate immutable generation was written. `failed`, `not-saved`, or `missing-paths`
   means the summary must not show a published generation; inspect the warning for the backend or
   path error. Aggregator publication failures fail the job because merged worker state is not yet
   durable.

---

## GitHub Actions cache storage keeps filling up

**Symptom:** Repository cache storage approaches the GitHub Actions cache cap, cache saves stop
being useful, or old cache entries are evicted before later jobs can reuse them.

**Diagnostic steps:**

1. **Keep timestamp GC enabled.** `cache-gc-mode: timestamp` is the default and prunes managed
   files in eligible writable post operations when mtime is older than
   `cache-gc-older-than-days` and current local or upstream activity does not protect them.
   No historical last-use grace is stored; noatime/relatime and coalesced clocks can hide use.
   `off` disables deletion only, retaining tracking/exchange costs.

2. **Tune the cutoff.** The default cutoff is `14` days. Lower values prune more aggressively, but
   the action rejects values below `2` days because common runner filesystems may not update access
   times on every read.

3. **Review custom partitions.** Broad custom `cache-partitions` can include generated or
   low-value files that grow quickly. Disable or narrow partitions that do not materially improve
   build time.

4. **Expect Maven to redownload pruned artifacts.** Maven local repositories are safe to prune
   conservatively because Maven can resolve old dependencies again when needed. If a workflow
   must run without network access, increase `cache-gc-older-than-days` or set
   `cache-gc-mode: off`.

---

## Delta artifact not found by aggregator

**Symptom:** The aggregator's prepare step fails with `Dependent delta artifact discovery failed`.

**Diagnostic steps:**

1. **Check the effective read-only policy.** A read-only aggregator intentionally performs no
   artifact lookup and reports `skipped-read-only`; missing artifacts are not an error in that
   mode. If the workflow only aggregates writable events, use a trusted-event `if` condition to
   skip the aggregator job entirely.

2. **Verify the `dependent-jobs` value on the aggregator matches the exact job key of each
   worker.** The job key is the YAML key in the `jobs:` map, not the `name:` field. For example,
   if the worker is defined as `jobs: { build-worker-a: … }`, the aggregator must list
   `dependent-jobs: build-worker-a`.

3. **Check whether the worker's finalize step actually ran.** If the worker build failed and the
   step running the action was skipped or the post-action hook was suppressed, no delta artifact
   was uploaded. The aggregator must still run (`if: always()` or equivalent) to clean up; it
   will report every missing or invalid configured worker rather than silently producing a broken
   cache. A successful writable worker uploads an explicit envelope even when it made no changes.

4. **Check for matrix job names with special characters.** Matrix dimension values such as
   `ubuntu-latest / Java 21` contain spaces and slashes that are sanitized when constructing
   the artifact name, but the `dependent-jobs` input must use the original unsanitized job key
   (e.g. `build (ubuntu-latest, 21)`). Use the `github-job-name` input on both worker and
   aggregator to assign simple, stable names that are independent of matrix labeling:

   ```yaml
   # worker
   - uses: buildish-tooling/buildish-mammoth-cache/actions/github/gradle@<sha>
     with:
       job-mode: distributed-worker
       github-job-name: worker-a
   # aggregator
   - uses: buildish-tooling/buildish-mammoth-cache/actions/github/gradle@<sha>
     with:
       job-mode: distributed-aggregator
       dependent-jobs: worker-a, worker-b
       github-job-name: aggregator
   ```

5. **Check rerun selection diagnostics.** The aggregator selects the newest unambiguous worker
   attempt not newer than its own attempt, so aggregator-only and failed-job reruns can reuse
   retained earlier envelopes. Duplicate artifacts for the same worker attempt are rejected as
   ambiguous instead of being selected arbitrarily.

6. **Check that the job is running on GitHub Actions with runtime artifact service variables.**
   Same-run worker upload and aggregator discovery use GitHub-provided Actions runtime credentials,
   not `actions: write`. If this is a nonstandard runner environment, inspect the first artifact
   client error rather than broadening `GITHUB_TOKEN` permissions.

---

## Gradle wrapper provisioning failure

**Symptom:** The action fails during provisioning with a message like
`Checksum mismatch for gradle-wrapper.jar`, `Detached signature verification failed`, or a network
error downloading from `services.gradle.org`.

**Diagnostic steps:**

1. **Checksum mismatch or invalid signature.** A checksum mismatch means the downloaded JAR does
   not match the expected digest published by Gradle. An invalid signature means its authenticity
   could not be verified. For `No public key`, see the signing-key guidance below. Possible causes
   of mismatched or invalid artifact bytes include:
   - A network proxy altered the response in transit. Check whether your runner uses a corporate
     proxy and whether it terminates TLS.
   - The `gradle-wrapper.properties` file specifies a custom `distributionUrl` or the wrapper JAR
     in the repository was modified. Verify the file against the official Gradle wrapper
     validation service at `https://services.gradle.org/versions/all`.
   - The wrapper was hand-edited or generated by a tool other than `gradle wrapper`. Re-generate
     it with `./gradlew wrapper --gradle-version=<version>`.

2. **GPG signing key unavailable.** Gradle occasionally rotates its signing key. A failure such as
   `Can't check signature: No public key` can mean that your Mammoth Cache version predates the
   signing key used by your Gradle version. Upgrade to a Mammoth Cache version that pins the
   current key. Compare the primary and signing subkey fingerprints with
   [Gradle's official key material](https://gradle.org/keys/). If the key is still missing from
   `src/build-tool/gradle/wrapper/signature.ts`, report the missing key or propose an allowlist
   update. Importing a key into the runner's normal keyring does not affect verification: the
   action uses an isolated temporary keyring and does not retrieve keys automatically.

3. **Network timeout or rate limit.** Wrapper downloads require outbound HTTPS to
   `services.gradle.org` and (for authenticated lookups) to `api.github.com`. If your runner is
   network-restricted, pre-install the Gradle wrapper JAR in the repository or use a proxy that
   allowlists those hosts. For GitHub API rate limits, pass a `github-token` with at least
   read-only `contents` access.

4. **Windows: wrong `gpg` binary or path format.** On Windows runners multiple `gpg` variants
   may be on `PATH`. Errors such as `Unable to inspect trusted OpenPGP key material` followed by
   `directory does not exist`, with a Windows temporary path appended to the workspace path,
   indicate that MSYS GnuPG received a Windows path it treated as relative. With Mammoth Cache
   0.1.1, set `BUILDISH_MAMMOTH_CACHE_GRADLE_GPG_COMMAND` to the full path of the installed
   `gpg.exe` before the action runs. This lets the action select the correct path format. The
   override also selects a specific GnuPG installation when several are available.

If prepare fails during wrapper provisioning, finalize logs that it is skipping execution and
saves no caches or artifacts. Resolve the original prepare error first. Older Mammoth Cache
versions may also report `Cache lifecycle state is missing` in the post action after prepare
failed. This follow-on error does not indicate that anything was saved without validated state.

---

## Missing `github-token`

**Symptom:** The Gradle action logs a warning about unauthenticated API access, or wrapper
provisioning intermittently fails with HTTP 403 or HTTP 429 responses.

**Explanation:** The `github-token` input (and the `GITHUB_TOKEN` environment variable fallback)
is used exclusively by the **Gradle** action to download wrapper JARs from GitHub Releases via
the GitHub API. It is not used by the Maven action and is not required when the wrapper JAR is
already present in the repository.

**How to pass it:**

```yaml
- uses: buildish-tooling/buildish-mammoth-cache/actions/github/gradle@<sha>
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

The token is applied only to requests targeting `api.github.com` and `raw.githubusercontent.com`.
It is never written to workflow summaries, log output, or post-action persisted state.

## Interrupted cache operations

Dedicate the Gradle or Maven user home to one active invocation at a time.
Keep other processes out of the root while Mammoth prepares, observes or moves
cache contents. Use the same home for the Action and the build. For example,
set Gradle's `GRADLE_USER_HOME` to the same path as an explicit
`gradle-user-home` input.

If the Action reports an interrupted lifecycle or an incompatible legacy intent,
preserve the old root and start the next invocation with a fresh dedicated root.
Check the reported paths for retained data before removing any files. A
disabled-cache invocation still checks a root that already exists.

If writable Gradle post reports a quiescence failure, check the log for the
installation or unavailable process evidence. Ensure Gradle builds and any
consumers have finished, including nested builds and background daemons. The
Action can safely stop registered Gradle daemons when it can establish ownership.
Required aggregator publication fails when that evidence is unavailable.
A standalone save can be skipped with a diagnostic. For Maven, finish all
repository users before post.

A failed or unconfirmed worker upload reports any retained immutable package.
Preserve the package and inspect that original invocation's failure. For a
failed source return, inspect both the original and retained paths and avoid
overwriting either copy. Start a new workflow invocation on clean dedicated
roots after diagnosing the failure.

## Directory breadth and memory diagnostics

A directory breadth error gives the phase, directory and effective
[`cache-max-directory-entries`](../configuration/#cache-max-directory-entries)
value. A working-budget error instead identifies name metadata or decoded
records. The breadth setting leaves those budgets in force.
Phase timings in the Action log help locate time spent in observation,
validation, publication and backend SDK calls.

## Cross-platform cache sharing

Java versions, OS and architecture share by default; build tool, schema and partition layout still
separate families. The platform-sharing key change starts cold and does not restore older keys.
If platform jobs miss each other's caches, check that prefixes and family inputs match and that
self-hosted Windows runners provide GNU tar and zstd. The GitHub backend enables cross-OS archives
and uses paths relative to the cache root so runner home paths do not determine cache versions.

Exact file permissions are not preserved across every platform. Worker/snapshot restores establish
ordinary readable/writable files while retaining recorded executable bits, and base restores repair
Gradle and Maven distribution launchers on POSIX. Custom cached executables whose Unix execute bit was lost
on Windows may need a project-specific permission step.

If a platform-sensitive Gradle task reuses unsuitable output, declare the relevant task inputs or
isolate the prefix. For Maven local installs, distinguish environment-dependent coordinates or
isolate the prefix. Same-path different-byte conflicts remain errors; permission-only worker
differences do not require platform isolation.

The current GitHub cache toolkit constructs an unquoted tar argument for the cache root. Mammoth
therefore warns and skips base-cache operations when that root contains whitespace or double quotes,
instead of running a broken extraction/save. Use a runner/cache home without these characters;
distributed workflow-artifact exchange remains available. This is an SDK transport limitation,
independent of task compatibility and platform-family sharing.
