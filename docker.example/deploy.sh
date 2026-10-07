#!/usr/bin/env bash
#
# deploy.sh — build and start the Our Home web app and wait until it responds,
# instead of the bare `docker compose up -d` that returns before it is ready.
#
# This compose file runs the web app only. MongoDB (a replica set) runs on its
# own, reached via SERVER_DATABASE_URL. Reminders run inside the web app.
#
# Settings live in the single repo-root .env (shared with local dev). This
# script verifies it exists but never creates or edits it, and passes it to
# compose with --env-file.
#
# Usage:  ./deploy.sh [--no-build] [--timeout SECONDS] [--help]
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
ENV_FILE=../.env   # the repo-root .env, shared with local dev

# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------
NO_BUILD=0
TIMEOUT=180

usage() {
  cat <<EOF
${BOLD}Our Home — Docker deploy (web app)${RESET}

Builds and starts the web app, then waits until it responds.

${BOLD}Usage:${RESET}
  ./deploy.sh [options]

${BOLD}Options:${RESET}
  --no-build         Skip rebuilding the image; just (re)start the app.
  --timeout SECONDS  How long to wait for health checks (default: ${TIMEOUT}).
  -h, --help         Show this help and exit.

${BOLD}Environment:${RESET}
  NO_COLOR           Set to disable coloured output.

The settings file .env (repo root) must already exist.
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

STEP_N=0
STEP_TOTAL=4
step() {
  STEP_N=$((STEP_N + 1))
  printf '\n%s[%d/%d]%s %s%s%s\n' \
    "$DIM" "$STEP_N" "$STEP_TOTAL" "$RESET" "$BOLD" "$*" "$RESET"
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
# .env reader (handles CRLF, surrounding quotes)
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

# ---------------------------------------------------------------------------
# Container names (from docker-compose.yml) + checks
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

# --- [1/4] Preflight ------------------------------------------------------
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
[ -f "$ENV_FILE" ] || fail "Missing .env in the repo root — copy .env.example to .env and fill it in."
ok "Settings file present (../.env)"

# Soft placeholder warnings (do not block).
if grep -qE 'replace-with|change-me' "$ENV_FILE" 2>/dev/null; then
  warn ".env still contains placeholder values (replace-with… / change-me)."
fi

# Resolve ports / URL from .env (fall back to compose defaults).
WEB_PORT=$(env_get WEB_HOST_PORT || true);   WEB_PORT=${WEB_PORT:-3000}
AUTH_URL=$(env_get PUBLIC_URL || true)
WEB_BIND=$(env_get WEB_BIND || true);         WEB_BIND=${WEB_BIND:-0.0.0.0}
# This machine's address on the home network, for the "open it here" hint.
LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "$LAN_IP" ] || LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || true)
WEB_URL_LOCAL="http://127.0.0.1:$WEB_PORT/"
if command -v curl >/dev/null 2>&1; then HAVE_CURL=1; else HAVE_CURL=0; fi

# Shared Docker network (compose declares it external). Create it if missing.
NET=$(env_get DOCKER_NETWORK || true); NET=${NET:-ourhome_net}
if docker network inspect "$NET" >/dev/null 2>&1; then
  ok "Docker network present ($NET)"
else
  docker network create "$NET" >/dev/null || fail "Could not create Docker network '$NET'."
  ok "Docker network created ($NET)"
fi

# --- [2/4] Build & start --------------------------------------------------
if [ "$NO_BUILD" = 1 ]; then
  step "Start web app (no rebuild)"
  "${DC[@]}" up -d || fail "'${DC_STR} up -d' failed."
else
  step "Build & start web app"
  "${DC[@]}" up -d --build || fail "'${DC_STR} up -d --build' failed."
fi
ok "Containers created/started"

# --- [3/4] Health verification -------------------------------------------
step "Verify health (timeout ${TIMEOUT}s)"
wait_until "Web app (HTTP :$WEB_PORT)"  "$TIMEOUT" check_web   || fail "Web app did not start responding."

# --- [4/4] Summary --------------------------------------------------------
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

# --- Next steps -----------------------------------------------------------
printf '\n  %sFirst run?%s Open one of the addresses above. The setup page creates\n' "$BOLD" "$RESET"
printf '  the admin account, then the rest of the household.\n'
printf '    • Follow logs:   %s logs -f web\n\n' "$DC_STR"
