/**
 * The hooks that remind Main and a VP (an org lead) of their first rule: never do the work yourself,
 * at most ORG_SELF_COMMAND_LIMIT commands of your own in a turn, only to look
 * (src/core/org/core-instructions.ts orgSelfWorkRule).
 *
 * Why a hook and not only the prompt (2026-11-03, the user: "U never never nver do it urslef unless it
 * is under 3 command run ... this si the most improt rule, for a VP or CEO"): after a compaction a
 * VP's start was refused for a full slot and it ran the investigation itself with host_exec. The rule
 * was in its prompt and restated after the compaction; nothing reminded it at the moment it drifted.
 *
 * It only reminds, and never refuses a call (the same day, the user: "I think walnut probally shoudo't
 * stoop it, it shudo use prompt and in correct time to avoid forget"; 2026-11-04, of a switch that
 * refused the 4th command: "remove this shodln;'t do this at all"). At the ORG_SELF_COMMAND_LIMIT-th
 * command of a turn the hook adds one line of context to that call (`additionalContext`, which
 * Claude Code hands the model with the tool's result): this is your 3rd command, hand the rest on.
 * Once per turn. The refusal switch an older Walnut wrote into config.yaml is ignored, and the hook
 * prints no permission decision at all (tests/providers/org-work-guard-hook.test.ts fails on one). The
 * rule itself rides the prompt
 * (core instructions) and the `hand-on` message hint (core/hints/hint-registry.ts) at session start,
 * after a compaction and every few messages.
 *
 * Only an org node's session gets these (sessionSettingsHooks with its role, decided from the
 * session's own prompt by core/org/org-prompt-role.ts). A PreToolUse hook on every tool counts the
 * session's own work in this turn: one slot per call, taken with `mkdir` (atomic, so parallel calls
 * of one turn never share a number) under `${TMPDIR:-/tmp}/walnut-org-work-<uid>/<session id>/`; the call
 * that takes the last slot gets the reminder. A Stop hook (and a SessionStart at a process's start)
 * clears the slots, so every turn starts at none.
 *
 * What counts: a command (a Bash command with anything but Walnut ops in it, Monitor), host_exec /
 * host_mcp_call / host_http however they are called (`walnut tools call host_exec` too), reading, searching or editing files outside the task's own
 * directory and Claude Code's per-project store (tool results, memory), web fetches, subagents, and
 * any other MCP server's tool. What does not: Walnut's own ops (the `walnut` CLI, `walnut-cloud
 * start|send`, every other mcp__walnut__ tool), reading back a command's output, a picture the user
 * sent, and Claude Code's bookkeeping tools (ToolSearch, Skill, todo and task lists, crons, wakeups,
 * plan mode, questions). A Bash command is free only when every simple command in it is a Walnut op
 * or a helper around one (cd, echo, a heredoc's cat; jq or python3 reading an op's output through a
 * pipe), read the way sh splits it (walnut_only). It guards against drift by an agent that means
 * well, not against one that hides work.
 *
 * POSIX sh + awk, like the other Bash hooks (pattern-kill-guard-hook.ts). WALNUT_ORG_WORK_GUARD=0 on
 * the server turns the reminder off.
 */
import { TMP_PATH_AWK, shQuoteAwk } from './tmp-path-awk.js'
import { ORG_SELF_COMMAND_LIMIT, orgHandOn, ordinal, type CoreInstructionRole } from '../core/org/core-instructions.js'

/** Reads the hook's JSON; prints "count <sid>" for a call that counts, "free <sid>" for one that does not. */
const DECIDE_AWK = TMP_PATH_AWK + String.raw`
function own(p) {
  if (p == "") return 0
  if (substr(p, 1, 1) != "/") p = CWD "/" p
  p = norm(p)
  return (TD != "" && under(p, TD)) || under(p, HOME "/.claude/projects")
}
# What one simple command is, from its words w[1..nw]: "W" a Walnut op, "X" a Walnut op that runs
# work on a host (host_exec, host_mcp_call, host_http), "F" a helper (cd, a heredoc's cat, echo; jq or
# python3 only when it reads a Walnut op's output through a pipe), "N" nothing (empty, loop keywords),
# "work" anything else.
function segkind(w, nw, piped,   j, x, b) {
  j = 1
  while (j <= nw) {
    x = w[j]
    if (x ~ /^[A-Za-z_][A-Za-z0-9_]*=/ || x ~ /^[0-9]*[<>]/) { j++; continue }
    if (x ~ /^(if|then|else|elif|do|while|until|!|time|nohup|command|exec|env|builtin)$/) { j++; continue }
    if (x == "timeout" || x == "gtimeout") { j++; while (j <= nw && w[j] ~ /^-/) j++; j++; continue }
    break
  }
  if (j > nw) return "N"
  b = w[j]; sub(/^.*\//, "", b)
  # Words past this command are an earlier command's: read none of them.
  for (x = nw + 1; x <= j + 3; x++) w[x] = ""
  if (b ~ /^(for|case|done|fi|esac|in|[{}]|select)$/) return "N"
  if (b == "walnut") return (w[j + 1] == "tools" && w[j + 2] == "call" && w[j + 3] ~ /^(host_exec|host_mcp_call|host_http)$/) ? "X" : "W"
  if (b == "walnut-cloud") return w[j + 1] ~ /^(start|send)$/ ? "W" : "work"
  if (piped && b ~ /^(jq|head|tail|python3|python|sed|grep|egrep|sort|wc|cut|tr|cat|tee|awk|column|uniq|fold|fmt|nl)$/) return "F"
  if (b ~ /^(cd|cat|echo|printf|true|false|:|sleep|mkdir|export|set|unset|local|test|read|wait)$/ || b == "[") return "F"
  return "work"
}
# 1 when a Bash command only runs Walnut ops (and helpers around them), read the way sh splits it:
# quotes, escapes, ; & && || | ( ) and newlines, redirections such as 2>&1, a heredoc's body skipped,
# a $( ) or backtick inside a word kept as part of it. Anything else, or a command too long to read,
# is the session's own work.
function walnut_only(s) { return scan(s) == "w" }
# "w" when s runs Walnut ops and nothing else, "work" when it runs anything else, "none" for neither.
# A $( ) or backtick is read the same way, as part of the command around it.
function scan(s,   n, i, c, q, cur, w, nw, piped, pipew, anyw, work, r, hd, tab, k, d, j0, rest, L, m, t, BT) {
  n = length(s); if (n > 20000) return "work"
  BT = sprintf("%c", 96); q = ""; cur = ""; nw = 0; piped = 0; pipew = 0; anyw = 0; work = 0; hd = ""; tab = 0
  for (i = 1; i <= n + 1; i++) {
    c = i <= n ? substr(s, i, 1) : "\n"
    if (q == "'") { if (c == "'") q = ""; else cur = cur c; continue }
    if (q == "\"" && !(c == "$" && substr(s, i + 1, 1) == "(") && c != BT) { if (c == "\"") q = ""; else if (c == "\\") { i++; cur = cur substr(s, i, 1) } else cur = cur c; continue }
    if (c == "\\") { i++; cur = cur substr(s, i, 1); continue }
    if (c == "'" || c == "\"") { q = c; continue }
    if (c == BT || (c == "$" && substr(s, i + 1, 1) == "(")) {
      if (c == BT) { k = index(substr(s, i + 1), BT); r = scan(substr(s, i + 1, k ? k - 1 : n)); i = k ? i + k : n }
      else {
        j0 = i + 2; d = 0
        for (; i <= n; i++) { c = substr(s, i, 1); if (c == "(") d++; else if (c == ")" && --d == 0) break }
        r = scan(substr(s, j0, i - j0))
      }
      if (r == "w") anyw = 1; else if (r == "work") work = 1
      cur = cur "_"; continue
    }
    if (c == "<" && substr(s, i, 2) == "<<" && substr(s, i, 3) != "<<<") {
      i += 2; tab = 0; if (substr(s, i, 1) == "-") { tab = 1; i++ }
      while (substr(s, i, 1) == " ") i++
      hd = ""
      while (i <= n && substr(s, i, 1) !~ /[ \t\n;&|<>()]/) { c = substr(s, i, 1); if (c != "'" && c != "\"" && c != "\\") hd = hd c; i++ }
      i--; continue
    }
    # 2>&1, >&2, &>file: a redirection, not a separator.
    if (c == "&" && (substr(s, i - 1, 1) ~ /[<>]/ || substr(s, i + 1, 1) == ">")) { cur = cur c; continue }
    if (c == " " || c == "\t") { if (cur != "") { w[++nw] = cur; cur = "" } continue }
    if (c ~ /[;&|()\n]/) {
      if (cur != "") { w[++nw] = cur; cur = "" }
      r = segkind(w, nw, piped && pipew)
      if (r == "W") { anyw = 1; pipew = 1 } else if (r == "X" || r == "work") work = 1
      nw = 0
      if (c == "|" && substr(s, i + 1, 1) == "|") { i++; piped = 0; pipew = 0 }
      else if (c == "|") piped = 1
      else { if (c == "&" && substr(s, i + 1, 1) == "&") i++; piped = 0; pipew = 0 }
      if (c == "\n" && hd != "") {
        rest = substr(s, i + 1); m = split(rest, L, "\n")
        for (k = 1; k <= m; k++) { i += length(L[k]) + 1; t = L[k]; if (tab) sub(/^\t+/, "", t); if (t == hd) break }
        hd = ""
      }
      continue
    }
    cur = cur c
  }
  return work ? "work" : anyw ? "w" : "none"
}
function verdict(   tool, p, op) {
  tool = jstr(in_, "tool_name")
  if (tool ~ /^(ToolSearch|Skill|TodoWrite|TodoRead|TaskStop|TaskOutput|TaskCreate|TaskUpdate|TaskList|TaskGet|BashOutput|KillShell|KillBash|CronCreate|CronDelete|CronList|ScheduleWakeup|SendMessage|AskUserQuestion|EnterPlanMode|ExitPlanMode|ListMcpResourcesTool|ReadMcpResourceTool)$/) return "free"
  if (tool ~ /^mcp__walnut__/) { op = substr(tool, 14); return op ~ /^(host_exec|host_mcp_call|host_http)$/ ? "count" : "free" }
  if (tool == "Bash") return walnut_only(jstr(in_, "command")) ? "free" : "count"
  if (tool ~ /^(Read|Write|Edit|MultiEdit|NotebookEdit)$/) {
    p = jstr(in_, "file_path"); if (p == "") p = jstr(in_, "notebook_path")
    if (own(p)) return "free"
    if (tool == "Read" && tolower(p) ~ /\.(png|jpe?g|gif|webp|heic)$/) return "free"
    return "count"
  }
  if (tool == "Grep" || tool == "Glob") return own(jstr(in_, "path")) ? "free" : "count"
  return "count"
}
{ in_ = in_ (NR > 1 ? "\n" : "") $0 }
END {
  sid = jstr(in_, "session_id"); gsub(/[^A-Za-z0-9_-]/, "", sid)
  if (sid == "") exit
  CWD = jstr(in_, "cwd")
  print verdict() " " sid
}
`

/** The words at the limit-th command of a turn, per role (English: the model reads it). Short: it
 *  rides a tool result in the middle of the work. */
export function orgWorkReminder(role: CoreInstructionRole): string {
  return `Walnut: this is your ${ordinal(ORG_SELF_COMMAND_LIMIT)} command of your own in this turn. `
    + `Hand the rest to your team now: ${orgHandOn(role)}, with what you saw so far (Walnut's own ops do not count).`
}

// Per user: a shared /tmp dir another user made first would turn the guard off for this one.
const SLOTS = '"${TMPDIR:-/tmp}/walnut-org-work-$(id -u)/$sid"'

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** The PreToolUse command for one role: a reminder at the limit-th command. It never decides a call. */
export function orgWorkGuardCommand(role: CoreInstructionRole): string {
  const program = shQuoteAwk(DECIDE_AWK.replace(/^[ \t]*#.*\n/gm, ''))
  const remind = `printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\\n' ${shQuote(orgWorkReminder(role))}`
  return [
    'in=$(cat 2>/dev/null)',
    `v=$(printf '%s' "$in" | awk -v HOME="$HOME" -v TD="\${WALNUT_TASK_DIR%/}" ${program} 2>/dev/null)`,
    'case $v in "count "*) sid=${v#count } ;; *) exit 0 ;; esac',
    `mkdir -p ${SLOTS} 2>/dev/null || exit 0`,
    // One slot per call: mkdir is atomic, so parallel calls of a turn each get their own number.
    // Only the allowed slots are tried, so a call past them costs no more forks under load. The call
    // that takes the last one is reminded; past them nothing more is said.
    `i=1; while [ $i -le ${ORG_SELF_COMMAND_LIMIT} ]; do if mkdir ${SLOTS}/$i 2>/dev/null; then [ $i -eq ${ORG_SELF_COMMAND_LIMIT} ] && ${remind}; exit 0; fi; i=$((i+1)); done`,
    'exit 0',
  ].join('\n')
}

/** Stop and a process's SessionStart: a new turn starts at no commands. Prints nothing, so it never blocks. */
export const ORG_WORK_RESET_COMMAND = [
  'in=$(cat 2>/dev/null)',
  `sid=$(printf '%s' "$in" | awk ${shQuoteAwk(TMP_PATH_AWK.replace(/^[ \t]*#.*\n/gm, '') + String.raw`
{ in_ = in_ (NR > 1 ? "\n" : "") $0 }
END { sid = jstr(in_, "session_id"); gsub(/[^A-Za-z0-9_-]/, "", sid); print sid }
`)} 2>/dev/null)`,
  `[ -n "$sid" ] && rm -rf ${SLOTS} 2>/dev/null`,
  'exit 0',
].join('\n')

const HOOK_TIMEOUT_SECS = 10

export function orgWorkGuardHooks(role: CoreInstructionRole | undefined, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  if (!role || env.WALNUT_ORG_WORK_GUARD === '0') return null
  const reset = { type: 'command', command: ORG_WORK_RESET_COMMAND, timeout: HOOK_TIMEOUT_SECS }
  return {
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: orgWorkGuardCommand(role), timeout: HOOK_TIMEOUT_SECS }] }],
    // A turn's end, and a process's start (a slot left by one that died mid-turn). Never
    // UserPromptSubmit: Claude Code runs it for every message queued into a running turn too
    // (2026-11-03 on prod: a Walnut notice taken in after the VP's first command reset its count),
    // and never a compaction's SessionStart, which comes in the middle of a turn.
    Stop: [{ hooks: [reset] }],
    SessionStart: [{ matcher: 'startup|resume|clear', hooks: [reset] }],
  }
}
