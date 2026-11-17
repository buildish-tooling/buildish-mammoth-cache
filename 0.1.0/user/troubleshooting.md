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

3. **Check whether the Java major version changed.** Switching between Java 17, 21, and 24 produces
   different cache families. Ensure
   `actions/setup-java` uses the same major version on every run.

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
   files before standalone or distributed-aggregator jobs save the base cache when modification and
   effective access times are both older than `cache-gc-older-than-days`.

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
`Checksum mismatch for gradle-wrapper.jar`, `GPG signature verification failed`, or a network
error downloading from `services.gradle.org`.

**Diagnostic steps:**

1. **Checksum mismatch or signature failure.** This means the downloaded JAR does not match the
   expected digest published by Gradle. Possible causes:
   - A network proxy altered the response in transit. Check whether your runner uses a corporate
     proxy and whether it terminates TLS.
   - The `gradle-wrapper.properties` file specifies a custom `distributionUrl` or the wrapper JAR
     in the repository was modified. Verify the file against the official Gradle wrapper
     validation service at `https://services.gradle.org/versions/all`.
   - The wrapper was hand-edited or generated by a tool other than `gradle wrapper`. Re-generate
     it with `./gradlew wrapper --gradle-version=<version>`.

2. **GPG key not in the allowlist.** Gradle occasionally rotates its signing key. If the action
   rejects the signature with `key fingerprint … is not in the pinned allowlist`, open an issue
   or pull request against the `src/build-tool/gradle/wrapper/signature.ts` pinned key list.
   In the meantime, you can verify the new key independently against
   `https://gradle.com/security`.

3. **Network timeout or rate limit.** Wrapper downloads require outbound HTTPS to
   `services.gradle.org` and (for authenticated lookups) to `api.github.com`. If your runner is
   network-restricted, pre-install the Gradle wrapper JAR in the repository or use a proxy that
   allowlists those hosts. For GitHub API rate limits, pass a `github-token` with at least
   read-only `contents` access.

4. **Windows: wrong `gpg` binary selected.** On Windows runners multiple `gpg` variants may be
   on the PATH. Set the `BUILDISH_MAMMOTH_CACHE_GRADLE_GPG_COMMAND` environment variable to the
   full path of the correct binary before the action runs.

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
