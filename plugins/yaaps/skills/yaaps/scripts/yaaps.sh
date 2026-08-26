#!/bin/sh

set -eu
set +x
umask 077

yaaps_temp_directory=$(mktemp -d "${TMPDIR:-/tmp}/yaaps-helper.XXXXXX")
yaaps_http_response="$yaaps_temp_directory/response"
yaaps_curl_config="$yaaps_temp_directory/curl-config"
yaaps_url_temp=
yaaps_key_temp=

cleanup_sensitive_temps() {
  [ -z "$yaaps_http_response" ] || rm -f "$yaaps_http_response"
  [ -z "$yaaps_curl_config" ] || rm -f "$yaaps_curl_config"
  [ -z "$yaaps_url_temp" ] || rm -f "$yaaps_url_temp"
  [ -z "$yaaps_key_temp" ] || rm -f "$yaaps_key_temp"
  rmdir "$yaaps_temp_directory" 2>/dev/null || true
}

trap cleanup_sensitive_temps EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  printf 'YAAPS: %s\n' "$1" >&2
  exit 1
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but was not found on PATH."
}

YAAPS_JSON_ENGINE=

YAAPS_JSON_JS='function run(argv){
  var op=argv[0], a=argv.slice(1);
  switch(op){
    case "get": {
      var value=JSON.parse(a[0]);
      var parts=a[1].split(".");
      for(var i=0;i<parts.length;i++){ if(value===null||value===undefined){value=undefined;break;} value=value[parts[i]]; }
      if(value===null||value===undefined) return "";
      return (typeof value==="object")?JSON.stringify(value):String(value);
    }
    case "category_body": return JSON.stringify({category:a[0]==="clear"?null:a[1]});
    case "connect_body": return JSON.stringify({keyHash:a[0],keyPrefix:a[1],label:a[2]});
    case "secret_body": return JSON.stringify({deviceSecret:a[0]});
    case "status_body": return JSON.stringify({status:a[0]});
    case "config_show": return JSON.stringify({apiUrl:a[0]||null,apiKeyPrefix:a[1]||null});
    case "pending": return JSON.stringify({status:"pending",verificationUrl:a[0],userCode:a[1],expiresAt:a[2]});
    case "approved": return JSON.stringify({status:"approved",apiUrl:a[0],apiKeyPrefix:a[1],apiKeyId:a[2]});
    case "pair": return JSON.stringify({draft:JSON.parse(a[0]),versions:JSON.parse(a[1])});
    case "health": return JSON.stringify({health:JSON.parse(a[0]),readiness:JSON.parse(a[1])});
    case "deleted": return JSON.stringify({deleted:a[0]});
    case "urlencode": return encodeURIComponent(a[0]);
    case "epoch": { var t=Math.floor(new Date(a[0]).getTime()/1000); return isFinite(t)?String(t):""; }
  }
  return "";
}'

YAAPS_JSON_PY='import sys, json
from urllib.parse import quote
a = sys.argv[1:]
op = a[0]; a = a[1:]
w = sys.stdout.write
if op == "get":
    v = json.loads(a[0])
    for p in a[1].split("."):
        if isinstance(v, dict): v = v.get(p)
        else:
            v = None; break
    if v is None: w("")
    elif isinstance(v, bool): w("true" if v else "false")
    elif isinstance(v, (dict, list)): w(json.dumps(v, separators=(",", ":"), ensure_ascii=False))
    else: w(str(v))
elif op == "category_body": w(json.dumps({"category": None if a[0] == "clear" else a[1]}, separators=(",", ":"), ensure_ascii=False))
elif op == "connect_body": w(json.dumps({"keyHash": a[0], "keyPrefix": a[1], "label": a[2]}, separators=(",", ":"), ensure_ascii=False))
elif op == "secret_body": w(json.dumps({"deviceSecret": a[0]}, separators=(",", ":"), ensure_ascii=False))
elif op == "status_body": w(json.dumps({"status": a[0]}, separators=(",", ":"), ensure_ascii=False))
elif op == "config_show": w(json.dumps({"apiUrl": a[0] or None, "apiKeyPrefix": a[1] or None}, separators=(",", ":"), ensure_ascii=False))
elif op == "pending": w(json.dumps({"status": "pending", "verificationUrl": a[0], "userCode": a[1], "expiresAt": a[2]}, separators=(",", ":"), ensure_ascii=False))
elif op == "approved": w(json.dumps({"status": "approved", "apiUrl": a[0], "apiKeyPrefix": a[1], "apiKeyId": a[2]}, separators=(",", ":"), ensure_ascii=False))
elif op == "pair": w(json.dumps({"draft": json.loads(a[0]), "versions": json.loads(a[1])}, separators=(",", ":"), ensure_ascii=False))
elif op == "health": w(json.dumps({"health": json.loads(a[0]), "readiness": json.loads(a[1])}, separators=(",", ":"), ensure_ascii=False))
elif op == "deleted": w(json.dumps({"deleted": a[0]}, separators=(",", ":"), ensure_ascii=False))
elif op == "urlencode": w(quote(a[0], safe="!*()-._~'"'"'"))
elif op == "epoch":
    from datetime import datetime
    try: w(str(int(datetime.fromisoformat(a[0].replace("Z", "+00:00")).timestamp())))
    except Exception: w("")
'

select_json_engine() {
  [ -n "$YAAPS_JSON_ENGINE" ] && return 0
  if command -v osascript >/dev/null 2>&1; then YAAPS_JSON_ENGINE=osascript
  elif command -v node >/dev/null 2>&1; then YAAPS_JSON_ENGINE=node
  elif command -v python3 >/dev/null 2>&1; then YAAPS_JSON_ENGINE=python3
  elif command -v python >/dev/null 2>&1; then YAAPS_JSON_ENGINE=python
  else fail 'A JSON runtime is required: osascript (macOS), node, or python3.'; fi
}

yaaps_js() {
  case "$YAAPS_JSON_ENGINE" in
    osascript) osascript -l JavaScript -e "$YAAPS_JSON_JS" "$@" ;;
    node) node -e "$YAAPS_JSON_JS
var __o=run(process.argv.slice(1)); if(__o!==undefined&&__o!==null) process.stdout.write(String(__o));" "$@" ;;
    *) "$YAAPS_JSON_ENGINE" -c "$YAAPS_JSON_PY" "$@" ;;
  esac
}

json_get() {
  yaaps_json_get_output=$(yaaps_js get "$1" "$2" 2>/dev/null) ||
    fail 'The server response was not valid JSON.'
  printf '%s' "$yaaps_json_get_output"
}
json_category_body() { yaaps_js category_body "$1" "$2"; }
json_connect_body() { yaaps_js connect_body "$1" "$2" "$3"; }
json_secret_body() { yaaps_js secret_body "$1"; }
json_status_body() { yaaps_js status_body "$1"; }
json_config_show() { yaaps_js config_show "$1" "$2"; }
json_pending() { yaaps_js pending "$1" "$2" "$3"; }
json_approved() { yaaps_js approved "$1" "$2" "$3"; }
json_pair() { yaaps_js pair "$1" "$2"; }
json_health() { yaaps_js health "$1" "$2"; }
json_deleted() { yaaps_js deleted "$1"; }

normalize_origin() {
  case "$1" in http://*|https://*) ;; *) fail 'The service URL must be a bare HTTP or HTTPS origin.' ;; esac
  yaaps_origin_authority=${1#*://}
  yaaps_origin_authority=${yaaps_origin_authority%/}
  case "$yaaps_origin_authority" in ''|*'/'*|*'?'*|*'#'*|*'@'*) fail 'The service URL must be a bare HTTP or HTTPS origin.' ;; esac
  printf '%s://%s\n' "${1%%://*}" "$yaaps_origin_authority"
}

url_encode() { yaaps_js urlencode "$1"; }

assert_draft_id() {
  printf '%s' "$1" | LC_ALL=C grep -Eq '^[A-Za-z0-9_-]{32}$' || fail 'The draft ID format is invalid.'
  printf '%s\n' "$1"
}

config_directory() {
  if [ -n "${YAAPS_CONFIG_DIR:-}" ]; then
    printf '%s\n' "$YAAPS_CONFIG_DIR"
  else
    [ -n "${HOME:-}" ] || fail 'HOME is not set.'
    printf '%s/.yaaps\n' "$HOME"
  fi
}

# Read-only fallback to the YAAPS CLI's config so connecting with either tool
# is enough; this helper still writes only its own store.
cli_config_path() {
  if [ -n "${XDG_CONFIG_HOME:-}" ]; then
    printf '%s/yaaps/config.json\n' "$XDG_CONFIG_HOME"
  elif [ -n "${HOME:-}" ]; then
    printf '%s/.config/yaaps/config.json\n' "$HOME"
  fi
}

read_cli_config_value() {
  yaaps_cli_config_path=$(cli_config_path)
  [ -n "$yaaps_cli_config_path" ] && [ -f "$yaaps_cli_config_path" ] || return 0
  yaaps_js get "$(cat "$yaaps_cli_config_path")" "$1" 2>/dev/null || true
}

read_config_url() {
  yaaps_config_path="$(config_directory)/api-url"
  if [ -f "$yaaps_config_path" ]; then
    cat "$yaaps_config_path"
  else
    read_cli_config_value apiUrl
  fi
}

read_config_key() {
  yaaps_config_path="$(config_directory)/api-key"
  if [ -f "$yaaps_config_path" ]; then
    cat "$yaaps_config_path"
  else
    read_cli_config_value apiKey
  fi
}

write_config() {
  yaaps_config_directory=$(config_directory)
  mkdir -p "$yaaps_config_directory"
  chmod 700 "$yaaps_config_directory"
  yaaps_url_temp=$(mktemp "$yaaps_config_directory/.api-url.XXXXXX")
  yaaps_key_temp=$(mktemp "$yaaps_config_directory/.api-key.XXXXXX")
  printf '%s\n' "$1" >"$yaaps_url_temp"
  printf '%s\n' "$2" >"$yaaps_key_temp"
  chmod 600 "$yaaps_url_temp" "$yaaps_key_temp"
  mv -f "$yaaps_url_temp" "$yaaps_config_directory/api-url"
  yaaps_url_temp=
  mv -f "$yaaps_key_temp" "$yaaps_config_directory/api-key"
  yaaps_key_temp=
  chmod 600 "$yaaps_config_directory/api-url" "$yaaps_config_directory/api-key"
}

load_credentials() {
  yaaps_api_url=${YAAPS_API_URL:-$(read_config_url)}
  yaaps_api_key=${YAAPS_API_KEY:-$(read_config_key)}
  [ -n "$yaaps_api_url" ] && [ -n "$yaaps_api_key" ] || fail 'Credentials are missing. Run connect first.'
  printf '%s' "$yaaps_api_key" | LC_ALL=C grep -Eq '^yaaps_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$' || fail 'The stored API key is invalid.'
  yaaps_api_url=$(normalize_origin "$yaaps_api_url")
}

http_request() {
  yaaps_http_method=$1
  yaaps_http_url=$2
  yaaps_http_key=$3
  yaaps_http_body=$4
  yaaps_http_file=$5
  yaaps_http_response="$yaaps_temp_directory/response"
  yaaps_curl_config="$yaaps_temp_directory/curl-config"
  : >"$yaaps_http_response"
  : >"$yaaps_curl_config"
  chmod 600 "$yaaps_http_response" "$yaaps_curl_config"
  if [ -n "$yaaps_http_key" ]; then
    printf 'header = "Authorization: Bearer %s"\n' "$yaaps_http_key" >"$yaaps_curl_config"
  else
    : >"$yaaps_curl_config"
  fi
  if [ -n "$yaaps_http_body" ] || [ -n "$yaaps_http_file" ]; then
    printf 'header = "Content-Type: %s"\n' "$(if [ -n "$yaaps_http_file" ]; then printf 'text/html; charset=utf-8'; else printf 'application/json'; fi)" >>"$yaaps_curl_config"
  fi
  if [ -n "$yaaps_http_file" ]; then
    yaaps_http_status=$(curl --config "$yaaps_curl_config" -sS --max-time 60 --max-redirs 0 -X "$yaaps_http_method" --data-binary "@$yaaps_http_file" -o "$yaaps_http_response" -w '%{http_code}' "$yaaps_http_url") || yaaps_http_curl_status=$?
  elif [ -n "$yaaps_http_body" ]; then
    yaaps_http_status=$(printf '%s' "$yaaps_http_body" | curl --config "$yaaps_curl_config" -sS --max-time 60 --max-redirs 0 -X "$yaaps_http_method" --data-binary @- -o "$yaaps_http_response" -w '%{http_code}' "$yaaps_http_url") || yaaps_http_curl_status=$?
  else
    yaaps_http_status=$(curl --config "$yaaps_curl_config" -sS --max-time 60 --max-redirs 0 -X "$yaaps_http_method" -o "$yaaps_http_response" -w '%{http_code}' "$yaaps_http_url") || yaaps_http_curl_status=$?
  fi
  rm -f "$yaaps_curl_config"
  yaaps_curl_config=
  if [ "${yaaps_http_curl_status:-0}" -ne 0 ]; then
    rm -f "$yaaps_http_response"
    yaaps_http_response=
    fail 'The HTTP request could not be completed.'
  fi
  case "$yaaps_http_status" in
    2??) cat "$yaaps_http_response" ;;
    *)
      printf 'YAAPS: request failed with HTTP %s: ' "$yaaps_http_status" >&2
      cat "$yaaps_http_response" >&2
      printf '\n' >&2
      rm -f "$yaaps_http_response"
      yaaps_http_response=
      exit 1
      ;;
  esac
  rm -f "$yaaps_http_response"
  yaaps_http_response=
  unset yaaps_http_curl_status
}

new_secret() {
  dd if=/dev/urandom bs=32 count=1 2>/dev/null | base64 | tr -d '\r\n=' | tr '+/' '-_'
}

sha256() {
  if command -v shasum >/dev/null 2>&1; then
    set -- $(printf '%s' "$1" | shasum -a 256)
    printf '%s\n' "$1"
  elif command -v openssl >/dev/null 2>&1; then
    printf '%s' "$1" | openssl dgst -sha256 | sed 's/^.*= //'
  else
    fail 'shasum or openssl is required.'
  fi
}

require_tool curl
select_json_engine

command_name=${1:-}
[ -n "$command_name" ] || fail 'A command is required.'
shift

case "$command_name" in
  connect)
    connect_url="https://yaaps.net"
    connect_label="YAAPS Skill on $(hostname)"
    connect_open=true
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --api-url) [ "$#" -ge 2 ] || fail '--api-url requires a value.'; connect_url=$2; shift 2 ;;
        --label) [ "$#" -ge 2 ] || fail '--label requires a value.'; connect_label=$2; shift 2 ;;
        --no-open) connect_open=false; shift ;;
        *) fail "Unknown connect argument: $1" ;;
      esac
    done
    connect_url=$(normalize_origin "$connect_url")
    case "$connect_url" in
      http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*) ;;
      http://*) printf 'YAAPS: warning: plain HTTP sends the API key in cleartext; use HTTPS outside localhost.\n' >&2 ;;
    esac
    [ -n "$connect_label" ] && [ "${#connect_label}" -le 100 ] || fail 'The connection label must be 1 to 100 characters.'
    connect_secret=$(new_secret)
    connect_prefix="yaaps_$(new_secret | cut -c1-10)"
    connect_key="${connect_prefix}_${connect_secret}"
    connect_hash=$(sha256 "$connect_key")
    connect_response=$(http_request POST "$connect_url/auth/device-connections" '' "$(json_connect_body "$connect_hash" "$connect_prefix" "$connect_label")" '')
    verification_url=$(json_get "$connect_response" verificationUrlComplete)
    user_code=$(json_get "$connect_response" userCode)
    expires_at=$(json_get "$connect_response" expiresAt)
    interval=$(json_get "$connect_response" intervalSeconds)
    device_secret=$(json_get "$connect_response" deviceSecret)
    json_pending "$verification_url" "$user_code" "$expires_at"
    if [ "$connect_open" = true ]; then
      case "$verification_url" in
        "$connect_url"/*)
          if command -v osascript >/dev/null 2>&1; then
            osascript -e 'on run argv' -e 'open location item 1 of argv' -e 'end run' "$verification_url" >/dev/null 2>&1 || printf 'YAAPS: could not open the browser; open the verification URL manually.\n' >&2
          elif command -v xdg-open >/dev/null 2>&1; then
            xdg-open "$verification_url" >/dev/null 2>&1 || printf 'YAAPS: could not open the browser; open the verification URL manually.\n' >&2
          else
            printf 'YAAPS: no browser opener available; open the verification URL manually.\n' >&2
          fi
          ;;
        *)
          printf 'YAAPS: refusing to open an unexpected verification URL; open it manually from the pending output.\n' >&2
          ;;
      esac
    fi
    expires_epoch=$(yaaps_js epoch "$expires_at")
    while [ "$(date +%s)" -lt "$expires_epoch" ]; do
      sleep "$interval"
      # Transient failures (a 429 at the rate-limit boundary, a network blip)
      # must not abort a request the user may already be approving; only denial
      # and expiry are fatal.
      if ! decision=$(http_request POST "$connect_url/auth/device-connections/token" '' "$(json_secret_body "$device_secret")" '' 2>/dev/null); then
        continue
      fi
      decision_status=$(json_get "$decision" status)
      [ "$decision_status" = pending ] && continue
      [ "$decision_status" != denied ] || fail 'The connection request was denied.'
      if [ "$decision_status" = approved ]; then
        write_config "$connect_url" "$connect_key"
        json_approved "$connect_url" "$connect_prefix" "$(json_get "$decision" apiKeyId)"
        exit 0
      fi
      fail 'The connection response was invalid.'
    done
    fail 'The connection request expired.'
    ;;
  config)
    [ "$#" -eq 1 ] && [ "$1" = show ] || fail 'Usage: config show'
    config_show_url=$(read_config_url)
    config_show_key=$(read_config_key)
    config_show_prefix=
    [ -z "$config_show_key" ] || config_show_prefix=$(printf '%.16s' "$config_show_key")
    json_config_show "$config_show_url" "$config_show_prefix"
    ;;
  status)
    status_url=
    while [ "$#" -gt 0 ]; do
      case "$1" in --api-url) [ "$#" -ge 2 ] || fail '--api-url requires a value.'; status_url=$2; shift 2 ;; *) fail "Unknown status argument: $1" ;; esac
    done
    status_url=${status_url:-${YAAPS_API_URL:-$(read_config_url)}}
    status_url=${status_url:-https://yaaps.net}
    status_url=$(normalize_origin "$status_url")
    json_health "$(http_request GET "$status_url/healthz" '' '' '')" "$(http_request GET "$status_url/readyz" '' '' '')"
    ;;
  publish)
    [ "$#" -ge 1 ] || fail 'Usage: publish <html-file> [--category <name>] [--draft-id <id>] [--title <title>] [--ttl <seconds>]'
    publish_file=$1; shift
    [ -f "$publish_file" ] || fail 'The HTML file does not exist.'
    publish_category= publish_draft= publish_title= publish_ttl=
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --category) [ "$#" -ge 2 ] || fail '--category requires a value.'; publish_category=$2; shift 2 ;;
        --draft-id) [ "$#" -ge 2 ] || fail '--draft-id requires a value.'; publish_draft=$(assert_draft_id "$2"); shift 2 ;;
        --title) [ "$#" -ge 2 ] || fail '--title requires a value.'; publish_title=$2; shift 2 ;;
        --ttl) [ "$#" -ge 2 ] || fail '--ttl requires a value.'; publish_ttl=$2; shift 2 ;;
        *) fail "Unknown publish argument: $1" ;;
      esac
    done
    load_credentials
    publish_route=/api/drafts
    [ -z "$publish_draft" ] || publish_route="/api/drafts/$publish_draft/versions"
    publish_separator='?'
    if [ -n "$publish_category" ]; then publish_route="$publish_route${publish_separator}category=$(url_encode "$publish_category")"; publish_separator='&'; fi
    if [ -n "$publish_title" ]; then publish_route="$publish_route${publish_separator}title=$(url_encode "$publish_title")"; publish_separator='&'; fi
    if [ -n "$publish_ttl" ]; then
      case "$publish_ttl" in *[!0-9]*|'') fail '--ttl must be a positive integer.' ;; esac
      [ "$publish_ttl" -gt 0 ] || fail '--ttl must be a positive integer.'
      publish_route="$publish_route${publish_separator}ttlSeconds=$publish_ttl"
    fi
    http_request POST "$yaaps_api_url$publish_route" "$yaaps_api_key" '' "$publish_file"
    ;;
  list)
    list_category= list_limit=50 list_offset=0
    while [ "$#" -gt 0 ]; do
      case "$1" in --category) [ "$#" -ge 2 ] || fail '--category requires a value.'; list_category=$2; shift 2 ;; --limit) [ "$#" -ge 2 ] || fail '--limit requires a value.'; list_limit=$2; shift 2 ;; --offset) [ "$#" -ge 2 ] || fail '--offset requires a value.'; list_offset=$2; shift 2 ;; *) fail "Unknown list argument: $1" ;; esac
    done
    load_credentials
    list_route="/api/drafts?limit=$list_limit&offset=$list_offset"
    [ -z "$list_category" ] || list_route="$list_route&category=$(url_encode "$list_category")"
    http_request GET "$yaaps_api_url$list_route" "$yaaps_api_key" '' ''
    ;;
  inspect)
    [ "$#" -eq 1 ] || fail 'Usage: inspect <draft-id>'
    inspect_id=$(assert_draft_id "$1")
    load_credentials
    inspect_draft=$(http_request GET "$yaaps_api_url/api/drafts/$inspect_id" "$yaaps_api_key" '' '')
    inspect_versions=$(http_request GET "$yaaps_api_url/api/drafts/$inspect_id/versions?limit=100&offset=0" "$yaaps_api_key" '' '')
    json_pair "$inspect_draft" "$inspect_versions"
    ;;
  categorize)
    [ "$#" -ge 1 ] || fail 'Usage: categorize <draft-id> <category> | categorize <draft-id> --clear'
    categorize_id=$(assert_draft_id "$1"); shift
    categorize_category= categorize_clear=false categorize_given=false
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --clear) categorize_clear=true; shift ;;
        --*) fail "Unknown categorize argument: $1" ;;
        *)
          [ "$categorize_given" = false ] || fail 'Usage: categorize <draft-id> <category> | categorize <draft-id> --clear'
          categorize_category=$1; categorize_given=true; shift
          ;;
      esac
    done
    if [ "$categorize_clear" = true ]; then
      [ "$categorize_given" = false ] || fail 'A category and --clear cannot be used together.'
      categorize_body=$(json_category_body clear '')
    else
      [ "$categorize_given" = true ] || fail 'Provide a category or --clear.'
      categorize_body=$(json_category_body set "$categorize_category")
    fi
    load_credentials
    http_request PATCH "$yaaps_api_url/api/drafts/$categorize_id" "$yaaps_api_key" "$categorize_body" ''
    ;;
  disable|enable)
    [ "$#" -eq 1 ] || fail "Usage: $command_name <draft-id>"
    update_id=$(assert_draft_id "$1")
    update_status=enabled; [ "$command_name" = enable ] || update_status=disabled
    load_credentials
    http_request PATCH "$yaaps_api_url/api/drafts/$update_id" "$yaaps_api_key" "$(json_status_body "$update_status")" ''
    ;;
  delete)
    [ "$#" -ge 1 ] || fail 'Usage: delete <draft-id> --confirm <draft-id>'
    delete_id=$(assert_draft_id "$1"); shift
    delete_confirm=
    while [ "$#" -gt 0 ]; do
      case "$1" in --confirm) [ "$#" -ge 2 ] || fail '--confirm requires a value.'; delete_confirm=$2; shift 2 ;; *) fail "Unknown delete argument: $1" ;; esac
    done
    [ "$delete_confirm" = "$delete_id" ] || fail 'The confirmation draft ID does not match.'
    load_credentials
    http_request DELETE "$yaaps_api_url/api/drafts/$delete_id" "$yaaps_api_key" '' '' >/dev/null
    json_deleted "$delete_id"
    ;;
  *) fail 'Unknown command. Use connect, config show, status, publish, list, inspect, categorize, disable, enable, or delete.' ;;
esac
