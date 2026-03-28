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

# Cache Key Generation

This document explains how the base cache key is derived for each job execution, covering the
default template, all available placeholders, Java major version detection, partition fingerprint
computation, and the branch-fallback restore-key logic.

## Default cache key template

When `cache-key-template` is not set the action uses:

```
${cacheKeyPrefix}${schemaVersion}-${javaMajor}-${runnerOs}-${runnerArch}-${partitionFingerprint}-${refName}
```

This produces a key such as:

```
buildish-mammoth-gradle-cache-1-21-linux-x64-a1b2c3d4e5f6a7b8-main
```

## Placeholder reference

| Placeholder | Source | Example |
|---|---|---|
| `${cacheKeyPrefix}` | `cache-key-prefix` input; default `buildish-mammoth-gradle-cache-` | `buildish-mammoth-gradle-cache-` |
| `${schemaVersion}` | `cacheSchemaVersion` constant in `src/config/types.ts` | `1` |
| `${javaMajor}` | `java -version` output parsed at runtime | `21` |
| `${runnerOs}` | Lowercased OS from the CI adapter | `linux` |
| `${runnerArch}` | Lowercased architecture from the CI adapter | `x64` |
| `${partitionFingerprint}` | SHA-256 digest of the resolved partition layout (first 16 hex chars) | `a1b2c3d4e5f6a7b8` |
| `${refName}` | Cache-safe ref slug from the CI adapter | `main` or `feature-my-branch` |

Any placeholder that appears in a custom template but is not in the table above is left as-is in
the rendered key (no silent substitution with empty string).

The rendered key is validated against the pattern `[A-Za-z0-9._:-]{1,512}`. Keys outside this set
or over 512 characters are rejected.

## Java major version detection

The action detects the Java runtime by running `java -version` and parsing the version string. The
`JAVA_BIN` environment variable overrides the binary path (useful in multi-JDK environments).

Parsing rules:

- `java version "21.0.3"` → major `21`
- `java version "1.8.0_412"` → major `8` (old `1.x` scheme)
- `openjdk version "17.0.11"` → major `17`

Versions below 8 are rejected. If `java` is not found on `PATH` the action fails with a clear
message rather than silently using a default.

## Partition fingerprint

The fingerprint encodes the full resolved cache partition layout so that a change to any partition
(add, remove, reorder, or modify includes/excludes) automatically produces a new cache key without
a manual schema version bump.

```
fingerprint = SHA-256(JSON({
  hardExcludes: HARD_CACHE_EXCLUDE_GLOBS,
  partitions: [
    { id, includes: relativeIncludeGlobs, excludes: relativeExcludeGlobs },
    ...
  ]
}))[0..15]  // first 16 hex characters
```

The JSON is built from the resolved, deduplicated, ordered partition list after overrides and
opt-outs have been applied. The hard safety excludes are included in the hash so adding a new
global exclude also changes the fingerprint.

## Branch-fallback restore keys

After a primary key miss the action can fall back to a prefix match to restore a cache entry from
the same branch without an exact key hit. A restore-key prefix is generated only when **all** of
the following are true:

1. The active cache backend supports restore keys.
2. `${refName}` appears exactly once in the template.
3. `${refName}` is the **last** placeholder in the template.

When those conditions hold, the restore key prefix is the template rendered without the trailing
`${refName}`. For the default template this produces:

```
buildish-mammoth-gradle-cache-1-21-linux-x64-a1b2c3d4e5f6a7b8-
```

The cache backend matches any key that starts with that prefix, which typically finds the most
recent save from the same partition layout on any branch.

Custom templates that place `${refName}` in the middle or use it more than once suppress the
restore key entirely to avoid unintentionally widening fallback scope.

## Custom template guidelines

- Always include `${partitionFingerprint}` so different partition layouts never share a key.
- End the template with `${refName}` to keep branch-level fallback working.
- Use only the allowed set of characters in literal parts of the template (`[A-Za-z0-9._:-]`).
- The total rendered key must not exceed 512 characters.

Example — add a project prefix before the default layout:

```
my-project-${cacheKeyPrefix}${schemaVersion}-${javaMajor}-${runnerOs}-${runnerArch}-${partitionFingerprint}-${refName}
```

