#!/usr/bin/env bash
#
# deploy.sh — set up, build and start the Our Home web app, and wait until it
# responds.
#
# First run: creates the repo-root settings.yml and .env from their templates
# and walks through every setting (what it's for, where to get it, links for
# the outside accounts). Later runs ask once whether to change settings; "no"
# deploys straight away.
#
# This compose file runs the web app only. MongoDB (a replica set) runs on its
# own, reached via DATABASE_URL in .env. Reminders run inside the web app.
#
# The image is built from GitHub (settings.yml docker.repo / docker.branch, or
# -b), so a deploy runs exactly the pushed code; BuildKit checks the branch for
# new commits on every build. -l builds from this checkout instead.
#
# Settings live in the repo-root settings.yml and secrets in the repo-root .env
# (both shared with local dev). Only the walkthrough writes them. Compose passes
# .env to the container; the app reads settings.yml inside it; this script reads
# its `docker:` section (with a pinned yq container, so nothing needs
# installing) into .compose.env, which compose uses for names, ports and source.
#
# Usage:  ./deploy.sh [-n] [-l] [-b BRANCH] [-s|-y] [--no-build] [--timeout S]
#
# On a fresh database, open the printed address: the setup page creates the
# admin and the household's accounts.
#
# The PowerShell twin is deploy.ps1.

set -uo pipefail

# ---------------------------------------------------------------------------
# Run from this script's directory (= docker/) so all compose paths resolve.
# ---------------------------------------------------------------------------
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$SCRIPT_DIR"
REPO_ROOT=$(cd .. && pwd)
SETTINGS=../settings.yml   # the repo-root settings, shared with local dev
SECRETS=../.env            # the repo-root secrets; compose passes them to the app
ENV_FILE=.compose.env      # generated from SETTINGS on every run; don't edit
YQ_IMAGE=mikefarah/yq:4.44.3
# settings.yml `docker:` section -> DOCKER_* for compose, plus the public URL.
# The services: and android: sections and the app id ride along (SERVICES_*,
# ANDROID_*, APP_ID); compose ignores them.
YQ_EXPR='(.docker // {} | to_entries | .[] | "DOCKER_" + (.key | upcase) + "=" + ((.value // "") | tostring)), (.services // {} | to_entries | .[] | "SERVICES_" + (.key | upcase) + "=" + ((.value // "") | tostring)), (.android // {} | to_entries | .[] | "ANDROID_" + (.key | upcase) + "=" + ((.value // "") | tostring)), ("APP_ID=" + ((.firebase.android_app_id // "") | tostring)), ("PUBLIC_URL=" + ((.better_auth.url // "") | tostring))'
DEFAULT_REPO=https://github.com/EOSOClub/OurHome.git
# MongoDB, Paperless-ngx and the Proton Bridge, when this script runs them.
SERVICES_REPO=https://github.com/EOSOClub/OurHomeServices.git
# The Android app, when this script builds it.
APP_REPO_DEFAULT=https://github.com/EOSOClub/OurHomeApp.git
# Gitignored: the app's signing key (+ its password), Firebase file, built APK.
ANDROID_DIR="$REPO_ROOT/android"

# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------
NO_BUILD=0
NO_CACHE=0
LOCAL=0
BRANCH=        # empty = settings.yml docker.branch, else main
SETUP=ask      # ask | yes (-s) | no (-y)
TIMEOUT=180

usage() {
  cat <<EOF
${BOLD}Our Home — Docker deploy (web app)${RESET}

Sets up settings on the first run, builds the web app from GitHub, starts it,
then waits until it responds.

${BOLD}Usage:${RESET}
  ./deploy.sh [options]

${BOLD}Options:${RESET}
  -n, --no-cache       Rebuild every layer and re-pull the base image.
  -l, --local          Build from this checkout instead of GitHub.
  -b, --branch NAME    Git branch to build (default: docker.branch, else main).
  -s, --setup          Go straight to the settings walkthrough.
  -y, --yes            Don't ask about settings; just deploy (for scripts).
      --no-build       Skip rebuilding the image; just (re)start the app.
      --timeout SECONDS
                       How long to wait for health checks (default: ${TIMEOUT}).
  -h, --help           Show this help and exit.

${BOLD}Environment:${RESET}
  NO_COLOR             Set to disable coloured output.

The first run creates settings.yml and .env (repo root) from their templates.
EOF
}

# ---------------------------------------------------------------------------
# Colours — disabled when NO_COLOR is set or stdout is not a TTY.
# ---------------------------------------------------------------------------
if [ -z "${NO_COLOR:-}" ] && [ -t 1 ]; then
  RESET=$'\033[0m'; BOLD=$'\033[1m'; DIM=$'\033[2m'
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
  BLUE=$'\033[34m'; MAGENTA=$'\033[35m'; CYAN=$'\033[36m'
  IS_TTY=1
else
  RESET= BOLD= DIM= RED= GREEN= YELLOW= BLUE= MAGENTA= CYAN=
  IS_TTY=0
fi
# Questions need a keyboard; without one (cron, CI) settings are never asked.
if [ -t 0 ]; then CAN_ASK=1; else CAN_ASK=0; fi

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
ok()    { printf '  %s✓%s %s\n'  "$GREEN"  "$RESET" "$*"; }
warn()  { printf '  %s!%s %s\n'  "$YELLOW" "$RESET" "$*"; }
info()  { printf '  %s·%s %s\n'  "$CYAN"   "$RESET" "$*"; }
errln() { printf '  %s✗%s %s\n'  "$RED"    "$RESET" "$*" >&2; }

DC_STR="docker compose"   # for hint messages; resolved for real below

fail() {
  errln "$*"
  printf '\n%sDeploy aborted.%s  Inspect logs with: %s%s logs -f%s\n' \
    "$RED$BOLD" "$RESET" "$BOLD" "$DC_STR" "$RESET" >&2
  exit 1
}

# Numbered without a total: which steps run (service stacks, Paperless setup,
# the Android app) is only known once the settings are read.
STEP_N=0
step() {
  STEP_N=$((STEP_N + 1))
  printf '\n%s[%d]%s %s%s%s\n' "$DIM" "$STEP_N" "$RESET" "$BOLD" "$*" "$RESET"
}

banner() {
  printf '%s' "$MAGENTA$BOLD"
  cat <<'EOF'
  ╔══════════════════════════════════════════════════╗
  ║            O U R   H O M E   ·   deploy           ║
  ╚══════════════════════════════════════════════════╝
EOF
  printf '%s' "$RESET"
  printf '  %sweb app%s\n' "$DIM" "$RESET"
}

# ---------------------------------------------------------------------------
# Spinner / wait helpers
# ---------------------------------------------------------------------------
SPIN_FRAMES='-\|/'
SPIN_I=0
spin_tick() {  # $1 label  $2 elapsed
  [ "$IS_TTY" = 1 ] || return 0
  local f=${SPIN_FRAMES:SPIN_I:1}
  SPIN_I=$(((SPIN_I + 1) % ${#SPIN_FRAMES}))
  printf '\r  %s%s%s waiting for %s… %ss ' "$CYAN" "$f" "$RESET" "$1" "$2"
}
spin_clear() { [ "$IS_TTY" = 1 ] && printf '\r%*s\r' 64 ''; return 0; }

# wait_until <label> <timeout> <check_fn>
wait_until() {
  local label=$1 timeout=$2 check=$3 start=$SECONDS elapsed
  [ "$IS_TTY" = 1 ] || info "waiting for $label…"
  while true; do
    if "$check"; then spin_clear; ok "$label"; return 0; fi
    elapsed=$((SECONDS - start))
    if [ "$elapsed" -ge "$timeout" ]; then
      spin_clear; errln "$label (timed out after ${timeout}s)"; return 1
    fi
    spin_tick "$label" "$elapsed"
    sleep 0.5
  done
}

# ---------------------------------------------------------------------------
# .compose.env / .env reader (handles CRLF, surrounding quotes)
# ---------------------------------------------------------------------------
env_get() {  # $1 key  [$2 file]
  local key=$1 file=${2:-$ENV_FILE} line val
  [ -f "$file" ] || return 1
  line=$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n1) || return 1
  [ -n "$line" ] || return 1
  val=${line#*=}
  val=${val%$'\r'}
  val="${val#"${val%%[![:space:]]*}"}"   # ltrim
  val="${val%"${val##*[![:space:]]}"}"   # rtrim
  val=${val#\"}; val=${val%\"}
  val=${val#\'}; val=${val%\'}
  printf '%s' "$val"
}

# Replace KEY=… in an env file, or append it. awk takes the value from the
# environment, so no character in a secret needs escaping.
env_put_file() {  # $1 file  $2 key  $3 value
  local tmp
  tmp=$(mktemp) || return 1
  if grep -qE "^[[:space:]]*$2=" "$1"; then
    K="$2" V="$3" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"] }
      $0 ~ "^[[:space:]]*" k "=" { print k "=" v; next } { print }' "$1" > "$tmp"
  else
    cat "$1" > "$tmp"
    [ ! -s "$1" ] || [ -z "$(tail -c1 "$1")" ] || printf '\n' >> "$tmp"
    printf '%s=%s\n' "$2" "$3" >> "$tmp"
  fi
  # cat > keeps the file's owner and mode (.env can stay 600).
  cat "$tmp" > "$1"; rm -f "$tmp"
}
env_put() { env_put_file "$SECRETS" "$1" "$2"; }   # the web app's .env

# ---------------------------------------------------------------------------
# Settings walkthrough
# ---------------------------------------------------------------------------
# The settings.yml keys it asks about (lists are entered comma-separated), and
# the .env secrets. Values are held in S_<key> / E_<NAME> until the end, so
# quitting part way (Ctrl+C) changes nothing.
SETTING_KEYS="app.name better_auth.url better_auth.trusted_origins smtp.host smtp.port smtp.user smtp.from contact.forward_to bug_report.email turnstile.site_key paperless.url paperless.public_url firebase.android_app_id docker.project docker.container docker.network docker.port docker.bind docker.repo docker.branch services.path services.mongo services.paperless services.mail services.mail_folder android.build android.repo android.branch"
LIST_KEYS=" better_auth.trusted_origins "
# Written as YAML values (numbers, true/false), not quoted strings.
NUMBER_KEYS=" smtp.port docker.port android.build "
SECRET_KEYS="DATABASE_URL BETTER_AUTH_SECRET CRON_SECRET SMTP_PASS TURNSTILE_SECRET_KEY FIREBASE_SERVICE_ACCOUNT PAPERLESS_TOKEN"
ENV_CHANGED=""
APP_NOTE=""
# Paperless setup chosen in the walkthrough; runs after the app is up. The
# admin login lives only in these variables for this run.
PL_SETUP=0
PL_ADMIN_USER=""
PL_ADMIN_PASS=""
PL_BILLERS=""

sget() { local n="S_${1//./_}"; printf '%s' "${!n-}"; }
sput() { printf -v "S_${1//./_}" '%s' "$2"; }
eget() { local n="E_$1"; printf '%s' "${!n-}"; }
eput() { printf -v "E_$1" '%s' "$2"; ENV_CHANGED="$ENV_CHANGED $1"; }

load_settings() {
  local expr="" sep="" k out line
  for k in $SETTING_KEYS; do
    case "$LIST_KEYS" in
      *" $k "*) expr+="$sep(\"$k=\" + ((.$k // []) | join(\",\")))" ;;
      *)        expr+="$sep(\"$k=\" + ((.$k // \"\") | tostring))" ;;
    esac
    sep=", "
  done
  out=$(docker run --rm -i "$YQ_IMAGE" "$expr" < "$SETTINGS") || return 1
  while IFS= read -r line; do
    [ -n "$line" ] && sput "${line%%=*}" "${line#*=}"
  done <<< "$out"
  # Defaults for keys an older settings.yml doesn't have yet.
  [ -n "$(sget app.name)" ]         || sput app.name "Our Home"
  [ -n "$(sget smtp.port)" ]        || sput smtp.port 587
  [ -n "$(sget docker.project)" ]   || sput docker.project ourhome
  [ -n "$(sget docker.container)" ] || sput docker.container ourhome_web
  [ -n "$(sget docker.network)" ]   || sput docker.network ourhome_net
  [ -n "$(sget docker.port)" ]      || sput docker.port 3000
  [ -n "$(sget docker.bind)" ]      || sput docker.bind 0.0.0.0
  [ -n "$(sget docker.repo)" ]      || sput docker.repo "$DEFAULT_REPO"
  [ -n "$(sget docker.branch)" ]    || sput docker.branch main
  [ -n "$(sget services.path)" ]    || sput services.path ../OurHomeServices
  [ -n "$(sget services.paperless)" ] || sput services.paperless off
  [ -n "$(sget services.mail)" ]    || sput services.mail off
  [ -n "$(sget android.build)" ]    || sput android.build false
  [ -n "$(sget android.repo)" ]     || sput android.repo "$APP_REPO_DEFAULT"
  [ -n "$(sget android.branch)" ]   || sput android.branch main
  # What was there (or defaulted), so saving only rewrites the keys that changed.
  for k in $SETTING_KEYS; do printf -v "O_${k//./_}" '%s' "$(sget "$k")"; done
  for k in $SECRET_KEYS; do
    line=$(env_get "$k" "$SECRETS" || true)
    case "$line" in *replace-with*|*change-me*) line= ;; esac   # template placeholder
    printf -v "E_$k" '%s' "$line"
  done
}

# Writes only the keys that changed (returns 2 when there were none), so an
# unchanged walkthrough leaves the file exactly as it was.
save_settings() {
  local expr="" sep="" k n o v tmp args=()
  for k in $SETTING_KEYS; do
    n="W_${k//./_}"; o="O_${k//./_}"; v=$(sget "$k")
    [ "$v" = "${!o-}" ] && continue
    export "$n=$v"; args+=(-e "$n")
    case "$LIST_KEYS" in
      *" $k "*) expr+="$sep.$k = (strenv($n) | split(\",\") | map(select(. != \"\")))" ;;
      *)
        case "$NUMBER_KEYS" in
          *" $k "*) expr+="$sep.$k = env($n)" ;;   # validated digits; kept unquoted
          *)        expr+="$sep.$k = strenv($n)" ;;
        esac ;;
    esac
    sep=" | "
  done
  [ -n "$expr" ] || return 2
  tmp=$(mktemp) || return 1
  # yq keeps comments but drops blank lines, so they ride through as a marker
  # comment; the last sed also turns `key: ""` back into a bare `key:`.
  if sed 's/^[[:space:]]*$/#__blank__/' "$SETTINGS" \
      | docker run --rm -i "${args[@]}" "$YQ_IMAGE" "$expr" \
      | sed -E -e 's/^[[:space:]]*#__blank__[[:space:]]*$//' \
               -e 's/^([[:space:]]*[A-Za-z0-9_]+): ""([[:space:]]*(#.*)?)$/\1:\2/' > "$tmp" \
      && [ -s "$tmp" ]; then
    cat "$tmp" > "$SETTINGS"; rm -f "$tmp"
  else
    rm -f "$tmp"; return 1
  fi
}

save_env() {
  local k done_keys=" "
  for k in $ENV_CHANGED; do
    case "$done_keys" in *" $k "*) continue ;; esac
    env_put "$k" "$(eget "$k")" || return 1
    done_keys="$done_keys$k "
  done
}

rand_hex() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }

section() { printf '\n  %s%s── %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"; }
say()     { local l; for l in "$@"; do printf '    %s\n' "$l"; done; }
example() { printf '    %se.g.%s %s\n' "$DIM" "$RESET" "$*"; }
hint()    { printf '    %s%s%s\n' "$DIM" "$*" "$RESET"; }
link()    { printf '    %s→%s %s%s%s\n' "$CYAN" "$RESET" "$BOLD" "$1" "$RESET"; }

# Input ended (Ctrl+D) mid-walkthrough: stop rather than loop on a required
# question. Nothing has been written yet.
no_input() { printf '\n'; fail "Input ended; no settings were changed."; }

# ask VAR "Question" [default] — Enter keeps the default, "-" clears it.
ask() {
  local __a
  if [ -n "${3:-}" ]; then
    printf '    %s %s[%s]%s: ' "$2" "$DIM" "$3" "$RESET"
  else
    printf '    %s: ' "$2"
  fi
  IFS= read -r __a || no_input
  __a="${__a#"${__a%%[![:space:]]*}"}"; __a="${__a%"${__a##*[![:space:]]}"}"
  if [ "$__a" = "-" ]; then __a=; elif [ -z "$__a" ]; then __a=${3:-}; fi
  printf -v "$1" '%s' "$__a"
}

# ask_yn "Question" y|n — returns 0 for yes.
ask_yn() {
  local a prompt='y/N'
  [ "$2" = y ] && prompt='Y/n'
  while true; do
    printf '    %s %s[%s]%s: ' "$1" "$DIM" "$prompt" "$RESET"
    IFS= read -r a || no_input
    case "${a:-$2}" in
      [Yy]|[Yy][Ee][Ss]) return 0 ;;
      [Nn]|[Nn][Oo])     return 1 ;;
    esac
  done
}

# ask_hidden VAR "Question" — hidden typing, nothing kept or shown back (for a
# one-time admin password).
ask_hidden() {
  local __a
  printf '    %s %s(hidden)%s: ' "$2" "$DIM" "$RESET"
  IFS= read -rs __a || no_input
  printf '\n'
  printf -v "$1" '%s' "$__a"
}

# How a secret is shown back: a database URL with its password hidden,
# anything else as its length and last four characters.
masked() {  # $1 name  $2 value
  [ -n "$2" ] || { printf 'not set'; return; }
  if [ "$1" = DATABASE_URL ]; then
    printf '%s' "$2" | sed -E 's#(://[^:/@]*:)[^@]*@#\1•••@#'
  else
    printf 'set, %d characters, ends …%s' "${#2}" "${2: -4}"
  fi
}

# ask_secret VAR NAME "Question" — hidden typing/pasting; Enter keeps the
# current value, "-" clears it.
ask_secret() {
  local __a cur
  cur=$(eget "$2")
  [ -n "$cur" ] && hint "Now: $(masked "$2" "$cur"). Enter keeps it, - clears it."
  printf '    %s %s(hidden)%s: ' "$3" "$DIM" "$RESET"
  IFS= read -rs __a || no_input
  printf '\n'
  __a="${__a#"${__a%%[![:space:]]*}"}"; __a="${__a%"${__a##*[![:space:]]}"}"
  if [ "$__a" = "-" ]; then __a=; elif [ -z "$__a" ]; then __a=$cur; fi
  if [ -n "$__a" ] && [ "$__a" != "$cur" ]; then hint "Got it: $(masked "$2" "$__a")"; fi
  printf -v "$1" '%s' "$__a"
}

# ready "What to have ready" — returns 1 if the user types skip.
ready() {
  local a
  printf '    %s%s%s %s(Enter when ready, or type skip)%s: ' "$BOLD" "$1" "$RESET" "$DIM" "$RESET"
  IFS= read -r a || no_input
  case "$a" in [Ss][Kk][Ii][Pp]) return 1 ;; esac
  return 0
}

# Newest Firebase key file in the usual download spots, to offer as default.
find_firebase_key() {
  local f best= dir
  for dir in "$HOME/Downloads" "$REPO_ROOT" "$SCRIPT_DIR"; do
    for f in "$dir"/*firebase-adminsdk*.json; do
      [ -f "$f" ] || continue
      if [ -z "$best" ] || [ "$f" -nt "$best" ]; then best=$f; fi
    done
  done
  printf '%s' "$best"
}

# ask_menu VAR "Question" DEFAULT "option 1" "option 2" … — VAR gets the number.
ask_menu() {
  local __var=$1 __q=$2 __def=$3 __a __i=1
  shift 3
  printf '    %s\n' "$__q"
  for __a in "$@"; do printf '      %s%d)%s %s\n' "$BOLD" "$__i" "$RESET" "$__a"; __i=$((__i + 1)); done
  while true; do
    printf '    %sChoice%s %s[%s]%s: ' "" "" "$DIM" "$__def" "$RESET"
    IFS= read -r __a || no_input
    __a=${__a:-$__def}
    case "$__a" in *[!0-9]*|'') ;; *) if [ "$__a" -ge 1 ] && [ "$__a" -le $# ]; then printf -v "$__var" '%s' "$__a"; return 0; fi ;; esac
  done
}

# This machine's address on the home network, or nothing if unknown (Linux,
# macOS, then Windows' ipconfig under Git Bash).
lan_ip() {
  local ip=
  case "$(uname -s 2>/dev/null)" in
    Darwin)               ip=$(ipconfig getifaddr en0 2>/dev/null || true) ;;
    # The IPv4 of the first adapter with a real IPv4 default gateway: virtual
    # adapters have none, and VPNs (e.g. Proton VPN) show 0.0.0.0.
    MINGW*|MSYS*|CYGWIN*) ip=$(ipconfig.exe 2>/dev/null | tr -d '\r' | awk '
        /^[^ \t]/ { ip = ""; gw = 0 }
        /IPv4/ { v = $0; sub(/.*: */, "", v); sub(/\(.*/, "", v); ip = v }
        /Default Gateway/ { gw = 1 }
        gw && /[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+[ \t]*$/ && !/ 0\.0\.0\.0[ \t]*$/ && ip != "" { print ip; exit }') ;;
    *)                    ip=$(hostname -I 2>/dev/null | awk '{print $1}') ;;
  esac
  printf '%s' "$ip"
}

# The host's time zone as an IANA name (Paperless dates), UTC if unknown.
guess_tz() {
  local tz=
  [ -r /etc/timezone ] && tz=$(head -n1 /etc/timezone)
  [ -n "$tz" ] || tz=$(readlink /etc/localtime 2>/dev/null | sed -n 's#.*/zoneinfo/##p')
  printf '%s' "${tz:-UTC}"
}

# ---------------------------------------------------------------------------
# Service stacks (OurHomeServices): MongoDB, Paperless-ngx, Proton Bridge
# ---------------------------------------------------------------------------
# Each stack is its own compose project in its own folder, with its own .env
# (secrets generated here, never typed), all on the docker.network network so
# they reach each other by name: mongo, paperless, protonmail-bridge.

# services.path, absolute (relative paths are from the repo root).
svc_dir() {
  local p=${1:-$(sget services.path)}
  p=${p:-../OurHomeServices}
  case "$p" in /*|[A-Za-z]:*) printf '%s' "$p" ;; *) printf '%s' "$(cd "$REPO_ROOT" && mkdir -p "$(dirname "$p")" && cd "$(dirname "$p")" && pwd)/$(basename "$p")" ;; esac
}

# Clone the stacks, or update an existing clone (fast-forward only).
svc_fetch() {  # $1 folder
  if [ -f "$1/mongo/docker-compose.yml" ]; then
    if [ -d "$1/.git" ] && command -v git >/dev/null 2>&1; then
      if git -C "$1" pull -q --ff-only 2>/dev/null; then ok "Service stacks up to date ($1)"; else warn "Couldn't update $1; using it as it is."; fi
    else
      ok "Service stacks present ($1)"
    fi
  else
    command -v git >/dev/null 2>&1 || fail "git is needed to fetch the service stacks (or clone $SERVICES_REPO into $1 yourself)."
    info "fetching the service stacks into $1…"
    git clone -q "$SERVICES_REPO" "$1" || fail "Could not clone $SERVICES_REPO into $1."
    ok "Service stacks fetched ($1)"
  fi
}

# A stack's .env, from its template, readable only by you.
svc_env_init() {  # $1 stack folder
  [ -f "$1/.env" ] && return 0
  if [ -f "$1/.env.example" ]; then (umask 077 && cp "$1/.env.example" "$1/.env"); else (umask 077 && : > "$1/.env"); fi
}

# A stack secret: kept if set, else a new random one. Prints it.
svc_secret() {  # $1 stack folder  $2 key
  local v
  v=$(env_get "$2" "$1/.env" || true)
  case "$v" in ''|*replace-with*|*change-me*) v=$(rand_hex); env_put_file "$1/.env" "$2" "$v" ;; esac
  printf '%s' "$v"
}

# Fetches the stacks and writes the .env files of the ones this install runs:
# missing secrets are generated, existing ones kept. Called at the
# walkthrough's Save (WIZARD_SAVING=1: DATABASE_URL goes with the other
# answers) and again by every deploy, so hand-edited settings work too.
svc_prepare() {
  local d net user pass url
  d=$(svc_dir); net=$(sget docker.network); net=${net:-ourhome_net}
  svc_fetch "$d"
  if [ "$(sget services.mongo)" = managed ]; then
    svc_env_init "$d/mongo"
    svc_secret "$d/mongo" MONGO_ROOT_PASSWORD >/dev/null
    pass=$(svc_secret "$d/mongo" MONGO_APP_PASSWORD)
    env_put_file "$d/mongo/.env" DOCKER_NETWORK "$net"
    # Internal auth between replica-set members; base64 text, 6-1024 chars.
    [ -s "$d/mongo/keyfile" ] || (umask 077 && head -c 756 /dev/urandom | base64 | tr -d '\n' > "$d/mongo/keyfile")
    user=$(env_get MONGO_APP_USERNAME "$d/mongo/.env" || true)
    url="mongodb://${user:-household}:$pass@mongo:27017/household?replicaSet=rs0&authSource=admin"
    if [ "${WIZARD_SAVING:-0}" = 1 ]; then
      eput DATABASE_URL "$url"
    elif [ "$(env_get DATABASE_URL "$SECRETS" || true)" != "$url" ]; then
      env_put DATABASE_URL "$url"; ok "DATABASE_URL now points at the MongoDB run here"
    fi
    ok "MongoDB prepared ($d/mongo/.env)"
  fi
  if [ "$(sget services.paperless)" = managed ]; then
    svc_env_init "$d/paperless"
    svc_secret "$d/paperless" PAPERLESS_SECRET_KEY >/dev/null
    svc_secret "$d/paperless" PAPERLESS_DBPASS >/dev/null
    svc_secret "$d/paperless" PAPERLESS_ADMIN_PASSWORD >/dev/null
    # Answers from this run's walkthrough; otherwise the .env keeps its own.
    [ -n "${PL_BROWSER_URL:-}" ] && env_put_file "$d/paperless/.env" PAPERLESS_URL "$PL_BROWSER_URL"
    [ -n "${PL_PORT:-}" ]        && env_put_file "$d/paperless/.env" PAPERLESS_PORT "$PL_PORT"
    [ -n "${PL_BIND:-}" ]        && env_put_file "$d/paperless/.env" PAPERLESS_BIND "$PL_BIND"
    [ -n "${PL_TZ:-}" ]          && env_put_file "$d/paperless/.env" TZ "$PL_TZ"
    env_put_file "$d/paperless/.env" DOCKER_NETWORK "$net"
    ok "Paperless prepared ($d/paperless/.env)"
  fi
  if [ "$(sget services.mail)" = bridge ]; then
    svc_env_init "$d/proton-bridge"
    env_put_file "$d/proton-bridge/.env" DOCKER_NETWORK "$net"
    ok "Proton Bridge prepared"
  fi
}

svc_compose() {  # $1 stack folder, then compose arguments
  local d=$1; shift
  (cd "$d" && docker compose "$@")
}

container_state() { docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$1" 2>/dev/null; }
check_mongo_init() { case "$(container_state ourhome_mongo_init)" in "exited 0") return 0 ;; esac; return 1; }
check_paperless() {
  if command -v curl >/dev/null 2>&1; then
    curl -s -o /dev/null -m 5 "http://127.0.0.1:${PL_HOST_PORT}/api/" >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$PL_HOST_PORT") 2>/dev/null && { exec 3>&- 3<&-; return 0; }
    return 1
  fi
}

mongo_up() {  # $1 services folder
  svc_compose "$1/mongo" up -d || fail "Could not start MongoDB ($1/mongo)."
  wait_until "MongoDB replica set and app user" "$TIMEOUT" check_mongo_init || {
    case "$(container_state ourhome_mongo_init)" in
      exited*) fail "MongoDB setup failed; see: (cd $1/mongo && docker compose logs mongo-init)" ;;
      *)       fail "MongoDB didn't get ready in time; see: (cd $1/mongo && docker compose logs)" ;;
    esac
  }
}

paperless_up() {  # $1 services folder
  PL_HOST_PORT=$(env_get PAPERLESS_PORT "$1/paperless/.env" || true); PL_HOST_PORT=${PL_HOST_PORT:-8200}
  svc_compose "$1/paperless" up -d || fail "Could not start Paperless ($1/paperless)."
  # The first start sets up its database, which takes a minute or two.
  wait_until "Paperless (HTTP :$PL_HOST_PORT)" $((TIMEOUT > 300 ? TIMEOUT : 300)) check_paperless \
    || fail "Paperless didn't start responding; see: (cd $1/paperless && docker compose logs webserver)"
}

# Logged in = the Bridge has saved state beyond the placeholder file.
bridge_logged_in() {
  [ -n "$(find "$1/proton-bridge/state" -mindepth 1 ! -name .gitkeep -print -quit 2>/dev/null)" ]
}

# The Bridge's own IMAP login, read from its `info` command. Uses the Bridge
# binary directly rather than `init` (which would re-create its keychain).
bridge_info() {  # $1 services folder → sets MAIL_USER / MAIL_PASS when found
  local out
  out=$(printf 'info\nexit\n' | svc_compose "$1/proton-bridge" run --rm -T --entrypoint /protonmail/proton-bridge protonmail-bridge --cli 2>&1 | tr -d '\r' | sed 's/\x1b\[[0-9;]*m//g')
  MAIL_USER=$(printf '%s\n' "$out" | sed -n 's/^[[:space:]]*Username:[[:space:]]*//p' | head -n1)
  MAIL_PASS=$(printf '%s\n' "$out" | sed -n 's/^[[:space:]]*Password:[[:space:]]*//p' | head -n1)
  [ -n "$MAIL_USER" ] && [ -n "$MAIL_PASS" ]
}

bridge_up() {  # $1 services folder
  local d="$1/proton-bridge"
  svc_compose "$d" build -q || fail "Could not build the Proton Bridge image ($d)."
  if ! bridge_logged_in "$1"; then
    printf '\n'
    say "${BOLD}Proton login (once).${RESET} The Bridge starts its own prompt now. Type:" \
        "  ${BOLD}login${RESET}   then your Proton email, password and 2FA code" \
        "  ${BOLD}exit${RESET}    once it says the account was added" \
        "It syncs your mailbox afterwards, which can take a while for big inboxes."
    ready "Ready to log in?" || fail "Stopped before the Proton login; run ./deploy.sh again to continue."
    svc_compose "$d" run --rm protonmail-bridge init
    bridge_logged_in "$1" || fail "The Bridge has no saved login; run ./deploy.sh again to retry."
    ok "Proton login saved ($d/state)"
    MAIL_FROM_BRIDGE=1
  fi
  if [ "${MAIL_FROM_BRIDGE:-0}" = 1 ]; then
    # One Bridge at a time per login: pause a running one while reading.
    svc_compose "$d" stop >/dev/null 2>&1 || true
    if bridge_info "$1"; then
      ok "Bridge mail login read (user $MAIL_USER)"
    else
      warn "Couldn't read the Bridge's mail login by itself. It opens once more: type"
      warn "info, copy the IMAP Username and Password, then exit."
      svc_compose "$d" run --rm --entrypoint /protonmail/proton-bridge protonmail-bridge --cli
      hint "The Bridge's own password: about 22 letters and digits, not your Proton password."
      ask MAIL_USER "Bridge IMAP username"
      ask_hidden MAIL_PASS "Bridge IMAP password"
    fi
  fi
  svc_compose "$d" up -d || fail "Could not start the Proton Bridge."
  ok "Proton Bridge running (protonmail-bridge:143 on the Docker network)"
}

# ---------------------------------------------------------------------------
# Android app build (android/Dockerfile)
# ---------------------------------------------------------------------------

# A host path as Docker wants it (Windows form under Git Bash).
docker_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

sha256_of() {  # $1 file → hex digest
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# The signing key, made once: android/release.jks + keystore.env (its
# password). Android only installs an update over an APK signed with the same
# key, so losing these means everyone uninstalls and signs in again.
android_keystore() {
  local pw user_args=()
  if [ -s "$ANDROID_DIR/release.jks" ]; then
    [ -s "$ANDROID_DIR/keystore.env" ] || fail "android/release.jks has no keystore.env next to it; restore that file from your backup."
    return 0
  fi
  mkdir -p "$ANDROID_DIR"
  pw=$(rand_hex)
  (umask 077 && printf '# Password of release.jks. Back up both files together.\nKEYSTORE_PASSWORD=%s\n' "$pw" > "$ANDROID_DIR/keystore.env")
  # On Linux, write the key as you rather than as root.
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ;; *) user_args=(--user "$(id -u):$(id -g)") ;; esac
  KS_PW=$pw MSYS_NO_PATHCONV=1 docker run --rm "${user_args[@]}" -e KS_PW -v "$(docker_path "$ANDROID_DIR"):/k" eclipse-temurin:21-jdk \
    keytool -genkeypair -keystore /k/release.jks -storetype PKCS12 -alias ourhome -keyalg RSA -keysize 4096 \
    -validity 36500 -dname "CN=Our Home" -storepass:env KS_PW -keypass:env KS_PW >/dev/null 2>&1 \
    || { rm -f "$ANDROID_DIR/keystore.env"; fail "Could not create the app's signing key."; }
  chmod 600 "$ANDROID_DIR/release.jks" 2>/dev/null || true
  ok "Signing key created: android/release.jks + keystore.env (back both up)"
}

# The server address built into the app: the public address, else this
# machine on the home network, else none (the sign-in screen asks).
android_server_url() {
  if [ -n "$AUTH_URL" ]; then printf '%s' "$AUTH_URL"
  elif [ "$WEB_BIND" != 127.0.0.1 ] && [ -n "$LAN_IP" ]; then printf 'http://%s:%s' "$LAN_IP" "$WEB_PORT"
  fi
}

# Builds android/out/ourhome.apk (+ ourhome.json, what the site shows) when the
# app's code or its settings changed since the last build, or with -n.
android_build() {
  local repo branch sha appid url cfg tmp fp old pw vcode vname apk src out="$ANDROID_DIR/out"
  repo=$(env_get ANDROID_REPO || true); repo=${repo:-$APP_REPO_DEFAULT}
  branch=$(env_get ANDROID_BRANCH || true); branch=${branch:-main}
  if [ -d "$repo" ]; then
    # A local checkout (e.g. to try unpushed app changes): built as it is on
    # disk; its .dockerignore keeps build output and private files out.
    sha=$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo local)
    if [ -n "$(git -C "$repo" status --porcelain 2>/dev/null)" ]; then
      sha="$sha-dirty-$(git -C "$repo" diff HEAD 2>/dev/null | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-12)"
    fi
    src=$(docker_path "$repo")
  else
    case "$repo" in *.git) ;; *) repo="$repo.git" ;; esac
    sha=$(git ls-remote --heads "$repo" "refs/heads/$branch" 2>/dev/null | awk '{print $1}' | head -n1)
    [ -n "$sha" ] || { warn "Couldn't find branch '$branch' at ${repo%.git}; Android app not built."; return 1; }
    src="$repo#$sha"
  fi
  appid=$(env_get APP_ID || true); appid=${appid:-com.eosoclub.ourhome}
  url=$(android_server_url)

  cfg=$(mktemp -d)
  printf '# Generated by deploy.sh for the Android build.\nserver:\n  url: %s\napp:\n  id: %s\n' "$url" "$appid" > "$cfg/settings.yml"
  [ -f "$ANDROID_DIR/google-services.json" ] && cp "$ANDROID_DIR/google-services.json" "$cfg/"
  # Same code + same settings + same Firebase file = same APK; skip the build.
  fp=$(printf '%s|%s|%s|%s' "$sha" "$url" "$appid" "$([ -f "$cfg/google-services.json" ] && sha256_of "$cfg/google-services.json")" | { sha256sum 2>/dev/null || shasum -a 256; } | awk '{print $1}')
  old=$(sed -n 's/.*"fingerprint": *"\([^"]*\)".*/\1/p' "$out/ourhome.json" 2>/dev/null)
  if [ "$NO_CACHE" = 0 ] && [ "$fp" = "$old" ] && [ -s "$out/ourhome.apk" ]; then
    rm -rf "$cfg"; ok "Android app up to date (${sha:0:7}, $url)"; return 0
  fi

  android_keystore
  pw=$(env_get KEYSTORE_PASSWORD "$ANDROID_DIR/keystore.env")
  vcode=$(( $(date +%s) / 60 ))   # minutes since 1970: always rising, fits Android's int
  vname="$(date +%Y.%m.%d)-${sha:0:7}"
  tmp=$(mktemp -d)
  info "building the Android app ${vname} for ${url:-'(server asked at sign-in)'} as $appid…"
  info "(the first build downloads the Android tools and takes around 10 minutes)"
  if ! KS_PW=$pw MSYS_NO_PATHCONV=1 docker buildx build \
      -f "$(docker_path "$SCRIPT_DIR/android/Dockerfile")" \
      --build-context app="$src" \
      --build-context config="$(docker_path "$cfg")" \
      --secret id=keystore,src="$(docker_path "$ANDROID_DIR/release.jks")" \
      --secret id=keystore_password,env=KS_PW \
      --build-arg VERSION_CODE="$vcode" --build-arg VERSION_NAME="$vname" \
      $([ "$NO_CACHE" = 1 ] && echo --no-cache) \
      --target out --output "type=local,dest=$(docker_path "$tmp")" \
      "$(docker_path "$SCRIPT_DIR/android")"; then
    rm -rf "$cfg" "$tmp"; warn "Android app build failed (see above); the site works without it."; return 1
  fi
  apk="$tmp/ourhome.apk"
  [ -s "$apk" ] || { rm -rf "$cfg" "$tmp"; warn "The Android build produced no APK."; return 1; }
  mkdir -p "$out"
  cp "$apk" "$out/ourhome.apk.new" && mv -f "$out/ourhome.apk.new" "$out/ourhome.apk"
  cat > "$out/ourhome.json.new" <<EOF
{
  "versionName": "$vname",
  "versionCode": $vcode,
  "appId": "$appid",
  "server": "$url",
  "commit": "$sha",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "sizeBytes": $(wc -c < "$out/ourhome.apk" | tr -d ' '),
  "sha256": "$(sha256_of "$out/ourhome.apk")",
  "firebase": $([ -f "$cfg/google-services.json" ] && echo true || echo false),
  "fingerprint": "$fp"
}
EOF
  mv -f "$out/ourhome.json.new" "$out/ourhome.json"
  rm -rf "$cfg" "$tmp"
  ok "Android app $vname built ($(( $(wc -c < "$out/ourhome.apk") / 1048576 )) MB), on the site under Profile"
}

setup_firebase() {
  local name cur v file b64 json project found def=n
  say "The Android app checks the server about once an hour. With Firebase, the" \
      "server nudges phones the moment a request or bug report comes in, so" \
      "alerts arrive within seconds. Firebase Cloud Messaging is free (no cost," \
      "no message limit); you need a Google account. Only a \"something changed\"" \
      "signal goes through Google, never your household's data."
  [ -n "$(eget FIREBASE_SERVICE_ACCOUNT)" ] && def=y
  if ! ask_yn "Set up instant phone alerts?" "$def"; then
    if [ -n "$(eget FIREBASE_SERVICE_ACCOUNT)" ]; then
      eput FIREBASE_SERVICE_ACCOUNT ""; info "Instant alerts turned off (the hourly check stays)."
    fi
    return 0
  fi

  printf '\n'
  say "First, your app's id. Every Android app has one, like com.<name>.ourhome." \
      "Pick your own <name>: lowercase letters and digits, e.g. your family name." \
      "Firebase and the app you build must use the same id."
  cur=$(sget firebase.android_app_id); cur=${cur#com.}; cur=${cur%.ourhome}
  while true; do
    ask name "Your <name> in com.<name>.ourhome" "$cur"
    name=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')
    if printf '%s' "$name" | grep -qE '^[a-z][a-z0-9_]{1,29}$'; then break; fi
    warn "Required: 2-30 lowercase letters, digits or _, starting with a letter."
  done
  sput firebase.android_app_id "com.$name.ourhome"
  ok "App id: com.$name.ourhome"

  printf '\n'
  say "Now in Firebase (keep this window open):"
  say "${BOLD}1.${RESET} Create a project (any name; Google Analytics isn't needed, turn it off)."
  link "https://console.firebase.google.com"
  say "${BOLD}2.${RESET} In the project: Add app → Android. Package name:" \
      "     ${BOLD}com.$name.ourhome${RESET}   (exactly). Skip the SHA-1, then Register app."
  say "${BOLD}3.${RESET} Download google-services.json. That file is for the ${BOLD}app${RESET} build" \
      "   (it goes in the app repo, see the note at the end). Skip the remaining steps."
  say "${BOLD}4.${RESET} Project settings → Service accounts → Generate new private key →" \
      "   Generate key. That downloads the ${BOLD}server key${RESET}, a .json file:"
  link "https://console.firebase.google.com/project/_/settings/serviceaccounts/adminsdk"
  if ! ready "Have the server key file downloaded?"; then
    info "Skipped; run ./deploy.sh -s to finish later."
    return 0
  fi

  printf '\n'
  say "Where is it? Give the file's path (drag it into this window), or paste the" \
      "key as base64."
  example "file named like  my-home-1a2b3-firebase-adminsdk-fbsvc-0a1b2c3d4e.json"
  example "base64 starts with  ewogICJ0eXBlIjogInNlcnZpY2VfYWNjb3VudCIs"
  # A key file lying around is offered as the answer, unless a key is already
  # set: then Enter keeps that one.
  if [ -n "$(eget FIREBASE_SERVICE_ACCOUNT)" ]; then
    hint "Now: a key is set. Enter keeps it."; found=
  else
    found=$(find_firebase_key)
  fi
  while true; do
    ask v "Server key" "$found"
    v=${v#\"}; v=${v%\"}; v=${v#\'}; v=${v%\'}
    case "$v" in "~/"*) v="$HOME/${v#\~/}" ;; esac
    file=
    if [ -z "$v" ]; then
      if [ -n "$(eget FIREBASE_SERVICE_ACCOUNT)" ]; then ok "Kept the current key"; break; fi
      warn "Required (or Ctrl+C to stop; nothing is saved)."; continue
    elif [ -f "$v" ]; then
      file=$v; json=$(cat "$file"); b64=$(base64 < "$file" | tr -d '\r\n')
    else
      b64=$(printf '%s' "$v" | tr -d ' \r\n'); json=$(printf '%s' "$b64" | base64 --decode 2>/dev/null || true)
    fi
    if printf '%s' "$json" | grep -q '"project_info"'; then
      warn "That's google-services.json, the app's file. The server needs the key from step 4."
    elif printf '%s' "$json" | grep -qE '"type": *"service_account"' && printf '%s' "$json" | grep -q '"private_key"'; then
      project=$(printf '%s' "$json" | sed -n 's/.*"project_id": *"\([^"]*\)".*/\1/p' | head -n1)
      eput FIREBASE_SERVICE_ACCOUNT "$b64"
      ok "Server key for Firebase project '${project:-?}'"
      if [ -n "$file" ] && ask_yn "Delete the downloaded key file? It's saved in .env now, and anyone with it can send alerts to your phones." y; then
        rm -f -- "$file" && ok "Deleted $file"
      fi
      break
    else
      warn "That isn't a Firebase server key (it should contain \"type\": \"service_account\")."
    fi
  done

  APP_NOTE=$(cat <<EOF
  ${BOLD}For the app (OurHomeApp repo), so phones get the instant alerts:${RESET}
    1. In its settings.yml:   app:
                                id: com.$name.ourhome
    2. Put google-services.json (from step 3) in OurHomeApp/OurHomeApp/
    3. Rebuild and install. If the app was installed under another id,
       uninstall that one first (you sign in once more).
EOF
)
}

# Where the service stacks live; asked once, the first time one is run here.
SVC_PATH_ASKED=0
ask_services_path() {
  local p
  [ "$SVC_PATH_ASKED" = 1 ] && return 0
  SVC_PATH_ASKED=1
  hint "The service stacks go in a folder of their own, fetched from GitHub;"
  hint "a relative path is from this repo's root."
  ask p "Folder for the service stacks" "$(sget services.path)"
  sput services.path "${p:-../OurHomeServices}"
}

# Paperless you already run: its addresses, then setup with an admin login or
# a token you made yourself.
setup_own_paperless() {
  local v def
  hint "How the web container reaches Paperless. In Docker on the same network"
  hint "(step 10), its container name works."
  example "http://paperless:8000"
  while true; do
    ask v "Paperless address (server side)" "$(sget paperless.url)"
    case "$v" in http://*|https://*) break ;; esac
    warn "Required here; starts with http:// or https://"
  done
  sput paperless.url "${v%/}"
  hint "The address you open Paperless at in a browser, for \"Open in Paperless\" links."
  example "https://paperless.example.com"
  ask v "Paperless address (browser)" "$(sget paperless.public_url)"; sput paperless.public_url "${v%/}"
  say "Our Home can set Paperless up for you: the bill / bill-payment tags, the" \
      "Amount / Due date / Account / Invoice fields, a read-only user and its token," \
      "workflows that add those fields to tagged documents, two dashboard views," \
      "your billers and the bill mailbox. Existing ones are kept. It needs a" \
      "Paperless admin login once; that isn't saved anywhere."
  def=y; [ -n "$(eget PAPERLESS_TOKEN)" ] && def=n
  if ask_yn "Set up Paperless for you?" "$def"; then
    while true; do ask PL_ADMIN_USER "Paperless admin username" "${PL_ADMIN_USER:-}"; [ -n "$PL_ADMIN_USER" ] && break; warn "Required."; done
    while true; do ask_hidden PL_ADMIN_PASS "Its password"; [ -n "$PL_ADMIN_PASS" ] && break; warn "Required."; done
    PL_SETUP=1
    info "Runs once the app is up; the token goes into .env by itself."
  else
    PL_SETUP=0
    say "Then the API token of a read-only Paperless user: sign in to Paperless as" \
        "that user → user menu (top right) → My Profile → API Auth Token."
    hint "40 characters of 0-9 and a-f, e.g. 3f2a9c0d…"
    ask_secret v PAPERLESS_TOKEN "API token"
    if [ -n "$v" ] && ! printf '%s' "$v" | grep -qE '^[0-9a-f]{40}$'; then
      warn "That doesn't look like a Paperless token (40 hex characters); saved anyway."
    fi
    [ "$v" = "$(eget PAPERLESS_TOKEN)" ] || eput PAPERLESS_TOKEN "$v"
  fi
}

# Paperless run here from the OurHomeServices stack: port, who may open it,
# its exact address and time zone. Secrets are generated at Save.
setup_managed_paperless() {
  local d cur def
  say "Then it runs here too (with OCR, and email-to-PDF for HTML bills), on the" \
      "same Docker network. Its admin password is generated and kept in its .env."
  ask_services_path
  d=$(svc_dir)
  cur=$(env_get PAPERLESS_PORT "$d/paperless/.env" 2>/dev/null || true)
  hint "Port Paperless is served on (the web app uses ${BOLD}$(sget docker.port)${RESET}${DIM})."
  while true; do ask PL_PORT "Paperless port" "${cur:-8200}"; case "$PL_PORT" in ''|*[!0-9]*) warn "A number, e.g. 8200." ;; *) break ;; esac; done
  def=y; [ "$(env_get PAPERLESS_BIND "$d/paperless/.env" 2>/dev/null || true)" = 127.0.0.1 ] && def=n
  if ask_yn "Open Paperless to your home network? (so phones can scan bills into it)" "$def"; then PL_BIND=0.0.0.0; else PL_BIND=127.0.0.1; fi
  say "The address you'll open Paperless at. It must be exact: Paperless refuses" \
      "sign-in from any other address. A tunnel's https:// address works too."
  cur=$(sget paperless.public_url)
  if [ -z "$cur" ]; then
    cur=$(lan_ip)
    if [ "$PL_BIND" = 0.0.0.0 ] && [ -n "$cur" ]; then cur="http://$cur:$PL_PORT"; else cur="http://localhost:$PL_PORT"; fi
  fi
  example "https://paperless.example.com"
  while true; do
    ask PL_BROWSER_URL "Paperless address" "$cur"
    case "$PL_BROWSER_URL" in http://*|https://*) break ;; esac
    warn "Starts with http:// or https://"
  done
  PL_BROWSER_URL=${PL_BROWSER_URL%/}
  hint "Time zone for document dates, as a region name (America/Chicago, Europe/London)."
  cur=$(env_get TZ "$d/paperless/.env" 2>/dev/null || true)
  ask PL_TZ "Time zone" "${cur:-$(guess_tz)}"
  sput paperless.url http://paperless:8000
  sput paperless.public_url "$PL_BROWSER_URL"
  PL_SETUP=1   # the admin login comes from Paperless's .env at setup time
}

# Where bills arrive by email, for a Paperless mail account and its rules.
setup_mail() {
  local n def v
  say "Bills by email: Paperless can watch a mail folder and file every bill in it."
  case "$(sget services.mail)" in bridge) def=1 ;; imap) def=2 ;; *) def=3 ;; esac
  ask_menu n "Where do your bills arrive?" "$def" \
    "Proton Mail, through the Proton Bridge run here (needs a paid Proton plan)" \
    "Another mail provider, over IMAP (Gmail, Outlook, Fastmail, your own Bridge…)" \
    "Not by email (paper and uploads only)"
  case "$n" in
    1)
      sput services.mail bridge
      MAIL_HOST=protonmail-bridge; MAIL_PORT=143; MAIL_SECURITY=none; MAIL_FROM_BRIDGE=1
      ask_services_path
      say "The Proton login happens during the deploy, in the Bridge's own prompt." \
          "In Proton, make a folder named Bills and a filter that files bills into it" \
          "(by sender, or subject containing bill / statement / invoice):"
      link "https://account.proton.me/u/0/mail/filters"
      def=Folders/Bills
      ;;
    2)
      sput services.mail imap
      example "imap.gmail.com · outlook.office365.com · imap.fastmail.com · protonmail-bridge"
      while true; do ask MAIL_HOST "IMAP server" "${MAIL_HOST:-}"; [ -n "$MAIL_HOST" ] && break; warn "Required."; done
      ask_menu n "Connection security" 1 "SSL/TLS (port 993, most providers)" "STARTTLS (port 143)" "None (only inside Docker, e.g. a Proton Bridge)"
      case "$n" in 1) MAIL_SECURITY=ssl; v=993 ;; 2) MAIL_SECURITY=starttls; v=143 ;; *) MAIL_SECURITY=none; v=143 ;; esac
      while true; do ask MAIL_PORT "IMAP port" "$v"; case "$MAIL_PORT" in ''|*[!0-9]*) warn "A number." ;; *) break ;; esac; done
      while true; do ask MAIL_USER "Username (usually the email address)" "${MAIL_USER:-}"; [ -n "$MAIL_USER" ] && break; warn "Required."; done
      say "The password: most providers want an app password here, not your normal" \
          "one (Gmail: myaccount.google.com/apppasswords). Blank = keep the mail" \
          "account Paperless already has from an earlier setup."
      ask_hidden MAIL_PASS "IMAP password"
      say "Use a folder just for bills: make one named Bills (Gmail: a label) and a" \
          "filter that moves bill emails into it, by sender or by subject."
      def=Bills
      ;;
    *)
      sput services.mail off
      return 0
      ;;
  esac
  hint "The folder Paperless reads. Everything in it is filed as a bill, so not INBOX."
  while true; do
    v=$(sget services.mail_folder)
    ask v "Mail folder with your bills" "${v:-$def}"
    v=${v:-$def}
    case "$v" in [Ii][Nn][Bb][Oo][Xx]) warn "Every email in INBOX would become a bill; use a folder just for bills." ;; *) break ;; esac
  done
  sput services.mail_folder "$v"
}

# Newest google-services.json in the usual download spots.
find_google_services() {
  local f best= dir
  for dir in "$HOME/Downloads" "$REPO_ROOT" "$SCRIPT_DIR"; do
    for f in "$dir"/google-services*.json; do
      [ -f "$f" ] || continue
      if [ -z "$best" ] || [ "$f" -nt "$best" ]; then best=$f; fi
    done
  done
  printf '%s' "$best"
}

# Whether to build the Android app here, and its Firebase file.
ANDROID_GS_SRC=""
setup_android() {
  local def v appid
  say "Build the Android app here, with this server's address built in, signed with" \
      "this install's own key, and offered to signed-in members on the site (Profile" \
      "page). Each deploy rebuilds it when the app or these settings changed. The" \
      "first build downloads the Android tools (about 3 GB) and takes ~10 minutes."
  def=n; [ "$(sget android.build)" = true ] && def=y
  if ! ask_yn "Build the Android app here?" "$def"; then
    sput android.build false
    return 0
  fi
  sput android.build true
  appid=$(sget firebase.android_app_id)
  if [ -n "$appid" ] && [ -n "$(eget FIREBASE_SERVICE_ACCOUNT)" ]; then
    say "Built as ${BOLD}$appid${RESET}, with instant alerts. That needs the app's" \
        "google-services.json (Firebase step 3)."
    if [ -f "$ANDROID_DIR/google-services.json" ] && grep -q "\"package_name\": *\"$appid\"" "$ANDROID_DIR/google-services.json"; then
      ok "google-services.json for $appid is in place (android/)"
    else
      example "named google-services.json, from Firebase → Project settings → Your apps"
      while true; do
        ask v "Path to google-services.json (blank = build without instant alerts)" "$(find_google_services)"
        v=${v#\"}; v=${v%\"}; v=${v#\'}; v=${v%\'}
        case "$v" in "~/"*) v="$HOME/${v#\~/}" ;; esac
        [ -z "$v" ] && { warn "Building without instant alerts; run ./deploy.sh -s to add the file later."; break; }
        if [ ! -f "$v" ]; then warn "No file at $v"
        elif grep -q '"type": *"service_account"' "$v"; then warn "That's the server key; the app needs google-services.json."
        elif ! grep -q "\"package_name\": *\"$appid\"" "$v"; then warn "That file isn't for $appid (check the package name in Firebase)."
        else ANDROID_GS_SRC=$v; ok "google-services.json for $appid"; break
        fi
      done
    fi
    APP_NOTE=""   # the build takes care of what that note asked for
  else
    say "Built as com.eosoclub.ourhome, without instant alerts (set those up in" \
        "step 7 to get them)."
  fi
  hint "Where the app is built from: a GitHub repo (change only for your own fork),"
  hint "or the path of a local checkout to build it as it is on disk."
  ask v "App repo" "$(sget android.repo)"; sput android.repo "${v:-$APP_REPO_DEFAULT}"
  ask v "Branch" "$(sget android.branch)"; sput android.branch "${v:-main}"
}

setup_wizard() {
  local v def cur
  load_settings || fail "Could not read settings.yml — check it is valid YAML."
  printf '\n  %sSettings walkthrough.%s Enter keeps the value in [brackets], - clears it.\n' "$BOLD" "$RESET"
  printf '  Nothing is saved until the end; Ctrl+C leaves everything as it was.\n'

  section "1/10  Name"
  say "Shown in the browser tab, on the sign-in page and in emails."
  ask v "Site name" "$(sget app.name)"; sput app.name "${v:-Our Home}"

  section "2/10  Database (required)"
  say "Everything is stored in MongoDB, as a replica set (the app uses transactions)."
  cur=$(sget services.mongo); def=n
  if [ "$cur" = own ] || { [ -z "$cur" ] && [ -n "$(eget DATABASE_URL)" ]; }; then def=y; fi
  if ask_yn "Already have MongoDB running?" "$def"; then
    sput services.mongo own
    say "Give the address as the web container sees it: if MongoDB runs in Docker" \
        "on the same network (asked in step 10), its container name is the host."
    example "mongodb://household:<password>@mongo:27017/household?replicaSet=rs0&authSource=admin"
    hint "Starts with mongodb:// (or mongodb+srv:// for a hosted service)."
    while true; do
      ask_secret v DATABASE_URL "Database URL"
      case "$v" in mongodb://*|mongodb+srv://*) break ;; esac
      warn "Required, and it starts with mongodb:// or mongodb+srv://"
    done
    [ "$v" = "$(eget DATABASE_URL)" ] || eput DATABASE_URL "$v"
  else
    sput services.mongo managed
    say "Then it runs here too: a single-node replica set from the OurHomeServices" \
        "stacks, on the same Docker network, with generated passwords. Nothing to type."
    link "https://github.com/EOSOClub/OurHomeServices/tree/main/mongo"
    ask_services_path
  fi

  section "3/10  Sign-in keys"
  say "Two random keys: one signs everyone's sign-in sessions, the other lets you" \
      "trigger the reminder sweep by hand. They're made for you; nothing to type."
  if [ -z "$(eget BETTER_AUTH_SECRET)" ]; then
    eput BETTER_AUTH_SECRET "$(rand_hex)"; ok "Session key created"
  elif ask_yn "Session key is set. Make a new one? (signs everyone out)" n; then
    eput BETTER_AUTH_SECRET "$(rand_hex)"; ok "New session key created"
  fi
  if [ -z "$(eget CRON_SECRET)" ]; then
    eput CRON_SECRET "$(rand_hex)"; ok "Reminder-sweep key created"
  else
    ok "Reminder-sweep key is set"
  fi

  section "4/10  Web address"
  say "At home the site works at http://<this-server>:<port> with no setup. To use" \
      "it from anywhere, put a tunnel or reverse proxy in front for HTTPS" \
      "(Cloudflare Tunnel, Caddy, nginx…) and enter its address; links in emails" \
      "use it. Leave blank for home network only. Never forward the port on your router."
  example "https://home.example.com"
  while true; do
    ask v "Public address" "$(sget better_auth.url)"
    case "$v" in ''|https://*|http://*) break ;; esac
    warn "Starts with https:// (or leave blank)."
  done
  sput better_auth.url "${v%/}"
  say "Other addresses allowed to sign in, comma-separated. Usually blank: the" \
      "address above and any home-network address already work."
  ask v "Extra trusted addresses" "$(sget better_auth.trusted_origins)"
  sput better_auth.trusted_origins "$(printf '%s' "$v" | tr -d ' ')"

  section "5/10  Email (optional)"
  say "Password-reset links, contact-form messages and bug reports. Any SMTP" \
      "provider works (Proton Mail, Gmail, Fastmail, your ISP…). Without it," \
      "messages are logged instead of sent."
  def=n; [ -n "$(sget smtp.host)" ] && def=y
  if ask_yn "Send email?" "$def"; then
    example "smtp.protonmail.ch · smtp.gmail.com · smtp.fastmail.com"
    while true; do ask v "SMTP server" "$(sget smtp.host)"; [ -n "$v" ] && break; warn "Required for email."; done
    sput smtp.host "$v"
    hint "587 for STARTTLS (most providers), 465 for SSL."
    while true; do ask v "Port" "$(sget smtp.port)"; case "$v" in ''|*[!0-9]*) warn "A number, e.g. 587." ;; *) break ;; esac; done
    sput smtp.port "$v"
    hint "The mail server login, usually the full email address."
    ask v "Username" "$(sget smtp.user)"; sput smtp.user "$v"
    hint "Who emails come from: an address, optionally with a name."
    example "Our Home <home@example.com>"
    cur=$(sget smtp.from); ask v "From" "${cur:-$(sget smtp.user)}"; sput smtp.from "$v"
    say "The SMTP password. Many providers want an app password or SMTP token" \
        "here, not your normal password (Gmail: myaccount.google.com/apppasswords;" \
        "Proton: Settings → IMAP/SMTP → SMTP tokens)."
    ask_secret v SMTP_PASS "SMTP password"
    [ "$v" = "$(eget SMTP_PASS)" ] || eput SMTP_PASS "$v"
    hint "Where contact-form messages are forwarded. Blank = kept on the site only."
    ask v "Forward contact form to" "$(sget contact.forward_to)"; sput contact.forward_to "$v"
    hint "Where bug reports (site and app) are emailed. Blank = in-app notice only."
    ask v "Email bug reports to" "$(sget bug_report.email)"; sput bug_report.email "$v"
  else
    sput smtp.host ""
  fi

  section "6/10  Contact-form CAPTCHA (optional)"
  say "Stops bots spamming the public contact form, with Cloudflare Turnstile." \
      "Free; needs a Cloudflare account (your domain doesn't have to use Cloudflare)."
  def=n; [ -n "$(sget turnstile.site_key)" ] && def=y
  if ask_yn "Protect the contact form?" "$def"; then
    say "In Cloudflare: Turnstile → Add widget. Name it, add your site's hostname" \
        "(e.g. home.example.com), mode Managed, Create. It shows two keys."
    link "https://dash.cloudflare.com/?to=/:account/turnstile"
    if ready "Have the widget's keys on screen?"; then
      hint "Site Key: starts with 0x4AAAAAAA, about 24 characters (the shorter one)."
      while true; do
        ask v "Site Key" "$(sget turnstile.site_key)"
        case "$v" in 0x*) break ;; esac
        warn "Turnstile keys start with 0x4AAAAAAA."
      done
      sput turnstile.site_key "$v"
      hint "Secret Key: also starts with 0x4AAAAAAA, but longer (about 35 characters)."
      while true; do
        ask_secret v TURNSTILE_SECRET_KEY "Secret Key"
        case "$v" in 0x*) break ;; esac
        warn "Turnstile keys start with 0x4AAAAAAA."
      done
      [ "$v" = "$(eget TURNSTILE_SECRET_KEY)" ] || eput TURNSTILE_SECRET_KEY "$v"
    else
      info "Skipped; run ./deploy.sh -s to finish later."
    fi
  else
    sput turnstile.site_key ""
  fi

  section "7/10  Instant phone alerts (optional)"
  setup_firebase

  section "8/10  Android app (optional)"
  setup_android

  section "9/10  Paperless-ngx bill import (optional)"
  say "Documents tagged \"bill\" / \"bill-payment\" in Paperless-ngx become bills and" \
      "payments, checked every 15 minutes. Skip if you don't run Paperless-ngx."
  link "https://github.com/EOSOClub/OurHome/blob/main/docs/paperless-import.md"
  def=n; [ -n "$(sget paperless.url)" ] && def=y
  if ask_yn "Import bills from Paperless?" "$def"; then
    cur=$(sget services.paperless); def=n
    if [ "$cur" = own ] || { [ "$cur" != managed ] && [ -n "$(sget paperless.url)" ]; }; then def=y; fi
    if ask_yn "Already have Paperless-ngx running?" "$def"; then
      sput services.paperless own
      setup_own_paperless
    else
      sput services.paperless managed
      setup_managed_paperless
    fi
    if [ "$PL_SETUP" = 1 ]; then
      printf '\n'
      say "Who sends you bills? Their names set up two things: Paperless files each" \
          "biller's documents under it (a correspondent, which also helps Our Home" \
          "match a payment to its bill), and tags bills / payments by their text." \
          "Comma-separated; short names fit best (about 100 characters in all)."
      example "water, electric, comcast"
      ask PL_BILLERS "Billers" "${PL_BILLERS:-}"
      printf '\n'
      setup_mail
    fi
  else
    sput paperless.url ""; sput services.paperless off; sput services.mail off
  fi

  section "10/10  Docker"
  hint "Port the site is served on."
  while true; do ask v "Port" "$(sget docker.port)"; case "$v" in ''|*[!0-9]*) warn "A number, e.g. 3000." ;; *) break ;; esac; done
  sput docker.port "$v"
  say "Who can open it directly: every device on your home network, or only this" \
      "machine (when a tunnel/proxy here is the only way in; finish the site's" \
      "first-run setup page before choosing that)."
  def=y; [ "$(sget docker.bind)" = 127.0.0.1 ] && def=n
  if ask_yn "Open to your home network?" "$def"; then sput docker.bind 0.0.0.0; else sput docker.bind 127.0.0.1; fi
  hint "Docker network the app joins (created if missing). Put MongoDB on it to reach it by name."
  ask v "Network" "$(sget docker.network)"; sput docker.network "${v:-ourhome_net}"
  hint "Where the app is built from. Change only to run your own fork."
  ask v "GitHub repo" "$(sget docker.repo)"; sput docker.repo "${v:-$DEFAULT_REPO}"
  ask v "Branch" "$(sget docker.branch)"; sput docker.branch "${v:-main}"
  if ask_yn "Change the project/container names? (only for a second install)" n; then
    ask v "Compose project" "$(sget docker.project)"; sput docker.project "${v:-ourhome}"
    ask v "Container name" "$(sget docker.container)"; sput docker.container "${v:-ourhome_web}"
  fi

  section "Save"
  local db_row pl_row mail_row
  if [ "$(sget services.mongo)" = managed ]; then db_row="MongoDB, run here"; else db_row=$(masked DATABASE_URL "$(eget DATABASE_URL)"); fi
  case "$(sget services.paperless)" in
    managed) pl_row="run here, at $(sget paperless.public_url)" ;;
    own)     pl_row=$(sget paperless.url) ;;
    *)       pl_row=off ;;
  esac
  case "$(sget services.mail)" in
    bridge) mail_row="Proton Bridge, folder $(sget services.mail_folder)" ;;
    imap)   mail_row="$MAIL_HOST, folder $(sget services.mail_folder)" ;;
    *)      mail_row=off ;;
  esac
  printf '    %-18s %s\n' "Name:" "$(sget app.name)" \
    "Database:" "$db_row" \
    "Public address:" "$(v=$(sget better_auth.url); printf '%s' "${v:-home network only}")" \
    "Email:" "$(v=$(sget smtp.host); printf '%s' "${v:-off}")" \
    "CAPTCHA:" "$([ -n "$(sget turnstile.site_key)" ] && echo on || echo off)" \
    "Instant alerts:" "$([ -n "$(eget FIREBASE_SERVICE_ACCOUNT)" ] && echo "on ($(sget firebase.android_app_id))" || echo off)" \
    "Android app:" "$([ "$(sget android.build)" = true ] && echo "built here, $(sget android.repo) ($(sget android.branch))" || echo "not built here")" \
    "Paperless:" "$pl_row" \
    "Bill mail:" "$mail_row" \
    "Served on:" "$(sget docker.bind):$(sget docker.port)" \
    "Built from:" "$(sget docker.repo) ($(sget docker.branch))"
  if [ "$PL_SETUP" = 1 ]; then printf '    %-18s %s\n' "Paperless setup:" "after start, as ${PL_ADMIN_USER:-its admin}"; fi
  if ! ask_yn "Save these settings?" y; then
    warn "Nothing saved."
    PL_SETUP=0; PL_ADMIN_PASS=; MAIL_PASS=
    return 0
  fi
  # Service stacks first: their passwords are what DATABASE_URL points at.
  if [ "$(sget services.mongo)" = managed ] || [ "$(sget services.paperless)" = managed ] || [ "$(sget services.mail)" = bridge ]; then
    WIZARD_SAVING=1 svc_prepare
  fi
  if [ -n "$ANDROID_GS_SRC" ]; then
    mkdir -p "$ANDROID_DIR" && cp "$ANDROID_GS_SRC" "$ANDROID_DIR/google-services.json" \
      && ok "google-services.json copied to android/ (used by the app build)"
  fi
  save_settings
  case $? in
    0) ok "settings.yml saved" ;;
    2) ok "settings.yml unchanged" ;;
    *) fail "Could not write settings.yml (nothing was changed)." ;;
  esac
  if [ -n "$ENV_CHANGED" ]; then
    save_env || fail "Could not write .env."
    ok ".env saved"
  else
    ok ".env unchanged"
  fi
  [ -n "$APP_NOTE" ] && printf '\n%s\n' "$APP_NOTE"
  return 0
}

# ---------------------------------------------------------------------------
# Container checks (the name comes from settings.yml, read below)
# ---------------------------------------------------------------------------
C_WEB=ourhome_web

cstatus() { docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null; }
chealth() { docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' "$1" 2>/dev/null; }

check_web() {
  if [ "$HAVE_CURL" = 1 ]; then
    curl -sS -o /dev/null -m 5 "$WEB_URL_LOCAL" >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$WEB_PORT") 2>/dev/null && { exec 3>&- 3<&-; return 0; }
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    -n|--no-cache)  NO_CACHE=1 ;;
    -l|--local)     LOCAL=1 ;;
    -b|--branch)    shift; BRANCH=${1:-}
                    [ -n "$BRANCH" ] || { printf 'error: -b/--branch needs a branch name\n' >&2; exit 2; } ;;
    --branch=*)     BRANCH=${1#*=} ;;
    -s|--setup)     SETUP=yes ;;
    -y|--yes)       SETUP=no ;;
    --no-build)     NO_BUILD=1 ;;
    --timeout)      shift; TIMEOUT=${1:-} ;;
    --timeout=*)    TIMEOUT=${1#*=} ;;
    -h|--help)      usage; exit 0 ;;
    *)              printf 'Unknown option: %s\n\n' "$1" >&2; usage; exit 2 ;;
  esac
  shift
done
case "$TIMEOUT" in ''|*[!0-9]*) printf 'error: --timeout must be a positive integer\n' >&2; exit 2 ;; esac

# ===========================================================================
banner

# --- [1/5] Preflight ------------------------------------------------------
step "Preflight checks"

command -v docker >/dev/null 2>&1 || fail "Docker is not installed or not on PATH."
ok "docker found ($(docker --version 2>/dev/null | head -n1))"

docker info >/dev/null 2>&1 || fail "Docker daemon is not reachable. Is Docker running?"
ok "Docker daemon is running"

if docker compose version >/dev/null 2>&1; then
  DC=(docker compose --env-file "$ENV_FILE")
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose --env-file "$ENV_FILE")
else
  fail "Docker Compose v2 not found (need 'docker compose')."
fi
DC_STR="${DC[*]}"
ok "Compose available (${DC_STR})"

[ -f docker-compose.yml ] || fail "docker-compose.yml not found in $SCRIPT_DIR."

# --- [2/5] Settings -------------------------------------------------------
step "Settings"

FIRST_RUN=0
if [ ! -f "$SETTINGS" ]; then
  [ -f ../settings.example.yml ] || fail "Missing settings.yml and its template settings.example.yml in the repo root."
  cp ../settings.example.yml "$SETTINGS" || fail "Could not create settings.yml."
  ok "Created settings.yml from the template"
  FIRST_RUN=1
fi
if [ ! -f "$SECRETS" ]; then
  [ -f ../.env.example ] || fail "Missing .env and its template .env.example in the repo root."
  (umask 077 && cp ../.env.example "$SECRETS") || fail "Could not create .env."
  ok "Created .env from the template (readable only by you)"
  FIRST_RUN=1
fi

if [ "$FIRST_RUN" = 1 ] || [ "$SETUP" = yes ]; then
  [ "$CAN_ASK" = 1 ] || fail "Settings need answers; run ./deploy.sh in a terminal (or fill in ../settings.yml and ../.env by hand)."
  setup_wizard
elif [ "$SETUP" = ask ] && [ "$CAN_ASK" = 1 ]; then
  ok "Settings present (../settings.yml, ../.env)"
  if ask_yn "Change settings before deploying?" n; then setup_wizard; fi
else
  ok "Settings present (../settings.yml, ../.env)"
fi

# Read the docker: section for compose (names, network, port, bind, source).
info "reading settings.yml (${YQ_IMAGE})…"
docker run --rm -i "$YQ_IMAGE" "$YQ_EXPR" < "$SETTINGS" > "$ENV_FILE" \
  || fail "Could not read settings.yml — check it is valid YAML."
ok "Compose values read ($(grep -c . "$ENV_FILE") from settings.yml)"

# Resolve ports / URL / names (fall back to compose defaults).
WEB_PORT=$(env_get DOCKER_PORT || true);     WEB_PORT=${WEB_PORT:-3000}
AUTH_URL=$(env_get PUBLIC_URL || true)
WEB_BIND=$(env_get DOCKER_BIND || true);     WEB_BIND=${WEB_BIND:-0.0.0.0}
C_WEB=$(env_get DOCKER_CONTAINER || true);   C_WEB=${C_WEB:-ourhome_web}
# Which service stacks this install runs (settings.yml services:).
SVC_MONGO=$(env_get SERVICES_MONGO || true)
SVC_PAPERLESS=$(env_get SERVICES_PAPERLESS || true)
SVC_MAIL=$(env_get SERVICES_MAIL || true)
SVC_MAIL_FOLDER=$(env_get SERVICES_MAIL_FOLDER || true)
ANDROID_BUILD=$(env_get ANDROID_BUILD || true)
SVC_ANY=0
if [ "$SVC_MONGO" = managed ] || [ "$SVC_PAPERLESS" = managed ] || [ "$SVC_MAIL" = bridge ]; then
  SVC_ANY=1
  SVC_HOME=$(svc_dir "$(env_get SERVICES_PATH || true)")
fi
# This machine's address on the home network, for the "open it here" hint.
LAN_IP=$(lan_ip)
WEB_URL_LOCAL="http://127.0.0.1:$WEB_PORT/"
if command -v curl >/dev/null 2>&1; then HAVE_CURL=1; else HAVE_CURL=0; fi

# What to build: GitHub (repo#branch, which BuildKit fetches itself, checking
# for new commits every build) or this checkout. Compose reads BUILD_CONTEXT
# from .compose.env.
if [ "$LOCAL" = 1 ]; then
  BUILD_CONTEXT=..
  ok "Source: this checkout ($REPO_ROOT)"
else
  REPO=$(env_get DOCKER_REPO || true);       REPO=${REPO:-$DEFAULT_REPO}
  case "$REPO" in *.git) ;; *) REPO="$REPO.git" ;; esac
  [ -n "$BRANCH" ] || BRANCH=$(env_get DOCKER_BRANCH || true)
  BRANCH=${BRANCH:-main}
  BUILD_CONTEXT="$REPO#$BRANCH"
  # Catch a mistyped branch now rather than halfway through a build (needs git;
  # an unreachable GitHub only warns, the build will say more).
  if command -v git >/dev/null 2>&1 && [ "$NO_BUILD" = 0 ]; then
    if HEADS=$(git ls-remote --heads "$REPO" "refs/heads/$BRANCH" 2>/dev/null); then
      [ -n "$HEADS" ] || fail "Branch '$BRANCH' not found at ${REPO%.git}."
      ok "Source: ${REPO%.git} ($BRANCH @ ${HEADS:0:7})"
    else
      warn "Couldn't reach ${REPO%.git} to check branch '$BRANCH'."
    fi
  else
    ok "Source: ${REPO%.git} ($BRANCH)"
  fi
fi
printf 'BUILD_CONTEXT=%s\n' "$BUILD_CONTEXT" >> "$ENV_FILE"

# Shared Docker network (compose declares it external). Create it if missing.
NET=$(env_get DOCKER_NETWORK || true);       NET=${NET:-ourhome_net}
if docker network inspect "$NET" >/dev/null 2>&1; then
  ok "Docker network present ($NET)"
else
  docker network create "$NET" >/dev/null || fail "Could not create Docker network '$NET'."
  ok "Docker network created ($NET)"
fi

# The web container mounts android/out; made here so it's yours, not root's.
mkdir -p "$ANDROID_DIR/out" 2>/dev/null || true

# --- Service stacks this install runs (MongoDB, Proton Bridge, Paperless) ---
# Before the web app, which needs its database on first start. Each is its own
# compose project on the shared network; re-running only (re)starts them.
if [ "$SVC_ANY" = 1 ]; then
  step "Service stacks"
  # svc_prepare reads these through sget, as in the walkthrough.
  sput services.path "$SVC_HOME"; sput services.mongo "$SVC_MONGO"
  sput services.paperless "$SVC_PAPERLESS"; sput services.mail "$SVC_MAIL"; sput docker.network "$NET"
  svc_prepare
  [ "$SVC_MONGO" = managed ]     && mongo_up "$SVC_HOME"
  [ "$SVC_MAIL" = bridge ]       && bridge_up "$SVC_HOME"
  [ "$SVC_PAPERLESS" = managed ] && paperless_up "$SVC_HOME"
fi

# Soft placeholder warnings (do not block), after the service stacks have
# filled in what they own. DEV_ entries are for local dev only.
for f in "$SETTINGS" "$SECRETS"; do
  if grep -vE '^[[:space:]]*DEV_' "$f" 2>/dev/null | grep -qE 'replace-with|change-me'; then
    warn "${f#../} still contains placeholder values (replace-with… / change-me)."
  fi
done

# --- [3/5] Build & start --------------------------------------------------
if [ "$NO_BUILD" = 1 ]; then
  step "Start web app (no rebuild)"
  "${DC[@]}" up -d || fail "'${DC_STR} up -d' failed."
elif [ "$NO_CACHE" = 1 ]; then
  step "Build (no cache) & start web app"
  "${DC[@]}" build --no-cache --pull || fail "'${DC_STR} build --no-cache --pull' failed."
  "${DC[@]}" up -d || fail "'${DC_STR} up -d' failed."
else
  step "Build & start web app"
  "${DC[@]}" up -d --build || fail "'${DC_STR} up -d --build' failed."
fi
ok "Containers created/started"

# --- [4/5] Health verification -------------------------------------------
step "Verify health (timeout ${TIMEOUT}s)"
wait_until "Web app (HTTP :$WEB_PORT)"  "$TIMEOUT" check_web   || fail "Web app did not start responding."

# --- Paperless setup (only when chosen in the walkthrough) ----------------
# Runs inside the web container, where Paperless is reachable by its
# container name. The admin login is passed by name only (-e NAME), so it never
# shows on a command line; progress prints as it goes, the token is the only
# thing on stdout. Then the app restarts to pick the token up.
if [ "$PL_SETUP" = 1 ]; then
  step "Paperless setup"
  if [ "$SVC_PAPERLESS" = managed ]; then
    # Paperless run here: its admin login is in its own .env.
    PL_ADMIN_USER=$(env_get PAPERLESS_ADMIN_USER "$SVC_HOME/paperless/.env" || true); PL_ADMIN_USER=${PL_ADMIN_USER:-admin}
    PL_ADMIN_PASS=$(env_get PAPERLESS_ADMIN_PASSWORD "$SVC_HOME/paperless/.env" || true)
  fi
  export PAPERLESS_ADMIN_USER="$PL_ADMIN_USER" PAPERLESS_ADMIN_PASSWORD="$PL_ADMIN_PASS" PAPERLESS_SETUP_BILLERS="$PL_BILLERS"
  # The bill mailbox, when one was chosen and its login is known this run.
  export PAPERLESS_SETUP_IMAP_HOST= PAPERLESS_SETUP_IMAP_PORT= PAPERLESS_SETUP_IMAP_SECURITY= \
    PAPERLESS_SETUP_IMAP_USER= PAPERLESS_SETUP_IMAP_PASSWORD= PAPERLESS_SETUP_MAIL_FOLDER=
  if [ "$SVC_MAIL" = bridge ] || [ "$SVC_MAIL" = imap ]; then
    export PAPERLESS_SETUP_IMAP_HOST="${MAIL_HOST:-}" PAPERLESS_SETUP_IMAP_PORT="${MAIL_PORT:-}" \
      PAPERLESS_SETUP_IMAP_SECURITY="${MAIL_SECURITY:-}" PAPERLESS_SETUP_IMAP_USER="${MAIL_USER:-}" \
      PAPERLESS_SETUP_IMAP_PASSWORD="${MAIL_PASS:-}" PAPERLESS_SETUP_MAIL_FOLDER="$SVC_MAIL_FOLDER"
  fi
  PL_TOKEN=$("${DC[@]}" exec -T -e PAPERLESS_ADMIN_USER -e PAPERLESS_ADMIN_PASSWORD -e PAPERLESS_SETUP_BILLERS \
    -e PAPERLESS_SETUP_IMAP_HOST -e PAPERLESS_SETUP_IMAP_PORT -e PAPERLESS_SETUP_IMAP_SECURITY \
    -e PAPERLESS_SETUP_IMAP_USER -e PAPERLESS_SETUP_IMAP_PASSWORD -e PAPERLESS_SETUP_MAIL_FOLDER \
    web npm run -s paperless:setup)
  PL_RC=$?
  unset PAPERLESS_ADMIN_PASSWORD PAPERLESS_SETUP_IMAP_PASSWORD; PL_ADMIN_PASS=; MAIL_PASS=
  PL_TOKEN=$(printf '%s' "$PL_TOKEN" | tr -d '\r' | tail -n1)
  if [ "$PL_RC" = 0 ] && printf '%s' "$PL_TOKEN" | grep -qE '^[0-9a-f]{40}$'; then
    env_put PAPERLESS_TOKEN "$PL_TOKEN" && ok "Token saved to .env"
    "${DC[@]}" up -d || fail "'${DC_STR} up -d' failed."
    wait_until "Web app restarted with the token" "$TIMEOUT" check_web || fail "Web app did not start responding."
    info "Check what it would import: ${DC_STR} exec web npm run paperless:preview"
  else
    warn "Paperless setup didn't finish (see above). The app runs without the import;"
    warn "fix the cause and run ./deploy.sh -s --no-build to try again."
  fi
fi

# --- Android app (when built here) ----------------------------------------
# After the site is up: a failed or slow app build never holds the site back.
# The web container serves android/out (mounted read-only), so a new APK shows
# on the Profile page without a restart.
if [ "$ANDROID_BUILD" = true ]; then
  step "Android app"
  if ! docker buildx version >/dev/null 2>&1; then
    warn "Docker Buildx is missing (it ships with Docker Desktop and docker-buildx-plugin); app not built."
  else
    android_build || true
  fi
fi

# --- Summary ----------------------------------------------------------------
step "Summary"

print_row() {  # $1 label  $2 container
  local st health c
  st=$(cstatus "$2"); st=${st:-absent}
  health=$(chealth "$2"); health=${health:--}
  case "$st" in
    running) c=$GREEN ;;
    exited)  c=$DIM ;;
    *)       c=$YELLOW ;;
  esac
  printf '    %-24s %s%-10s%s %s\n' "$1" "$c" "$st" "$RESET" "$([ "$health" = "-" ] && echo "" || echo "($health)")"
}
print_row "web"            "$C_WEB"

printf '\n  %s%s✓ web app is up%s\n' "$GREEN" "$BOLD" "$RESET"
printf '    %-18s %s\n' "On this machine:" "http://localhost:$WEB_PORT/"
if [ "$WEB_BIND" != 127.0.0.1 ] && [ -n "$LAN_IP" ]; then
  printf '    %-18s %s\n' "On your network:" "http://$LAN_IP:$WEB_PORT/"
fi
[ -n "$AUTH_URL" ] && printf '    %-18s %s\n' "Public URL:" "$AUTH_URL"
if [ "$SVC_PAPERLESS" = managed ]; then
  printf '    %-18s %s\n' "Paperless:" "$(env_get PAPERLESS_URL "$SVC_HOME/paperless/.env" || true)" \
    "" "admin login: PAPERLESS_ADMIN_USER / _PASSWORD in $SVC_HOME/paperless/.env"
fi

# --- Next steps -----------------------------------------------------------
printf '\n  %sFirst run?%s Open one of the addresses above. The setup page creates\n' "$BOLD" "$RESET"
printf '  the admin account, then the rest of the household.\n'
printf '    • Change settings: ./deploy.sh -s   (add --no-build to only restart)\n'
printf '    • Follow logs:     %s logs -f web\n\n' "$DC_STR"
