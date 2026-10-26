/**
 * The hooks every Claude Code session gets in its `--settings` JSON, one place
 * for send() (claude-code-session.ts) and the host spawn template
 * (spawn-template.ts), which must stay identical (spawn-template-parity test).
 * The CLI merges them with the user's own settings hooks.
 */
import { compactOpenItemsHooks } from './compact-open-items-hook.js'
import { gitTmpGuardHooks } from './git-tmp-guard-hook.js'

export function sessionSettingsHooks(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  const hooks = { ...(compactOpenItemsHooks(env) ?? {}), ...(gitTmpGuardHooks(env) ?? {}) }
  return Object.keys(hooks).length > 0 ? hooks : null
}
