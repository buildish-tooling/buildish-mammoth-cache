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

# Stages a fresh copy of $FIXTURE_SOURCE_DIRECTORY into
# build/integration-fixtures/<dest-name> (relative to $ACTION_DIRECTORY).
# If the staged copy contains a gradlew script it is made executable,
# making this script safe for both Gradle and Maven fixtures.
#
# Usage: stage-fixture.sh <dest-name>
# Required env: FIXTURE_SOURCE_DIRECTORY, ACTION_DIRECTORY

set -euo pipefail

dest="${1:?Usage: stage-fixture.sh <dest-name>}"
fixture_dir="${ACTION_DIRECTORY}/build/integration-fixtures/${dest}"

rm -rf "$fixture_dir"
mkdir -p "$fixture_dir"
cp -R "${FIXTURE_SOURCE_DIRECTORY}/." "$fixture_dir"

# Gradle fingerprints script bytes: checkout CRLF must not change the portable task key.
node --input-type=module - "$fixture_dir" <<'NODE'
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
for (const name of ['build.gradle', 'settings.gradle', 'gradlew']) {
  const file = path.join(process.argv[2], name);
  if (existsSync(file)) writeFileSync(file, readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
}
NODE

if [ -f "$fixture_dir/gradlew" ]; then
  chmod +x "$fixture_dir/gradlew"
fi

