/**
 * The `--settings` JSON of a Walnut session: the coordination allow rules, the session's env and the
 * hooks (compact open items, the guards). One builder for claude-code-session.ts `send()` and the host
 * spawn template (spawn-template.ts), so the two cannot drift; the argv around it is
 * claude-session-argv.ts. A source ratchet (tests/providers/claude-session-argv-ratchet.test.ts)
 * keeps other files from calling sessionSettingsHooks. Pure: it reads only the env it is given.
 */
import { walnutCoordinationAllowRules } from './claude-walnut-allow.js'
import { sessionSettingsHooks } from './session-settings-hooks.js'

export type SessionHookOpts = NonNullable<Parameters<typeof sessionSettingsHooks>[1]>

export interface SessionSettingsInput {
  /** Read for WALNUT_AUTO_ALLOW_OPS and by the hooks (compact open items and the guards). */
  env: NodeJS.ProcessEnv
  /** A slim lane loads none of the user's settings, so it gets no allow rules and no hooks. */
  slim?: boolean
  /** The session's own env (Walnut API root, request tags, a slim lane's auth): set when not empty. */
  sessionEnv?: Record<string, string>
  /** Whole settings keys a slim lane adds (its model aliases); applied before the hooks. */
  overrides?: Record<string, unknown>
  /** The session's role and prompt, which add the org hooks; absent for a host-started ask. */
  hooks?: SessionHookOpts
}

/** The `--settings` object, in the key order every session has had: permissions, env, overrides, hooks. */
export function buildSessionSettings(i: SessionSettingsInput): Record<string, unknown> {
  const settings: Record<string, unknown> = {}
  // Auto can refuse before stdio asks us. Specific CLI and MCP rules keep task coordination
  // running while the engine's deny/ask rules still win. WALNUT_AUTO_ALLOW_OPS=0 leaves them out.
  if (!i.slim && i.env.WALNUT_AUTO_ALLOW_OPS !== '0') settings.permissions = { allow: walnutCoordinationAllowRules() }
  if (i.sessionEnv && Object.keys(i.sessionEnv).length > 0) settings.env = i.sessionEnv
  if (i.overrides) Object.assign(settings, i.overrides)
  // The post-compaction "what is still open" hook and the guards, local and remote alike.
  const hooks = i.slim ? null : sessionSettingsHooks(i.env, i.hooks)
  if (hooks) settings.hooks = hooks
  return settings
}
