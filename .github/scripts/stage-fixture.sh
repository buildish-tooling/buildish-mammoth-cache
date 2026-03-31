#!/usr/bin/env bash
#
# Copyright 2026 The Apache Software Foundation
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

if [ -f "$fixture_dir/gradlew" ]; then
  chmod +x "$fixture_dir/gradlew"
fi

