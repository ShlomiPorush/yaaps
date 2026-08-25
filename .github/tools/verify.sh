#!/usr/bin/env bash

set -Eeuo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"
source "$SCRIPT_DIRECTORY/docker-verify.sh"

declare -a CHANGED_FILES=()

get_changed_files() {
  CHANGED_FILES=()
  if ! git -C "$REPOSITORY_ROOT" rev-parse --verify HEAD >/dev/null 2>&1; then
    return 1
  fi
  local -a tracked=()
  local -a untracked=()
  mapfile -t tracked < <(git -C "$REPOSITORY_ROOT" diff --name-only HEAD)
  mapfile -t untracked < <(git -C "$REPOSITORY_ROOT" ls-files --others --exclude-standard)
  mapfile -t CHANGED_FILES < <(printf '%s\n' "${tracked[@]}" "${untracked[@]}" | sed '/^$/d' | sort -u)
}

test_documentation_only() {
  (($# > 0)) || return 1
  local file
  for file in "$@"; do
    case "$file" in
      *.md|docs/*|.editorconfig|.gitattributes) ;;
      *) return 1 ;;
    esac
  done
}

test_compose_definitions() {
  require_command docker
  if [[ -f "$DEVELOPMENT_COMPOSE_PATH" ]]; then
    compose_arguments "$DEVELOPMENT_COMPOSE_PATH"
    docker "${COMPOSE_ARGUMENTS[@]}" config --quiet
  fi
  compose_arguments "$PRODUCTION_COMPOSE_PATH"
  YAAPS_IMAGE="ghcr.io/example/yaaps@sha256:verification" \
  YAAPS_HOSTNAME="yaaps.net" \
  YAAPS_PUBLIC_ORIGIN="https://yaaps.net" \
  YAAPS_RP_ID="yaaps.net" \
  YAAPS_TRAEFIK_CERT_RESOLVER="verification" \
  YAAPS_TRAEFIK_NETWORK="verification" \
    docker "${COMPOSE_ARGUMENTS[@]}" config --quiet
}

invoke_verification() {
  require_command npm
  local changed_mode=false
  local skip_docker=false
  has_argument_flag --changed "$@" && changed_mode=true
  has_argument_flag --skip-docker "$@" && skip_docker=true
  if [[ "$changed_mode" == "true" ]]; then
    get_changed_files || true
  fi

  (cd "$REPOSITORY_ROOT" && npm run guard)
  (cd "$REPOSITORY_ROOT" && npm run check:format)
  (cd "$REPOSITORY_ROOT" && npm run lint)

  if [[ "$changed_mode" == "true" ]] && test_documentation_only "${CHANGED_FILES[@]}"; then
    printf 'Changed-area verification completed for documentation-only changes.\n'
    return
  fi

  (cd "$REPOSITORY_ROOT" && npm run typecheck)
  (cd "$REPOSITORY_ROOT" && npm test)
  (cd "$REPOSITORY_ROOT" && npm run build)
  (cd "$REPOSITORY_ROOT" && npm run test:e2e:run)
  (cd "$REPOSITORY_ROOT" && npm run package:check)
  test_compose_definitions

  if [[ "$skip_docker" == "true" ]]; then
    printf 'Docker image execution was explicitly skipped; verification is not production-shaped.\n'
  else
    invoke_docker_verification
  fi
  printf 'YAAPS verification completed successfully.\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  invoke_verification "$@"
fi
