#!/usr/bin/env bash

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/yaaps-skill-installer-test.XXXXXX")"
cleanup() {
  [[ "$temporary_root" == "${TMPDIR:-/tmp}"/yaaps-skill-installer-test.* ]] || return 1
  rm -rf -- "$temporary_root"
}
trap cleanup EXIT

package_path="${1:-}"
if [[ -n "$package_path" ]] && command -v cygpath >/dev/null 2>&1; then
  package_path="$(cygpath -u "$package_path")"
fi
if [[ -z "$package_path" ]]; then
  command -v zip >/dev/null 2>&1 || {
    printf '%s\n' "zip is required when no test package is supplied." >&2
    exit 1
  }
  mkdir -p "$temporary_root/package/yaaps"
  cp -R -- "$repository_root/plugins/yaaps/skills/yaaps/." "$temporary_root/package/yaaps/"
  package_path="$temporary_root/yaaps-skill.zip"
  (cd "$temporary_root/package" && zip -qr "$package_path" yaaps)
fi

installer="$repository_root/plugins/yaaps/installers/install-yaaps-skill.sh"
target="$temporary_root/installed/yaaps"
bash "$installer" --target "$target" --local-package "$package_path" --home "$temporary_root/home" --dry-run
[[ ! -e "$target" ]]
bash "$installer" --target "$target" --local-package "$package_path" --home "$temporary_root/home"
diff -r -- "$repository_root/plugins/yaaps/skills/yaaps" "$target"
printf '%s\n' "preserve backup" >"$target/local-marker.txt"
bash "$installer" --target "$target" --local-package "$package_path" --home "$temporary_root/home"
compgen -G "$temporary_root/installed/yaaps.backup-*/local-marker.txt" >/dev/null

printf '%s\n' "POSIX skill installer tests passed."
