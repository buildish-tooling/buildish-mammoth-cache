#!/usr/bin/env bash
#
# Copyright 2026 The Buildish Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Verifies that after the aggregator applies worker deltas, both worker
# dependencies resolve successfully and are NOT re-downloaded from the network.
# Must be run from the aggregator fixture directory (build/integration-fixtures/aggregator).

set -euo pipefail

./gradlew --info --no-daemon --continue resolveWorkerA resolveWorkerB 2>&1 | tee aggregator-gradle.log

grep -F 'resolved workerA: guava-33.6.0-jre.jar'    aggregator-gradle.log
grep -F 'resolved workerB: commons-io-2.22.0.jar'   aggregator-gradle.log

if grep -Eq '(?:Downloading|Downloaded).*(?:guava-33\.6\.0-jre|commons-io-2\.22\.0)\.jar' aggregator-gradle.log; then
  echo 'Expected restored worker dependency jars to be reused, but Gradle downloaded them again.' >&2
  exit 1
fi
