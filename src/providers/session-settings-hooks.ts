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
import { shellDollarGuardHooks } from './shell-dollar-guard-hook.js'
import { patternSignalGuardHooks } from './pattern-kill-guard-hook.js'
import { orgWorkGuardHooks } from './org-work-guard-hook.js'
import type { OrgRole } from '../core/types.js'

/**
 * `orgRole`: the session is Main's or a VP's (core/org/org-prompt-role.ts), which adds the hooks that
 * hold it to at most a few commands of its own in a turn (org-work-guard-hook.ts). The host spawn
 * template starts asks only, never an org node, so it passes none.
 */
export function sessionSettingsHooks(env: NodeJS.ProcessEnv = process.env, opts: { orgRole?: OrgRole } = {}): Record<string, unknown> | null {
  const hooks: Record<string, unknown[]> = {}
  // Concatenate per event, so two sources on the same event never drop one.
  for (const part of [compactOpenItemsHooks(env), gitTmpGuardHooks(env), tmpWriteNoteHooks(env), cloneIdentityHooks(env), shellDollarGuardHooks(env), patternSignalGuardHooks(env), stopUnansweredHooks(env), orgWorkGuardHooks(opts.orgRole, env)]) {
    for (const [event, groups] of Object.entries(part ?? {})) hooks[event] = [...(hooks[event] ?? []), ...(groups as unknown[])]
  }
  return Object.keys(hooks).length > 0 ? hooks : null
}
