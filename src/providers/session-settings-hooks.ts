/**
 * The hooks every Claude Code session gets in its `--settings` JSON, one place
 * for send() (claude-code-session.ts) and the host spawn template
 * (spawn-template.ts), which must stay identical (spawn-template-parity test).
 * The CLI merges them with the user's own settings hooks.
 */
import { compactOpenItemsHooks } from './compact-open-items-hook.js'
import { gitTmpGuardHooks } from './git-tmp-guard-hook.js'
import { tmpWriteNoteHooks } from './tmp-write-note-hook.js'
import { cloneIdentityHooks } from './clone-identity-hook.js'
import { stopUnansweredHooks } from './stop-unanswered-hook.js'

export function sessionSettingsHooks(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  const hooks: Record<string, unknown[]> = {}
  // Concatenate per event, so two sources on the same event never drop one.
  for (const part of [compactOpenItemsHooks(env), gitTmpGuardHooks(env), tmpWriteNoteHooks(env), cloneIdentityHooks(env), stopUnansweredHooks(env)]) {
    for (const [event, groups] of Object.entries(part ?? {})) hooks[event] = [...(hooks[event] ?? []), ...(groups as unknown[])]
  }
  return Object.keys(hooks).length > 0 ? hooks : null
}
