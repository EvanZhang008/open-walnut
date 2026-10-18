#!/usr/bin/env bash
#
# tests/setup/large-run.sh: the large local run of the replica servers
# (docs/plan/walnut-replica-servers-impl.md section 11, WP14). One suite after
# another, never two at once, with WALNUT_SIM_RUNS raised and a fresh seed per
# property suite, each heavy step through the machine's heavy slot.
#
#   bash tests/setup/large-run.sh                      the full counts (the release gate)
#   WALNUT_LARGE_RUN_SMOKE=1 bash tests/setup/large-run.sh   tiny counts: proves the run works
#
# Knobs:
#   WALNUT_LARGE_RUN_SMOKE=1      tiny run counts and one pass of each e2e suite
#   WALNUT_LARGE_RUN_ONLY=a,b     only these suites (names of the table below)
#   WALNUT_LARGE_RUN_CHECKLISTS="<files>"  the implementers' checklists the wp-ref-lint reads beside the plan
#   WALNUT_LARGE_RUN_OUT=<dir>    where the logs and the seed list go (default /tmp/replica-plan/large-run-<stamp>)
#   WALNUT_HEAVY_SLOT=<script>    the heavy-slot wrapper (default $HOME/tmp-evidence/heavy-slot.sh); missing: the run fails
#   WALNUT_LARGE_RUN_MAX_LOAD=<n> wait while the 1 min load is above n (default: twice the cores; a
#                                 load-generating probe pushes it far past that), at most 20 min
#
# Before it starts: the wp-ref-lint (every WPn mention names its owner), bun is
# REQUIRED (the standalone twin: a missing bun FAILS this run, the quick tier may
# skip), `scripts/pw-cleanup.sh status` is printed and the load is checked, so this
# never runs beside another agent's load-generating probe. A suite whose file is not
# in this tree (three-way-merge-property and notes-property are WP11's) is listed with "not in this tree", never
# skipped silently. A failed property suite prints its seed: replay it with
# WALNUT_SIM_SEED=<seed> WALNUT_SIM_RUNS=<runs> on that file.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1
SMOKE="${WALNUT_LARGE_RUN_SMOKE:-0}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${WALNUT_LARGE_RUN_OUT:-/tmp/replica-plan/large-run-$STAMP}"
HEAVY_SLOT="${WALNUT_HEAVY_SLOT:-$HOME/tmp-evidence/heavy-slot.sh}"
VITEST=./node_modules/.bin/vitest
CONFIG=vitest.focus.config.ts
mkdir -p "$OUT"
SEEDS="$OUT/seeds.txt"
: > "$SEEDS"

say() { echo "[large-run] $*" | tee -a "$OUT/summary.txt"; }
fail_now() { say "FAIL: $*"; exit 1; }

# name | file | full runs | smoke runs | kind (property: seeded; passes: back to back)
SUITES="
kind-property|tests/core/replication/kind-property.test.ts|20000|5|property
offline-host-journal-property|tests/providers/offline-host-journal-property.test.ts|20000|5|property
task-fields-property|tests/core/offline-merge/task-fields-property.test.ts|50000|5|property
three-way-merge-property|tests/lib/three-way-merge-property.test.ts|100000|5|property
notes-property|tests/core/offline-merge/notes-property.test.ts|20000|5|property
replica-cluster-e2e|tests/e2e/replica-cluster-e2e.test.ts|10|1|passes
replica-scale-e2e|tests/e2e/replica-scale-e2e.test.ts|3|1|passes
"

wanted() {
  [[ -z "${WALNUT_LARGE_RUN_ONLY:-}" ]] && return 0
  case ",${WALNUT_LARGE_RUN_ONLY}," in *",$1,"*) return 0 ;; esac
  return 1
}

find_bun() {
  for b in "${BUN_INSTALL:+$BUN_INSTALL/bin/bun}" "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    [[ -n "$b" && -x "$b" ]] && { echo "$b"; return 0; }
  done
  command -v bun 2>/dev/null
}

cores() { sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4; }
load1() { sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}' || awk '{print $1}' /proc/loadavg; }

# A fresh 31-bit seed (no Math.random in tests; the shell picks the base, mulberry32 runs from it).
fresh_seed() { echo $(( ((RANDOM << 16) | (RANDOM << 1) | (RANDOM & 1)) & 0x7fffffff )); }

# ── Before anything runs ──
say "large run $STAMP (smoke=$SMOKE) in $ROOT; logs in $OUT"
[[ -x "$VITEST" ]] || fail_now "no $VITEST (run from a checkout with node_modules)"
[[ -f "$HEAVY_SLOT" ]] || fail_now "no heavy-slot wrapper at $HEAVY_SLOT (set WALNUT_HEAVY_SLOT); every heavy step goes through it"
say "wp-ref-lint:"
# shellcheck disable=SC2086
if ! node tests/setup/wp-ref-lint.mjs ${WALNUT_LARGE_RUN_CHECKLISTS:-} >"$OUT/wp-ref-lint.log" 2>&1; then
  cat "$OUT/wp-ref-lint.log"
  fail_now "wp-ref-lint found WPn mentions that name the wrong package ($OUT/wp-ref-lint.log)"
fi
BUN="$(find_bun || true)"
[[ -n "$BUN" ]] || fail_now "bun is required for the standalone daemon twin; the large run fails without it (install bun, or set BUN_INSTALL)"
say "bun: $BUN"
say "playwright and fixture state (scripts/pw-cleanup.sh status):"
bash scripts/pw-cleanup.sh status 2>&1 | sed 's/^/  /' | tee -a "$OUT/summary.txt"
max_load="${WALNUT_LARGE_RUN_MAX_LOAD:-$(( $(cores) * 2 ))}"
waited=0
while :; do
  l="$(load1)"
  if awk -v l="$l" -v m="$max_load" 'BEGIN { exit !(l <= m) }'; then break; fi
  (( waited >= 1200 )) && fail_now "the load stayed above $max_load for 20 min (now $l): another run is generating load"
  (( waited % 120 == 0 )) && say "load $l above $max_load, waiting (another agent's probe may be running)"
  sleep 30; waited=$((waited + 30))
done
say "load $(load1) (at most $max_load), $(cores) cores"

export WALNUT_REQUIRE_BUN=1
export REPLICA_CLUSTER_TWINS=source,standalone
export BUN_INSTALL="${BUN_INSTALL:-$(dirname "$(dirname "$BUN")")}"

passed=0; failed=0; missing=0
FAILED_LIST=""

run_one() { # name file runs kind
  local name="$1" file="$2" runs="$3" kind="$4" log="$OUT/$1.log"
  if [[ "$kind" == "property" ]]; then
    local seed; seed="$(fresh_seed)"
    echo "$name seed=$seed runs=$runs file=$file" >> "$SEEDS"
    say "RUN $name: $runs runs, seed $seed"
    if WALNUT_SIM_RUNS="$runs" WALNUT_SIM_SEED="$seed" bash "$HEAVY_SLOT" "$VITEST" run --config "$CONFIG" "$file" >"$log" 2>&1; then
      say "PASS $name ($(grep -aE 'Tests +[0-9]' "$log" | tail -1 | sed 's/^ *//'))"; passed=$((passed + 1))
    else
      say "FAIL $name: replay with WALNUT_SIM_SEED=$seed WALNUT_SIM_RUNS=$runs $VITEST run --config $CONFIG $file (log $log)"
      failed=$((failed + 1)); FAILED_LIST="$FAILED_LIST $name"
    fi
    return
  fi
  local n=1 bad=0
  while (( n <= runs )); do
    say "RUN $name: pass $n of $runs"
    if bash "$HEAVY_SLOT" "$VITEST" run --config "$CONFIG" "$file" >"$log.$n" 2>&1; then
      say "PASS $name pass $n ($(grep -aE 'Tests +[0-9]' "$log.$n" | tail -1 | sed 's/^ *//'))"
    else
      say "FAIL $name pass $n (log $log.$n)"; bad=$((bad + 1))
    fi
    n=$((n + 1))
  done
  if (( bad == 0 )); then passed=$((passed + 1)); else failed=$((failed + 1)); FAILED_LIST="$FAILED_LIST $name($bad/$runs)"; fi
}

while IFS='|' read -r name file full smoke kind; do
  [[ -z "$name" ]] && continue
  wanted "$name" || continue
  if [[ ! -f "$file" ]]; then
    say "SKIP $name: not in this tree ($file); it belongs to another package and runs once that lands"
    missing=$((missing + 1)); continue
  fi
  runs="$full"; [[ "$SMOKE" == "1" ]] && runs="$smoke"
  run_one "$name" "$file" "$runs" "$kind"
done <<< "$SUITES"

say "seeds (replay a failure with WALNUT_SIM_SEED and WALNUT_SIM_RUNS on its file):"
sed 's/^/  /' "$SEEDS" | tee -a "$OUT/summary.txt"
say "done: $passed passed, $failed failed, $missing not in this tree${FAILED_LIST:+ (failed:$FAILED_LIST)}"
(( failed == 0 )) || exit 1
exit 0
