---
title: Maven Cache Internals
weight: 15
description: What lives inside the Maven local repository, what is portable across runners, and what must be excluded.
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

The Maven local repository stores downloaded artifacts, locally installed builds, and Resolver
metadata. Mammoth preserves that distinction when caching `repository/` under the Maven user home.

## Coordinates identify paths, not content

The usual layout is:

```text
repository/<groupId path>/<artifactId>/<version>/<artifactId>-<version>.<ext>
```

These paths are coordinate-addressed, not content-addressed. Snapshots, local installs, and
repositories serving different bytes for identical coordinates can overwrite the same path.
Neither the path nor Mammoth's cache family authenticates an artifact.

The default `repository` partition includes releases, snapshots, plugins, local installs, Maven
metadata, and origin markers. Existing partition exclusions can remove complete coordinate trees;
see [Maven caching patterns](../../user/maven-caching-patterns/).

## Origin markers: `_remote.repositories`

Resolver's enhanced local repository manager writes a properties file beside the artifacts:

```properties
example-1.0.jar>central=
example-1.0.pom>central=
example-1.0-tests.jar>=
```

The key combines a filename with a repository key. An empty repository key identifies a local
install. Several artifact filenames and origins can share one file. Repository-key formats depend
on Resolver version and configuration; newer versions can include a URL hash.

Mammoth preserves the file verbatim. Resolver uses it to decide whether downloaded bytes are
available under the active remote context. Changing repository IDs or effective mirror IDs can
require a new download and can make an offline build fail. Removing the marker changes that
behavior: in the tested Resolver, untracked bytes are accepted even when their former origin is
absent from the build.

Markers do not establish cryptographic provenance or fully encode settings. For example, the tested
Resolver configuration accepts the previous bytes when the repository ID stays the same and only
its URL changes. Mammoth does not override that behavior. See the upstream
[local repository documentation](https://maven.apache.org/resolver/local-repository.html) and
[repository key documentation](https://maven.apache.org/resolver/repository-key-function.html).

## Directory consistency in distributed mode

For managed files under `repository/`, a changed file causes all managed files in its immediate
directory to be included as upserts. This can increase payload sizes when a version has many
classifiers. It carries the worker's artifact bytes and origin marker
together, including siblings whose timestamps did not change. It does not replicate deletions.

By default, if two worker packages update the same directory, they must contain identical path sets,
content hashes and sizes for that directory. Otherwise aggregation fails before applying the plan.
`allow-duplicate-dependent-delta-paths` cannot override this Maven directory check. Even markers
with matching properties can conflict because Resolver writes timestamp comments; Mammoth neither
parses nor merges those properties.

Opt-in partition `conflict-handling: choose-worker-directory` elects the producer
with the smallest job name in JavaScript UTF-16 ordinal order and retains its
complete immediate-directory contribution. Membership differences trigger the
same election as content differences. It does not combine properties, bytes or
attributes from losing workers. The policy is limited to aggregate Maven
repository partitions and participates in their compatibility fingerprint.
Default families remain unchanged. This trades the losing workers' cache
contents and resolution contexts for one actual producer view. Usage-only
packages cannot win; forwarding changes producer identity. Different directories
can elect different producers. See [configuration](../../user/configuration/).

Before applying any upserts, the aggregator checks all non-transient files already in each
target directory, including files excluded from caching. An existing sibling absent from the
worker's complete view makes the update fail before any managed files change. Source snapshots
and payload staging likewise reject directories containing excluded artifacts while their marker
remains managed. Whole-directory exclusions remain supported; selectively excluding classifiers,
POMs, checksums, or other artifact files from a managed directory is rejected when those files
are present. Resolver check-state files and locks are exempt.

When custom Maven exclusions are configured, base restore performs a metadata-only scan of the
existing included trees before allowing archive extraction. This also catches directories
containing only excluded artifacts, before a restored marker could relabel them. It adds traversal
cost for custom exclusions, without storing a pre-build baseline or hashing pre-build contents.
Default exclusions alone do not add this pre-restore scan. Existing package integrity and ownership
checks still apply.

The qualified topology uses the enhanced local repository manager with its default
`_remote.repositories` tracking filename and unsplit `repository/` layout under a dedicated Maven
user home. The default strict policy uses a common seeded repository and compatible
Resolver/repository configuration, with one writer for each changed directory.
The opt-in directory policy instead accepts discarding other workers' complete
directory contributions, retaining the same target-completeness checks. Custom marker filenames and split layouts have not been
qualified. Workers may add different artifact/version directories. Independent workers adding different classifiers, origins,
or local installs to the same version directory can fail aggregation. Seed shared plugin and
transitive dependencies in one job first, serialize overlapping resolution, or use standalone mode.
Do not run Maven concurrently with Mammoth's prepare/finalize operations. Application remains
file-by-file, so a filesystem failure can leave a partial application requiring a fresh aggregator
retry; this is not an atomic directory transaction.

## Activity and garbage collection

Current path-only usage of a repository file protects its managed siblings, including the marker.
If any file in the immediate directory survives timestamp GC, the whole managed directory survives.
If every non-transient file is eligible for GC, the directory's files can be evicted together.
Before deleting any managed files, GC rejects a plan that would leave an excluded artifact sibling
behind. It checks for remaining non-transient siblings again before removing a marker. Thus an old
marker timestamp or missed marker atime cannot by itself strip origin evidence from retained bytes.
Markers are deleted after artifact files so an interrupted GC sweep retains provenance for
surviving bytes. Native timestamp misses can still evict a wholly inactive-looking directory and
require downloads.
Warm usage-only worker envelopes remain payload-free.

## Excluded check state and locks

Three patterns remain hard exclusions in every Maven partition:

| Pattern                         | Reason                                                                      |
| ------------------------------- | --------------------------------------------------------------------------- |
| `**/*.lastUpdated`              | Artifact resolution failure/check state can suppress retries after restore. |
| `**/resolver-status.properties` | Metadata update-check timestamps and errors can suppress fresh checks.      |
| `**/*.lock`                     | Resolver synchronization state should be recreated in the consuming job.    |

The first two exclusions discard update-check history; they do not remove Maven metadata XML or
origin markers, and do not guarantee that every invocation downloads fresh snapshots. Resolver's
update policy still governs resolution. Lock files have different semantics from either category;
there is no assumption that every lock file contains a PID.

## Wrapper distributions: `wrapper/dists/`

When projects use the Maven Wrapper, the Wrapper script downloads the Maven distribution into
`~/.m2/wrapper/dists/`. The distribution is identified by its URL, making the path
deterministic and portable. This directory is covered by the `wrapper-dists` partition.

## Compatibility and tested behavior

Removing the marker hard exclusion changes the partition fingerprint and therefore the Maven cache
family. Old generations and worker packages do not match the new family; there is no fallback to
marker-stripped entries. Cold-seed with a fresh dedicated Maven user home so an existing untracked
local repository does not carry earlier ambiguity into the new family. Gradle's layout is unchanged.

`make integration-test-maven-repository-semantics` uses the installed Maven distribution's actual
Resolver, enhanced local repository manager, and file transport against controlled local remotes.
It also exercises Mammoth's cache archive paths, worker packages, aggregation, and cutoff GC.
The archive test compares restored repositories with independently populated native repositories,
including artifact bytes and origin entries. It requires same-origin offline reuse and rejects
different-origin offline reuse while markers are retained. Removing the marker instead permits
offline reuse of the original bytes across origins.

Online byte selection remains Resolver behavior. Probes with Maven 3.9.15 components and Resolver
1.9.27 retain the cached bytes after checking that the artifact exists at the other remote, adding
that remote to the origin entries. Maven 3.10.0 / Resolver 2.0.24 defaults to downloading the other
remote's bytes. Both behaviors occur with native and restored repositories. See Resolver's
[existence-check relabel configuration](https://maven.apache.org/resolver-archives/resolver-2.0.24/configuration.html).
Preserving markers does not guarantee a fresh download when changing origins.

The full suite was initially qualified with Maven 3.10.0, Resolver 2.0.24, Java 21.0.12 on Linux.
Local installs remain available
across remote changes. Timestamped snapshots honor the tested `never` and `always` update policies.
Other Maven/Resolver versions and native platforms require their own qualification.
