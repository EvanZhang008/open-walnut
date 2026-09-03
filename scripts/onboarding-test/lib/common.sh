# Shared helpers for the fresh-machine onboarding harness (operator side).
# Sourced by run.sh; never executed directly. bash 3.2 compatible (macOS /bin/bash).

ONB_TAG_KEY="walnut-onboarding-test"
ONB_TTL_TAG_KEY="walnut-onboarding-test-ttl"
ONB_OUT_ROOT="${WALNUT_ONB_OUT_ROOT:-/tmp/walnut-onboarding-test}"

c_dim=$'\033[2m'; c_bold=$'\033[1m'; c_red=$'\033[31m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_cyan=$'\033[36m'; c_off=$'\033[0m'

log()  { printf '%s[onb]%s %s\n' "$c_cyan" "$c_off" "$*" >&2; }
ok()   { printf '%s[onb] ✓%s %s\n' "$c_grn" "$c_off" "$*" >&2; }
warn() { printf '%s[onb] !%s %s\n' "$c_yel" "$c_off" "$*" >&2; }
die()  { printf '%s[onb] ✗ %s%s\n' "$c_red" "$*" "$c_off" >&2; exit 1; }

now_s() { date +%s; }
utc_stamp() { date -u +%Y%m%dT%H%M%SZ; }

# run id = target + UTC stamp; also the tag value on every cloud resource we create.
new_run_id() { printf '%s-%s' "$1" "$(utc_stamp)"; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing tool: $1 ($2)"
}

# Cleanup steps are registered as shell snippets and run in reverse order on EXIT,
# so a failure at any point still tears down what was already created.
ONB_CLEANUP_STACK=""
on_exit_push() { ONB_CLEANUP_STACK="$1"$'\n'"$ONB_CLEANUP_STACK"; }
run_cleanup_stack() {
  local rc=$?
  [ -n "$ONB_CLEANUP_STACK" ] || return "$rc"
  log "cleanup…"
  local line
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    # shellcheck disable=SC2086
    eval "$line" || warn "cleanup step failed (continuing): $line"
  done <<EOF
$ONB_CLEANUP_STACK
EOF
  ONB_CLEANUP_STACK=""
  return "$rc"
}
trap run_cleanup_stack EXIT

# Wait until $1 (a command string) succeeds, polling every $3s for at most $2s.
wait_for() {
  local cmd="$1" timeout="$2" every="${3:-5}" start
  start=$(now_s)
  while ! eval "$cmd" >/dev/null 2>&1; do
    if [ $(( $(now_s) - start )) -ge "$timeout" ]; then return 1; fi
    sleep "$every"
  done
}

# Pretty-print the probe's steps.jsonl as a summary table + findings list.
# Uses node because it is guaranteed on the operator box (this repo needs it).
summarize_steps() {
  local steps="$1"
  [ -s "$steps" ] || { warn "no steps recorded at $steps"; return 1; }
  node - "$steps" <<'JS'
const fs = require('fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const pad = (s, n) => String(s).padEnd(n);
console.log('');
console.log(pad('step', 26) + pad('status', 8) + pad('secs', 8) + 'note');
console.log('-'.repeat(90));
let total = 0;
for (const s of lines) {
  total += s.seconds || 0;
  const mark = s.status === 'ok' ? '✓' : s.status === 'skip' ? '·' : '✗';
  console.log(pad(`${mark} ${s.name}`, 26) + pad(s.status, 8) + pad(s.seconds ?? '', 8) + (s.note || ''));
}
console.log('-'.repeat(90));
console.log(pad('total', 26) + pad('', 8) + pad(total, 8));
const findings = lines.filter((s) => s.finding);
console.log('');
console.log(findings.length ? `Findings (${findings.length}) — friction a brand-new user would hit:` : 'Findings: none — the documented path worked as written.');
findings.forEach((s, i) => console.log(`  ${i + 1}. [${s.name}] ${s.finding}`));
console.log('');
JS
}
