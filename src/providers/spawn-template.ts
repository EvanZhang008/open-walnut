import { walnutCoordinationAllowRules } from './claude-walnut-allow.js'
/**
 * The Mac's per-home SPAWN TEMPLATE for a host (docs/plan/walnut-replica-servers-impl.md
 * section 8, WP12): the argv claude-code-session.ts `send()` builds for a fresh Ask
 * Walnut session on that host, with SLOTS where a start's own fields go (sid, mode,
 * model, effort, persona, tool lists). The host's daemon fills the slots from validated
 * fields only (host-start-core.ts), so a new ask can start there while the Mac is away
 * without the daemon ever running an argv a follower wrote. The tool lists are this
 * Mac's (each agent's lane profile, `agents`), never a follower's.
 *
 * Kept in step with `send()` by tests/providers/spawn-template-parity.test.ts, which
 * fills this template and compares it with what `send()` hands the daemon for the same
 * inputs (argv, the `--settings` JSON with the compact hook, `--debug`, a model value
 * outside the picker and its effort). A remote host's session gets no Walnut API env
 * (self-api-root.ts walnutApiEnvForSession) and no walnut MCP mount: its `walnut` CLI
 * reaches the host's gateway socket, which the daemon sets in the spawn env.
 */

import type { ClaudeLaunchMode } from './claude-launch-mode.js'
import type { AgentTools, EffortRules, SpawnTemplate } from './host-start-core.js'
import { sessionSettingsHooks } from './session-settings-hooks.js'
import { hookArgsFor } from './hook-files.js'
import { walnutApiEnvForSession } from '../lib/self-api-root.js'
import {
  DEFAULT_SESSION_MODE, MODEL_EFFORT_FAMILY_DEFAULTS, MODEL_EFFORT_OVERRIDES, SESSION_EFFORT_IDS, SESSION_MODELS,
  SESSION_MODE_CLI_MAP, modelSupportsEffort, type SessionMode,
} from '../core/types.js'

export interface SpawnTemplateInputs {
  /** The Walnut this template is for (the Mac's WALNUT_HOME). */
  home: string
  /** The Mac's name for the host (a remote host: no Walnut API env in the session). */
  hostKey: string
  /** The folder asks run in on that host (the host replica's data dir). */
  cwd: string
  /** The CLI command (claude-code-session.ts cliCommand, 'claude' for a daemon start). */
  cliCommand?: string
  /** config.session.stream_partial_messages (default on). */
  streamPartialMessages?: boolean
  /** config.session.permission_prompt (default on). */
  permissionPrompt?: boolean
  /** The user let asks on this host start in bypassPermissions. */
  bypassAllowed?: boolean
  /** Effective Claude setting on this host/folder, resolved before publishing. */
  defaultMode?: SessionMode
  implicitModeCli?: string | null
  /** Read for WALNUT_CLAUDE_DEBUG and WALNUT_COMPACT_OPEN_ITEMS, as send() reads them. */
  env?: NodeJS.ProcessEnv
  /** Each agent's tool lists from its lane profile (hostAgentTools); absent: none. */
  agents?: Record<string, AgentTools>
  now?: number
}

/** The order core/types.ts effortFamilyOf looks for a family in a model value. */
const EFFORT_FAMILY_ORDER = ['haiku', 'sonnet', 'fable', 'opus'] as const

/** core/types.ts modelEffortCapability as data, for a model value the template does not list. */
export function hostEffortRules(): EffortRules {
  return {
    overrides: MODEL_EFFORT_OVERRIDES.map((o) => ({ match: o.match.toLowerCase(), ...(o.effort !== undefined ? { effort: o.effort } : {}) })),
    families: EFFORT_FAMILY_ORDER.map((f) => ({ match: f, effort: MODEL_EFFORT_FAMILY_DEFAULTS[f].effort })),
  }
}

/** A tool rule the daemon takes: never a flag, never two rules in one. */
const TOOL_RULE_RE = /^[A-Za-z0-9_.:*()/][A-Za-z0-9_.:*()/ -]{0,199}$/

/**
 * Each console agent's tool lists, as its lane profile (personal-ai-lane.ts buildLaneProfile)
 * gives them to an ask on this Mac. An agent whose lists hold a rule the daemon would refuse
 * is left out, with a warning (its ask on the host then gets no lists, as the lanes have today).
 */
export async function hostAgentTools(): Promise<Record<string, AgentTools>> {
  const [{ getConsoleAgents }, { buildLaneProfile }, { getConfig }, { log }] = await Promise.all([
    import('../core/agent-registry.js'), import('../core/sessions/personal-ai-lane.js'), import('../core/config-manager.js'), import('../logging/index.js'),
  ])
  const config = await getConfig()
  const ids = ['general', ...(await getConsoleAgents()).map((a) => a.id).filter((id) => id !== 'general')]
  const out: Record<string, AgentTools> = {}
  const ok = (v: string[] | undefined) => !v || (v.length <= 64 && v.every((t) => TOOL_RULE_RE.test(t) && !t.includes(',')))
  for (const id of ids) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) continue
    try {
      const { profile } = await buildLaneProfile(config, id)
      const entry: AgentTools = {
        ...(profile.allowedTools?.length ? { allowedTools: [...profile.allowedTools] } : {}),
        ...(profile.tools?.length ? { tools: [...profile.tools] } : {}),
      }
      if (!ok(entry.allowedTools) || !ok(entry.tools)) {
        log.session.warn('host spawn template: an agent tool list the host would refuse is left out', { agentId: id })
        continue
      }
      if (entry.allowedTools || entry.tools) out[id] = entry
    } catch (err) {
      log.session.warn('host spawn template: no tool lists for an agent', { agentId: id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

/** The Walnut mode ids an ask on a host may start in: its default and plan; bypass only when allowed. */
export function hostAskModes(bypassAllowed: boolean, chosen?: SessionMode): { modes: Record<string, string>; defaultMode: string } {
  // Asks from another machine run in Bypass only when the host allows it, even
  // when the engine's own setting names Bypass.
  const named = chosen === 'bypass' && !bypassAllowed ? 'default' : chosen
  const defaultMode: SessionMode = named ?? (bypassAllowed ? DEFAULT_SESSION_MODE : 'default')
  const ids = new Set<SessionMode>([defaultMode, 'plan', 'default', 'auto', 'accept', 'dontAsk'])
  if (bypassAllowed) ids.add('bypass')
  const modes: Record<string, string> = {}
  for (const id of ids) modes[id] = SESSION_MODE_CLI_MAP[id]
  return { modes, defaultMode }
}

export function buildHostSpawnTemplate(i: SpawnTemplateInputs): SpawnTemplate {
  const env = i.env ?? process.env
  // The same order as send(): output flags, --debug, the bypass capability, then the slots.
  const argv: SpawnTemplate['argv'] = [i.cliCommand ?? 'claude', '-p', '--output-format', 'stream-json', '--verbose']
  if (i.streamPartialMessages !== false) argv.push('--include-partial-messages')
  if (env.WALNUT_CLAUDE_DEBUG !== '0') argv.push('--debug')
  argv.push('--allow-dangerously-skip-permissions')
  argv.push({ slot: 'mode' }, { slot: 'model' }, { slot: 'effort' }, { slot: 'sid' }, { slot: 'persona' }, { slot: 'tools' })
  const sessionSettings: Record<string, unknown> = { permissions: { allow: walnutCoordinationAllowRules() } }
  const walnutEnv = walnutApiEnvForSession(i.hostKey)
  if (Object.keys(walnutEnv).length > 0) sessionSettings.env = walnutEnv
  const hooks = sessionSettingsHooks(env)
  if (hooks) sessionSettings.hooks = hooks
  if (Object.keys(sessionSettings).length > 0) argv.push('--settings', JSON.stringify(sessionSettings))
  argv.push('--input-format', 'stream-json')
  if (i.permissionPrompt !== false) argv.push('--permission-prompt-tool', 'stdio')
  const models: SpawnTemplate['models'] = {}
  for (const m of SESSION_MODELS) models[m.id] = { cli: m.cliModel, effort: modelSupportsEffort(m.cliModel) }
  return {
    v: 1, home: i.home, argv, ...(i.implicitModeCli !== undefined ? { implicitModeCli: i.implicitModeCli } : {}), ...hostAskModes(i.bypassAllowed === true, i.defaultMode), models,
    autoEffort: modelSupportsEffort(undefined), effortRules: hostEffortRules(), efforts: [...SESSION_EFFORT_IDS],
    agents: i.agents ?? {},
    // As send() passes it: the string flag (the daemon caps it at 120 KB).
    persona: 'arg', cwd: i.cwd, builtAt: i.now ?? Date.now(),
  }
}

/**
 * Routine templates accept the registry's modes because each trusted clock
 * start resolves its own folder's engine setting before it is sent. A follower
 * cannot use this template to start an ask.
 */
export function hostRoutineModes(chosen: SessionMode = DEFAULT_SESSION_MODE): { modes: Record<string, string>; defaultMode: string } {
  const ids = new Set<SessionMode>([chosen, 'default', 'bypass', 'auto', 'plan', 'accept', 'dontAsk'])
  const modes: Record<string, string> = {}
  for (const id of ids) modes[id] = SESSION_MODE_CLI_MAP[id]
  return { modes, defaultMode: chosen }
}

/**
 * The template a routine's run starts from on that host while the Mac is away
 * (host-start-core.ts planRoutine): the same argv as an ask's, the routine modes, no
 * agents (a routine run has no persona and no tool lists), and no cwd of its own (each
 * run names its routine's folder).
 */
export function buildRoutineSpawnTemplate(i: Omit<SpawnTemplateInputs, 'cwd' | 'bypassAllowed' | 'agents'>): SpawnTemplate {
  return { ...buildHostSpawnTemplate({ ...i, cwd: '' }), ...hostRoutineModes(i.defaultMode), agents: {} }
}

/** The last launch-mode choice a real read gave, per host and folder. */
const lastRealLaunchChoice = new Map<string, ClaudeLaunchMode>()

/**
 * The launch mode a template is built from. A read that failed or ran slow (degraded) gives
 * the safe default, not what the host says: it builds from the last real read instead, so the
 * template's hash does not flip with the link's speed (2026-11-12: each flip sent its 110 to
 * 220 KB again on the session link). Every other input is read as usual, so a setting changed
 * meanwhile (askBypass, the agents' tools) still goes out.
 */
function launchChoice(hostKey: string, cwd: string, choice: ClaudeLaunchMode): ClaudeLaunchMode {
  const key = JSON.stringify([hostKey, cwd])
  if (!choice.degraded) { lastRealLaunchChoice.set(key, choice); return choice }
  return lastRealLaunchChoice.get(key) ?? choice
}

/** Tests only: forget the real reads. */
export function _resetLaunchChoicesForTesting(): void { lastRealLaunchChoice.clear() }

/**
 * Whether the daemon process already holds this template (push-probe-v1): this server
 * restarted, so it does not know, and asks in about 100 bytes instead of sending about 200 KB
 * (2026-11-12: each deploy sent both templates again on the new link, which the relay on the
 * SSH path ended). A daemon without it, or a probe that fails, holds nothing: the push goes out.
 */
async function daemonHoldsTemplate(
  host: { hasCapability(cap: string): boolean; send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> },
  home: string, use: 'ask' | 'routine', hash: string,
): Promise<boolean> {
  if (!host.hasCapability('push-probe-v1')) return false
  try {
    const r = await host.send('leader.spawnTemplate', { home, use, probe: true, hash }, 15_000)
    return r.ok === true && r.held === true
  } catch {
    return false
  }
}

/**
 * Push this Mac's routine template to a host's daemon (`leader.spawnTemplate
 * {use:'routine'}`, trusted socket, after leader.configure). Returns the template's
 * hash (its content without the build time), and sends nothing when that is
 * `unlessHash` (the daemon holds it already); null for a daemon that cannot start a
 * routine run (no 'replica-start-v1' or no 'clock-host-start-v1'). Throws on a refusal.
 */
export async function pushRoutineSpawnTemplate(
  host: { hasCapability(cap: string): boolean; send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> },
  o: { home: string; hostKey: string; unlessHash?: string | null },
): Promise<string | null> {
  if (!host.hasCapability('replica-start-v1') || !host.hasCapability('clock-host-start-v1') || !host.hasCapability('implicit-mode-v1')) return null
  const [{ getConfig }, { createHash }] = await Promise.all([import('../core/config-manager.js'), import('node:crypto')])
  const config = await getConfig()
  const choice = launchChoice(o.hostKey, '', await (await import('./claude-launch-mode.js')).resolveClaudeLaunchMode(o.hostKey))
  const defaultMode = choice.mode
  const template = buildRoutineSpawnTemplate({
    defaultMode, implicitModeCli: choice.cli ?? null, home: o.home, hostKey: o.hostKey,
    streamPartialMessages: config.session?.stream_partial_messages, permissionPrompt: config.session?.permission_prompt,
  })
  // Long hook scripts ride files on a daemon that reads them (hook-files.ts); the hash covers that form.
  template.argv = hookArgsFor(host, template.argv)
  const { builtAt: _at, ...content } = template
  const hash = createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16)
  if (hash === o.unlessHash) return hash
  if (await daemonHoldsTemplate(host, o.home, 'routine', hash)) return hash
  const reply = await host.send('leader.spawnTemplate', { home: o.home, template, use: 'routine', hash }, 15_000)
  if (reply.ok !== true) throw new Error(String(reply.error ?? 'leader.spawnTemplate refused'))
  return hash
}

/**
 * Push this Mac's template to a host's daemon (`leader.spawnTemplate`, trusted socket,
 * after leader.configure), so a new ask can start there while the Mac is away. Called by
 * the host-server manager when it configures the replica program (it knows the replica's
 * data dir, where asks run). A daemon without 'replica-start-v1' is never asked (false).
 * Answers the template's hash (its content without the build time) and whether it went:
 * nothing is sent when that is `unlessHash` (the daemon process holds it already).
 */
export async function pushHostSpawnTemplate(
  host: { hasCapability(cap: string): boolean; send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> },
  o: { home: string; hostKey: string; cwd: string; bypassAllowed?: boolean; unlessHash?: string | null },
): Promise<false | { hash: string; sent: boolean }> {
  if (!host.hasCapability('replica-start-v1') || !host.hasCapability('implicit-mode-v1')) return false
  const [{ getConfig }, { createHash }] = await Promise.all([import('../core/config-manager.js'), import('node:crypto')])
  const config = await getConfig()
  const choice = launchChoice(o.hostKey, o.cwd, await (await import('./claude-launch-mode.js')).resolveClaudeLaunchMode(o.hostKey, o.cwd))
  const defaultMode = choice.mode
  const template = buildHostSpawnTemplate({
    defaultMode, implicitModeCli: choice.mode === 'bypass' && o.bypassAllowed !== true ? 'default' : choice.cli ?? null,
    home: o.home, hostKey: o.hostKey, cwd: o.cwd, bypassAllowed: o.bypassAllowed,
    streamPartialMessages: config.session?.stream_partial_messages, permissionPrompt: config.session?.permission_prompt,
    agents: await hostAgentTools(),
  })
  // Long hook scripts ride files on a daemon that reads them (hook-files.ts); the hash covers that form.
  template.argv = hookArgsFor(host, template.argv)
  const { builtAt: _at, ...content } = template
  const hash = createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16)
  if (hash === o.unlessHash) return { hash, sent: false }
  if (await daemonHoldsTemplate(host, o.home, 'ask', hash)) return { hash, sent: false }
  const reply = await host.send('leader.spawnTemplate', { home: o.home, template, hash }, 15_000)
  if (reply.ok !== true) throw new Error(String(reply.error ?? 'leader.spawnTemplate refused'))
  return { hash, sent: true }
}
