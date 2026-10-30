/**
 * The Stop hook every Claude Code session gets: before a turn closes, a request the session
 * holds and has not answered is named, and the CLI goes on in the same turn to answer it
 * (src/core/sessions/unanswered-at-stop.ts says which requests count and why).
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

export const STOP_UNANSWERED_HOOK_COMMAND =
  'in=$(cat); case "$in" in *\'"stop_hook_active":true\'*|*\'"stop_hook_active": true\'*) exit 0;; esac; '
  // Only a block answer is printed: an older walnut, server or host copy that answers with
  // anything else (an error, the whole open-items read) leaves the turn alone.
  + 'out=$(walnut tools call open_items \'{"hook":"stop"}\' 2>/dev/null); '
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
