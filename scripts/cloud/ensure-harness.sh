#!/usr/bin/env bash
# Open Walnut cloud companion: make the box a real 24h exec host.
#
# Converges a NEW or an EXISTING box and is safe to run on every deploy
# (scripts/cloud/setup.sh runs it each time):
#   1. ~/.claude/settings.json pointing Claude Code at Bedrock through the EC2
#      instance role. Written ONLY when absent (an operator's file is theirs) and
#      only when the box has an instance role: off AWS there is nothing for it
#      to point at.
#   2. Claude Code for the service user. Always installed, whatever the default
#      engine is, because Walnut's own chat lanes run on it. Native installer
#      first (it self-updates), npm as the fallback. Nothing is linked onto
#      root's PATH from the service home; the service finds ~/.local/bin itself.
#   3. The CLI of the default engine, when that engine is not claude and the
#      box's node meets the package's floor (warned otherwise, never upgraded).
#   4. A systemd drop-in giving walnut.service SHELL=/bin/bash. The session
#      daemon spawns the CLI through $SHELL, and systemd sets SHELL from passwd
#      for a unit with User=, which for this service user is a nologin shell:
#      every spawn would die on it.
#   5. config.yaml keys that turn cloud exec on (src/core/cloud-exec.ts) plus
#      defaults.engine, each seeded ONLY when absent. Cloud exec is seeded only
#      once Claude Code is installed AND has a credential (the instance role,
#      an operator's settings.json, or a `claude` login); otherwise the box
#      stays a relay and the summary says what is missing.
#
# It never restarts the service; the caller decides when (setup.sh restarts at
# its end, a hand run follows up with `systemctl restart walnut`). It refuses to
# run at all (exit 4) from a code tree the service user can change; see the
# check below.
#
# Usage (as root):
#   bash scripts/cloud/ensure-harness.sh [--engine <id>] [--bedrock-region <region>] [--dry-run]
#   bash scripts/cloud/ensure-harness.sh --validate-args [--engine <id>] [--bedrock-region <region>]
#
#   --engine          default: the box's own defaults.engine, then claude
#                     (or the WALNUT_ENGINE environment variable)
#   --bedrock-region  region Claude Code calls Bedrock in (default us-west-2, or
#                     WALNUT_BEDROCK_REGION). NOT the box's region: model
#                     availability is best there.
#   --dry-run         print the plan and change nothing. Needs no root, but run it
#                     as root on a real box: as another user, the probes of the
#                     service user's files can come back empty.
#   --validate-args   check the arguments and exit 0, or 2 with the reason
#
# Engine credentials (API keys, logins) are out of scope: this script installs
# engine CLIs but never configures their auth.
#
# Test hooks, never set on a real box: WALNUT_HARNESS_ROOT prefixes every system
# path (/etc, /usr, /var/lib/walnut, /root) so a test can run this exact script
# against a temp dir with stub installers first on PATH; WALNUT_HARNESS_HOME,
# WALNUT_HARNESS_REPO and WALNUT_HARNESS_USER override the service home, the
# checkout that provides node_modules (default: the one holding this script),
# and the user.
set -euo pipefail

# Must match SESSION_ENGINE_IDS in src/core/types.ts (a test compares them).
ENGINE_IDS="claude codex gemini opencode goose pi dsh custom"
# Walnut drives current models through flags that need at least this CLI.
CLAUDE_MIN_VERSION=2.1.280
DEFAULT_BEDROCK_REGION=us-west-2
CLAUDE_INSTALL_URL=https://claude.ai/install.sh
CLAUDE_NPM_PACKAGE=@anthropic-ai/claude-code
GOOSE_INSTALL_URL=https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh
IMDS_URL=http://169.254.169.254
REGION_RE='^[a-z]{2}(-[a-z]+)+-[0-9]{1,2}$'

usage() {
  echo "usage: ensure-harness.sh [--engine <id>] [--bedrock-region <region>] [--dry-run | --validate-args]"
  echo "       engines: $ENGINE_IDS"
}
die_usage() { echo "ensure-harness: $*" >&2; usage >&2; exit 2; }

ENGINE="${WALNUT_ENGINE:-}"
BEDROCK_REGION="${WALNUT_BEDROCK_REGION:-$DEFAULT_BEDROCK_REGION}"
# Asked for, not defaulted: only then is a kept settings.json in another region news.
REGION_ASKED=0
if [ -n "${WALNUT_BEDROCK_REGION:-}" ]; then REGION_ASKED=1; fi
DRY_RUN=0
VALIDATE_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --engine) [ $# -ge 2 ] || die_usage "--engine needs a value"; ENGINE="$2"; shift 2 ;;
    --engine=*) ENGINE="${1#--engine=}"; shift ;;
    --bedrock-region) [ $# -ge 2 ] || die_usage "--bedrock-region needs a value"; BEDROCK_REGION="$2"; REGION_ASKED=1; shift 2 ;;
    --bedrock-region=*) BEDROCK_REGION="${1#--bedrock-region=}"; REGION_ASKED=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --validate-args) VALIDATE_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die_usage "unknown argument: $1" ;;
  esac
done

is_engine_id() {
  case "$1" in ''|*[!a-z]*) return 1 ;; esac
  case " $ENGINE_IDS " in *" $1 "*) return 0 ;; esac
  return 1
}
if [ -n "$ENGINE" ] && ! is_engine_id "$ENGINE"; then
  die_usage "unknown engine '$ENGINE' (expected one of: $ENGINE_IDS)"
fi
if ! [[ $BEDROCK_REGION =~ $REGION_RE ]]; then
  die_usage "invalid --bedrock-region '$BEDROCK_REGION' (expected a region id such as $DEFAULT_BEDROCK_REGION)"
fi
if [ "$VALIDATE_ONLY" = 1 ]; then exit 0; fi

ROOT="${WALNUT_HARNESS_ROOT:-}"
WALNUT_USER="${WALNUT_HARNESS_USER:-walnut}"
WALNUT_HOME_DIR="${WALNUT_HARNESS_HOME:-$ROOT/var/lib/walnut}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The checkout this script lives in, not a fixed /opt/walnut: a deploy runs it
# from a freshly built sibling tree before swapping that tree into place.
REPO_DIR="${WALNUT_HARNESS_REPO:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
DATA_HOME="$WALNUT_HOME_DIR/.open-walnut"
CONFIG_FILE="$DATA_HOME/config.yaml"
WORK_DIR="$WALNUT_HOME_DIR/work"
SETTINGS_FILE="$WALNUT_HOME_DIR/.claude/settings.json"
CREDENTIALS_FILE="$WALNUT_HOME_DIR/.claude/.credentials.json"
DROPIN_FILE="$ROOT/etc/systemd/system/walnut.service.d/harness.conf"
LINK_DIR="$ROOT/usr/local/bin"
SYSTEM_BIN_DIR="$ROOT/usr/bin"
SEED_SCRIPT="$SCRIPT_DIR/seed-harness-config.mjs"
# Root-only record that a code tree was writable by the service user; setup.sh
# and the deploy read it (see the code tree check below).
EXPOSED_MARKER="$ROOT/root/.walnut-code-tree-exposed"

# `sudo` on AL2023 resets PATH to a secure_path without /usr/local/bin,
# which is where setup.sh links node and npm. Appended, so it never outranks
# anything already on PATH.
if [ -z "$ROOT" ]; then
  case ":$PATH:" in *":/usr/local/bin:"*) ;; *) PATH="$PATH:/usr/local/bin" ;; esac
  export PATH
fi

if [ -z "$ROOT" ] && [ "$DRY_RUN" = 0 ] && [ "$(id -u)" != 0 ]; then
  echo "FATAL: run as root (sudo bash $0 ...), or add --dry-run to preview" >&2
  exit 1
fi
if ! id -u "$WALNUT_USER" >/dev/null 2>&1; then
  if [ "$DRY_RUN" = 1 ]; then
    echo "note: service user '$WALNUT_USER' does not exist yet (setup.sh creates it)"
  else
    echo "FATAL: service user '$WALNUT_USER' does not exist (scripts/cloud/setup.sh creates it)" >&2
    exit 1
  fi
fi

RUNUSER="$(command -v runuser 2>/dev/null || true)"
for c in /usr/sbin/runuser /sbin/runuser; do
  if [ -z "$RUNUSER" ] && [ -x "$c" ]; then RUNUSER="$c"; fi
done

# The code tree this script runs from is root's, read-only to the service user.
# That user runs agents (cloud exec), and root runs code from this tree on every
# deploy (this script, npm lifecycle scripts, the build, git). Anything in it the
# service user could change is a path to root for a prompt-injected agent, so
# record it in $EXPOSED_MARKER and refuse to go on rather than run on top of it.
# setup.sh makes the same check and refuses too; the deploy replaces such a tree
# from a fresh clone. None of them takes an exposed tree back in place.
# Test hook: WALNUT_HARNESS_CODE_TREE names the tree to check; in a sandboxed run
# (WALNUT_HARNESS_ROOT set) the check only runs when a test asks for it.
CODE_TREE="${WALNUT_HARNESS_CODE_TREE:-}"
if [ -z "$CODE_TREE" ] && [ -z "$ROOT" ]; then CODE_TREE="$(cd "$SCRIPT_DIR/../.." && pwd)"; fi
# The service home as the kernel sees it (resolves /var -> /private/var and the like).
HOME_REAL="$(cd "$WALNUT_HOME_DIR" 2>/dev/null && pwd -P || printf '%s' "$WALNUT_HOME_DIR")"
# True when path $1 names, or resolves through any chain of links to, a place
# in the service home. A dangling link is judged by its own target text.
in_service_home() {
  local p r target
  target="$(realpath "$1" 2>/dev/null || true)"
  if [ -z "$target" ] && [ -L "$1" ]; then
    target="$(readlink "$1")"
    case "$target" in /*) ;; *) target="$(dirname "$1")/$target" ;; esac
  fi
  for p in "$1" "$target"; do
    [ -n "$p" ] || continue
    for r in "$WALNUT_HOME_DIR" "$HOME_REAL"; do
      case "$p" in "$r"|"$r"/*) return 0 ;; esac
    done
  done
  return 1
}
# A link in the tree is as safe as what it resolves to: one leaving the tree
# for the service home, for something the service user controls, or for a name
# that does not exist yet (anyone may create it) counts as a way in.
tree_link_exposure() {
  local tree_real l t
  tree_real="$(cd "$CODE_TREE" 2>/dev/null && pwd -P)" || return 0
  while IFS= read -r l; do
    t="$(realpath "$l" 2>/dev/null || true)"
    case "$t" in "$tree_real"|"$tree_real"/*) continue ;; esac
    if [ -z "$t" ] || [ ! -e "$t" ]; then echo "$l (a link to $(readlink "$l"), which does not exist)"; return 0; fi
    if in_service_home "$t"; then echo "$l (a link into $WALNUT_HOME_DIR)"; return 0; fi
    if [ -n "$(find "$t" "$(dirname "$t")" -maxdepth 0 -user "$WALNUT_USER" -print 2>/dev/null)" ]; then
      echo "$l (a link to $t, which $WALNUT_USER controls)"; return 0
    fi
  done < <(find "$CODE_TREE" -type l -print 2>/dev/null)
  return 0
}
# First path the service user could change: in the tree, anything it owns, any
# non-link that is group or world writable, or a link out to something it
# controls; above the tree, a directory it owns or can write (sticky ones
# excepted), since that lets it swap the tree.
code_tree_exposure() {
  local hit d
  hit="$(find "$CODE_TREE" \( -user "$WALNUT_USER" -o \( ! -type l \( -perm -020 -o -perm -002 \) \) \) -print -quit 2>/dev/null || true)"
  if [ -z "$hit" ]; then hit="$(tree_link_exposure)"; fi
  if [ -n "$hit" ]; then echo "$hit"; return 0; fi
  d="$(dirname "$CODE_TREE")"
  while :; do
    hit="$(find "$d" -maxdepth 0 \( -user "$WALNUT_USER" -o \( ! -perm -1000 \( -perm -020 -o -perm -002 \) \) \) -print 2>/dev/null || true)"
    if [ -n "$hit" ]; then echo "$hit"; return 0; fi
    if [ "$d" = / ] || [ "$d" = . ]; then return 0; fi
    d="$(dirname "$d")"
  done
}
if [ -n "$CODE_TREE" ] && id -u "$WALNUT_USER" >/dev/null 2>&1; then
  exposed="$(code_tree_exposure)"
  if [ -n "$exposed" ]; then
    # Recorded for setup.sh and the deploy, which then only replace the tree
    # from a fresh clone: taking it back would erase the evidence, and nothing
    # could tell afterwards what in it (.npmrc, node_modules, .git) is whose.
    if [ "$DRY_RUN" = 0 ]; then
      (umask 077 && mkdir -p "$(dirname "$EXPOSED_MARKER")" && printf '%s ensure-harness.sh: %s was writable by %s (first: %s)\n' \
        "$(date -u +%FT%TZ)" "$CODE_TREE" "$WALNUT_USER" "$exposed" >> "$EXPOSED_MARKER") \
        || echo "WARNING: could not record this in $EXPOSED_MARKER" >&2
    fi
    echo "FATAL: the code tree $CODE_TREE can be changed by $WALNUT_USER (first: $exposed)." >&2
    echo "       Root must not run code from it, or build on it: replace it from a fresh clone" >&2
    echo "       (the deploy builds one next to it and swaps it in; see docs/reference/cloud-sync.md)." >&2
    if [ "$DRY_RUN" = 0 ]; then echo "       Recorded in $EXPOSED_MARKER." >&2; fi
    exit 4
  fi
fi

# Installers must not hold first boot forever: the harness runs before the
# service starts. `timeout` is coreutils (always there on the Linux images);
# without it the commands simply run unbounded.
INSTALL_TIMEOUT=()
PROBE_TIMEOUT=()
if command -v timeout >/dev/null 2>&1; then
  INSTALL_TIMEOUT=(timeout 600)
  PROBE_TIMEOUT=(timeout 30)
fi
CURL_OPTS="-fsSL --connect-timeout 20 --retry 2"

# Run a command as the service user, from its home (a root cwd like /root is not
# readable by it). HOME and SHELL are explicit: runuser's env handling varies
# across util-linux versions, and SHELL is what installers key rc edits off.
# Everything that writes under the service user's home goes through here, so
# root never follows a link the service user planted there.
# Run from an interactive root shell (sudo -i), a child holding root's terminal
# could push keystrokes into it (TIOCSTI) or read what root types next. So a
# switched child gets a session of its own (setsid: no controlling terminal;
# runuser --pty where setsid cannot wait) and no terminal fd at all: stdin is
# /dev/null, stdout and stderr go through pipes. Data goes in as arguments.
ISOLATE=()
if setsid --wait true </dev/null >/dev/null 2>&1; then
  ISOLATE=(setsid --wait)
fi
RUNUSER_PTY=()
if [ "${#ISOLATE[@]}" = 0 ] && [ "$(id -u)" = 0 ] && [ -n "$RUNUSER" ] && "$RUNUSER" --help 2>&1 | grep -q -- '--pty'; then
  RUNUSER_PTY=(--pty)
fi
# "$@" with stdin /dev/null and stdout/stderr each through a pipe (both drained
# before it returns; the exit status is the command's, under pipefail).
no_tty() { { "$@" </dev/null 2>&1 1>&3 3>&- | cat >&2; } 3>&1 | cat; }
as_walnut() {
  local run_env=(env HOME="$WALNUT_HOME_DIR" SHELL=/bin/bash PATH="$WALNUT_HOME_DIR/.local/bin:$PATH")
  (
    cd "$WALNUT_HOME_DIR" 2>/dev/null || cd /
    if [ "$(id -un)" = "$WALNUT_USER" ]; then
      exec "${run_env[@]}" "$@" </dev/null
    fi
    if [ "${#ISOLATE[@]}" = 0 ] && [ "${#RUNUSER_PTY[@]}" = 0 ]; then
      echo "cannot run a command as $WALNUT_USER in a session of its own (no setsid --wait, no runuser --pty)" >&2
      exit 1
    fi
    if [ "$(id -u)" = 0 ] && [ -n "$RUNUSER" ]; then
      no_tty ${ISOLATE[@]+"${ISOLATE[@]}"} "$RUNUSER" ${RUNUSER_PTY[@]+"${RUNUSER_PTY[@]}"} -u "$WALNUT_USER" -- "${run_env[@]}" "$@"
    elif [ "${#ISOLATE[@]}" -gt 0 ] && command -v sudo >/dev/null 2>&1; then
      no_tty "${ISOLATE[@]}" sudo -n -u "$WALNUT_USER" -H "${run_env[@]}" "$@"
    else
      echo "cannot run a command as $WALNUT_USER (no runuser or sudo)" >&2
      exit 1
    fi
  )
}

SUMMARY=()
RESTART_NEEDED=0
record() { SUMMARY+=("$(printf '  %-22s %-9s %s' "$1:" "$2" "$3")"); }
step() { echo "--> $*"; }

# First X.Y.Z of `<bin> --version`, run as the service user; empty when unusable.
# stdin is /dev/null: this runs inside `while read` loops, and a CLI that reads
# stdin would otherwise swallow the rest of the loop's input.
version_of() {
  [ -x "$1" ] || return 0
  local out
  out="$(as_walnut ${PROBE_TIMEOUT[@]+"${PROBE_TIMEOUT[@]}"} "$1" --version </dev/null 2>/dev/null | head -n 1 || true)"
  printf '%s\n' "$out" | sed -nE 's/^[^0-9]*([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -n 1
}

# True when dotted version $1 >= $2 (numeric per field; no sort -V, not portable).
version_ge() {
  local i x y
  for i in 1 2 3; do
    x="$(printf '%s' "$1" | cut -d. -f"$i")"; y="$(printf '%s' "$2" | cut -d. -f"$i")"
    x="${x:-0}"; y="${y:-0}"
    if [ "$x" -gt "$y" ]; then return 0; fi
    if [ "$x" -lt "$y" ]; then return 1; fi
  done
  return 0
}

npm_global_bin() {
  local prefix=""
  if command -v npm >/dev/null 2>&1; then prefix="$(npm prefix -g 2>/dev/null </dev/null || true)"; fi
  if [ -n "$prefix" ]; then printf '%s/bin\n' "$prefix"; fi
  return 0
}
NPM_BIN_DIR="$(npm_global_bin)"

# The CLI the service would run for <name>, or nothing. Same order the service
# looks in: the unit's PATH (/usr/local/bin before /usr/bin), then
# ~/.local/bin, which the server's own lookups (claude-cli-detect.ts,
# engine-probe.ts) and every session spawn's PATH (the daemon preamble) append.
# The FIRST hit is what runs, so a stale system-wide binary shadows a fresh one
# in ~/.local/bin. Explicit paths only: a PATH lookup would answer for root.
effective_cli() {
  local cand
  for cand in "$LINK_DIR/$1" "$SYSTEM_BIN_DIR/$1" "$WALNUT_HOME_DIR/.local/bin/$1"; do
    if [ -x "$cand" ]; then echo "$cand"; return 0; fi
  done
  return 0
}

# Nothing on root's PATH may point into the service user's home: that user can
# rewrite the target, and root runs whatever /usr/local/bin/<name> is. Such a
# link (an install guide suggests one) is removed; ~/.local/bin is found
# without it (see effective_cli).
# Judged by where the link RESOLVES, so a relative link or a chain of links
# into the home counts too.
drop_home_link() {
  local link="$LINK_DIR/$1"
  [ -L "$link" ] || return 0
  in_service_home "$link" || return 0
  if [ "$DRY_RUN" = 1 ]; then
    echo "    would remove $link: it points into $WALNUT_HOME_DIR"
  else
    rm -f "$link"
    echo "    removed $link: it pointed into $WALNUT_HOME_DIR"
  fi
  return 0
}

# Link <name> from an npm prefix that is off the unit's PATH into /usr/local/bin.
# Safe because npm -g runs as root, so the target is root's; a target under the
# service home is refused outright. Prints: (nothing) | present | linked |
# planned | kept (a regular file there is left alone) | failed.
link_npm_bin() {
  local link="$LINK_DIR/$1" target="$NPM_BIN_DIR/$1"
  [ -n "$NPM_BIN_DIR" ] && [ -x "$target" ] || return 0
  case "$NPM_BIN_DIR" in "$LINK_DIR"|"$SYSTEM_BIN_DIR") return 0 ;; esac
  if in_service_home "$target"; then return 0; fi
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then echo present; return 0; fi
  if [ -e "$link" ] && [ ! -L "$link" ]; then echo kept; return 0; fi
  if [ "$DRY_RUN" = 1 ]; then echo planned; return 0; fi
  if mkdir -p "$LINK_DIR" 2>/dev/null && ln -sfn "$target" "$link" 2>/dev/null; then echo linked; else echo failed; fi
}

# Node floors from each package's `engines` field (npm view <pkg> engines).
# Packages without one are absent. This script warns and never upgrades node.
npm_node_floor() {
  case "$1" in
    "$CLAUDE_NPM_PACKAGE") echo 22.0.0 ;;
    @openai/codex) echo 16.0.0 ;;
    @google/gemini-cli) echo 20.0.0 ;;
    @earendil-works/pi-coding-agent) echo 22.19.0 ;;
  esac
}
NODE_VERSION="$(node --version 2>/dev/null </dev/null | sed -nE 's/^v([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' || true)"
# Why the box's node cannot run <package>, or nothing when it can.
node_floor_problem() {
  local floor
  floor="$(npm_node_floor "$1")"
  [ -n "$floor" ] || return 0
  if [ -z "$NODE_VERSION" ]; then
    echo "$1 needs node >= $floor and no node was found"
  elif ! version_ge "$NODE_VERSION" "$floor"; then
    echo "$1 needs node >= $floor (its engines field) but the box has node $NODE_VERSION; upgrade node (this script never does) and run it again"
  fi
  return 0
}

# The EC2 instance role's name via IMDSv2, or nothing (not on EC2, IMDS off, no
# role attached). Off AWS the token request fails fast: 169.254.169.254 either
# answers 4xx or drops the connection, and both end the probe in seconds.
instance_role() {
  local token role
  command -v curl >/dev/null 2>&1 || return 0
  token="$(curl -fsS -m 3 --retry 1 -X PUT "$IMDS_URL/latest/api/token" \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null </dev/null || true)"
  [ -n "$token" ] || return 0
  role="$(curl -fsS -m 3 --retry 1 -H "X-aws-ec2-metadata-token: $token" \
    "$IMDS_URL/latest/meta-data/iam/security-credentials/" 2>/dev/null </dev/null | head -n 1 || true)"
  case "$role" in ''|*[!A-Za-z0-9+=,.@_-]*) return 0 ;; esac
  echo "$role"
}

mode_note=""
if [ "$DRY_RUN" = 1 ]; then mode_note=", DRY RUN"; fi
echo "==> Walnut agent harness (user $WALNUT_USER, home $WALNUT_HOME_DIR$mode_note)"

# ── 1. Claude Code settings: Bedrock via the instance role ───────────────────
# Before the install, so Claude Code's very first run (the installer runs it)
# already sees DISABLE_TELEMETRY.
step "Claude Code settings ($SETTINGS_FILE)"
INSTANCE_ROLE="$(instance_role)"
# How Claude Code authenticates on this box; empty = no credential found.
CLAUDE_AUTH=""
if [ -e "$SETTINGS_FILE" ] || [ -L "$SETTINGS_FILE" ]; then
  CLAUDE_AUTH="the operator's settings.json"
  # Read as the service user: the file (or a link in its place) is theirs.
  if as_walnut grep -q CLAUDE_CODE_USE_BEDROCK "$SETTINGS_FILE" </dev/null 2>/dev/null; then
    kept_region="$(as_walnut sed -nE 's/.*"AWS_REGION"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$SETTINGS_FILE" </dev/null 2>/dev/null | head -n 1 || true)"
    case "$kept_region" in *[!a-z0-9-]*) kept_region="" ;; esac
    if [ "$REGION_ASKED" = 1 ] && [ -n "$kept_region" ] && [ "$kept_region" != "$BEDROCK_REGION" ]; then
      record settings.json present "kept as is (Bedrock in $kept_region, not the requested $BEDROCK_REGION; edit the file to move it)"
    else
      record settings.json present "kept as is"
    fi
    if [ -n "$INSTANCE_ROLE" ]; then CLAUDE_AUTH="Bedrock with instance role $INSTANCE_ROLE"; fi
  else
    record settings.json present "kept as is (it does not set CLAUDE_CODE_USE_BEDROCK, so Claude Code auth is whatever it configures)"
  fi
elif [ -z "$INSTANCE_ROLE" ]; then
  record settings.json skipped "no EC2 instance role found (not on AWS, or no role attached), so there is no Bedrock credential to point at"
elif [ "$DRY_RUN" = 1 ]; then
  record settings.json planned "Bedrock in $BEDROCK_REGION through instance role $INSTANCE_ROLE"
  CLAUDE_AUTH="Bedrock with instance role $INSTANCE_ROLE"
else
  # No credentials and no base URL: the AWS SDK's default chain finds the
  # instance role, and there is no Bedrock proxy on the box.
  settings_json="{
  \"\$schema\": \"https://json.schemastore.org/claude-code-settings.json\",
  \"env\": {
    \"CLAUDE_CODE_USE_BEDROCK\": \"1\",
    \"AWS_REGION\": \"$BEDROCK_REGION\",
    \"DISABLE_TELEMETRY\": \"1\",
    \"DISABLE_ERROR_REPORTING\": \"1\"
  }
}
"
  # shellcheck disable=SC2016  # $1 and $2 are expanded by the inner shell, as walnut
  if as_walnut bash -c 'set -e; umask 077; mkdir -p "$(dirname "$1")"; tmp="$1.tmp-harness-$$"; printf %s "$2" > "$tmp"; mv -f "$tmp" "$1"' \
      write-settings "$SETTINGS_FILE" "$settings_json"
  then
    record settings.json written "Bedrock in $BEDROCK_REGION through instance role $INSTANCE_ROLE"
    CLAUDE_AUTH="Bedrock with instance role $INSTANCE_ROLE"
    RESTART_NEEDED=1
  else
    record settings.json warned "could not write it as $WALNUT_USER (see above)"
  fi
fi
if [ -z "$CLAUDE_AUTH" ] && [ -e "$CREDENTIALS_FILE" ]; then CLAUDE_AUTH="a claude login"; fi

# ── 2. Claude Code ───────────────────────────────────────────────────────────
# No /usr/local/bin/claude link, on purpose: its target would be a file the
# service user can rewrite, on root's PATH. The service finds ~/.local/bin/claude
# without one (see effective_cli).
step "Claude Code (minimum $CLAUDE_MIN_VERSION)"
drop_home_link claude
CLAUDE_READY=0
CLAUDE_STATUS=warned
claude_link=""
claude_bin=""
claude_version=""
refresh_claude() {
  claude_bin="$(effective_cli claude)"
  claude_version=""
  if [ -n "$claude_bin" ]; then claude_version="$(version_of "$claude_bin")"; fi
}
claude_ok() { [ -n "$claude_version" ] && version_ge "$claude_version" "$CLAUDE_MIN_VERSION"; }

install_claude_native() {
  echo "    installing with the native installer as $WALNUT_USER"
  as_walnut ${INSTALL_TIMEOUT[@]+"${INSTALL_TIMEOUT[@]}"} bash -c "set -o pipefail; curl $CURL_OPTS '$CLAUDE_INSTALL_URL' | bash" </dev/null || true
}
install_claude_npm() {
  local problem
  if ! command -v npm >/dev/null 2>&1; then echo "    npm not found; no npm fallback"; return 0; fi
  problem="$(node_floor_problem "$CLAUDE_NPM_PACKAGE")"
  if [ -n "$problem" ]; then echo "    no npm fallback: $problem"; return 0; fi
  echo "    installing with npm install -g $CLAUDE_NPM_PACKAGE"
  ${INSTALL_TIMEOUT[@]+"${INSTALL_TIMEOUT[@]}"} npm install -g --no-fund --no-audit "$CLAUDE_NPM_PACKAGE" </dev/null || true
  NPM_BIN_DIR="$(npm_global_bin)"
  claude_link="$(link_npm_bin claude)"
}

refresh_claude
if [ -n "$claude_bin" ] && ! claude_ok; then
  echo "    $claude_bin is ${claude_version:-not a working claude}, older than $CLAUDE_MIN_VERSION"
fi
if claude_ok; then
  CLAUDE_READY=1
  CLAUDE_STATUS=present
  record claude-code present "$claude_version at $claude_bin"
elif [ "$DRY_RUN" = 1 ]; then
  CLAUDE_READY=1
  CLAUDE_STATUS=planned
  record claude-code planned "install via $CLAUDE_INSTALL_URL as $WALNUT_USER, npm $CLAUDE_NPM_PACKAGE as fallback"
else
  # A stale npm-managed claude first on the PATH is upgraded in place by npm;
  # anything else gets the native installer first (it keeps itself updated).
  order="native npm"
  if [ -n "$NPM_BIN_DIR" ] && [ "$claude_bin" = "$NPM_BIN_DIR/claude" ]; then order="npm native"; fi
  for method in $order; do
    if [ "$method" = native ]; then install_claude_native; else install_claude_npm; fi
    refresh_claude
    if claude_ok; then break; fi
  done
  if claude_ok; then
    CLAUDE_READY=1
    CLAUDE_STATUS=installed
    RESTART_NEEDED=1
    record claude-code installed "$claude_version at $claude_bin${claude_link:+ ($LINK_DIR/claude $claude_link)}"
  elif [ -n "$claude_bin" ] && [ "$claude_bin" != "$WALNUT_HOME_DIR/.local/bin/claude" ]; then
    record claude-code warned "$claude_bin (first on the service's PATH) is ${claude_version:-not a working claude}, older than $CLAUDE_MIN_VERSION, and shadows any newer install; remove or upgrade it and run again"
  else
    record claude-code warned "could not install claude >= $CLAUDE_MIN_VERSION (native installer and npm both failed; see above)"
  fi
fi

# ── 3. The default engine's CLI ──────────────────────────────────────────────
engine_source="--engine"
if [ -z "$ENGINE" ]; then
  configured=""
  if command -v node >/dev/null 2>&1 && [ -e "$CONFIG_FILE" ]; then
    configured="$(as_walnut "$(command -v node)" "$SEED_SCRIPT" --config "$CONFIG_FILE" --repo "$REPO_DIR" --print-engine </dev/null 2>/dev/null || true)"
  fi
  if [ -n "$configured" ] && is_engine_id "$configured"; then
    ENGINE="$configured"; engine_source="config.yaml"
  else
    if [ -n "$configured" ]; then echo "    config.yaml names an unknown engine '$configured'; using claude"; fi
    ENGINE=claude; engine_source="default"
  fi
fi
step "Default engine: $ENGINE (from $engine_source)"

engine_binary() { if [ "$1" = custom ]; then return 0; fi; echo "$1"; }
engine_npm_package() {
  case "$1" in
    codex) echo @openai/codex ;;
    gemini) echo @google/gemini-cli ;;
    opencode) echo opencode-ai ;;
    pi) echo @earendil-works/pi-coding-agent ;;
    dsh) echo @deepseek-ai/dsh ;;
  esac
}
engine_min_version() { if [ "$1" = pi ]; then echo 0.80.4; fi; }
engine_install_hint() {
  if [ "$1" = goose ]; then echo "curl -fsSL $GOOSE_INSTALL_URL | CONFIGURE=false bash (as $WALNUT_USER)"; return 0; fi
  echo "npm install -g $(engine_npm_package "$1")"
}

# The CLI the service would run for the engine, when it meets the engine's
# minimum version (if it has one); otherwise nothing.
find_engine_cli() {
  local cli min v
  cli="$(effective_cli "$(engine_binary "$1")")"
  min="$(engine_min_version "$1")"
  [ -n "$cli" ] || return 0
  if [ -n "$min" ]; then
    v="$(version_of "$cli")"
    if [ -z "$v" ] || ! version_ge "$v" "$min"; then
      echo "    $cli is ${v:-not a working $1}, older than $min" >&2
      return 0
    fi
  fi
  echo "$cli"
}

install_engine_cli() {
  if [ "$1" = goose ]; then
    # The release asset is a .tar.bz2; a minimal image may lack bzip2.
    if ! command -v bzip2 >/dev/null 2>&1; then
      if command -v dnf >/dev/null 2>&1; then
        ${INSTALL_TIMEOUT[@]+"${INSTALL_TIMEOUT[@]}"} dnf install -y bzip2 </dev/null || true
      elif command -v apt-get >/dev/null 2>&1; then
        DEBIAN_FRONTEND=noninteractive ${INSTALL_TIMEOUT[@]+"${INSTALL_TIMEOUT[@]}"} apt-get install -y bzip2 </dev/null || true
      fi
    fi
    # CONFIGURE=false: the installer otherwise starts an interactive `goose configure`.
    as_walnut ${INSTALL_TIMEOUT[@]+"${INSTALL_TIMEOUT[@]}"} bash -c \
      "set -o pipefail; curl $CURL_OPTS '$GOOSE_INSTALL_URL' | CONFIGURE=false GOOSE_BIN_DIR=\"\$HOME/.local/bin\" bash" </dev/null
    return
  fi
  command -v npm >/dev/null 2>&1 || { echo "    npm not found" >&2; return 1; }
  ${INSTALL_TIMEOUT[@]+"${INSTALL_TIMEOUT[@]}"} npm install -g --no-fund --no-audit "$(engine_npm_package "$1")" </dev/null
}

ENGINE_READY=0
ENGINE_CLI=""
case "$ENGINE" in
  claude)
    ENGINE_READY="$CLAUDE_READY"
    record "engine:claude" "$CLAUDE_STATUS" "same CLI as claude-code above"
    ;;
  custom)
    record "engine:custom" skipped "its adapter command comes from engines.custom.adapter_cmd in config.yaml; nothing to install, defaults.engine not seeded"
    ;;
  *)
    bin="$(engine_binary "$ENGINE")"
    pkg="$(engine_npm_package "$ENGINE")"
    floor_problem=""
    if [ -n "$pkg" ]; then floor_problem="$(node_floor_problem "$pkg")"; fi
    drop_home_link "$bin"
    cli="$(find_engine_cli "$ENGINE")"
    how=present
    link=""
    if [ -n "$floor_problem" ]; then
      # Not installed and not seeded as the default: a CLI node cannot run
      # would turn every Walnut-started session on the box into a failure.
      record "engine:$ENGINE" warned "$floor_problem; the box keeps claude as its default meanwhile"
    elif [ -z "$cli" ] && [ "$DRY_RUN" = 1 ]; then
      record "engine:$ENGINE" planned "install via $(engine_install_hint "$ENGINE")"
      ENGINE_READY=1
    elif [ -z "$cli" ]; then
      echo "    installing via $(engine_install_hint "$ENGINE")"
      if install_engine_cli "$ENGINE"; then
        NPM_BIN_DIR="$(npm_global_bin)"
        link="$(link_npm_bin "$bin")"
        cli="$(find_engine_cli "$ENGINE")"
        how=installed
      fi
    fi
    if [ -z "$floor_problem" ] && [ -n "$cli" ]; then
      ENGINE_CLI="$cli"
      # npm -g lands in /usr/bin on both images, already on the unit's PATH.
      # ~/.local/bin (goose) needs no link: Walnut's engine lookup and every
      # session spawn's PATH include it (see effective_cli).
      case "$(dirname "$cli")" in
        "$WALNUT_HOME_DIR/.local/bin") where="found through ~/.local/bin" ;;
        *) if [ -n "$link" ]; then where="$LINK_DIR/$bin $link to $NPM_BIN_DIR/$bin"; else where="on PATH"; fi ;;
      esac
      ENGINE_READY=1
      record "engine:$ENGINE" "$how" "$(version_of "$cli") at $cli ($where)"
      if [ "$how" = installed ]; then RESTART_NEEDED=1; fi
    elif [ -z "$floor_problem" ] && [ "$DRY_RUN" = 0 ]; then
      record "engine:$ENGINE" warned "install failed ($(engine_install_hint "$ENGINE")); the box falls back to claude for Walnut-started work"
    fi
    ;;
esac
if [ "$ENGINE" = claude ]; then
  if [ -n "$CLAUDE_AUTH" ]; then
    record engine-auth skipped "Claude Code uses $CLAUDE_AUTH; nothing to configure"
  else
    record engine-auth warned "Claude Code has no credential here; sign it in (sudo -u $WALNUT_USER -H claude) and run this script again"
  fi
elif [ "$ENGINE" = custom ]; then
  record engine-auth skipped "out of scope: configure engines.custom (its adapter command and auth) on the box yourself"
else
  record engine-auth skipped "out of scope: sign $ENGINE in on the box yourself (sudo -u $WALNUT_USER -H ${ENGINE_CLI:-$ENGINE})"
fi

# ── 4. systemd drop-in: a real shell for the session daemon ──────────────────
step "systemd drop-in ($DROPIN_FILE)"
DROPIN_CONTENT="# Written by scripts/cloud/ensure-harness.sh. The session daemon spawns the
# agent CLI through \$SHELL, and systemd sets SHELL from passwd for a unit with
# User=, which for this service user is a nologin shell.
[Service]
Environment=SHELL=/bin/bash"
if [ -f "$DROPIN_FILE" ] && [ "$(cat "$DROPIN_FILE")" = "$DROPIN_CONTENT" ]; then
  record "systemd drop-in" present "SHELL=/bin/bash"
elif [ "$DRY_RUN" = 1 ]; then
  record "systemd drop-in" planned "SHELL=/bin/bash, then systemctl daemon-reload"
else
  mkdir -p "$(dirname "$DROPIN_FILE")"
  tmp="$DROPIN_FILE.tmp-harness-$$"
  printf '%s\n' "$DROPIN_CONTENT" > "$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$DROPIN_FILE"
  RESTART_NEEDED=1
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload
    record "systemd drop-in" written "SHELL=/bin/bash (daemon-reload done)"
  else
    record "systemd drop-in" warned "written, but systemctl is missing; reload systemd yourself"
  fi
fi

# ── 5. config.yaml: cloud exec on, default engine ────────────────────────────
step "Walnut config ($CONFIG_FILE)"
seed_args=(--config "$CONFIG_FILE" --repo "$REPO_DIR")
seed_keys=0
if [ "$CLAUDE_READY" = 0 ]; then
  record cloud.exec skipped "Claude Code is not usable, so the box stays a relay; run this script again once the install works"
elif [ -z "$CLAUDE_AUTH" ]; then
  record cloud.exec skipped "Claude Code has no credential (no instance role, settings.json or login), so the box stays a relay; sign it in (sudo -u $WALNUT_USER -H claude) and run this script again"
else
  # shellcheck disable=SC2016  # $1 below is expanded by the inner shell, as walnut
  if [ -d "$WORK_DIR" ]; then
    record "work dir" present "$WORK_DIR"
  elif [ "$DRY_RUN" = 1 ]; then
    record "work dir" planned "$WORK_DIR"
  elif as_walnut bash -c 'umask 027; mkdir -p "$1"' mkdir-work "$WORK_DIR" </dev/null; then
    record "work dir" written "$WORK_DIR"
  else
    record "work dir" warned "could not create $WORK_DIR as $WALNUT_USER"
  fi
  if [ "$DRY_RUN" = 1 ] || [ -d "$WORK_DIR" ]; then
    seed_args+=(--exec-root "$WORK_DIR")
    seed_keys=1
  fi
fi
# A default engine is seeded only once its CLI is verified (a later run seeds it
# after a failed install), and custom never: its adapter argv is machine-local
# config this script cannot carry.
if [ "$ENGINE_READY" = 1 ] && [ "$ENGINE" != custom ]; then seed_args+=(--engine "$ENGINE"); seed_keys=1; fi
if [ "$DRY_RUN" = 1 ]; then seed_args+=(--dry-run); fi

if [ "$seed_keys" = 1 ]; then
  if ! command -v node >/dev/null 2>&1; then
    record config.yaml warned "node not found; nothing seeded"
  else
    err_file="$(mktemp "${TMPDIR:-/tmp}/walnut-harness.XXXXXX")"
    if seed_out="$(as_walnut "$(command -v node)" "$SEED_SCRIPT" "${seed_args[@]}" </dev/null 2>"$err_file")"; then
      while IFS=$'\t' read -r key status detail; do
        [ -n "$key" ] || continue
        record "$key" "$status" "$detail"
        if [ "$status" = seeded ]; then RESTART_NEEDED=1; fi
        if [ "$key" = defaults.engine ] && [ "$status" = present ] && [ "$detail" != "kept \"$ENGINE\"" ]; then
          echo "    note: config.yaml keeps its own defaults.engine ($detail); edit it there to change the box's default"
        fi
      done <<< "$seed_out"
    else
      record config.yaml warned "$(tr '\n' ' ' < "$err_file")"
    fi
    rm -f "$err_file"
  fi
fi

echo "==> harness summary"
for line in "${SUMMARY[@]}"; do echo "$line"; done
if [ "$DRY_RUN" = 1 ]; then
  echo "  (dry run: nothing was changed)"
elif [ "$RESTART_NEEDED" = 1 ]; then
  echo "  restart:               needed    systemctl restart walnut (this script never restarts it)"
else
  echo "  restart:               no        nothing changed"
fi

if [ "$DRY_RUN" = 0 ] && [ "$CLAUDE_READY" = 0 ]; then exit 1; fi
exit 0
