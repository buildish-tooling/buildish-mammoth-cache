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

# Open TODOs

1. Adopt the in-development release workflows after the Buildish release process and legal policy
   are approved.
   - Replace transitional release configuration and enable mandatory build, test, legal, and
     verification gates.
   - Materialize and validate both action `dist/` entrypoints in the release commit and immutable
     version tag.
   - Validate moving tags, release assets, approval boundaries, rollback, and rerun behavior before
     publishing the first release.
   - Replace pre-release documentation with tested installation references after publication.

## Deferred / explicitly out of scope for v1

- Non-default `GRADLE_USER_HOME`
- Project-local `.gradle`
- Non-GitHub CI implementations
- Java versions below 8
- Built-in invocation of `actions/setup-java`.
  Just to install Java for a particular version using a particular distribution.
  Using the same defaults as `actions/setup-java` for the version and distribution (value pass-through).
  PROBLEM:
  - the stock setup-java entrypoint always writes Maven auth/toolchain files after installing Java.
  - invoking upstream setup-java as a raw child process would not update this action’s current process environment by itself
  - the upstream entrypoint also emits a Java problem matcher and writes Maven settings/toolchains by default
- Multi-level aggregation (TO BE THOUGHT THROUGH / DOES IT MAKE REAL SENSE?)
  - Currently, the action only supports a set of jobs and exactly one aggregator.
  - It should be possible to have multiple levels of aggregation. In other words, an aggregator could just
    aggregate the input deltas and produce a new, combined delta consumed by another aggregator.
