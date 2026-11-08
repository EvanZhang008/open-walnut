/**
 * The SessionStart hook Main's and every VP's session gets (sources `startup` and `compact`), so a
 * new conversation and a compacted one both begin with what the node keeps across conversations:
 * its own MEMORY.md, its skills' index and its recent work in its Threads
 * (src/core/sessions/own-readback.ts explains why and what).
 *
 * `startup` fires for a new conversation only, never for a `--resume` of one (checked on CLI 2.1.312
 * in `-p` stream-json mode), so a resumed session that already holds the text is not told again. A
 * hook of its own beside open_items' (compact-open-items-hook.ts): Claude Code's limit on what one
 * hook may add holds per hook.
 *
 * The command never fails: with the server unreachable, or an older `walnut` whose op lacks `hook`,
 * it prints nothing and exits 0, and nothing is injected. WALNUT_OWN_READBACK=0 on the server turns
 * it off (then the compaction's open_items reads MEMORY.md back as before).
 */
import type { OrgRole } from '../core/types.js'
import { OWN_READBACK_MARK } from '../core/sessions/own-readback-mark.js'

const command = (hook: 'startup' | 'compact'): string =>
  `walnut tools call agent_memory_read '{"hook":"${hook}"}' 2>/dev/null || true`

/** Seconds the CLI waits for the hook before it gives up on it. */
const HOOK_TIMEOUT_SECS = 20

/**
 * `prompt`: the session's own prompt. Only one carrying OWN_READBACK_MARK gets the hook (a Main or VP
 * prompt this Walnut built); an older one a resume replays reads MEMORY.md in open_items as before.
 */
export function ownReadbackHooks(orgRole: OrgRole | undefined, prompt: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  if (env.WALNUT_OWN_READBACK === '0') return null
  if (orgRole !== 'main' && orgRole !== 'lead') return null
  if (!prompt.includes(OWN_READBACK_MARK)) return null
  return {
    SessionStart: (['startup', 'compact'] as const).map((hook) => ({
      matcher: hook,
      hooks: [{ type: 'command', command: command(hook), timeout: HOOK_TIMEOUT_SECS }],
    })),
  }
}
