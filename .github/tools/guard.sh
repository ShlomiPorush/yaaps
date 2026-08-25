#!/usr/bin/env bash

set -Eeuo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

ALLOWED_HEBREW_PATH="apps/dashboard/src/locales/he.json"

contains_hebrew() {
  LC_ALL=C grep -Pq '(?:\xD6[\x90-\xBF]|\xD7[\x80-\xBF])' "$1"
}

test_compose_build_key() {
  local document="$1"
  grep -Eq '^[[:space:]]*build[[:space:]]*:' <<<"$document"
}

test_text_file() {
  local relative_path="${1//\\//}"
  case "$relative_path" in
    *.css|*.html|*.js|*.json|*.jsx|*.md|*.mjs|*.sh|*.ts|*.tsx|*.txt|*.yaml|*.yml|*.example|*/Dockerfile|Dockerfile)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

get_unpinned_action_references() {
  local document="$1"
  local reference
  while IFS= read -r reference; do
    [[ -z "$reference" ]] && continue
    if [[ "$reference" != ./* && ! "$reference" =~ @[0-9a-f]{40}$ ]]; then
      printf '%s\n' "$reference"
    fi
  done < <(sed -nE 's/^[[:space:]]*-[[:space:]]+uses:[[:space:]]+([^[:space:]#]+).*/\1/p' <<<"$document")
}

get_dependabot_entries_without_cooldown() {
  local document="$1"
  awk '
    function report_missing() {
      if (ecosystem != "" && cooldown != 1) print ecosystem
    }
    /^[[:space:]]*-[[:space:]]+package-ecosystem:[[:space:]]*/ {
      report_missing()
      ecosystem = $0
      sub(/^[[:space:]]*-[[:space:]]+package-ecosystem:[[:space:]]*/, "", ecosystem)
      cooldown = 0
      next
    }
    ecosystem != "" && /^[[:space:]]+default-days:[[:space:]]+7[[:space:]]*$/ {
      cooldown = 1
    }
    END {
      report_missing()
    }
  ' <<<"$document"
}

get_direct_workflow_expressions_in_run() {
  local document="$1"
  awk '
    function indentation(line) {
      match(line, /[^ ]/)
      return RSTART == 0 ? length(line) : RSTART - 1
    }
    /^[[:space:]]*(-[[:space:]]+)?run:[[:space:]]*[|>]/ {
      in_run = 1
      run_indent = index($0, "run:") - 1
      next
    }
    /^[[:space:]]*(-[[:space:]]+)?run:[[:space:]]*[^|>[:space:]]/ {
      if ($0 ~ /\$\{\{/) {
        print NR ":" $0
      }
      next
    }
    in_run {
      if ($0 !~ /^[[:space:]]*$/ && indentation($0) <= run_indent) {
        in_run = 0
      }
      if (in_run && $0 ~ /\$\{\{/) {
        print NR ":" $0
      }
    }
  ' <<<"$document"
}

test_npm_minimum_release_age() {
  local document="$1"
  grep -Eq '^min-release-age=7[[:space:]]*$' <<<"$document"
}

invoke_repository_guards() {
  require_command git

  local -a files=()
  local -a failures=()
  local -a compose_definitions=(
    "docker-compose.yml"
  )
  local file document reference name lockfile_version

  while IFS= read -r -d '' file; do
    files+=("$file")
  done < <(git -C "$REPOSITORY_ROOT" ls-files --cached --others --exclude-standard -z)

  if [[ -f "$DEVELOPMENT_COMPOSE_PATH" ]]; then
    compose_definitions+=("docker-compose.dev.yml")
  fi
  for file in "${compose_definitions[@]}"; do
    document="$(<"$REPOSITORY_ROOT/$file")"
    if test_compose_build_key "$document"; then
      failures+=("$file must not contain a build key.")
    fi
  done

  for file in "${files[@]}"; do
    if [[ "$file" =~ ^\.github/workflows/.+\.ya?ml$ ]]; then
      document="$(<"$REPOSITORY_ROOT/$file")"
      while IFS= read -r reference; do
        [[ -n "$reference" ]] && failures+=("$file uses unpinned action reference $reference.")
      done < <(get_unpinned_action_references "$document")
      while IFS= read -r reference; do
        [[ -n "$reference" ]] && failures+=("$file interpolates a workflow expression directly in a run script at $reference.")
      done < <(get_direct_workflow_expressions_in_run "$document")
    fi

    if test_text_file "$file" && [[ "${file//\\//}" != "$ALLOWED_HEBREW_PATH" ]]; then
      if contains_hebrew "$REPOSITORY_ROOT/$file"; then
        failures+=("Hebrew text is not allowed in $file.")
      fi
    fi

    name="${file##*/}"
    if [[ "$name" == ".env" || "$name" == .env.* ]]; then
      [[ "$name" == *.example ]] || failures+=("$file must not be tracked.")
    fi
  done

  if ! contains_hebrew "$REPOSITORY_ROOT/$ALLOWED_HEBREW_PATH"; then
    failures+=("$ALLOWED_HEBREW_PATH must contain the Hebrew localization.")
  fi

  document="$(<"$REPOSITORY_ROOT/.github/dependabot.yml")"
  while IFS= read -r reference; do
    [[ -n "$reference" ]] && failures+=("Dependabot $reference updates must use a seven-day cooldown.")
  done < <(get_dependabot_entries_without_cooldown "$document")

  document="$(<"$REPOSITORY_ROOT/.npmrc")"
  if ! test_npm_minimum_release_age "$document"; then
    failures+=(".npmrc must set min-release-age=7.")
  fi

  lockfile_version="$(sed -nE 's/^[[:space:]]*"lockfileVersion":[[:space:]]*([0-9]+),?[[:space:]]*$/\1/p' "$REPOSITORY_ROOT/package-lock.json" | head -n 1)"
  if [[ "$lockfile_version" != "3" ]]; then
    failures+=("package-lock.json must use lockfile version 3.")
  fi

  repository_version="$(tr -d '[:space:]' <"$REPOSITORY_ROOT/VERSION")"
  root_package_version="$(sed -nE 's/^[[:space:]]*"version": "([^"]+)",?$/\1/p' "$REPOSITORY_ROOT/package.json" | head -n 1)"
  cli_package_version="$(sed -nE 's/^[[:space:]]*"version": "([^"]+)",?$/\1/p' "$REPOSITORY_ROOT/packages/cli/package.json" | head -n 1)"
  foundation_version="$(sed -nE 's/.*FOUNDATION_VERSION = "([^"]+)".*/\1/p' "$REPOSITORY_ROOT/packages/contracts/src/index.ts" | head -n 1)"
  if [[ -z "$repository_version" ]]; then
    failures+=("VERSION must contain the release version.")
  elif [[ "$root_package_version" != "$repository_version" || "$cli_package_version" != "$repository_version" || "$foundation_version" != "$repository_version" ]]; then
    failures+=("VERSION ($repository_version) must match package.json ($root_package_version), the CLI package ($cli_package_version), and FOUNDATION_VERSION ($foundation_version); run npm run version:sync.")
  fi

  if ((${#failures[@]} > 0)); then
    printf 'Repository guards failed:\n' >&2
    printf -- '- %s\n' "${failures[@]}" >&2
    return 1
  fi

  printf 'Repository guards passed for %d visible files.\n' "${#files[@]}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  invoke_repository_guards
fi
