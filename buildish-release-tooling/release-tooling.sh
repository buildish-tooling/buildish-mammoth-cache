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

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILDISH_COMPONENT_CONFIG_PATH="$SCRIPT_DIR/release-config.yaml"

fail() {
  printf '%s\n' "$1" >&2
  exit 2
}

usage() {
  printf 'usage: %s <command> [args...]\n' "${BASH_SOURCE[0]}" >&2
}

is_tooling_dir() {
  local tooling_dir="$1"

  [[ -f "$tooling_dir/pyproject.toml" && -d "$tooling_dir/src/apache_buildish_release_tooling" ]]
}

resolve_tooling_dir() {
  local configured_dir="${BUILDISH_RELEASE_TOOLING_DIR:-}"
  local github_workspace="${GITHUB_WORKSPACE:-}"
  local github_internal_dir=""
  local sibling_dir="$REPO_ROOT/../buildish-release-tooling"

  if [[ -n "$configured_dir" ]]; then
    is_tooling_dir "$configured_dir" || fail "invalid BUILDISH_RELEASE_TOOLING_DIR: $configured_dir"
    printf '%s\n' "$configured_dir"
    return
  fi

  if is_tooling_dir "$REPO_ROOT"; then
    printf '%s\n' "$REPO_ROOT"
    return
  fi

  if [[ -n "$github_workspace" ]]; then
    github_internal_dir="$github_workspace/.buildish-internal/buildish-release-tooling"
    if is_tooling_dir "$github_internal_dir"; then
      printf '%s\n' "$github_internal_dir"
      return
    fi
  fi

  if is_tooling_dir "$sibling_dir"; then
    printf '%s\n' "$sibling_dir"
    return
  fi

  fail "could not locate buildish-release-tooling; set BUILDISH_RELEASE_TOOLING_DIR or check it out at .buildish-internal/buildish-release-tooling"
}

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

COMMAND_NAME="$1"
shift

TOOLING_DIR="$(resolve_tooling_dir)"

exec uv run --project "$TOOLING_DIR" --frozen buildish-release-tooling \
  "$COMMAND_NAME" \
  --component-config "$BUILDISH_COMPONENT_CONFIG_PATH" \
  "$@"
