/**
 * The PreToolUse hook (matcher `AskUserQuestion`) that holds a question to the user written in another
 * language than his Reply language setting names: the session's own `walnut` CLI judges it (op
 * reply_language_check; the hook's input goes on stdin, wrapped as `hook_input`, so no content rides a
 * command line) and, when it fails, answers `permissionDecision: deny` with the reason, so the session
 * asks again in his language before he sees the question. Only a deny answer is printed: an older CLI
 * that knows no reply_language_check, a server that is away, or the experiment off asks as written.
 * The other words for him are held by the send gate (ops/reply-language-gate.ts); a chat reply never is.
 * WALNUT_REPLY_LANGUAGE_GATE=0 on the server leaves the hook out; in the session's env it silences it.
 */

export const REPLY_LANGUAGE_HOOK_COMMAND = [
  'in=$(cat 2>/dev/null); [ "$WALNUT_REPLY_LANGUAGE_GATE" = 0 ] && exit 0',
  "out=$({ printf '{\"hook_input\":'; printf '%s' \"$in\"; printf '}'; } | walnut tools call reply_language_check - 2>/dev/null)",
  `case "$out" in *'"permissionDecision"'*) printf '%s\\n' "$out" ;; esac`,
  'exit 0',
].join('\n')

/** Seconds the CLI waits for the hook before it asks the question without it. */
const HOOK_TIMEOUT_SECS = 5

export function replyLanguageHooks(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  if (env.WALNUT_REPLY_LANGUAGE_GATE === '0') return null
  return {
    PreToolUse: [{
      matcher: 'AskUserQuestion',
      hooks: [{ type: 'command', command: REPLY_LANGUAGE_HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECS }],
    }],
  }
}
