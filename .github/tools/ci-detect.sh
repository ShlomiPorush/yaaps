#!/usr/bin/env bash

set -Eeuo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

declare -Ag CI_AREAS=()

# The exact set of files a release pull request is allowed to touch: the
# version sources kept in step by npm run version:sync, plus the changelog.
declare -ag CI_RELEASE_FILES=(
  VERSION
  package.json
  package-lock.json
  docs/CHANGELOG.md
  apps/server/package.json
  apps/dashboard/package.json
  packages/cli/package.json
  packages/contracts/package.json
  packages/contracts/src/index.ts
)

# True when the change is a version bump and nothing else. VERSION must be
# part of it, because an ordinary dependency pull request also touches
# package.json and package-lock.json and still needs the full matrix.
test_release_only_change() {
  local file candidate normalized
  local version_changed=false
  local matched

  (($# > 0)) || return 1

  for file in "$@"; do
    normalized="${file//\\//}"
    if [[ "$normalized" == "VERSION" ]]; then
      version_changed=true
    fi
    matched=false
    for candidate in "${CI_RELEASE_FILES[@]}"; do
      if [[ "$normalized" == "$candidate" ]]; then
        matched=true
        break
      fi
    done
    [[ "$matched" == "true" ]] || return 1
  done

  [[ "$version_changed" == "true" ]]
}

get_ci_affected_areas() {
  local full="$1"
  shift
  local file normalized

  CI_AREAS=(
    [browser]=false
    [cli]=false
    [dashboard]=false
    [documentation]=false
    [infrastructure]=false
    [server]=false
  )
  if [[ "$full" == "true" ]]; then
    for file in "${!CI_AREAS[@]}"; do CI_AREAS["$file"]=true; done
    return
  fi

  # A release pull request is the only change allowed to edit VERSION, and the
  # v* tag workflow reruns npm run verify before publishing anything, so the
  # heavy matrix here would only repeat that gate. Any file outside the release
  # set falls through to normal detection and restores the full checks.
  if test_release_only_change "$@"; then
    return
  fi

  for file in "$@"; do
    normalized="${file//\\//}"
    case "$normalized" in
      README.md|docs/*|LICENSE|AGENTS.md)
        CI_AREAS[documentation]=true
        ;;
      apps/server/*)
        CI_AREAS[server]=true
        CI_AREAS[browser]=true
        ;;
      apps/dashboard/*)
        CI_AREAS[dashboard]=true
        CI_AREAS[browser]=true
        ;;
      packages/cli/*)
        CI_AREAS[cli]=true
        ;;
      packages/contracts/*)
        CI_AREAS[server]=true
        CI_AREAS[dashboard]=true
        CI_AREAS[cli]=true
        CI_AREAS[browser]=true
        ;;
      tests/e2e/*|config/playwright.*)
        CI_AREAS[browser]=true
        ;;
      plugins/*)
        CI_AREAS[cli]=true
        CI_AREAS[infrastructure]=true
        ;;
      infra/*|docker-compose.yml|.github/*|tests/workflows/*|tests/operations/*)
        CI_AREAS[infrastructure]=true
        ;;
      package.json|package-lock.json|.npmrc|config/*)
        CI_AREAS[server]=true
        CI_AREAS[dashboard]=true
        CI_AREAS[cli]=true
        CI_AREAS[browser]=true
        CI_AREAS[infrastructure]=true
        ;;
      *)
        CI_AREAS[server]=true
        CI_AREAS[dashboard]=true
        CI_AREAS[cli]=true
        CI_AREAS[browser]=true
        CI_AREAS[infrastructure]=true
        ;;
    esac
  done
}

invoke_ci_detection() {
  local force_full=false
  local base head output_path area diff_output
  local -a files=()

  has_argument_flag --full "$@" && force_full=true
  base="$(get_argument_value --base "$@")"
  head="$(get_argument_value --head "$@")"

  if [[ "$force_full" == "false" ]]; then
    if [[ -z "$base" || -z "$head" || "$base" =~ ^0{40}$ ]]; then
      force_full=true
    elif ! diff_output="$(git -C "$REPOSITORY_ROOT" diff --name-only --diff-filter=ACDMRTUXB "$base" "$head")"; then
      force_full=true
    elif [[ -n "$diff_output" ]]; then
      mapfile -t files <<<"$diff_output"
    fi
  fi

  get_ci_affected_areas "$force_full" "${files[@]}"
  output_path="${GITHUB_OUTPUT:-}"
  for area in browser cli dashboard documentation infrastructure server; do
    if [[ -n "$output_path" ]]; then
      printf '%s=%s\n' "$area" "${CI_AREAS[$area]}" >>"$output_path"
    else
      printf '%s=%s\n' "$area" "${CI_AREAS[$area]}"
    fi
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  invoke_ci_detection "$@"
fi
