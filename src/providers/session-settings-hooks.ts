/**
 * The hooks every Claude Code session gets in its `--settings` JSON, one place
 * for send() (claude-code-session.ts) and the host spawn template
 * (spawn-template.ts), which must stay identical (spawn-template-parity test).
 * The CLI merges them with the user's own settings hooks.
 */
import { compactOpenItemsHooks } from './compact-open-items-hook.js'
import { gitTmpGuardHooks } from './git-tmp-guard-hook.js'
import { approvalsGuardHooks } from './approvals-guard-hook.js'
import { tmpWriteNoteHooks } from './tmp-write-note-hook.js'
import { cloneIdentityHooks } from './clone-identity-hook.js'
import { stopUnansweredHooks } from './stop-unanswered-hook.js'
import { shellDollarGuardHooks } from './shell-dollar-guard-hook.js'
import { patternSignalGuardHooks } from './pattern-kill-guard-hook.js'
import { codexProviderGuardHooks } from './codex-provider-guard-hook.js'
import { soundGuardHooks } from './sound-guard-hook.js'
import { typecheckGuardHooks } from './typecheck-guard-hook.js'
import { orgWorkGuardHooks } from './org-work-guard-hook.js'
import { ownReadbackHooks } from './own-readback-hook.js'
import type { OrgRole } from '../core/types.js'

/**
 * `orgRole`: the session is Main's or a VP's (core/org/org-prompt-role.ts), which adds the hooks that
 * remind it at its few commands of its own in a turn (org-work-guard-hook.ts; it never refuses one), and
 * the one that reads back what it keeps across conversations (own-readback-hook.ts), when `prompt`,
 * its own, says so.
 * The host spawn template starts asks only, never an org node, so it passes none.
 */
export function sessionSettingsHooks(env: NodeJS.ProcessEnv = process.env, opts: { orgRole?: OrgRole; prompt?: string } = {}): Record<string, unknown> | null {
  const hooks: Record<string, unknown[]> = {}
  // Concatenate per event, so two sources on the same event never drop one.
  for (const part of [compactOpenItemsHooks(env), gitTmpGuardHooks(env), approvalsGuardHooks(env), tmpWriteNoteHooks(env), cloneIdentityHooks(env), shellDollarGuardHooks(env), patternSignalGuardHooks(env), soundGuardHooks(env), typecheckGuardHooks(env), codexProviderGuardHooks(env), stopUnansweredHooks(env), orgWorkGuardHooks(opts.orgRole === 'router' ? undefined : opts.orgRole, env), ownReadbackHooks(opts.orgRole, opts.prompt ?? '', env)]) {
    for (const [event, groups] of Object.entries(part ?? {})) hooks[event] = [...(hooks[event] ?? []), ...(groups as unknown[])]
  }
  return Object.keys(hooks).length > 0 ? hooks : null
}
