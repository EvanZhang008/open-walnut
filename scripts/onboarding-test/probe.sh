#!/bin/bash
# probe.sh — runs ON a brand-new machine and does exactly what the README tells a new
# user to do, timing every step and writing down each place a human would have had to
# stop and figure something out. It never repairs the product; it only reports.
#
#   bash probe.sh [--path readme,npm] [--repo URL] [--ref main] [--pkg open-walnut@latest]
#                 [--out DIR] [--readme-port 3456] [--npm-port 3458] [--ready-timeout 900]
#   bash probe.sh --stop [--out DIR]        # stop only the servers this probe started
#
# Output (all under --out, default ~/walnut-onb):
#   steps.jsonl      one JSON object per step: name, status ok|fail|skip, seconds, note, finding
#   logs/NN-step.log full output of that step
#   pids             PIDs of servers left running for the operator's screenshot/video
#
# Must stay bash 3.2 compatible: macOS ships bash 3.2 and a fresh Mac has nothing else.

set -u

PATHS="readme,npm"
REPO="https://github.com/EvanZhang008/open-walnut.git"
REF="main"
PKG="open-walnut@latest"
OUT="$HOME/walnut-onb"
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
    --out) OUT="$2"; shift 2 ;;
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
# `npm start`, so a TERM to npm alone would leave them running under --keep.
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
  grep -m1 -E 'not found|ERR!|Error|error:|command not found|EACCES|ENOENT|failed' "$STEP_LOG" | cut -c1-220
}

health_note() {  # $1 base url -> "provider:false cli:false | GET / -> 200 in 0.01s"
  local base="$1" h root ms
  h=$(curl -s --max-time 5 "$base/api/system/health" 2>/dev/null)
  ms=$(curl -s -o /dev/null -w '%{time_total}' --max-time 10 "$base/" 2>/dev/null)
  root=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$base/" 2>/dev/null)
  printf '%s | GET / -> %s in %ss' \
    "$(printf '%s' "$h" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(`provider:${j.hasReadyProvider} cli:${j.claudeCliAvailable} source:${j.credentialSource??"none"}`)}catch{console.log("health:(unparsed)")}})')" \
    "$root" "$ms"
}

say "${B}Open Walnut onboarding probe${O}  ${D}$(date -u +%Y-%m-%dT%H:%M:%SZ) · $OS $ARCH · paths: $PATHS${O}"
: > "$STEPS"; : > "$PIDS"

# ── 0. what does a fresh machine come with? ────────────────────────────────────
step_begin "system"
inv=""
for t in node npm git bun brew curl claude; do
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

# ── 1. git (README step 1 is `git clone`) ─────────────────────────────────────
step_begin "prereq:git"
if [ "$IS_MAC" = 1 ] && ! xcode-select -p >/dev/null 2>&1; then
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

# ── 2. Node 22 (README: nodejs.org or `nvm install 22`) ───────────────────────
step_begin "prereq:node22"
node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }
# glibc helpers (Linux only; empty elsewhere)
glibc_version() { getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}'; }
glibc_at_least() { local v; v=$(glibc_version); [ -n "$v" ] || return 1; [ "${v%%.*}" -gt "$1" ] 2>/dev/null || { [ "${v%%.*}" -eq "$1" ] && [ "${v#*.}" -ge "$2" ]; } 2>/dev/null; }
if have node && [ "$(node_major)" -ge 22 ] 2>/dev/null; then
  step_end ok "already present: $(ver node -v)"
else
  say "  README says Node.js 22+; using the nvm route it suggests"
  cmd "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"
  run_logged bash -c 'curl -fsSL -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash'
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  cmd "nvm install 22"
  run_logged bash -c ". \"$NVM_DIR/nvm.sh\" && nvm install 22 && nvm alias default 22"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null 2>&1
  if have node && [ "$(node_major)" -ge 22 ] 2>/dev/null; then
    step_end ok "installed $(ver node -v) via nvm" "Node.js is not preinstalled. The README's Requirements now gives the nvm two-liner; this is the time it costs."
  elif [ -n "$(glibc_version)" ] && ! glibc_at_least 2 28; then
    # nvm "installed" a binary that cannot start here: official Node 20+ builds need
    # glibc 2.28. The community glibc-2.17 build is the only Node 22 that runs on this OS.
    say "  official Node binaries need glibc 2.28 and this OS has $(glibc_version); trying the community glibc-217 build"
    NODE_UNOFFICIAL_VER=$(curl -fsSL https://unofficial-builds.nodejs.org/download/release/index.tab | awk -F'\t' 'NR>1 && $1 ~ /^v22\./ && $0 ~ /linux-x64-glibc-217/ {print $1; exit}')
    # Its own prefix, like nvm's: unpacking into ~/.local would make ~/.local/bin npm's
    # global bin dir, where the server's own `walnut` shim already lives.
    cmd "curl -fsSL https://unofficial-builds.nodejs.org/download/release/$NODE_UNOFFICIAL_VER/node-$NODE_UNOFFICIAL_VER-linux-x64-glibc-217.tar.gz | tar -xz -C ~/.local/node22 --strip-components=1"
    mkdir -p "$HOME/.local/node22"
    run_logged bash -c "curl -fsSL https://unofficial-builds.nodejs.org/download/release/$NODE_UNOFFICIAL_VER/node-$NODE_UNOFFICIAL_VER-linux-x64-glibc-217.tar.gz | tar -xz -C \"$HOME/.local/node22\" --strip-components=1"
    export PATH="$HOME/.local/node22/bin:$PATH"; hash -r 2>/dev/null || true
    if have node && [ "$(node_major)" -ge 22 ] 2>/dev/null; then
      step_end ok "installed $(ver node -v) (community glibc-217 build)" "This OS has glibc $(glibc_version); the official Node 22 binaries need 2.28, so 'nvm install 22' completes and then node cannot start (GLIBC_2.28 not found). Getting Started's older-Linux section gives the community glibc-217 build; this is the time it costs."
    else
      tail_log 5
      step_end fail "no Node 22 runs on glibc $(glibc_version): $(first_error_line)" "Official Node 22 needs glibc 2.28 and the community glibc-217 build also failed here."
    fi
  else
    tail_log 5
    step_end fail "node 22 not available after nvm: $(first_error_line)" "Installing Node 22 failed following the README's nvm suggestion."
  fi
fi
have node || { say "${R}cannot continue without node${O}"; exit 1; }

# ── README path: git clone → npm install → npm start ──────────────────────────
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

  if [ -d "$README_DIR" ]; then
    step_begin "readme:npm-install"
    cmd "cd open-walnut && npm install"
    if (cd "$README_DIR" && run_logged npm install); then
      warns=$(grep -c -E '^npm (warn|WARN)' "$STEP_LOG" || true)
      step_end ok "ok; $warns npm warnings; $(du -sh "$README_DIR/node_modules" 2>/dev/null | cut -f1) node_modules"
    elif [ -f "$README_DIR/scripts/check-native-toolchain.mjs" ] && ! (cd "$README_DIR" && node scripts/check-native-toolchain.mjs >> "$STEP_LOG" 2>&1) && grep -q "Fix, then install again" "$STEP_LOG"; then
      # The native build failed and Walnut's own check (what `npm start` would run next)
      # printed the recipe. A user would paste it; do the same, and record whether the
      # printed advice actually works. The env it names stays exported for the npm route.
      fix_installs=$(sed -n '/Fix, then install again/,/npm install$/p' "$STEP_LOG" | grep -E '^\s+sudo ' | sed 's/^ *//')
      fix_npm=$(sed -n '/Fix, then install again/,/npm install$/p' "$STEP_LOG" | grep -E 'npm install$' | tail -1 | sed 's/^ *//')
      tail_log 14; step_end fail "native build failed (glibc $(glibc_version)); Walnut's check printed the recipe, following it" "This OS has glibc $(glibc_version): prebuilt native modules need 2.29+, so better-sqlite3 compiles and needs Python 3.8+ and GCC 10+, which the stock toolchain lacks. 'npm install' fails in node-gyp; Walnut's check explains and prints the commands."
      step_begin "readme:npm-install-fix"
      while IFS= read -r line; do [ -n "$line" ] && { cmd "$line"; run_logged bash -c "$line"; }; done <<< "$fix_installs"
      fix_env=$(printf '%s' "$fix_npm" | sed 's/ *npm install$//')
      [ -n "$fix_env" ] && { say "  exporting for the rest of the run: $fix_env"; export $fix_env; }
      cmd "$fix_npm"
      if [ -n "$fix_npm" ] && (cd "$README_DIR" && run_logged npm install); then
        step_end ok "the printed recipe worked; $(du -sh "$README_DIR/node_modules" 2>/dev/null | cut -f1) node_modules"
      else
        tail_log 12; step_end fail "the printed recipe did not work: $(first_error_line)" "The toolchain check's own advice failed on this OS: $(first_error_line)"
      fi
    else
      tail_log 8; step_end fail "npm install failed: $(first_error_line)" "'npm install' fails on a fresh machine: $(first_error_line)"
    fi

    step_begin "readme:npm-start"
    if port_in_use "$README_PORT"; then
      step_end fail "port $README_PORT already has a listener; this is not a fresh machine" "Something already listens on $README_PORT here, so the probe cannot tell its own server from it. Run the probe on a fresh machine."
      START_PID=""
    else
    cmd "npm start"
    ( cd "$README_DIR" && exec npm start ) >> "$STEP_LOG" 2>&1 &
    START_PID=$!
    echo "$START_PID" >> "$PIDS"
    fi
    if [ -z "$START_PID" ]; then
      step_begin "readme:first-run"; step_end skip "port was not free"
    elif { say "  waiting for http://127.0.0.1:$README_PORT/api/system/health (timeout ${READY_TIMEOUT}s)"; wait_ready "http://127.0.0.1:$README_PORT/api/system/health" "$START_PID"; }; then
      listeners_on_port "$README_PORT" >> "$PIDS"
      step_end ok "server ready in ${READY_SECS}s (build + start)"
      step_begin "readme:first-run"
      step_end ok "$(health_note "http://127.0.0.1:$README_PORT")"
    else
      rc=$?
      tail_log 8
      if [ "$rc" = 1 ]; then
        step_end fail "npm start exited before the server came up: $(first_error_line)" "'npm start' on a fresh machine fails: $(first_error_line). A user following the README stops here."
      else
        step_end fail "server not ready after ${READY_TIMEOUT}s" "'npm start' did not serve within ${READY_TIMEOUT}s on this machine."
      fi
      step_begin "readme:first-run"; step_end skip "server never came up"
    fi
  fi
else
  step_begin "readme:git-clone"; step_end skip "path not requested"
fi

# ── npm path: npm i -g open-walnut → open-walnut web ──────────────────────────
if want_path npm; then
  step_begin "npm:install-global"
  cmd "npm install -g $PKG"
  if run_logged npm install -g "$PKG"; then
    warns=$(grep -c -E '^npm (warn|WARN)' "$STEP_LOG" || true)
    hash -r 2>/dev/null
    if have open-walnut; then step_end ok "$(ver open-walnut --version | cut -c1-40); $warns npm warnings"
    else step_end fail "installed but 'open-walnut' is not on PATH" "After 'npm install -g open-walnut' the command is not on PATH (npm global bin dir not in PATH on this machine)."; fi
  else
    tail_log 8; step_end fail "global install failed: $(first_error_line)" "'npm install -g open-walnut' fails on a fresh machine: $(first_error_line)"
  fi

  if have open-walnut; then
    step_begin "npm:start"
    if port_in_use "$NPM_PORT"; then
      step_end fail "port $NPM_PORT already has a listener; this is not a fresh machine" "Something already listens on $NPM_PORT here. Run the probe on a fresh machine."
      NPM_PID=""
    else
    cmd "open-walnut web --port $NPM_PORT"
    mkdir -p "$OUT/npm-home" "$OUT/npm-daemon"
    OPEN_WALNUT_HOME="$OUT/npm-home" WALNUT_DAEMON_DIR="$OUT/npm-daemon" open-walnut web --port "$NPM_PORT" >> "$STEP_LOG" 2>&1 &
    NPM_PID=$!
    echo "$NPM_PID" >> "$PIDS"
    fi
    if [ -z "$NPM_PID" ]; then
      step_begin "npm:first-run"; step_end skip "port was not free"
    elif { say "  waiting for http://127.0.0.1:$NPM_PORT/api/system/health (timeout ${READY_TIMEOUT}s)"; wait_ready "http://127.0.0.1:$NPM_PORT/api/system/health" "$NPM_PID"; }; then
      listeners_on_port "$NPM_PORT" >> "$PIDS"
      step_end ok "server ready in ${READY_SECS}s"
      step_begin "npm:first-run"
      step_end ok "$(health_note "http://127.0.0.1:$NPM_PORT")"
    else
      rc=$?; tail_log 8
      if [ "$rc" = 1 ]; then step_end fail "open-walnut web exited: $(first_error_line)" "'open-walnut web' exits on a fresh machine: $(first_error_line)"
      else step_end fail "server not ready after ${READY_TIMEOUT}s" "'open-walnut web' did not serve within ${READY_TIMEOUT}s."; fi
      step_begin "npm:first-run"; step_end skip "server never came up"
    fi
  fi
else
  step_begin "npm:install-global"; step_end skip "path not requested"
fi

say ""
say "${B}probe done${O} · steps: $STEPS · servers left running for capture: $(tr '\n' ' ' < "$PIDS")"
