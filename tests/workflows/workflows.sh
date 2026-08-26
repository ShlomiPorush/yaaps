#!/usr/bin/env bash

set -Eeuo pipefail

WORKFLOW_TEST_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$WORKFLOW_TEST_DIRECTORY/../../.github/tools/guard.sh"
source "$WORKFLOW_TEST_DIRECTORY/../../.github/tools/ci-detect.sh"
source "$WORKFLOW_TEST_DIRECTORY/../operations/smoke.sh"

PASSED_TESTS=0

assert_equal() {
  local actual="$1"
  local expected="$2"
  local name="$3"
  if [[ "$actual" != "$expected" ]]; then
    printf "%s failed. Expected '%s', received '%s'.\n" "$name" "$expected" "$actual" >&2
    return 1
  fi
  ((PASSED_TESTS += 1))
}

assert_command_succeeds() {
  local name="$1"
  shift
  if "$@"; then assert_equal true true "$name"; else assert_equal false true "$name"; fi
}

assert_command_fails() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then assert_equal false true "$name"; else assert_equal true true "$name"; fi
}

assert_command_succeeds "Compose build key detection" test_compose_build_key $'services:\n  app:\n    build: .\n'
assert_command_fails "Compose build key prose" test_compose_build_key $'# build: is forbidden\nimage: example\n'
mapfile -t references < <(get_unpinned_action_references $'steps:\n  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1')
assert_equal "${#references[@]}" 0 "Pinned action accepted"
mapfile -t references < <(get_unpinned_action_references $'steps:\n  - uses: actions/checkout@v7')
assert_equal "${#references[@]}" 1 "Floating action rejected"
mapfile -t entries < <(get_dependabot_entries_without_cooldown $'updates:\n  - package-ecosystem: npm\n    cooldown:\n      default-days: 7\n  - package-ecosystem: github-actions\n')
assert_equal "${#entries[@]}" 1 "Missing Dependabot cooldown rejected"
assert_equal "${entries[0]}" github-actions "Dependabot cooldown identifies its ecosystem"
mapfile -t expressions < <(get_direct_workflow_expressions_in_run $'steps:\n  - env:\n      TITLE: ${{ github.event.pull_request.title }}\n    run: |\n      printf \'%s\\n\' "$TITLE"\n')
assert_equal "${#expressions[@]}" 0 "Workflow expressions isolated through environment"
mapfile -t expressions < <(get_direct_workflow_expressions_in_run $'steps:\n  - run: |\n      printf \'%s\\n\' "${{ github.event.pull_request.title }}"\n')
assert_equal "${#expressions[@]}" 1 "Direct workflow expression in run rejected"
mapfile -t expressions < <(get_direct_workflow_expressions_in_run $'steps:\n  - run: echo "${{ github.event.pull_request.title }}"\n')
assert_equal "${#expressions[@]}" 1 "Single-line run expression rejected"
mapfile -t expressions < <(get_direct_workflow_expressions_in_run $'steps:\n  - run: npm run lint\n')
assert_equal "${#expressions[@]}" 0 "Plain single-line run accepted"
assert_command_succeeds "npm minimum release age accepted" test_npm_minimum_release_age $'engine-strict=true\nmin-release-age=7\n'
assert_command_fails "npm minimum release age required" test_npm_minimum_release_age $'engine-strict=true\n'
assert_equal "$(resolve_smoke_origin https://dev.yaaps.net/)" https://dev.yaaps.net "Smoke origin normalization"
assert_command_fails "Unsafe smoke origin rejection" resolve_smoke_origin https://user:secret@dev.yaaps.net/path

get_ci_affected_areas false apps/server/src/app.ts
assert_equal "${CI_AREAS[server]}" true "Server path detection"
assert_equal "${CI_AREAS[browser]}" true "Server browser fanout"
assert_equal "${CI_AREAS[cli]}" false "Server does not fan out to CLI"
get_ci_affected_areas false packages/contracts/src/index.ts
assert_equal "${CI_AREAS[server]}" true "Shared server fanout"
assert_equal "${CI_AREAS[dashboard]}" true "Shared dashboard fanout"
assert_equal "${CI_AREAS[cli]}" true "Shared CLI fanout"
get_ci_affected_areas false docs/operations.md
assert_equal "${CI_AREAS[documentation]}" true "Documentation path detection"
assert_equal "${CI_AREAS[server]}" false "Documentation skips server"
get_ci_affected_areas false plugins/yaaps/skills/yaaps/scripts/yaaps.ps1
assert_equal "${CI_AREAS[cli]}" true "Skill path CLI fanout"
assert_equal "${CI_AREAS[infrastructure]}" true "Skill path infrastructure fanout"
assert_equal "${CI_AREAS[server]}" false "Skill path skips server"
assert_equal "${CI_AREAS[dashboard]}" false "Skill path skips dashboard"
assert_equal "${CI_AREAS[browser]}" false "Skill path skips browser"
get_ci_affected_areas false tests/workflows/workflows.sh
assert_equal "${CI_AREAS[infrastructure]}" true "Workflow test path detection"
assert_equal "${CI_AREAS[server]}" false "Workflow test path skips server"

printf '%d Bash workflow tests passed.\n' "$PASSED_TESTS"
