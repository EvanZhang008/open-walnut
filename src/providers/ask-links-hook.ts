/**
 * The PreToolUse hook (matcher `AskUserQuestion`) that reminds a session when its question to the
 * user names a code review, ticket, pull request or commit with no link to open it
 * (src/lib/missing-links.ts; 2026-11-20, the user: every thread, letter and question carries what he
 * needs, with links he can click). It never decides the permission and never refuses: the question
 * goes to the user as written, and the note reaches the model as `additionalContext` beside the
 * answer, so its next words to the user carry the links.
 *
 * The check runs in the session's own `walnut` CLI on its host (op link_check, which asks the server
 * only whether a short hex id is a task): the hook pipes its input there on stdin, wrapped as `hook_input`, so no content
 * rides a command line. No shortcut in sh: the hook's input always holds digits (its session id), and
 * a question is rare enough that one CLI call each is nothing.
 * Only an answer with `hookSpecificOutput` is printed: an older CLI that knows no link_check prints
 * nothing. WALNUT_LINK_NOTE=0 on the server leaves the hook out; in the session's env it silences it.
 */

export const ASK_LINKS_HOOK_COMMAND = [
  'in=$(cat 2>/dev/null); [ "$WALNUT_LINK_NOTE" = 0 ] && exit 0',
  "out=$({ printf '{\"hook_input\":'; printf '%s' \"$in\"; printf '}'; } | walnut tools call link_check - 2>/dev/null)",
  `case "$out" in *'"hookSpecificOutput"'*) printf '%s\\n' "$out" ;; esac`,
  'exit 0',
].join('\n')

/** Seconds the CLI waits for the hook before it asks the question without it. */
const HOOK_TIMEOUT_SECS = 5

export function askLinksHooks(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  if (env.WALNUT_LINK_NOTE === '0') return null
  return {
    PreToolUse: [{
      matcher: 'AskUserQuestion',
      hooks: [{ type: 'command', command: ASK_LINKS_HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECS }],
    }],
  }
}
