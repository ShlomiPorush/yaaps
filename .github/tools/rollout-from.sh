#!/usr/bin/env bash

set -Eeuo pipefail

ROLLOUT_ANCHOR_PATH=".github/tools/rollout-from.sh"
MIGRATIONS_PATH="apps/server/src/storage/migrations.ts"
RELEASE_TAG_PATTERN='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
STABLE_TAG_PATTERN='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

core_version() {
  local version="${1#v}"
  version="${version%%+*}"
  printf '%s' "${version%%-*}"
}

is_older_version() {
  [[ "$1" != "$2" && "$(printf '%s\n%s\n' "$1" "$2" | sort -V | sed -n 1p)" == "$1" ]]
}

older_stable_releases() {
  local release_tag="$1"
  local release_core tag
  release_core="$(core_version "$release_tag")"
  while IFS= read -r tag; do
    if [[ "$tag" =~ $STABLE_TAG_PATTERN ]] && is_older_version "${tag#v}" "$release_core"; then
      printf '%s\n' "${tag#v}"
    fi
  done < <(git tag --merged "$release_tag" --list 'v*') | sort -V
}

has_rollout_support() {
  git cat-file -e "$1:$ROLLOUT_ANCHOR_PATH" 2>/dev/null
}

has_rollout_support_version() {
  has_rollout_support "v$1"
}

has_migration() {
  git show "v$1:$MIGRATIONS_PATH" 2>/dev/null | grep -qF "\"$2\""
}

oldest_of_newest_run() {
  local check="$1"
  local argument="$2"
  shift 2
  local -a versions=("$@")
  local index oldest=""
  for ((index = ${#versions[@]} - 1; index >= 0; index--)); do
    "$check" "${versions[index]}" "$argument" || break
    oldest="${versions[index]}"
  done
  printf '%s' "$oldest"
}

newest_breaking_migration() {
  local release_tag="$1"
  local source names
  source="$(git show "$release_tag:$MIGRATIONS_PATH")" || {
    printf 'Cannot read %s at %s.\n' "$MIGRATIONS_PATH" "$release_tag" >&2
    return 1
  }
  names="$(printf '%s\n' "$source" | grep -oE '"[0-9]{3}_[a-z0-9_]+\.breaking"' || true)"
  [[ -n "$names" ]] || return 0
  printf '%s\n' "$names" | tr -d '"' | sort | tail -n 1
}

compute_rollout_from() {
  local release_tag="$1"
  [[ "$release_tag" =~ $RELEASE_TAG_PATTERN ]] || {
    printf 'Not a release tag: %s\n' "$release_tag" >&2
    return 1
  }
  git rev-parse --verify --quiet "refs/tags/$release_tag" >/dev/null || {
    printf 'The tag %s does not exist.\n' "$release_tag" >&2
    return 1
  }

  local release_version="${release_tag#v}"
  local -a candidates=()
  mapfile -t candidates < <(older_stable_releases "$release_tag")

  if ! has_rollout_support "$release_tag"; then
    printf '%s\n' "$release_version"
    return
  fi
  local first_safe
  first_safe="$(oldest_of_newest_run has_rollout_support_version "" "${candidates[@]}")"
  [[ -n "$first_safe" ]] || first_safe="$release_version"

  local breaking breaking_floor=""
  breaking="$(newest_breaking_migration "$release_tag")"
  if [[ -n "$breaking" ]]; then
    breaking_floor="$(oldest_of_newest_run has_migration "$breaking" "${candidates[@]}")"
    [[ -n "$breaking_floor" ]] || breaking_floor="$release_version"
  fi

  if [[ "$first_safe" == "$release_version" || "$breaking_floor" == "$release_version" ]]; then
    printf '%s\n' "$release_version"
  elif [[ -z "$breaking_floor" ]]; then
    printf '%s\n' "$first_safe"
  else
    printf '%s\n%s\n' "$first_safe" "$breaking_floor" | sort -V | tail -n 1
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  (($# == 1)) || {
    printf 'Usage: %s vX.Y.Z\n' "$0" >&2
    exit 2
  }
  compute_rollout_from "$1"
fi
