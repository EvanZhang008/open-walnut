/**
 * The PreToolUse hook (matcher `Bash`) that keeps type checks from piling up:
 * it refuses a session's new type check while one it started still runs, and
 * any session's new type check while the machine already runs as many as its
 * memory holds.
 *
 * Why (2026-11-11, the "Memory pressure" health alarm): the Mac (48 GB) sat at
 * 15.7 of 17.4 GB swap with the compressor holding 21 GB, and the largest
 * memory users Walnut's sessions controlled were seven `tsc --noEmit` runs of
 * 2 to 3 GB each, one session holding four copies of the same web type check.
 * Each copy ran slowly under that pressure, the Bash tool sent it to the
 * background at its two-minute limit, and the session started another, which
 * made every copy slower still (the oldest ran 45 minutes). One type check of a
 * large project holds 2 to 3 GB whatever runs it, so the rule is a count: one
 * per session, and one per 16 GB of the machine's memory (at least 2).
 *
 * What counts as a type check: a command word `tsc`, `vue-tsc` or `tsgo` (by
 * its basename, also through node, bun, npx, bunx, `bun x`, `npm exec`), and a
 * package script named lint, typecheck, type-check, tsc or tsgo (`:suffix`
 * included) run through bun, npm, pnpm or yarn, options such as --cwd web
 * skipped, and the commands of an `sh -c` body. The new command is read with the shell
 * splitter the git hooks use (shell-split-awk.ts), so quoted text, an echo or a
 * heredoc body never counts; the running ones are read from `ps`, a process
 * counted once at its outermost type check (`bun run lint` and every tsc it
 * starts, through a shell or not, are one). "This session's" is the process tree under the hook's parent, which
 * is the session's CLI (Claude Code runs a hook as `/bin/sh -c` itself).
 * tsserver (an editor's language server) is not a type check run.
 *
 * Not `command -v tsc` and not `tsc --version` or `--help`. A `tsc --watch`
 * counts while it runs: it holds the same memory. A package script named lint
 * counts by its name even where it runs eslint. Two Bash calls checked at the
 * same instant may both pass: a soft brake, no lock.
 *
 * Never a wait: the refusal names the run that holds the slot (pid, how long,
 * its command) so the session waits for it or stops its own. It fails open: no
 * `ps`, no awk, or an output it cannot read allows the command.
 *
 * WALNUT_TYPECHECK_GUARD=0 on the server leaves the hook out of new sessions;
 * on a host, WALNUT_TYPECHECK_GUARD=0 in a session's env turns it off and
 * WALNUT_TYPECHECK_MAX sets the machine's count (0: no machine count).
 * WALNUT_TYPECHECK_PS_FILE, WALNUT_TYPECHECK_ROOT_PID and
 * WALNUT_TYPECHECK_MEM_BYTES stand in for `ps`, the CLI's pid and the memory
 * size in tests.
 */

import { JSON_AWK, TMP_PATH_AWK, shQuoteAwk } from './tmp-path-awk.js'
import { SHELL_SPLIT_AWK } from './shell-split-awk.js'

/**
 * tc_at(w, j, n): 1 when the words w[j..n] start a type check. Shared by the
 * command check and the process scan, so both read a type check the same way.
 */
const TYPECHECK_WORD_AWK = String.raw`
function base(s) { sub(/\/+$/, "", s); sub(/^.*\//, "", s); return s }
function tc_name(s) { s = base(s); return s == "tsc" || s == "tsc.js" || s == "_tsc.js" || s == "vue-tsc" || s == "tsgo" }
function tc_script(s) { return s ~ /^(lint|typecheck|type-check|tsc|tsgo)(:|$)/ }
function tc_at(w, j, n,   b, k) {
  if (j > n) return 0
  b = base(w[j])
  if (tc_name(b)) return tc_runs(w, j, n)
  if (b == "node" || b == "nodejs" || b == "bun" || b == "npx" || b == "bunx" || b == "npm" || b == "pnpm" || b == "yarn") {
    k = pm_skip(w, j + 1, n)
    if (k > n) return 0
    if (tc_name(w[k])) return tc_runs(w, k, n)
    if (b == "node" || b == "nodejs") return 0
    if (w[k] == "x" || w[k] == "exec" || w[k] == "dlx") { k = pm_skip(w, k + 1, n); return k <= n && tc_name(w[k]) && tc_runs(w, k, n) }
    if (w[k] == "run" || w[k] == "run-script") { k = pm_skip(w, k + 1, n); return k <= n && tc_script(w[k]) }
    # bun <script>, yarn <script> and pnpm <script> run a package script by its name alone.
    if (b == "bun" || b == "yarn" || b == "pnpm") return tc_script(w[k])
  }
  return 0
}
# The type checker at w[j] checks something: not tsc --version, -v, --help or -h alone (a second, nothing checked).
function tc_runs(w, j, n,   i, flag) {
  for (i = j + 1; i <= n; i++) { if (w[i] == "--") continue; if (w[i] !~ /^(-v|--version|-h|--help|-V)$/) return 1; flag = 1 }
  return !flag
}
# Past a package manager's options, and the value of those that take one (--cwd web, --filter web).
function pm_skip(w, k, n) {
  while (k <= n && substr(w[k], 1, 1) == "-") {
    if (w[k] ~ /^(--cwd|--filter|-F|--prefix|-C|--dir|--workspace|-w|--config|--cache|--registry)$/) k++
    k++
  }
  return k
}
`

/** Prints 1 when the command the session typed starts a type check. */
const COMMAND_AWK = TMP_PATH_AWK + TYPECHECK_WORD_AWK + String.raw`
function check() { if (nt > 0 && starts(tok, 1, nt)) { print 1; denied = 1 } }
# 1 when the simple command w[j..n] starts a type check, past its prefixes.
function starts(w, j, n,   k, body, segs, ns, s, ww, nw, m) {
  while (j <= n) {
    if (w[j] == "command" && w[j + 1] ~ /^-[vV]$/) return 0
    if (w[j] ~ /^[A-Za-z_][A-Za-z0-9_]*=/ || w[j] ~ /^(command|exec|time|nohup|nice|sudo|env|timeout|gtimeout|caffeinate|taskpolicy|xargs|if|elif|while|until|then|do|else|!)$/) { j++; continue }
    # A prefix's options and their values (nice -n 5, timeout 600, taskpolicy -c utility).
    if (j > 1 && substr(w[j], 1, 1) == "-") { if (w[j] ~ /^-(n|c|s|k|u|g|t)$/) j++; j++; continue }
    if (j > 1 && w[j] ~ /^[0-9]+(\.[0-9]+)?[smhd]?$/) { j++; continue }
    break
  }
  if (j > n) return 0
  # sh -c '<body>': the body is one word here; read its commands too.
  if (base(w[j]) ~ /^(sh|bash|zsh|dash|ash)$/) {
    for (k = j + 1; k < n; k++) if (w[k] ~ /^-[a-z]*c[a-z]*$/) {
      body = w[k + 1]; gsub(/["'\\]/, "", body)
      ns = split(body, segs, /[;&|()\n]+/)
      for (s = 1; s <= ns; s++) {
        nw = split(segs[s], ww, /[ \t]+/)
        m = 1; while (m <= nw && ww[m] == "") m++
        if (m <= nw && starts(ww, m, nw)) return 1
      }
      return 0
    }
    return 0
  }
  return tc_at(w, j, n)
}
` + SHELL_SPLIT_AWK

/**
 * Reads `ps -A -ww -o pid= -o ppid= -o etime= -o args=` on stdin (`args` is `command` on
 * macOS and procps, and the one name busybox has); ROOT is the session's
 * CLI pid, MAX the machine's count ("" or 0: none). Prints the refusal, or
 * nothing.
 */
const PROCESS_AWK = JSON_AWK + TYPECHECK_WORD_AWK + String.raw`
function under_tc(p,   d) { for (d = 0; p != "" && p != "0" && p != "1" && d < 64; d++) { p = parent[p]; if (p in tc) return 1 } return 0 }
function own(p,   d) { for (d = 0; p != "" && p != "0" && p != "1" && d < 64; d++) { if (p == ROOT) return 1; p = parent[p] } return 0 }
function short(s) { return length(s) > 160 ? substr(s, 1, 157) "..." : s }
{
  if ($1 !~ /^[0-9]+$/ || $2 !~ /^[0-9]+$/) next
  pid = $1; parent[pid] = $2; et[pid] = $3
  c = $0; sub(/^[ \t]*[0-9]+[ \t]+[0-9]+[ \t]+[^ \t]+[ \t]+/, "", c); cmdl[pid] = c
  n = split(c, w, /[ \t]+/)
  if (tc_at(w, 1, n)) tc[pid] = 1
  order[++np] = pid
}
END {
  for (i = 1; i <= np; i++) {
    p = order[i]
    if (!(p in tc) || under_tc(p)) continue
    count++
    list = list (list == "" ? "" : "; ") "pid " p " (" et[p] "): " short(cmdl[p])
    if (mine == "" && ROOT != "" && own(parent[p])) mine = p
  }
  if (mine != "") {
    printf "%s", jesc("Walnut refused this command: a type check this session started is still running (pid " mine ", running " et[mine] ": " short(cmdl[mine]) "). " \
      "One type check of a large project holds 2 to 3 GB of memory, and copies side by side push the machine into swap and make each copy slower. " \
      "Wait for that run to finish (its output file, or the background task's notification), or stop it first with kill " mine ", then run this again. " \
      "To check two projects, run them one after another (tsc -p a && tsc -p b), in the background when it takes long.")
    exit
  }
  if (MAX + 0 > 0 && count >= MAX + 0) {
    printf "%s", jesc("Walnut refused this command: this machine already runs " count " type checks, as many as its memory holds (" MAX "; each holds 2 to 3 GB): " list ". " \
      "Start yours once one of them finishes; run it in the background then, so a slow run does not end in a second copy. Do not stop runs other tasks started.")
  }
}`

/** The hook command: a fast `case` bail-out, the command check, then the process scan. */
export const TYPECHECK_GUARD_COMMAND = [
  '[ "$WALNUT_TYPECHECK_GUARD" != 0 ] || exit 0',
  'in=$(cat 2>/dev/null)',
  'case $in in *tsc*|*tsgo*|*lint*|*typecheck*|*type-check*) ;; *) exit 0 ;; esac',
  '[ ${#in} -le 100000 ] || exit 0',
  `hit=$(printf '%s' "$in" | awk ${shQuoteAwk(COMMAND_AWK)} 2>/dev/null)`,
  '[ "$hit" = 1 ] || exit 0',
  'if [ -n "$WALNUT_TYPECHECK_PS_FILE" ]; then procs=$(cat "$WALNUT_TYPECHECK_PS_FILE" 2>/dev/null); else procs=$(ps -A -ww -o pid= -o ppid= -o etime= -o args= 2>/dev/null) || procs=$(ps -o pid,ppid,etime,args 2>/dev/null); fi',
  '[ -n "$procs" ] || exit 0',
  'max=$WALNUT_TYPECHECK_MAX',
  'if [ -z "$max" ]; then',
  '  mem=$WALNUT_TYPECHECK_MEM_BYTES',
  '  [ -n "$mem" ] || mem=$(sysctl -n hw.memsize 2>/dev/null)',
  '  [ -n "$mem" ] || mem=$(awk \'/^MemTotal:/ { printf "%.0f", $2 * 1024; exit }\' /proc/meminfo 2>/dev/null)',
  // One per 16 GB, at least 2; no reading means no machine count.
  '  case $mem in ""|*[!0-9]*) max=0 ;; *) max=$(awk -v m="$mem" \'BEGIN { c = int(m / 17179869184); if (c < 2) c = 2; print c }\') ;; esac',
  'fi',
  `msg=$(printf '%s\\n' "$procs" | awk -v ROOT="\${WALNUT_TYPECHECK_ROOT_PID:-$PPID}" -v MAX="$max" ${shQuoteAwk(PROCESS_AWK)} 2>/dev/null)`,
  'case $msg in "Walnut refused"*) ;; *) exit 0 ;; esac',
  'printf \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\\n\' "$msg"',
  'exit 0',
].join('\n')

/** Seconds the engine waits for the hook: one `ps` and two awks. */
const HOOK_TIMEOUT_SECS = 10

export function typecheckGuardHooks(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  if (env.WALNUT_TYPECHECK_GUARD === '0') return null
  return {
    PreToolUse: [{
      matcher: 'Bash',
      hooks: [{ type: 'command', command: TYPECHECK_GUARD_COMMAND, timeout: HOOK_TIMEOUT_SECS }],
    }],
  }
}

/** The package script names the hook reads as a type check (tests list every script that runs tsc against it). */
export const TYPECHECK_SCRIPT_NAME = /^(lint|typecheck|type-check|tsc|tsgo)(:|$)/
