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

# Prints and asserts the Gradle action outputs for a standalone prepare phase.
#
# Required env: ACTION_BASE_CACHE_RESTORE_STATUS, ACTION_JAVA_MAJOR,
#   ACTION_JOB_MODE, ACTION_GRADLE_VERSIONS, ACTION_RESOLVED_REF_NAME,
#   ACTION_SAFE_REF_NAME, ACTION_DEPENDENT_JOBS_COUNT, CALLER_RESOLVED_REF_NAME

set -euo pipefail

expected_safe="$(printf '%s' "$CALLER_RESOLVED_REF_NAME" \
  | sed -E 's/[ /]+/-/g; s/[^A-Za-z0-9._-]/-/g; s/-+/-/g; s/^-+|-+$//g')"

printf '%-42s %s\n' 'base-cache-restore-status:' "$ACTION_BASE_CACHE_RESTORE_STATUS"
printf '%-42s %s\n' 'java-major:'                "$ACTION_JAVA_MAJOR"
printf '%-42s %s\n' 'job-mode:'                  "$ACTION_JOB_MODE"
printf '%-42s %s\n' 'gradle-versions:'           "$ACTION_GRADLE_VERSIONS"
printf '%-42s %s\n' 'resolved-ref-name:'         "$ACTION_RESOLVED_REF_NAME"
printf '%-42s %s  (expected: %s)\n' 'safe-ref-name:' "$ACTION_SAFE_REF_NAME" "$expected_safe"
printf '%-42s %s\n' 'dependent-jobs-count:'      "$ACTION_DEPENDENT_JOBS_COUNT"

test "$ACTION_BASE_CACHE_RESTORE_STATUS" = 'miss'
test "$ACTION_JAVA_MAJOR"               = '21'
test "$ACTION_JOB_MODE"                 = 'standalone'
test "$ACTION_GRADLE_VERSIONS"          = '9.6.1'
test "$ACTION_RESOLVED_REF_NAME"        = "$CALLER_RESOLVED_REF_NAME"
test "$ACTION_SAFE_REF_NAME"            = "$expected_safe"
test "$ACTION_DEPENDENT_JOBS_COUNT"     = '0'
