/**
 * Unified hook registry — the ONE list of everything Walnut can do
 * automatically: dispatcher hooks (builtin/config/file), daemon policies,
 * and inline interventions enforced inside the session reader.
 *
 * Serves GET /api/hooks and the Settings → Hooks UI.
 */

import { getSessionHookDispatcher } from '../session-hooks/index.js';
import { HOOK_POINT_DOMAIN } from '../session-hooks/types.js';
import type { HookDefinition, HookDomain } from '../session-hooks/types.js';
import { DAEMON_POLICIES } from './daemon-policies.js';
import { resolveSetting, type HookSettingInfo } from './settings.js';
import { describeAction, type HookAction } from './actions.js';
import { getConfig } from '../config-manager.js';
import type { Config } from '../types.js';

export interface HookInfo {
  id: string;
  name: string;
  description?: string;
  /** Hook points (dispatcher) or daemon interception sites (pseudo-points). */
  on: string[];
  domains: HookDomain[];
  runtime: 'walnut' | 'daemon';
  source: 'builtin' | 'config' | 'file' | 'plugin' | 'daemon-policy' | 'inline';
  enabled: boolean;
  priority: number;
  timeoutMs?: number;
  actionType?: string;
  actionDetail?: string;
  conditions: string[];
  /** How the UI may change it:
   *  - config-override: PATCH writes hooks.overrides[id]
   *  - config-path: PATCH flips a dedicated config key (daemon restart needed)
   *  - readonly: not toggleable */
  mutable: 'config-override' | 'config-path' | 'readonly';
  configPath?: string;
  /** Tunable knobs with their CURRENT values, rendered under the toggle in
   *  Settings → Hooks and written back via PATCH { settings: {...} }. Absent or
   *  empty = the hook is a plain on/off switch. */
  settings?: HookSettingInfo[];
  note?: string;
}

function describeConditions(hook: HookDefinition): string[] {
  const out: string[] = [];
  const f = hook.filter;
  if (!f) return out;
  if (f.requiresSession) out.push('Requires active session');
  if (f.modes?.length) out.push(`Modes: ${f.modes.join(', ')}`);
  if (f.projects?.length) out.push(`Projects: ${f.projects.join(', ')}`);
  if (f.phases?.length) out.push(`Phase in: ${f.phases.join(', ')}`);
  if (f.fromPhases?.length) out.push(`Only from: ${f.fromPhases.join(', ')}`);
  if (f.sources?.length) out.push(`Sources: ${f.sources.join(', ')}`);
  if (f.predicate) out.push('Custom condition');
  return out;
}

function dispatcherHookInfo(hook: HookDefinition): HookInfo {
  const domains = [...new Set(hook.hooks.map(p => HOOK_POINT_DOMAIN[p]))];
  return {
    id: hook.id,
    name: hook.name,
    description: hook.description,
    on: hook.hooks,
    domains,
    runtime: 'walnut',
    source: hook.source ?? 'builtin',
    enabled: hook.enabled !== false,
    priority: hook.priority ?? 100,
    timeoutMs: hook.timeoutMs,
    actionType: hook.action?.type ?? (hook.agentId ? 'run_agent' : 'handler'),
    actionDetail: hook.action
      ? describeAction(hook.action as HookAction)
      : hook.agentId ? `Invoke agent: ${hook.agentId}` : 'Built-in handler',
    conditions: describeConditions(hook),
    mutable: 'config-override',
  };
}

/** Inline interventions enforced in the session reader / server — not
 *  dispatchable, listed for visibility. Enabled-ness of the toggleable ones is
 *  resolved against config in getHookInventory. */
interface InlineEntry extends Omit<HookInfo, 'enabled'> {
  isEnabled: (config: Config) => boolean;
}

const INLINE_ENTRIES: InlineEntry[] = [
  {
    id: 'askuserquestion-p-mode-correction',
    name: 'AskUserQuestion auto-correction',
    description: 'In -p (non-interactive) mode AskUserQuestion never reaches the user and the model can burn tokens retrying it. Injects one corrective message per turn telling the model to print its question as text instead.',
    on: ['onToolUse'],
    domains: ['session'],
    runtime: 'walnut',
    source: 'inline',
    priority: 100,
    actionType: 'inject_message',
    actionDetail: 'Inject a one-per-turn corrective message via the session control pipe',
    conditions: ['Tool is AskUserQuestion', 'Live control pipe available'],
    mutable: 'config-override',
    note: 'Enforced inline in the session reader (needs the live pipe + per-turn state). hooks.overrides["askuserquestion-p-mode-correction"].enabled=false disables it.',
    isEnabled: (c) => c.hooks?.overrides?.['askuserquestion-p-mode-correction']?.enabled !== false,
  },
  {
    id: 'session-auto-continue',
    name: 'Auto-continue after retry exhaustion',
    description: 'When a turn dies to upstream retry exhaustion, schedules one delayed "continue" nudge (rate-limited per session).',
    on: ['onTurnError'],
    domains: ['session'],
    runtime: 'walnut',
    source: 'inline',
    priority: 100,
    actionType: 'inject_message',
    actionDetail: 'Send a delayed continue message to the session',
    conditions: ['Error is retry exhaustion', 'Rate limit not exceeded'],
    mutable: 'config-override',
    note: 'Module: core/session-auto-continue.ts (epoch/TOCTOU semantics). Env defaults (WALNUT_AUTO_CONTINUE_*) still apply; hooks.overrides["session-auto-continue"].enabled=false wins over env.',
    isEnabled: (c) => c.hooks?.overrides?.['session-auto-continue']?.enabled !== false
      && process.env.WALNUT_AUTO_CONTINUE_ENABLED !== '0',
  },
  {
    id: 'auto-deny-stale-permissions',
    name: 'Auto-deny pending permissions on new user message',
    description: 'A new user message auto-denies permission prompts still pending from the previous turn, so the turn can pick up the new input instead of hanging.',
    on: ['onMessageSend'],
    domains: ['session'],
    runtime: 'walnut',
    source: 'inline',
    priority: 100,
    actionType: 'deny_permission',
    actionDetail: 'Deny stale pending permission requests',
    conditions: ['Pending permission exists from a previous turn'],
    mutable: 'readonly',
    note: 'Disabling this would make new user messages silently hang behind stale prompts.',
    isEnabled: () => true,
  },
];

/** True when the given inline intervention is enabled (synchronous callers in
 *  the session reader use the cached config snapshot they already hold). */
export function isInlineHookEnabled(id: string, config: Config): boolean {
  const entry = INLINE_ENTRIES.find(e => e.id === id);
  return entry ? entry.isEnabled(config) : true;
}

/** The full inventory: dispatcher hooks + daemon policies + inline entries. */
export async function getHookInventory(): Promise<HookInfo[]> {
  const config = await getConfig();
  const out: HookInfo[] = [];

  const dispatcher = getSessionHookDispatcher();
  if (dispatcher) {
    for (const hook of dispatcher.getHooks()) {
      if (hook.runtime === 'daemon' || hook.enforcedElsewhere) continue;
      out.push(dispatcherHookInfo(hook));
    }
  }

  // Disabled dispatcher hooks vanish from the live list (init filters them) —
  // resurface known builtins from overrides so the UI can re-enable them.
  const overrides = { ...(config.session_hooks?.overrides ?? {}), ...(config.hooks?.overrides ?? {}) };
  for (const [id, ov] of Object.entries(overrides)) {
    if (ov?.enabled === false && !out.some(h => h.id === id)
        && !INLINE_ENTRIES.some(e => e.id === id)) {
      out.push({
        id,
        name: id,
        on: [],
        domains: [],
        runtime: 'walnut',
        source: 'builtin',
        enabled: false,
        priority: ov.priority ?? 100,
        conditions: [],
        mutable: 'config-override',
        note: 'Disabled via config override — re-enable to see full details.',
      });
    }
  }

  for (const entry of INLINE_ENTRIES) {
    const { isEnabled, ...info } = entry;
    out.push({ ...info, enabled: isEnabled(config) });
  }

  for (const policy of DAEMON_POLICIES) {
    out.push({
      id: policy.id,
      name: policy.name,
      description: policy.description,
      on: policy.on,
      domains: ['session'],
      runtime: 'daemon',
      source: 'daemon-policy',
      enabled: policy.isEnabled(config),
      priority: 100,
      conditions: [],
      mutable: policy.setter ? 'config-path' : 'readonly',
      configPath: policy.configPath ?? undefined,
      settings: policy.settings?.map(s => resolveSetting(s, config)),
      note: policy.note,
    });
  }

  // Walnut first, then daemon; priority within runtime.
  out.sort((a, b) => (a.runtime === b.runtime ? a.priority - b.priority : a.runtime === 'walnut' ? -1 : 1));
  return out;
}

/** Legacy /api/task-phase-hooks shape — kept as a deprecated alias. */
export interface TaskPhaseHookInfoLegacy {
  id: string;
  name: string;
  description: string;
  triggerPhase: string;
  fromPhases?: string[];
  actionType: string;
  actionDetail: string;
  conditions: string[];
  priority: number;
}

export async function getHookInfoListLegacy(): Promise<TaskPhaseHookInfoLegacy[]> {
  const dispatcher = getSessionHookDispatcher();
  if (!dispatcher) return [];
  return dispatcher.getHooks()
    .filter(h => h.hooks.includes('onTaskPhaseChanged') && h.filter?.phases?.length)
    .map(h => {
      // Legacy condition vocabulary only — triggerPhase already encodes the
      // phase filter, and `sources` post-dates the old endpoint.
      const conditions: string[] = [];
      if (h.filter?.requiresSession) conditions.push('Requires active session');
      if (h.filter?.predicate) conditions.push('Custom condition');
      if (h.filter?.fromPhases?.length) conditions.push(`Only from: ${h.filter.fromPhases.join(', ')}`);
      return {
        id: h.id,
        name: h.name,
        description: h.description ?? '',
        triggerPhase: h.filter!.phases![0],
        fromPhases: h.filter?.fromPhases,
        actionType: h.action?.type === 'send_message_to_session' ? 'send_message' : (h.action?.type ?? 'handler'),
        actionDetail: h.action ? describeAction(h.action as HookAction) : 'Built-in handler',
        conditions,
        priority: h.priority ?? 100,
      };
    });
}
