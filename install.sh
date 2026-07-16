#!/usr/bin/env bash
# cc-usage — one-click employee installer.
#
# Idempotent. Safe to re-run. Does NOT touch .env / *.env* / git.
#
# What it does:
#   1. Check Node 22+ and pnpm.
#   2. Warm the ccusage rate table (npx ccusage@latest --version).
#   3. Install deps (pnpm install) so the collector can run.
#   4. Prompt once for CC_USAGE_INGEST_URL + CC_USAGE_INGEST_TOKEN and persist
#      them (plus the repo path) to ~/.claude/cc-usage/env.
#   5. Merge SessionStart + SessionEnd hooks into ~/.claude/settings.json and
#      install the /task command (via skill/cc-usage-sync/scripts/install-hooks.sh).
#   6. Dry-run: cc-usage --days 1 (no upload) to prove parsing works.
#   7. Print success + next steps.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CC="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
ENV_FILE="$CC/cc-usage/env"

# Team ingest endpoint — built in as the default so colleagues never have to be
# told the URL. Overridable via CC_USAGE_INGEST_URL env or the prompt below.
DEFAULT_INGEST_URL="${CC_USAGE_INGEST_URL:-https://cc-usage.up.railway.app/api/ingest}"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ok\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
# y/N confirm (default No). Auto-yes when not a TTY (curl|bash) to stay unattended.
confirm() {
  [[ -t 0 ]] || return 0
  local reply; read -r -p "$* [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

# --- 1. prerequisites -------------------------------------------------------
say "Checking prerequisites"

# Node 22+ — offer to auto-install if missing/old (brew or fnm; both put node on
# PATH within this process, unlike nvm which is a shell function).
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
install_node() {
  if command -v brew >/dev/null 2>&1; then
    say "Installing Node via Homebrew…"
    brew install node@22 >/dev/null && brew link --overwrite --force node@22 >/dev/null 2>&1
  elif command -v fnm >/dev/null 2>&1; then
    say "Installing Node 22 via fnm…"
    fnm install 22 >/dev/null && eval "$(fnm env)" && fnm use 22 >/dev/null && fnm default 22 >/dev/null 2>&1
  else
    return 1
  fi
}
if ! command -v node >/dev/null 2>&1 || [[ "$(node_major)" -lt 22 ]]; then
  warn "Node 22+ not found (have: $(command -v node >/dev/null 2>&1 && node -v || echo none))."
  if confirm "Install Node 22 automatically now?"; then
    install_node || die "Auto-install unavailable. Install Node 22+ manually: https://nodejs.org  (or 'brew install node' / 'fnm install 22'), then re-run."
    hash -r 2>/dev/null || true
  else
    die "Node 22+ required. Install: https://nodejs.org  or  brew install node  or  fnm install 22"
  fi
fi
[[ "$(node_major)" -ge 22 ]] || die "Node still <22 after install — open a new terminal and re-run."
ok "Node $(node -v)"

# pnpm — enable via corepack (ships with Node), else fall back to npm.
if ! command -v pnpm >/dev/null 2>&1; then
  warn "pnpm not found — enabling via corepack"
  corepack enable >/dev/null 2>&1 || npm i -g pnpm >/dev/null 2>&1 || true
fi
command -v pnpm >/dev/null 2>&1 || die "pnpm not found. Install with: npm i -g pnpm"
ok "pnpm $(pnpm -v)"

# --- 2. warm ccusage rate table --------------------------------------------
say "Warming ccusage (public-rate table for notional cost)"
npx ccusage@latest --version >/dev/null 2>&1 \
  && ok "ccusage cached" \
  || warn "could not warm ccusage now (will fetch on first run)"

# --- 3. install deps --------------------------------------------------------
say "Installing workspace dependencies"
( cd "$ROOT" && pnpm install ) || die "pnpm install failed"
ok "dependencies installed"

# --- 4. credentials ---------------------------------------------------------
say "Configuring the team backend"
mkdir -p "$CC/cc-usage"

# Reuse existing values if the env file is already present.
EXIST_URL=""; EXIST_TOKEN=""
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  EXIST_URL="$(. "$ENV_FILE" >/dev/null 2>&1; echo "${CC_USAGE_INGEST_URL:-}")"
  EXIST_TOKEN="$(. "$ENV_FILE" >/dev/null 2>&1; echo "${CC_USAGE_INGEST_TOKEN:-}")"
fi

# A token pre-set in the environment OVERRIDES the saved one. This is how a
# colleague switches tokens: re-enroll on the /enroll page → paste the new
# `CC_USAGE_INGEST_TOKEN=… bash install.sh` → the personal token replaces an old
# or shared one. A plain `git pull && bash install.sh` (no env var) reuses the
# saved token. (Was the reverse — saved-wins — which silently kept a stale token
# across a re-enroll.)
[[ -n "${CC_USAGE_INGEST_TOKEN:-}" ]] && EXIST_TOKEN="$CC_USAGE_INGEST_TOKEN"
: "${EXIST_URL:=${CC_USAGE_INGEST_URL:-}}"

prompt_default() {
  # $1 = prompt, $2 = current/default, $3 = "secret" to hide input
  local p="$1" cur="$2" secret="${3:-}" ans=""
  local shown="$cur"
  [[ "$secret" == "secret" && -n "$cur" ]] && shown="********"
  if [[ -n "$cur" ]]; then
    read -r -p "$p [$shown]: " ans || true
    echo "${ans:-$cur}"
  else
    read -r -p "$p: " ans || true
    echo "$ans"
  fi
}

INGEST_URL="${EXIST_URL:-$DEFAULT_INGEST_URL}"
ENROLL_PAGE_URL="${INGEST_URL%/api/ingest}/enroll"

# This machine's Claude OAuth work-account email (same path config.ts reads).
ACCOUNT="$(node -e '
  const os=require("os"),path=require("path"),fs=require("fs");
  const f=process.env.CLAUDE_CONFIG_DIR?path.join(process.env.CLAUDE_CONFIG_DIR,".claude.json"):path.join(os.homedir(),".claude.json");
  try{const j=JSON.parse(fs.readFileSync(f,"utf8"));process.stdout.write((j&&j.oauthAccount&&j.oauthAccount.emailAddress)||"")}catch{process.stdout.write("")}
' 2>/dev/null || true)"

if [[ -n "$EXIST_TOKEN" ]]; then
  # Happy path: the /enroll page hands `CC_USAGE_INGEST_TOKEN=… bash install.sh`,
  # which lands here via EXIST_TOKEN (env var overrides any saved token — a
  # re-enroll switches tokens). Also covers a plain re-run reusing the saved one.
  INGEST_TOKEN="$EXIST_TOKEN"
  ok "personal upload token set"
elif [[ -t 0 ]]; then
  # The /enroll page is PUBLIC (no dashboard login) — open it, type your @work
  # email, copy your per-account token. No shared secret to chase down.
  say "Get your personal upload token:"
  say "  $ENROLL_PAGE_URL   (enter your ${ACCOUNT:-@work} email, copy the token)"
  read -r -s -p "  Paste your upload token: " INGEST_TOKEN; echo
  [[ -n "$INGEST_TOKEN" ]] || die "token required — open $ENROLL_PAGE_URL to get one."
  ok "personal upload token set"
else
  die "non-interactive shell: pre-set CC_USAGE_INGEST_TOKEN (copy it from $ENROLL_PAGE_URL)."
fi

[[ -n "$INGEST_URL" && -n "$INGEST_TOKEN" ]] \
  || warn "ingest URL/token left empty — sync will fail until you edit $ENV_FILE"

# Persist. CC_USAGE_REPO lets sync.sh find the checkout from anywhere.
umask 077
# printf %q, not a heredoc: an unquoted heredoc would expand a literal `$` in a
# token, silently corrupting it; %q shell-quotes every value so `source` recovers
# it byte-for-byte regardless of content.
{
  echo "# cc-usage employee env — loaded by sync.sh. Do not commit. Generated by install.sh."
  printf 'CC_USAGE_REPO=%q\n' "$ROOT"
  printf 'CC_USAGE_INGEST_URL=%q\n' "$INGEST_URL"
  printf 'CC_USAGE_INGEST_TOKEN=%q\n' "$INGEST_TOKEN"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
ok "credentials saved to $ENV_FILE (chmod 600)"

# --- 5. hooks + /task command ----------------------------------------------
say "Installing Claude Code hooks + /task command"
bash "$ROOT/skill/cc-usage-sync/scripts/install-hooks.sh"

# --- 6. dry run -------------------------------------------------------------
say "Dry-run preview (no upload)"
# Run the CLI directly, NOT `pnpm <script> -- ARGS` — pnpm forwards the `--` and
# commander treats it as an options terminator, dropping --days (see sync.sh).
if ( cd "$ROOT/packages/collector" && npx tsx src/cli.ts --days 1 ); then
  ok "collector ran cleanly"
else
  warn "dry-run reported an issue — check the output above"
fi

# --- 7. done ----------------------------------------------------------------
cat <<EOF

$(ok "cc-usage installed.")

Next steps:
  • Just work as usual. At each session start, Claude will ask which Jira
    epic/task the session is for — answer with a key (e.g. ABC-123) and it
    runs /task for you, or say "none".
  • Set a task manually any time:   /task ABC-123        (task only)
                                     /task ABC-123 ABC-100 (task + epic)
  • Usage uploads automatically when a session ends (SessionEnd hook).
  • Manual sync:                     bash ~/.claude/cc-usage/bin/sync.sh
  • Preview without uploading:       pnpm --filter @cc-usage/collector start -- --days 1

Cost shown in the dashboard is NOTIONAL (public API rates) — you are on an
enterprise seat and are never billed per token.
EOF
