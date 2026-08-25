#!/usr/bin/env bash

set -Eeuo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/../../.github/tools/common.sh"

SMOKE_ORIGIN=""
SMOKE_TEMPORARY_PATH=""
SMOKE_TEMPORARY_ROOT=""
SMOKE_RUN_ID=""
SMOKE_DRAFT_ID=""
SMOKE_CLI_PATH=""

resolve_smoke_origin() {
  local value="$1"
  if [[ ! "$value" =~ ^https?://(\[[0-9A-Fa-f:]+\]|([A-Za-z0-9-]+\.)*[A-Za-z0-9-]+)(:[0-9]{1,5})?/?$ ]]; then
    printf 'The smoke origin must be an absolute HTTP or HTTPS origin without credentials, path, query, or fragment.\n' >&2
    return 1
  fi
  printf '%s\n' "${value%/}"
}

invoke_smoke_request() {
  local uri="$1"
  local expected_statuses="$2"
  local headers_path="$3"
  local body_path="$4"
  local status
  status="$(curl --silent --show-error --max-time 15 --dump-header "$headers_path" --output "$body_path" --write-out '%{http_code}' "$uri")"
  if [[ " $expected_statuses " != *" $status "* ]]; then
    printf 'Smoke request to %s returned HTTP %s; expected %s.\n' "$uri" "$status" "$expected_statuses" >&2
    return 1
  fi
}

invoke_yaaps_smoke() {
  require_command curl
  require_command node

  local origin_argument origin_value origin api_key cli_path run_id temporary_root temporary_path
  local report_path marker status_json publication_json draft_id public_url headers_path body_path
  origin_argument="$(get_argument_value --origin "$@")"
  origin_value="${origin_argument:-${YAAPS_SMOKE_ORIGIN:-}}"
  [[ -n "$origin_value" ]] || { printf 'Set YAAPS_SMOKE_ORIGIN or pass --origin <url>.\n' >&2; return 1; }
  origin="$(resolve_smoke_origin "$origin_value")"
  api_key="${YAAPS_SMOKE_API_KEY:-}"
  [[ "$api_key" =~ ^yaaps_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$ ]] || {
    printf 'Set YAAPS_SMOKE_API_KEY to a valid disposable API key. It is read only from the environment.\n' >&2
    return 1
  }

  cli_path="$REPOSITORY_ROOT/packages/cli/dist/index.js"
  [[ -f "$cli_path" ]] || { printf 'The CLI build is missing. Run npm run build before the smoke test.\n' >&2; return 1; }

  run_id="$$-$(date +%s%3N)"
  temporary_root="$(realpath -m -- "${TMPDIR:-/tmp}")"
  temporary_path="$temporary_root/yaaps-smoke-$run_id"
  [[ "$(realpath -m -- "$temporary_path")" == "$temporary_root"/yaaps-smoke-[0-9-]* ]] || {
    printf 'Refusing to use an unresolved smoke temporary path.\n' >&2
    return 1
  }
  report_path="$temporary_path/smoke-report.html"
  headers_path="$temporary_path/headers.txt"
  body_path="$temporary_path/body.html"
  draft_id=""
  SMOKE_ORIGIN="$origin"
  SMOKE_TEMPORARY_PATH="$temporary_path"
  SMOKE_TEMPORARY_ROOT="$temporary_root"
  SMOKE_RUN_ID="$run_id"
  SMOKE_DRAFT_ID=""
  SMOKE_CLI_PATH="$cli_path"

  cleanup_smoke() {
    if [[ -n "$SMOKE_DRAFT_ID" ]]; then
      YAAPS_API_KEY="${YAAPS_SMOKE_API_KEY:-}" YAAPS_API_URL="$SMOKE_ORIGIN" YAAPS_CONFIG_DIR="$SMOKE_TEMPORARY_PATH/config" \
        node "$SMOKE_CLI_PATH" delete "$SMOKE_DRAFT_ID" --confirm "$SMOKE_DRAFT_ID" >/dev/null 2>&1 || true
    fi
    if [[ -d "$SMOKE_TEMPORARY_PATH" ]]; then
      assert_exact_path "$SMOKE_TEMPORARY_PATH" "$SMOKE_TEMPORARY_ROOT/yaaps-smoke-$SMOKE_RUN_ID"
      rm -rf -- "$SMOKE_TEMPORARY_PATH"
    fi
  }
  trap cleanup_smoke EXIT

  mkdir -- "$temporary_path"
  marker="YAAPS smoke $run_id"
  printf '<!doctype html><html><head><title>YAAPS smoke</title></head><body><h1>%s</h1></body></html>' "$marker" >"$report_path"

  status_json="$(node "$cli_path" status --api-url "$origin" --json)"
  [[ "$(json_stdin_get health.status <<<"$status_json")" == "ok" ]] || { printf 'YAAPS health is not ready.\n' >&2; return 1; }
  [[ "$(json_stdin_get readiness.status <<<"$status_json")" == "ready" ]] || { printf 'YAAPS readiness is not ready.\n' >&2; return 1; }

  publication_json="$(YAAPS_API_KEY="$api_key" YAAPS_API_URL="$origin" YAAPS_CONFIG_DIR="$temporary_path/config" \
    node "$cli_path" publish "$report_path" --new-draft --title "$marker" --ttl 3600 --json)"
  draft_id="$(json_stdin_get draft.id <<<"$publication_json")"
  SMOKE_DRAFT_ID="$draft_id"
  public_url="$(json_stdin_get draft.publicUrl <<<"$publication_json")"

  invoke_smoke_request "$public_url" "200" "$headers_path" "$body_path"
  grep -Fq -- "$marker" "$body_path" || { printf 'The public report did not contain the smoke marker.\n' >&2; return 1; }
  grep -Eiq '^Content-Security-Policy:.*sandbox' "$headers_path" || { printf 'The public report is missing the sandbox CSP.\n' >&2; return 1; }

  YAAPS_API_KEY="$api_key" YAAPS_API_URL="$origin" YAAPS_CONFIG_DIR="$temporary_path/config" node "$cli_path" disable "$draft_id" >/dev/null
  invoke_smoke_request "$public_url" "404" "$headers_path" "$body_path"
  YAAPS_API_KEY="$api_key" YAAPS_API_URL="$origin" YAAPS_CONFIG_DIR="$temporary_path/config" node "$cli_path" enable "$draft_id" >/dev/null
  invoke_smoke_request "$public_url" "200" "$headers_path" "$body_path"
  YAAPS_API_KEY="$api_key" YAAPS_API_URL="$origin" YAAPS_CONFIG_DIR="$temporary_path/config" node "$cli_path" delete "$draft_id" --confirm "$draft_id" >/dev/null
  draft_id=""
  SMOKE_DRAFT_ID=""
  invoke_smoke_request "$public_url" "404" "$headers_path" "$body_path"

  printf 'YAAPS smoke test passed against %s; the temporary report was deleted.\n' "$origin"
  cleanup_smoke
  trap - EXIT
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  invoke_yaaps_smoke "$@"
fi
