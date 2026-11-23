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

# Mammoth tar-stream patch

This directory owns the opt-in worker TAR profile described in
`docs/dev/cache-protocol.md#tar-profile`. `tar-stream` is pinned to 3.3.0.
The installed package is never modified. `scripts/prepare-tar-stream.mjs` verifies
upstream source hashes and applies `extract.patch` with Git into the ignored
`build/patched-tar-stream/` directory, alongside `mammoth.cjs` and the narrow types.
Compilation, Vitest configuration and distribution legal analysis prepare this copy.
Build inputs include the patch, so an incremental build notices changes.

The patch checks padding within 3.3.0's guarded extraction loop and uses upstream's
PAX path validation after strict PAX decoding. The worker writer still uses local
PAX for fractional or post-2038 timestamps. The generated copy uses the narrow
`index.d.ts` with the patched API at the upstream package's types export.

`mammothStrict: true` selects the profile on an individual extractor; absent/false
uses upstream behavior. Application grammar and model ownership belong to the worker
codec, above this raw transport. `mtimeMs` carries exact portable milliseconds without
relying on a normalized Date. The generated copy is for bundling, never a runtime
path dependency in the distributed Action.

`UPSTREAM-LICENSE` preserves the MIT license and mafintosh copyright for tar-stream.
The unified patch and new helper/types/build code are modifications by The Buildish
Authors, licensed under Apache-2.0 as marked in those files. Upstream LICENSE is copied
unchanged into generated output. The legal analyzer maps generated input paths back
to the pinned upstream package for attribution. Other transitive packages retain their
own licenses; normal bundle/legal checks still apply.

To update upstream, review the patch, replace the pin/source hashes and upstream
license, and run raw conformance/default-isolation, preparation, runtime and bundle
attribution tests. A version/source mismatch fails before generation. Never substitute
runtime monkey-patching, silent fuzzy patching or an unreviewed upstream upgrade.
