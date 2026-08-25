#!/usr/bin/env bash
# shellcheck disable=SC2034

set -Eeuo pipefail

SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIRECTORY/../.." && pwd -P)"
DOCKERFILE_RELATIVE_PATH="infra/docker/Dockerfile"
DEVELOPMENT_COMPOSE_PATH="$REPOSITORY_ROOT/docker-compose.dev.yml"
PRODUCTION_COMPOSE_PATH="$REPOSITORY_ROOT/docker-compose.yml"

compose_arguments() {
  local compose_path="$1"
  COMPOSE_ARGUMENTS=(
    compose
    --project-directory "$REPOSITORY_ROOT"
    --file "$compose_path"
  )
}

require_command() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Required command is unavailable: %s\n' "$command_name" >&2
    return 1
  }
}

require_development_compose() {
  [[ -f "$DEVELOPMENT_COMPOSE_PATH" ]] || {
    printf 'Local development requires the ignored file: %s\n' "$DEVELOPMENT_COMPOSE_PATH" >&2
    return 1
  }
}

has_argument_flag() {
  local name="$1"
  shift
  local argument
  for argument in "$@"; do
    [[ "$argument" == "$name" ]] && return 0
  done
  return 1
}

get_argument_value() {
  local name="$1"
  shift
  local previous=""
  local argument
  for argument in "$@"; do
    if [[ "$previous" == "$name" ]]; then
      if [[ "$argument" == --* ]]; then
        printf '%s requires a value.\n' "$name" >&2
        return 2
      fi
      printf '%s\n' "$argument"
      return 0
    fi
    previous="$argument"
  done
  if [[ "$previous" == "$name" ]]; then
    printf '%s requires a value.\n' "$name" >&2
    return 2
  fi
  return 0
}

assert_exact_path() {
  local path="$1"
  local expected="$2"
  local resolved_path
  local resolved_expected
  resolved_path="$(realpath -m -- "$path")"
  resolved_expected="$(realpath -m -- "$expected")"
  if [[ "$resolved_path" != "$resolved_expected" ]]; then
    printf 'Refusing to operate on unexpected path: %s\n' "$resolved_path" >&2
    return 1
  fi
}

json_get() {
  local path="$1"
  local expression="$2"
  require_command node
  node - "$path" "$expression" <<'NODE'
const fs = require("node:fs");
const [path, expression] = process.argv.slice(2);
let value = JSON.parse(fs.readFileSync(path, "utf8"));
for (const segment of expression.split(".").filter(Boolean)) value = value?.[segment];
if (value === undefined || value === null) process.exit(1);
if (typeof value === "object") process.stdout.write(JSON.stringify(value));
else process.stdout.write(String(value));
NODE
}

json_stdin_get() {
  local expression="$1"
  require_command node
  node -e '
const fs = require("node:fs");
let value = JSON.parse(fs.readFileSync(0, "utf8"));
for (const segment of process.argv[1].split(".").filter(Boolean)) value = value?.[segment];
if (value === undefined || value === null) process.exit(1);
if (typeof value === "object") process.stdout.write(JSON.stringify(value));
else process.stdout.write(String(value));
' "$expression"
}

write_json_atomic() {
  local path="$1"
  local json="$2"
  local temporary_path="$path.$$.tmp"
  printf '%s' "$json" >"$temporary_path"
  if ! mv -- "$temporary_path" "$path"; then
    rm -f -- "$temporary_path"
    return 1
  fi
}
