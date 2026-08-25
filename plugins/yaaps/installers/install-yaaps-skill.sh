#!/bin/sh

set -eu

install_codex=false
install_claude=false
dry_run=false
source_url="${YAAPS_SKILL_SOURCE:-}"
local_package=""
install_home="${HOME:-}"
target_overrides=""

usage() {
  printf '%s\n' "Usage: install-yaaps-skill.sh [--codex|--claude|--all] [--target PATH] [--dry-run] [--source HTTPS_URL|--local-package PATH] [--home PATH]"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --codex) install_codex=true ;;
    --claude) install_claude=true ;;
    --all) install_codex=true; install_claude=true ;;
    --dry-run) dry_run=true ;;
    --source) shift; [ "$#" -gt 0 ] || { usage >&2; exit 2; }; source_url=$1 ;;
    --local-package) shift; [ "$#" -gt 0 ] || { usage >&2; exit 2; }; local_package=$1 ;;
    --home) shift; [ "$#" -gt 0 ] || { usage >&2; exit 2; }; install_home=$1 ;;
    --target) shift; [ "$#" -gt 0 ] || { usage >&2; exit 2; }; target_overrides="${target_overrides}${target_overrides:+
}$1" ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

[ -n "$install_home" ] || { printf '%s\n' "A home directory could not be resolved." >&2; exit 1; }
case "$install_home" in /*) ;; *) install_home="$(pwd -P)/$install_home" ;; esac
[ -z "$source_url" ] || [ -z "$local_package" ] || { printf '%s\n' "Use either --source or --local-package, not both." >&2; exit 1; }
if [ -z "$source_url" ] && [ -z "$local_package" ]; then source_url="__YAAPS_SKILL_PACKAGE_URL__"; fi

if [ -z "$target_overrides" ] && [ "$install_codex" = false ] && [ "$install_claude" = false ]; then
  { command -v codex >/dev/null 2>&1 || [ -d "$install_home/.codex" ]; } && install_codex=true
  { command -v claude >/dev/null 2>&1 || [ -d "$install_home/.claude" ]; } && install_claude=true
fi

if [ -z "$target_overrides" ] && [ "$install_codex" = false ] && [ "$install_claude" = false ]; then
  printf '%s\n' "No Codex or Claude installation was detected; installing to both standard user skill paths."
  install_codex=true
  install_claude=true
fi

if [ "$dry_run" = true ]; then
  printf '%s\n' "YAAPS skill installation dry run."
  [ "$install_codex" = false ] || printf 'Would install: %s\n' "$install_home/.agents/skills/yaaps"
  [ "$install_claude" = false ] || printf 'Would install: %s\n' "$install_home/.claude/skills/yaaps"
  if [ -n "$target_overrides" ]; then
    printf '%s\n' "$target_overrides" | while IFS= read -r target; do printf 'Would install: %s\n' "$target"; done
  fi
  [ -z "$source_url" ] || printf 'Source: %s\n' "$source_url"
  [ -z "$local_package" ] || printf 'Package: %s\n' "$local_package"
  exit 0
fi

# Allow plain http only for localhost, including a port (http://localhost:9099/...).
# The host is extracted precisely: a glob like http://localhost:* would also
# match http://localhost:x@evil.example/, where localhost is only the userinfo.
is_local_http_source() {
  case "$1" in http://*) ;; *) return 1 ;; esac
  yaaps_local_hostport=${1#http://}
  yaaps_local_hostport=${yaaps_local_hostport%%/*}
  case "$yaaps_local_hostport" in *@*) return 1 ;; esac
  yaaps_local_host=${yaaps_local_hostport%%:*}
  case "$yaaps_local_host" in localhost|127.0.0.1) ;; *) return 1 ;; esac
  if [ "$yaaps_local_hostport" != "$yaaps_local_host" ]; then
    yaaps_local_port=${yaaps_local_hostport#*:}
    case "$yaaps_local_port" in ''|*[!0-9]*) return 1 ;; esac
  fi
  return 0
}

case "$source_url" in
  ""|https://*) ;;
  *)
    is_local_http_source "$source_url" || { printf '%s\n' "Source must use HTTPS except for localhost testing." >&2; exit 1; }
    ;;
esac

temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/yaaps-skill-install.XXXXXX")
cleanup() { rm -rf "$temporary_root"; }
trap cleanup EXIT HUP INT TERM
package_path="$temporary_root/yaaps-skill.zip"
if [ -n "$local_package" ]; then
  cp "$local_package" "$package_path"
else
  command -v curl >/dev/null 2>&1 || { printf '%s\n' "curl is required to download the skill package." >&2; exit 1; }
  curl_protocols='=https'
  if is_local_http_source "$source_url"; then curl_protocols='=http,https'; fi
  curl --fail --location --proto "$curl_protocols" --tlsv1.2 --silent --show-error "$source_url" --output "$package_path"
  curl --fail --location --proto "$curl_protocols" --tlsv1.2 --silent --show-error "$source_url.sha256" --output "$temporary_root/yaaps-skill.zip.sha256"
  expected_checksum=$(awk 'NF == 2 && $2 == "yaaps-skill.zip" && $1 ~ /^[a-fA-F0-9]{64}$/ { print tolower($1) }' "$temporary_root/yaaps-skill.zip.sha256")
  [ -n "$expected_checksum" ] || { printf '%s\n' "The skill package checksum document is invalid." >&2; exit 1; }
  actual_checksum=$(shasum -a 256 "$package_path" | awk '{print tolower($1)}')
  [ "$actual_checksum" = "$expected_checksum" ] || { printf '%s\n' "The skill package failed SHA-256 verification." >&2; exit 1; }
fi

expanded="$temporary_root/expanded"
mkdir -p "$expanded"
command -v unzip >/dev/null 2>&1 || { printf '%s\n' "unzip is required to validate and extract the skill package." >&2; exit 1; }
archive_listing="$temporary_root/archive-listing.txt"
unzip -Z1 "$package_path" > "$archive_listing" || { printf '%s\n' "The skill package is not a valid ZIP archive." >&2; exit 1; }
awk 'BEGIN { ok=1; count=0 } { count += 1 } !/^yaaps\// || /(^|\/)\.\.($|\/)/ || /[\\:]/ { ok=0 } END { exit ok && count > 0 ? 0 : 1 }' "$archive_listing" || { printf '%s\n' "The package contains an invalid path." >&2; exit 1; }
if command -v ditto >/dev/null 2>&1; then
  ditto -x -k "$package_path" "$expanded"
else
  unzip -q "$package_path" -d "$expanded"
fi
[ -f "$expanded/yaaps/SKILL.md" ] || { printf '%s\n' "The package does not contain yaaps/SKILL.md." >&2; exit 1; }

install_target() {
  destination=$1
  case "$destination" in /*) ;; *) destination="$(pwd -P)/$destination" ;; esac
  parent=$(dirname "$destination")
  mkdir -p "$parent"
  staged="$parent/.yaaps-install-$$-$(date -u +%s)"
  cp -R "$expanded/yaaps" "$staged"
  backup=""
  if [ -e "$destination" ]; then
    backup="$destination.backup-$(date -u +%Y%m%d%H%M%S)-$$"
    mv "$destination" "$backup"
  fi
  if ! mv "$staged" "$destination"; then
    rm -rf "$staged"
    [ -z "$backup" ] || mv "$backup" "$destination"
    return 1
  fi
  if [ -f "$destination/scripts/yaaps.sh" ]; then chmod 755 "$destination/scripts/yaaps.sh"; fi
  printf 'Installed YAAPS skill: %s\n' "$destination"
}

[ "$install_codex" = false ] || install_target "$install_home/.agents/skills/yaaps"
[ "$install_claude" = false ] || install_target "$install_home/.claude/skills/yaaps"
if [ -n "$target_overrides" ]; then
  printf '%s\n' "$target_overrides" | while IFS= read -r target; do install_target "$target"; done
fi
