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
BUILDISH_INTERNAL_TOOLING_PATH=".buildish-internal/buildish-release-tooling"

fail() {
  printf '%s\n' "$1" >&2
  exit 2
}

canonicalize_existing_dir() {
  (
    cd "$1"
    pwd -P
  )
}

require_valid_tooling_dir() {
  local tooling_dir="$1"

  [[ -d "$tooling_dir" ]] || fail "buildish-release-tooling directory does not exist: $tooling_dir"
  [[ -f "$tooling_dir/pyproject.toml" ]] || fail "buildish-release-tooling directory is missing pyproject.toml: $tooling_dir"
  [[ -d "$tooling_dir/src/apache_buildish_release_tooling" ]] || fail "buildish-release-tooling directory is missing src/apache_buildish_release_tooling: $tooling_dir"
}

require_internal_checkout_gitignored() {
  local gitignore_path="$REPO_ROOT/.gitignore"

  [[ -f "$gitignore_path" ]] || fail "missing $gitignore_path; expected /.buildish-internal/ to be gitignored"
  grep -Eq '^[[:space:]]*/?\.buildish-internal/[[:space:]]*$' "$gitignore_path" || fail "missing /.buildish-internal/ ignore rule in $gitignore_path"
}

repo_root_tooling_dir() {
  if [[ -f "$REPO_ROOT/pyproject.toml" && -d "$REPO_ROOT/src/apache_buildish_release_tooling" ]]; then
    printf '%s\n' "$REPO_ROOT"
    return
  fi
  return 1
}

local_sibling_tooling_dir() {
  local sibling_dir="$REPO_ROOT/../buildish-release-tooling"

  if [[ -f "$sibling_dir/pyproject.toml" && -d "$sibling_dir/src/apache_buildish_release_tooling" ]]; then
    printf '%s\n' "$sibling_dir"
    return
  fi
  return 1
}

resolve_tooling_dir() {
  local requested_dir="${BUILDISH_RELEASE_TOOLING_DIR:-}"
  local internal_dir="${GITHUB_WORKSPACE:-}/$BUILDISH_INTERNAL_TOOLING_PATH"
  local root_dir=""
  local sibling_dir=""
  local canonical_dir
  local -a allowed_dirs=()
  local allowed_dir

  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    require_internal_checkout_gitignored
    [[ -n "${GITHUB_WORKSPACE:-}" ]] || fail "GITHUB_ACTIONS=true but GITHUB_WORKSPACE is not set"

    if require_valid_tooling_dir "$internal_dir" 2>/dev/null; then
      allowed_dirs+=("$(canonicalize_existing_dir "$internal_dir")")
    fi
    if root_dir="$(repo_root_tooling_dir 2>/dev/null)"; then
      require_valid_tooling_dir "$root_dir"
      allowed_dirs+=("$(canonicalize_existing_dir "$root_dir")")
    fi
    [[ ${#allowed_dirs[@]} -gt 0 ]] || fail "could not find buildish-release-tooling in either $internal_dir or the repository root"

    if [[ -n "$requested_dir" ]]; then
      [[ "$requested_dir" = /* ]] || fail "BUILDISH_RELEASE_TOOLING_DIR must be an absolute path"
      require_valid_tooling_dir "$requested_dir"
      canonical_dir="$(canonicalize_existing_dir "$requested_dir")"
      for allowed_dir in "${allowed_dirs[@]}"; do
        if [[ "$canonical_dir" == "$allowed_dir" ]]; then
          printf '%s\n' "$canonical_dir"
          return
        fi
      done
      fail "on GitHub Actions, BUILDISH_RELEASE_TOOLING_DIR must resolve to either $internal_dir or the repository root when it is itself buildish-release-tooling"
    fi

    printf '%s\n' "${allowed_dirs[0]}"
    return
  fi

  if [[ -n "$requested_dir" ]]; then
    [[ "$requested_dir" = /* ]] || fail "BUILDISH_RELEASE_TOOLING_DIR must be an absolute path"
    require_valid_tooling_dir "$requested_dir"
    canonical_dir="$(canonicalize_existing_dir "$requested_dir")"
    printf '%s\n' "$canonical_dir"
    return
  fi

  if root_dir="$(repo_root_tooling_dir 2>/dev/null)"; then
    require_valid_tooling_dir "$root_dir"
    printf '%s\n' "$(canonicalize_existing_dir "$root_dir")"
    return
  fi

  if sibling_dir="$(local_sibling_tooling_dir 2>/dev/null)"; then
    require_valid_tooling_dir "$sibling_dir"
    printf '%s\n' "$(canonicalize_existing_dir "$sibling_dir")"
    return
  fi

  fail "could not locate buildish-release-tooling in the repository root or at ../buildish-release-tooling"
}

TOOLING_DIR="$(resolve_tooling_dir)"

usage() {
  printf 'usage: %s <command> [args...]\n' "${BASH_SOURCE[0]}" >&2
}

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

COMMAND_NAME="$1"
shift

case "$COMMAND_NAME" in
  attach-github-release-assets|build-source-rc|cleanup-dev-svn-rcs|create-final-tag|create-rc-materialization-tag|create-release-branch|create-source-artifact|finalize-draft-github-release|finalize-rc-vote-materials|prepare-rc|publish-dockerhub-moving-tags|publish-source-release-svn|prune-older-line-releases|release-version|sync-draft-github-release|update-moving-image-aliases|update-moving-tags|verify-rc|verify-source-ref-checks)
    ;;
  *)
    printf 'unsupported release-tooling command: %s\n' "$COMMAND_NAME" >&2
    usage
    exit 2
    ;;
esac

exec uv run --project "$TOOLING_DIR" --frozen buildish-release-tooling \
  "$COMMAND_NAME" \
  --component-config "$BUILDISH_COMPONENT_CONFIG_PATH" \
  "$@"
