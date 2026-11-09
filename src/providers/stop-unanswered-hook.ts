/**
 * The Stop hook every Claude Code session gets: before a turn closes, a request the session
 * holds and has not answered is named, and so is an Ask here question with no answer inside
 * its tag, and the CLI goes on in the same turn to answer it (src/core/sessions/unanswered-at-stop.ts
 * and ask-unanswered.ts say which count and why).
 *
 * The CLI runs Stop hooks when the model ends its turn; `{"decision":"block","reason":…}` on
 * stdout makes it continue with the reason as its next input, and `{}` lets the turn end. Its
 * input JSON carries `stop_hook_active: true` when this stop follows a continuation a Stop hook
 * asked for: then the hook says nothing, so a session is held at most once per turn and never
 * loops. Like the compaction hook it never fails: no server, or an older `walnut` without the
 * mode, prints nothing and exits 0.
 *
 * WALNUT_STOP_UNANSWERED=0 on the server turns it off.
 */

/**
 * The transcript read, one awk pass after one `grep -F` (a long transcript costs one fast pass
 * each). It walks the lines in order and keeps, per thread id, the place of its latest ask (a
 * person's line or a queued one, never a tool result: a session that reads Walnut's own source
 * quotes the tag) and of its latest answer (an assistant line holding text, never thinking or a
 * tool call). A thread is answered only when its latest answer comes after its latest ask, so a
 * follow-up in an answered thread counts again, and only when the answer repeats the ask's name
 * (spaces, case and a trailing ellipsis aside). Attributes are read in any order. JSON escapes
 * the tags' quotes, so they are unescaped first. Prints `<open ids> <answered ids>`, at most 60
 * of each. No single quote inside: it rides a single-quoted shell word.
 *
 * The last line it reads is the hook's own input, marked `walnut-stop-input `: the CLI hands a
 * Stop hook the turn's final text as `last_assistant_message`, and that text may not be in the
 * transcript yet when the hook runs (2026-11-07: an answer filed inside its tag at 08:30:28 was
 * read as missing at 08:30:29, and the question was answered a second time). It is the newest
 * answer of all, so it counts after every ask.
 *
 * A question the person stopped needs no answer: the CLI's `[Request interrupted by user` line
 * settles every ask taken since the last turn that ended (a Stop hook's `stop_hook_summary` line
 * marks each end; a stopped turn has none). 2026-11-09, round 7 on the fixed build: a follow-up
 * stopped mid-answer was named at the next question's turn end, and the model wrote "you stopped
 * this one" under it.
 */
const ASK_SCAN_AWK = String.raw`function key(s, n) { gsub(/[ \t]+/, " ", s); sub(/^ /, "", s); sub(/ $/, "", s); s = tolower(s); n = length(s); if (n >= 3 && substr(s, n - 2) == "...") s = substr(s, 1, n - 3); n = length(s); if (n >= 3 && substr(s, n - 2) == "\342\200\246") s = substr(s, 1, n - 3); sub(/ $/, "", s); return s }
function scan(L, tag, ans,   p, t, e, id, nm) { while ((p = index(L, tag)) > 0) { L = substr(L, p + length(tag)); t = L; e = index(t, ">"); if (e > 0) t = substr(t, 1, e - 1); gsub(/\\"/, "\"", t); id = ""; if (match(t, /thread="?[0-9]+(\.[0-9]+)*/)) { id = substr(t, RSTART, RLENGTH); sub(/^thread="?/, "", id) } if (id == "") continue; nm = ""; if (match(t, /name="[^"]*"/)) nm = substr(t, RSTART + 6, RLENGTH - 7); n++; if (ans) { at[id] = n; an[id] = key(nm) } else { q[id] = n; qn[id] = key(nm) } } }
/^walnut-stop-input / { scan($0, "<walnut-ask-answer ", 1); next }
index($0, "\"subtype\":\"stop_hook_summary\"") { te = ++n; next }
index($0, "\"type\":\"user\"") && index($0, "\"[Request interrupted by user") { for (id in q) if (q[id] > te) { at[id] = ++n; an[id] = qn[id] } next }
{ if (index($0, "\"type\":\"assistant\"")) { if (index($0, "\"type\":\"text\"") && !index($0, "\"type\":\"thinking\"") && !index($0, "\"type\":\"tool_use\"")) scan($0, "<walnut-ask-answer ", 1) } else if ((index($0, "\"type\":\"user\"") && !index($0, "\"tool_use_id\"")) || index($0, "\"type\":\"queue-operation\"")) scan($0, "<walnut-ask ", 0) }
END { a = ""; d = ""; na = 0; nd = 0; for (id in q) { if ((id in at) && at[id] > q[id] && (qn[id] == "" || an[id] == qn[id])) { if (nd < 60) d = d (nd++ ? "," : "") id } else if (na < 60) a = a (na++ ? "," : "") id } print a " " d }`

/**
 * Sets `$q` to `,"asked":"7","answered":"6.1"` (the open thread ids, then the answered ones)
 * from the transcript named by the hook input's `transcript_path`, or to nothing when it names
 * no open question (the server then names none, and an older server that knows no lists is
 * never sent them while nothing is open).
 */
export const ASK_IDS_SCRIPT =
  't=$(printf \'%s\' "$in" | sed -n \'s/.*"transcript_path"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p\' | head -n 1); q=; '
  + 'if [ -n "$t" ] && [ -r "$t" ]; then '
  // The transcript's lines, then the hook input on one line (JSON keeps no raw newline inside a
  // string, so joining its lines changes no value).
  + `r=$({ grep -F -e 'walnut-ask' -e 'stop_hook_summary' -e 'Request interrupted by user' "$t" 2>/dev/null; printf 'walnut-stop-input %s\\n' "$(printf '%s' "$in" | tr '\\n' ' ')"; } | LC_ALL=C awk '${ASK_SCAN_AWK}' 2>/dev/null); `
  + 'a=${r% *}; d=${r#* }; '
  + 'if [ -n "$a" ]; then q=",\\"asked\\":\\"$a\\",\\"answered\\":\\"$d\\""; fi; fi; '

export const STOP_UNANSWERED_HOOK_COMMAND =
  'in=$(cat); case "$in" in *\'"stop_hook_active":true\'*|*\'"stop_hook_active": true\'*) exit 0;; esac; '
  // The Ask here thread ids the transcript was asked (a user line's `<walnut-ask thread=`) and
  // answered inside their tag (an assistant line's `<walnut-ask-answer thread=`), read here, on
  // the session's own host, from the CLI's own transcript (sessions/ask-unanswered.ts).
  + ASK_IDS_SCRIPT
  // Only a block answer is printed: an older walnut, server or host copy that answers with
  // anything else (an error, the whole open-items read) leaves the turn alone.
  + 'out=$(walnut tools call open_items "{\\"hook\\":\\"stop\\"$q}" 2>/dev/null); '
  // An older server that knows no lists refuses the call: ask again without them.
  + 'case "$out" in *nrecognized*) [ -n "$q" ] && out=$(walnut tools call open_items "{\\"hook\\":\\"stop\\"}" 2>/dev/null);; esac; '
  + 'case "$out" in *\'"decision"\'*) printf \'%s\\n\' "$out";; esac; exit 0'

/** Seconds the CLI waits for the hook before it gives up on it and lets the turn end: the bound
 *  on what a slow or frozen server can add to any turn end (a normal answer takes well under one). */
const HOOK_TIMEOUT_SECS = 5

export function stopUnansweredHooks(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  if (env.WALNUT_STOP_UNANSWERED === '0') return null
  return {
    Stop: [{ hooks: [{ type: 'command', command: STOP_UNANSWERED_HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECS }] }],
  }
}
