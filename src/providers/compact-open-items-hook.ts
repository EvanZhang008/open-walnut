/**
 * The SessionStart hook (matcher `compact`) every Claude Code session gets, so
 * that right after a compaction the session reads back what is still open for
 * its task (src/core/sessions/open-items.ts explains why).
 *
 * Why the CLI's own hook and not a Walnut message: the CLI runs SessionStart
 * hooks with `source: "compact"` after every compaction (auto and /compact) and
 * puts their output into the model's context before the next model call, with
 * no extra turn. A message from Walnut would start a turn of its own. Verified on
 * CLI 2.1.284 in `-p` stream-json mode: the hook inherits the session's env
 * (WALNUT_SESSION_ID, OPEN_WALNUT_API_URL), multi-line JSON stdout is read as
 * hook output, and `{}` injects nothing. These hooks merge with the user's own
 * settings hooks; a successful run renders no row (src/core/stream/hook-notice.ts).
 *
 * The command never fails: with the server unreachable, or an older `walnut`
 * that lacks the op, it prints nothing and exits 0, so the human never sees a
 * "SessionStart:compact hook failed" row for a reminder that is best effort.
 *
 * WALNUT_COMPACT_OPEN_ITEMS=0 on the server turns it off.
 */

import { INSTRUCTION_HOOK_PARTS } from '../core/sessions/instruction-hook-parts.js'

export const OPEN_ITEMS_HOOK_COMMAND = 'walnut tools call open_items \'{"hook":"compact"}\' 2>/dev/null || true'

/**
 * The changed default instructions ride hooks of their own (core/sessions/instruction-hook-parts.ts):
 * the main hook names how many, and each part hook asks for one. An older `walnut` on the host refuses
 * the new arguments (exit 1, nothing printed): the main hook then asks the old way, and the part hooks
 * print nothing, so the session is told as before. The fallback runs on any failure of the first call,
 * not only that refusal (a shell test of the exit code would put a `$` in a command that crosses hosts
 * as argv): when the server fails it once and then answers, the old call may restate instructions the
 * part hooks restate too, a rare duplicate and never a loss.
 */
const mainCommand = `walnut tools call open_items '{"hook":"compact","parts":${INSTRUCTION_HOOK_PARTS}}' 2>/dev/null || ${OPEN_ITEMS_HOOK_COMMAND}`
const partCommand = (i: number) => `walnut tools call open_items '{"hook":"compact","part":${i},"of":${INSTRUCTION_HOOK_PARTS}}' 2>/dev/null || true`

/** Seconds the CLI waits for the hook before it gives up on it. */
const HOOK_TIMEOUT_SECS = 20

export function compactOpenItemsHooks(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  if (env.WALNUT_COMPACT_OPEN_ITEMS === '0') return null
  return {
    SessionStart: [{
      matcher: 'compact',
      hooks: [
        { type: 'command', command: mainCommand, timeout: HOOK_TIMEOUT_SECS },
        ...Array.from({ length: INSTRUCTION_HOOK_PARTS }, (_, i) => ({ type: 'command', command: partCommand(i + 1), timeout: HOOK_TIMEOUT_SECS })),
      ],
    }],
  }
}
