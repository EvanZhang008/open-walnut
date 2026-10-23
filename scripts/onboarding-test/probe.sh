#!/bin/bash
# probe.sh — runs ON a brand-new machine and does exactly what the README tells a new
# user to do, timing every step and writing down each place a human would have had to
# stop and figure something out. It never repairs the product; it only reports.
#
#   bash probe.sh [--path installer,readme,npm] [--repo URL] [--ref main] [--pkg open-walnut@latest]
#                 [--installer-url URL] [--out DIR] [--installer-port 3459] [--readme-port 3456]
#                 [--npm-port 3458] [--ready-timeout 900]
#   bash probe.sh --stop [--out DIR]        # stop only the servers this probe started
#
# The three README routes, each on its own port:
#   installer  curl -fsSL .../install.sh | sh, then walnut web (needs nothing first)
#   readme     the checkout: git, then Bun (curl -fsSL https://bun.sh/install | bash),
#              git clone, bun install, bun run start. No Node anywhere.
#   npm        npm install -g open-walnut, then open-walnut web. The one route that needs
#              Node: when npm is missing it installs Node LTS with nvm, as a person would.
#
# Output (all under --out, default ~/walnut-onb):
#   steps.jsonl      one JSON object per step: name, status ok|fail|skip, seconds, note, finding
#   logs/NN-step.log full output of that step
#   pids             PIDs of servers left running for the operator's screenshot/video
#
# Must stay bash 3.2 compatible: macOS ships bash 3.2 and a fresh Mac has nothing else.

set -u

PATHS="installer,readme,npm"
REPO="https://github.com/EvanZhang008/open-walnut.git"
REF="main"
PKG="open-walnut@latest"
INSTALLER_URL="https://github.com/EvanZhang008/open-walnut/releases/latest/download/install.sh"
OUT="$HOME/walnut-onb"
INSTALLER_PORT=3459
README_PORT=3456
NPM_PORT=3458
READY_TIMEOUT=900
STOP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --path) PATHS="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --pkg) PKG="$2"; shift 2 ;;
    --installer-url) INSTALLER_URL="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --installer-port) INSTALLER_PORT="$2"; shift 2 ;;
    --readme-port) README_PORT="$2"; shift 2 ;;
    --npm-port) NPM_PORT="$2"; shift 2 ;;
    --ready-timeout) READY_TIMEOUT="$2"; shift 2 ;;
    --stop) STOP=1; shift ;;
    *) echo "probe: unknown arg $1" >&2; exit 2 ;;
  esac
done

case "$OUT" in /|"$HOME"|"$HOME/") echo "probe: --out must be a dedicated directory, not $OUT (it gets wiped)" >&2; exit 2 ;; esac
mkdir -p "$OUT/logs"
STEPS="$OUT/steps.jsonl"
PIDS="$OUT/pids"

# ── stop mode: kill exactly the PIDs we recorded, nothing else ─────────────────
if [ "$STOP" = 1 ]; then
  [ -f "$PIDS" ] || { echo "probe: nothing to stop"; exit 0; }
  while IFS= read -r pid; do
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    [ "$pid" -gt 1 ] || continue
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null && echo "probe: stopped pid $pid"
    fi
  done < "$PIDS"
  : > "$PIDS"
  exit 0
fi

# ── narration + bookkeeping ────────────────────────────────────────────────────
B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; C=$'\033[36m'; O=$'\033[0m'
STEP_N=0; STEP_NAME=""; STEP_T0=0; STEP_LOG=""

say()   { printf '%s\n' "$*"; }
cmd()   { printf '%s$ %s%s\n' "$B" "$*" "$O"; }   # what the user would type

ESC=$'\033'
json_str() {  # escape a string for JSON; ANSI colour codes and other control bytes are
              # dropped first, since npm output carries them and one stray byte would make
              # the whole steps file unparseable.
  printf '%s' "$1" | sed -E "s/${ESC}\[[0-9;]*[A-Za-z]//g" | tr -d '\000-\010\013-\037\177' \
    | awk 'BEGIN{ORS=""} { gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); gsub(/\t/,"\\t"); if (NR>1) printf "\\n"; printf "%s", $0 }'
}

# PIDs listening on a TCP port: the servers we start are grandchildren of the recorded
# `bun run start`, so a TERM to bun alone would leave them running under --keep.
listeners_on_port() {
  if have lsof; then lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null
  elif have ss; then ss -Hltnp "sport = :$1" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p'
  fi | sort -u
}
# Anything already on the port means this is not a fresh machine: the probe would
# measure (and later stop) a server it did not start.
port_in_use() { [ -n "$(listeners_on_port "$1")" ] || curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$1/" 2>/dev/null; }

step_begin() {
  STEP_N=$((STEP_N + 1)); STEP_NAME="$1"; STEP_T0=$(date +%s)
  STEP_LOG="$OUT/logs/$(printf '%02d' "$STEP_N")-$(printf '%s' "$1" | tr ':/' '--').log"
  : > "$STEP_LOG"
  printf '\n%s▶ %s%s\n' "$C" "$1" "$O"
}

# step_end <ok|fail|skip> "<note>" "<finding or empty>"
step_end() {
  local status="$1" note="$2" finding="${3:-}" secs
  secs=$(( $(date +%s) - STEP_T0 ))
  printf '{"name":"%s","status":"%s","seconds":%d,"note":"%s","finding":"%s","log":"%s"}\n' \
    "$(json_str "$STEP_NAME")" "$status" "$secs" "$(json_str "$note")" "$(json_str "$finding")" "$(json_str "$STEP_LOG")" >> "$STEPS"
  case "$status" in
    ok)   printf '%s✓ %s%s %s(%ss)%s %s\n' "$G" "$STEP_NAME" "$O" "$D" "$secs" "$O" "$note" ;;
    skip) printf '%s· %s%s %s\n' "$D" "$STEP_NAME" "$O" "$note" ;;
    *)    printf '%s✗ %s%s %s(%ss)%s %s\n' "$R" "$STEP_NAME" "$O" "$D" "$secs" "$O" "$note" ;;
  esac
  [ -n "$finding" ] && printf '  %s⚑ finding:%s %s\n' "$Y" "$O" "$finding"
  return 0
}

# Run a command, teeing output to the step log and echoing the last lines live.
run_logged() {
  "$@" >> "$STEP_LOG" 2>&1
}

tail_log() { tail -n "${1:-5}" "$STEP_LOG" | sed 's/^/    │ /'; }

have() { command -v "$1" >/dev/null 2>&1; }
ver() { "$@" 2>/dev/null | head -1 | tr -d '\r' ; }

OS="$(uname -s)"; ARCH="$(uname -m)"
IS_MAC=0; [ "$OS" = Darwin ] && IS_MAC=1

want_path() { case ",$PATHS," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

# Poll a health URL until it answers 200 or the server process dies or timeout.
# Sets READY_SECS on success. Returns 1 dead, 2 timeout.
wait_ready() {
  local url="$1" pid="$2" t0 elapsed code
  t0=$(date +%s)
  while :; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || true)
    if [ "$code" = 200 ]; then READY_SECS=$(( $(date +%s) - t0 )); return 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then return 1; fi
    elapsed=$(( $(date +%s) - t0 ))
    if [ "$elapsed" -ge "$READY_TIMEOUT" ]; then return 2; fi
    if [ $((elapsed % 15)) -eq 0 ] && [ "$elapsed" -gt 0 ]; then
      printf '  %s… still building/starting (%ss)%s\n' "$D" "$elapsed" "$O"
      tail -n 1 "$STEP_LOG" | cut -c1-140 | sed 's/^/    │ /'
    fi
    sleep 1
  done
}

# Pick the first line of a log that reads like the reason it failed.
first_error_line() {
  grep -m1 -E 'not found|ERR!|Error|error:|command not found|EACCES|ENOENT|failed|curl: \(|GLIBC_' "$STEP_LOG" | cut -c1-220
}

# One top-level field of a flat JSON object, read with sed: the machine may have no
# JavaScript runtime at all (the installer route needs none), so none is used here.
json_field() {
  printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\).*/\1/p" | head -n 1
}

health_note() {  # $1 base url -> "provider:false cli:false source:none | GET / -> 200 in 0.01s"
  local base="$1" h root ms summary
  h=$(curl -s --max-time 5 "$base/api/system/health" 2>/dev/null)
  ms=$(curl -s -o /dev/null -w '%{time_total}' --max-time 10 "$base/" 2>/dev/null)
  root=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$base/" 2>/dev/null)
  if [ -n "$(json_field "$h" hasReadyProvider)" ]; then
    summary="provider:$(json_field "$h" hasReadyProvider) cli:$(json_field "$h" claudeCliAvailable) source:$(json_field "$h" credentialSource)"
  else
    summary="health:(unparsed)"
  fi
  printf '%s | GET / -> %s in %ss' "$summary" "$root" "$ms"
}

# Start a server in the background on a port, wait for it, and record the steps
# <prefix>:start and <prefix>:first-run. $1 prefix, $2 port, $3 the command as a user
# types it, then the command to run. Sets SERVER_PID ("" when the port was taken).
start_and_check() {
  local prefix="$1" port="$2" shown="$3" rc
  shift 3
  step_begin "$prefix:start"
  SERVER_PID=""
  if port_in_use "$port"; then
    step_end fail "port $port already has a listener; this is not a fresh machine" "Something already listens on $port here, so the probe cannot tell its own server from it. Run the probe on a fresh machine."
    step_begin "$prefix:first-run"; step_end skip "port was not free"
    return 0
  fi
  cmd "$shown"
  "$@" >> "$STEP_LOG" 2>&1 &
  SERVER_PID=$!
  echo "$SERVER_PID" >> "$PIDS"
  say "  waiting for http://127.0.0.1:$port/api/system/health (timeout ${READY_TIMEOUT}s)"
  if wait_ready "http://127.0.0.1:$port/api/system/health" "$SERVER_PID"; then
    listeners_on_port "$port" >> "$PIDS"
    step_end ok "server ready in ${READY_SECS}s"
    step_begin "$prefix:first-run"
    step_end ok "$(health_note "http://127.0.0.1:$port")"
  else
    rc=$?
    tail_log 8
    if [ "$rc" = 1 ]; then
      step_end fail "'$shown' exited before the server came up: $(first_error_line)" "'$shown' on a fresh machine fails: $(first_error_line). A user following the README stops here."
    else
      step_end fail "server not ready after ${READY_TIMEOUT}s" "'$shown' did not serve within ${READY_TIMEOUT}s on this machine."
    fi
    step_begin "$prefix:first-run"; step_end skip "server never came up"
  fi
}

say "${B}Open Walnut onboarding probe${O}  ${D}$(date -u +%Y-%m-%dT%H:%M:%SZ) · $OS $ARCH · paths: $PATHS${O}"
: > "$STEPS"; : > "$PIDS"

# ── 0. what does a fresh machine come with? ────────────────────────────────────
step_begin "system"
inv=""
for t in git curl bun node npm brew claude walnut open-walnut; do
  if have "$t"; then inv="$inv $t=$(ver "$t" --version | cut -c1-24 | tr ' ' '_')"; else inv="$inv $t=missing"; fi
done
if [ "$IS_MAC" = 1 ]; then
  osv="macOS $(sw_vers -productVersion 2>/dev/null)"
  if xcode-select -p >/dev/null 2>&1; then inv="$inv xcode-clt=present"; else inv="$inv xcode-clt=missing"; fi
else
  osv="$(. /etc/os-release 2>/dev/null; printf '%s' "${PRETTY_NAME:-$OS}")"
fi
say "  $osv ($ARCH)"; say " $inv"
step_end ok "$osv;$inv"

# ── installer path: curl … install.sh | sh → walnut web (the README's first route) ──
if want_path installer; then
  step_begin "installer:install"
  cmd "curl -fsSL $INSTALLER_URL | sh"
  WALNUT_CMD=""
  # pipefail: a download that fails hands sh an empty script, which "succeeds".
  if run_logged bash -c 'set -o pipefail; curl -fsSL "$1" | sh' bash "$INSTALLER_URL"; then
    hash -r 2>/dev/null || true
    if have walnut; then
      WALNUT_CMD="$(command -v walnut)"
      step_end ok "$(ver walnut --version | cut -c1-40) at $WALNUT_CMD"
    elif [ -x "$HOME/.local/bin/walnut" ]; then
      # Carry on with the full path, the way a person reads the installer's own hint.
      WALNUT_CMD="$HOME/.local/bin/walnut"
      step_end ok "$(ver "$WALNUT_CMD" --version | cut -c1-40); ~/.local/bin is not on PATH" "The installer put walnut in ~/.local/bin, which is not on this machine's PATH: 'walnut web' as the README writes it is 'command not found' until the user adds it (the installer prints the line)."
    else
      tail_log 8; step_end fail "the installer finished but there is no walnut: $(first_error_line)" "The one-line installer reported success and left no walnut command."
    fi
  else
    tail_log 8; step_end fail "install failed: $(first_error_line)" "The one-line installer fails on a fresh machine: $(first_error_line)"
  fi
  if [ -n "$WALNUT_CMD" ]; then
    mkdir -p "$OUT/installer-home" "$OUT/installer-daemon"
    start_and_check installer "$INSTALLER_PORT" "walnut web --port $INSTALLER_PORT" \
      env OPEN_WALNUT_HOME="$OUT/installer-home" WALNUT_DAEMON_DIR="$OUT/installer-daemon" "$WALNUT_CMD" web --port "$INSTALLER_PORT"
  fi
else
  step_begin "installer:install"; step_end skip "path not requested"
fi

# ── git: the checkout clones with it, and nvm (the npm route) installs with it ──
# The installer route above ran first, on the machine as it came: it needs no git.
step_begin "prereq:git"
if ! want_path readme && ! want_path npm; then
  step_end skip "only the installer route was requested"
elif [ "$IS_MAC" = 1 ] && ! xcode-select -p >/dev/null 2>&1; then
  say "  git on a fresh Mac needs the Xcode Command Line Tools; installing headlessly (a real user gets a GUI dialog here)"
  cmd "xcode-select --install"
  touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  label=$(softwareupdate -l 2>&1 | grep -E 'Label: Command Line Tools' | sed -E 's/^\* Label: //' | sort | tail -1)
  if [ -n "$label" ]; then
    run_logged sudo softwareupdate -i "$label" --verbose
  else
    echo "no CLT label from softwareupdate -l" >> "$STEP_LOG"
  fi
  rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  if xcode-select -p >/dev/null 2>&1 && git --version >/dev/null 2>&1; then
    step_end ok "installed Xcode CLT ($label)" "A brand-new Mac has no git: 'git clone' pops the Xcode Command Line Tools installer (several minutes, GUI dialog). The README does not mention it."
  else
    tail_log 5
    step_end fail "could not install Xcode CLT: $(first_error_line)" "A brand-new Mac has no git and the Command Line Tools install could not be automated here."
  fi
elif have git; then
  step_end ok "$(ver git --version)"
else
  say "  git is not installed; installing with the OS package manager"
  if have dnf; then cmd "sudo dnf install -y git"; run_logged sudo dnf install -y git
  elif have yum; then cmd "sudo yum install -y git"; run_logged sudo yum install -y git
  elif have apt-get; then cmd "sudo apt-get install -y git"; run_logged sudo apt-get update; run_logged sudo apt-get install -y git
  fi
  if have git; then step_end ok "$(ver git --version)" "A fresh Linux box has no git. The README's Requirements now gives the install line; this is the time it costs."
  else tail_log 5; step_end fail "git install failed: $(first_error_line)" "A fresh Linux box has no git and the README does not say how to get it."; fi
fi

# glibc helpers (Linux only; empty elsewhere). Only the npm route's finding reads them.
glibc_version() { getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}'; }
glibc_at_least() { local v; v=$(glibc_version); [ -n "$v" ] || return 1; [ "${v%%.*}" -gt "$1" ] 2>/dev/null || { [ "${v%%.*}" -eq "$1" ] && [ "${v#*.}" -ge "$2" ]; } 2>/dev/null; }

# ── Bun, for the checkout route (README: `curl -fsSL https://bun.sh/install | bash`) ──
if want_path readme; then
  step_begin "prereq:bun"
  if have bun; then
    step_end ok "already present: $(ver bun --version)"
  else
    say "  README says a checkout needs Bun and nothing else; using the installer it gives"
    cmd "curl -fsSL https://bun.sh/install | bash"
    run_logged bash -c 'curl -fsSL https://bun.sh/install | bash'
    export PATH="$HOME/.bun/bin:$PATH"; hash -r 2>/dev/null || true
    if have bun; then
      step_end ok "installed $(ver bun --version)" "Bun is not preinstalled. The README's Requirements gives the installer line; this is the time it costs."
    else
      tail_log 5; step_end fail "bun not available after its installer: $(first_error_line)" "Installing Bun failed following the README: $(first_error_line)"
    fi
  fi
fi

# ── README path: git clone → bun install → bun run start ──────────────────────
README_DIR="$OUT/open-walnut"
if want_path readme; then
  step_begin "readme:git-clone"
  cmd "git clone $REPO"
  rm -rf "$README_DIR"
  clone_ref() {  # `git clone --branch` takes branches and tags only; a commit needs fetch + checkout
    if echo "$REF" | grep -qE '^[0-9a-f]{7,40}$'; then
      run_logged git clone --depth 1 "$REPO" "$README_DIR" \
        && run_logged git -C "$README_DIR" fetch --depth 1 origin "$REF" \
        && run_logged git -C "$README_DIR" checkout -q FETCH_HEAD
    else
      run_logged git clone --depth 1 --branch "$REF" "$REPO" "$README_DIR"
    fi
  }
  if clone_ref; then
    step_end ok "$(du -sh "$README_DIR" 2>/dev/null | cut -f1) checked out ($REF)"
  else
    tail_log 5; step_end fail "clone failed: $(first_error_line)"
  fi

  if [ -d "$README_DIR" ] && have bun; then
    step_begin "readme:bun-install"
    cmd "cd open-walnut && bun install"
    if (cd "$README_DIR" && run_logged bun install); then
      warns=$(grep -c -E '^warn:' "$STEP_LOG" || true)
      step_end ok "ok; $warns bun warnings; $(du -sh "$README_DIR/node_modules" 2>/dev/null | cut -f1) node_modules"
    elif grep -q -E 'node-gyp|gyp ERR|gyp info' "$STEP_LOG"; then
      # The README promises Bun and nothing else, so a native build from source is the finding.
      tail_log 12; step_end fail "a dependency built from source and failed: $(first_error_line)" "'bun install' compiles a native module on this machine (node-gyp: Python, make and a C++ compiler), which the README's Bun-only checkout does not mention: $(first_error_line)"
    else
      tail_log 8; step_end fail "bun install failed: $(first_error_line)" "'bun install' fails on a fresh machine: $(first_error_line)"
    fi

    start_and_check readme "$README_PORT" "bun run start" sh -c 'cd "$1" && exec bun run start' sh "$README_DIR"
  elif [ -d "$README_DIR" ]; then
    step_begin "readme:bun-install"; step_end skip "no bun to install with"
  fi
else
  step_begin "readme:git-clone"; step_end skip "path not requested"
fi

# ── npm path: npm i -g open-walnut → open-walnut web ──────────────────────────
if want_path npm; then
  # The README: "the npm package needs only an npm (any Node 18 or newer)". A machine
  # without one gets Node LTS through nvm, the way a person most often does it.
  step_begin "prereq:npm"
  node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }
  if have npm && [ "$(node_major)" -ge 18 ] 2>/dev/null; then
    step_end ok "already present: npm $(ver npm --version), node $(ver node -v)"
  else
    say "  no npm here; installing Node LTS with nvm for the npm route"
    cmd "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && nvm install --lts"
    run_logged bash -c 'curl -fsSL -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash'
    export NVM_DIR="$HOME/.nvm"
    run_logged bash -c ". \"$NVM_DIR/nvm.sh\" && nvm install --lts && nvm alias default 'lts/*'"
    # shellcheck disable=SC1091
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm use default >/dev/null 2>&1
    hash -r 2>/dev/null || true
    if have npm && [ "$(node_major)" -ge 18 ] 2>/dev/null; then
      step_end ok "installed node $(ver node -v) via nvm" "The npm route needs Node and npm, which this machine lacks; the installer route needs neither. This is the time nvm costs."
    elif [ -n "$(glibc_version)" ] && ! glibc_at_least 2 28; then
      tail_log 5
      step_end fail "Node LTS cannot start on glibc $(glibc_version): $(first_error_line)" "Official Node builds need glibc 2.28 and this OS has $(glibc_version), so the npm route has no Node to run on here. The one-line installer needs no Node."
    else
      tail_log 5
      step_end fail "no npm after nvm: $(first_error_line)" "Installing Node with nvm failed here, so the npm route cannot start."
    fi
  fi

  if have npm && [ "$(node_major)" -ge 18 ] 2>/dev/null; then
    step_begin "npm:install-global"
    cmd "npm install -g $PKG"
    if run_logged npm install -g "$PKG"; then
      warns=$(grep -c -E '^npm (warn|WARN)' "$STEP_LOG" || true)
      hash -r 2>/dev/null
      # npm's own global bin: the installer route also links an open-walnut, into ~/.local/bin.
      NPM_WALNUT="$(npm prefix -g 2>/dev/null)/bin/open-walnut"
      on_path="$(command -v open-walnut 2>/dev/null || true)"
      if [ -x "$NPM_WALNUT" ] && [ "$on_path" = "$NPM_WALNUT" ]; then
        step_end ok "$(ver "$NPM_WALNUT" --version | cut -c1-40); $warns npm warnings"
      elif [ -x "$NPM_WALNUT" ] && [ "$on_path" = "$HOME/.local/bin/open-walnut" ] && want_path installer; then
        # The probe's own installer route put that one there; a person has one or the other.
        step_end ok "$(ver "$NPM_WALNUT" --version | cut -c1-40); $warns npm warnings; PATH finds the installer route's link first, so npm's own runs"
      elif [ -x "$NPM_WALNUT" ]; then
        step_end ok "$(ver "$NPM_WALNUT" --version | cut -c1-40); $warns npm warnings; 'open-walnut' on PATH is ${on_path:-nothing}" "After 'npm install -g open-walnut' the command on PATH is not npm's (${on_path:-none}): npm's global bin dir is not on PATH, or another install comes first."
      else
        NPM_WALNUT=""
        step_end fail "installed but npm's global bin has no open-walnut" "After 'npm install -g open-walnut' there is no open-walnut in npm's global bin dir ($(npm prefix -g 2>/dev/null)/bin)."
      fi
    else
      NPM_WALNUT=""
      tail_log 8; step_end fail "global install failed: $(first_error_line)" "'npm install -g open-walnut' fails on a fresh machine: $(first_error_line)"
    fi

    if [ -n "$NPM_WALNUT" ]; then
      mkdir -p "$OUT/npm-home" "$OUT/npm-daemon"
      start_and_check npm "$NPM_PORT" "open-walnut web --port $NPM_PORT" \
        env OPEN_WALNUT_HOME="$OUT/npm-home" WALNUT_DAEMON_DIR="$OUT/npm-daemon" "$NPM_WALNUT" web --port "$NPM_PORT"
    fi
  else
    step_begin "npm:install-global"; step_end skip "no working npm on this machine"
  fi
else
  step_begin "npm:install-global"; step_end skip "path not requested"
fi

say ""
say "${B}probe done${O} · steps: $STEPS · servers left running for capture: $(tr '\n' ' ' < "$PIDS")"
