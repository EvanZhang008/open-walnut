/**
 * The SubagentStop hook every Claude Code session gets: a subagent (the Agent tool) that ends its
 * run while a background command it started still runs is asked, once per command, to wait for it
 * in the foreground instead, so the session that launched it is woken once, by its final report.
 *
 * Why (2026-11-19, task mulhj6ie, session f9a5c542): a background subagent ran its tests with
 * `run_in_background` and ended its run seconds later each time. Claude Code then sends its caller
 * a task-notification "Agent ... is waiting on its own background work" (the result "may be
 * interim"), and starts a turn of the caller for it; when the command ends the subagent resumes,
 * starts the next command and ends again. One subagent woke its lead 15 times from 03:53 to
 * 06:54 UTC, each a full re-read of a 270K-token context, to write "I wait for its final report".
 * The CLI delivers that notification inside its own process, so Walnut never sees it before the
 * turn starts: the only place to stop it is the subagent's stop.
 *
 * How: the CLI hands a SubagentStop hook `agent_id`, `agent_transcript_path` and
 * `background_tasks` (the session's live background tasks: running or pending, backgrounded).
 * The subagent's own commands are the ids its transcript was given by the Bash tool ("Command
 * running in background with ID: X", "... moved to the background (ID: X)", "... backgrounded by
 * user with ID: X") or the Monitor tool ("Monitor started (task X"). A live one of those makes the
 * hook answer `{"decision":"block","reason":…}`: the subagent goes on in the same run with the
 * reason as its input, which names each command, its output file, and a bounded foreground loop
 * that waits for the closing line the CLI writes into that file when the command exits
 * (`[exited with code N]`). Nothing waits in the hook itself: a server the subagent meant to leave
 * running would hold its report for nothing.
 *
 * Once per command: the ids it asked about are kept in
 * `${TMPDIR:-/tmp}/walnut-subagent-wait-<uid>/<agent id>`, and a stop whose live commands were all asked
 * about before ends as it would have (the subagent chose to leave them running). So it never
 * loops, and `stop_hook_active` (which stays set for the whole continued run) is not needed.
 *
 * Only a background subagent: the CLI lists it in `background_tasks` under its agent id while it
 * runs. A foreground one's caller waits for it inside its own turn, so its stop wakes nobody.
 *
 * It fails open: an older CLI without `background_tasks`, no transcript, no awk, or nothing live
 * of the subagent's own prints nothing and the stop goes ahead.
 *
 * WALNUT_SUBAGENT_WAIT=0 on the server leaves the hook out of new sessions; in a session's env it
 * turns the hook off there.
 */

import { JESC_AWK, shQuoteAwk } from './tmp-path-awk.js'

/**
 * Reads, in order: `IN <the hook input on one line>`, `HELD <id>` for each id asked about before,
 * then the subagent's transcript lines that name a background command. Prints the block answer,
 * or nothing; appends the ids it asks about to the file S.
 *
 * Only the CLI's own words count: each phrasing must start a tool result's text (`"content":"`
 * or `"text":"` right before it, or a line break inside it, never an escaped one), so a transcript
 * or prompt the subagent quotes (its quotes and line breaks arrive escaped once more) names nothing. Only ids live in this session are
 * looked at, and each with index(), so a line naming thousands of ids stays linear.
 */
const WAIT_AWK = JESC_AWK + String.raw`
function take(line, pat, kind,   s, m, k, id) {
  s = line
  while (match(s, "(\"(content|text)\":\"|[^\\\\]\\\\n)" pat "[A-Za-z0-9_-]+")) {
    m = substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH)
    k = split(m, w, / /); id = w[k]
    if (!(id in live) || (id in mine)) continue
    mine[id] = kind; order[++n] = id
    if (kind == "command") out[id] = path_of(line, id)
  }
}
# The output file the line names for id: the run of path characters before "/<id>.output".
function path_of(line, id,   i, j, c) {
  i = index(line, "/" id ".output"); if (i == 0) return ""
  for (j = i; j > 1; j--) { c = substr(line, j - 1, 1); if (c == " " || c == "\"" || c == "\\" || c == "'") break }
  return substr(line, j, i - j + length(id) + 8)
}
/^IN / {
  s = $0
  while (match(s, /"id":"[A-Za-z0-9_-]+"/)) { live[substr(s, RSTART + 6, RLENGTH - 7)] = 1; s = substr(s, RSTART + RLENGTH) }
  next
}
/^HELD / { held[$2] = 1; next }
{
  take($0, "Command running in background with ID: ", "command")
  take($0, "Command was manually backgrounded by user with ID: ", "command")
  take($0, "Command was moved to the background \\(ID: ", "command")
  take($0, "Command did not complete within its [0-9]+s timeout and was moved to the background \\(ID: ", "command")
  take($0, "Monitor started \\(task ", "monitor")
}
END {
  # A foreground subagent's caller waits for it in its own turn and is never woken by its stop.
  if (!(AGENT in live)) exit
  fresh = 0; cmds = ""; mons = ""; files = ""; nf = 0
  for (i = 1; i <= n; i++) {
    id = order[i]
    if (!(id in held)) fresh = 1
    if (mine[id] == "monitor") { mons = mons (mons == "" ? "" : ", ") id; continue }
    p = out[id]
    cmds = cmds (cmds == "" ? "" : ", ") id (p == "" ? "" : " (output " p ")")
    if (p != "") { files = files " '" p "'"; nf++ }
  }
  if (!fresh) exit
  for (i = 1; i <= n; i++) if (!((id = order[i]) in held)) print id >> S
  r = "Walnut: do not end your run yet."
  if (cmds != "") r = r " Background command(s) you started still run: " cmds "."
  if (mons != "") r = r " Monitor(s) you started still run: " mons "."
  r = r " Each time you end your run while they run, the session that started you is woken to read an interim note (a full re-read of its context), and again when you resume; it should be woken once, by your final report. Wait for them here instead, in the foreground (no run_in_background, Bash timeout 600000)"
  if (nf > 0) r = r ": for i in $(seq 110); do d=1; for f in" files "; do tail -n 1 \"$f\" 2>/dev/null | grep -qE '^\\[(exited with code -?[0-9]+|killed)\\]' || d=0; done; [ $d = 1 ] && break; sleep 5; done; run it again until each output ends with its [exited with code N] or [killed] line"
  else r = r " with a loop bounded to under 10 minutes on the condition that tells they are done, run again until they are"
  if (mons != "") r = r "; for a monitor, wait for its condition the same way, then stop it with TaskStop"
  r = r ". Then carry on, and end only with your final report. If you meant to leave one running (a server), end again now: Walnut asks once per command."
  printf "{\"decision\":\"block\",\"reason\":\"%s\"}\n", jesc(r)
}
`

/** The hook command: fast bail-outs, then one grep over the transcript into one awk pass. */
export const SUBAGENT_WAIT_HOOK_COMMAND = [
  'in=$(cat); [ "$WALNUT_SUBAGENT_WAIT" = 0 ] && exit 0; ',
  // An older CLI without the list, or no live background task at all: nothing to ask.
  `case "$in" in *'"background_tasks":[{'*) ;; *) exit 0;; esac; `,
  `one=$(printf '%s' "$in" | tr '\\n' ' '); `,
  `t=$(printf '%s\\n' "$one" | sed -n 's/.*"agent_transcript_path"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1); `,
  `a=$(printf '%s\\n' "$one" | sed -n 's/.*"agent_id"[[:space:]]*:[[:space:]]*"\\([A-Za-z0-9_-]*\\)".*/\\1/p' | head -n 1); `,
  '[ -n "$t" ] && [ -r "$t" ] && [ -n "$a" ] || exit 0; ',
  // One folder per user, only theirs: a shared /tmp folder another user made is not writable.
  'd="${TMPDIR:-/tmp}/walnut-subagent-wait-$(id -u)"; [ -d "$d" ] || mkdir -p -m 700 "$d" 2>/dev/null; [ -d "$d" ] && [ -w "$d" ] && [ ! -L "$d" ] || exit 0; s="$d/$a"; ',
  `{ printf 'IN %s\\n' "$one"; [ -r "$s" ] && sed 's/^/HELD /' "$s"; `,
  `grep -F -e 'with ID: ' -e 'background (ID: ' -e 'Monitor started (task ' "$t" 2>/dev/null; } `,
  `| LC_ALL=C awk -v S="$s" -v AGENT="$a" ${shQuoteAwk(WAIT_AWK)} 2>/dev/null; exit 0`,
].join('')

/** Seconds the CLI waits for the hook: one grep and one awk pass over the transcript. */
const HOOK_TIMEOUT_SECS = 10

export function subagentWaitHooks(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  if (env.WALNUT_SUBAGENT_WAIT === '0') return null
  return {
    SubagentStop: [{ hooks: [{ type: 'command', command: SUBAGENT_WAIT_HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECS }] }],
  }
}
