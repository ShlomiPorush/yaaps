#!/usr/bin/env bash

set -Eeuo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

VERIFICATION_IMAGE="yaaps-server:verify"
DOCKER_VERIFY_CONTAINER_NAME=""
DOCKER_VERIFY_VOLUME_NAME=""

wait_yaaps_http() {
  local port="$1"
  local timeout_seconds="${2:-45}"
  local deadline=$((SECONDS + timeout_seconds))
  while ((SECONDS < deadline)); do
    if curl --silent --show-error --fail --max-time 3 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && \
       curl --silent --show-error --fail --max-time 3 "http://127.0.0.1:$port/readyz" >/dev/null 2>&1; then
      return
    fi
    sleep 0.5
  done
  printf 'Container did not become ready within %s seconds.\n' "$timeout_seconds" >&2
  return 1
}

invoke_docker_verification() {
  require_command docker
  require_command curl
  local suffix container_name volume_name port expected_image running_image
  suffix="$$-$(date +%s%3N)"
  container_name="yaaps-verify-$suffix"
  volume_name="yaaps-verify-data-$suffix"
  [[ "$container_name" =~ ^yaaps-verify-[0-9-]+$ ]] || { printf 'Generated unsafe verification container name.\n' >&2; return 1; }
  [[ "$volume_name" =~ ^yaaps-verify-data-[0-9-]+$ ]] || { printf 'Generated unsafe verification volume name.\n' >&2; return 1; }
  DOCKER_VERIFY_CONTAINER_NAME="$container_name"
  DOCKER_VERIFY_VOLUME_NAME="$volume_name"

  cleanup_docker_verification() {
    if [[ "$DOCKER_VERIFY_CONTAINER_NAME" =~ ^yaaps-verify-[0-9-]+$ ]]; then
      docker rm --force "$DOCKER_VERIFY_CONTAINER_NAME" >/dev/null 2>&1 || true
    fi
    if [[ "$DOCKER_VERIFY_VOLUME_NAME" =~ ^yaaps-verify-data-[0-9-]+$ ]]; then
      docker volume rm "$DOCKER_VERIFY_VOLUME_NAME" >/dev/null 2>&1 || true
    fi
  }
  trap cleanup_docker_verification EXIT

  docker build --file "$REPOSITORY_ROOT/$DOCKERFILE_RELATIVE_PATH" --target runtime --tag "$VERIFICATION_IMAGE" "$REPOSITORY_ROOT"
  docker volume create "$volume_name" >/dev/null
  docker run --detach --name "$container_name" --read-only \
    --tmpfs /tmp:size=16m,mode=1777 \
    --mount "type=volume,source=$volume_name,target=/data" \
    --publish 127.0.0.1::3000 "$VERIFICATION_IMAGE" >/dev/null

  port="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "3000/tcp") 0).HostPort}}' "$container_name")"
  wait_yaaps_http "$port"
  expected_image="$(docker image inspect --format '{{.Id}}' "$VERIFICATION_IMAGE")"
  running_image="$(docker inspect --format '{{.Image}}' "$container_name")"
  [[ "$expected_image" == "$running_image" ]] || {
    printf 'Running image %s does not match built image %s.\n' "$running_image" "$expected_image" >&2
    return 1
  }
  printf 'Docker verification passed on port %s (%s).\n' "$port" "$running_image"
  cleanup_docker_verification
  trap - EXIT
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  invoke_docker_verification
fi
