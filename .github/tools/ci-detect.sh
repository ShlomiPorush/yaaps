#!/usr/bin/env bash

set -Eeuo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

declare -Ag CI_AREAS=()

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
