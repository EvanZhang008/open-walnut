/**
 * Config-declared hooks — validate + normalize config.hooks.defs[] into
 * HookDefinition[]. A malformed entry is dropped with a loud warning; this
 * module must NEVER throw (a typo in config.yaml must not kill hook init).
 */

import { log } from '../../logging/index.js';
import { HOOK_POINT_DOMAIN } from '../session-hooks/types.js';
import type { HookDefinition, HookPoint, SessionHookFilter } from '../session-hooks/types.js';
import type { Config } from '../types.js';

const VALID_ACTION_TYPES = new Set(['send_message_to_session', 'notify', 'run_agent', 'log']);

type ConfigHookDef = NonNullable<NonNullable<Config['hooks']>['defs']>[number];

function validateDef(def: ConfigHookDef): { ok: true; hook: HookDefinition } | { ok: false; reason: string } {
  if (!def || typeof def !== 'object') return { ok: false, reason: 'not an object' };
  if (!def.id || typeof def.id !== 'string') return { ok: false, reason: 'missing id' };
  if (!Array.isArray(def.on) || def.on.length === 0) return { ok: false, reason: 'missing on[] hook points' };

  const points: HookPoint[] = [];
  for (const p of def.on) {
    if (typeof p !== 'string' || !(p in HOOK_POINT_DOMAIN)) {
      return { ok: false, reason: `unknown hook point "${String(p)}"` };
    }
    points.push(p as HookPoint);
  }

  if (!def.action || typeof def.action !== 'object' || typeof def.action.type !== 'string') {
    return { ok: false, reason: 'missing action.type' };
  }
  if (!VALID_ACTION_TYPES.has(def.action.type)) {
    return { ok: false, reason: `unknown action type "${def.action.type}" (valid: ${[...VALID_ACTION_TYPES].join(', ')})` };
  }
  if ((def.action.type === 'send_message_to_session' || def.action.type === 'notify')
      && typeof def.action.message !== 'string') {
    return { ok: false, reason: `action ${def.action.type} requires a string "message"` };
  }
  if (def.action.type === 'run_agent' && typeof def.action.agentId !== 'string') {
    return { ok: false, reason: 'action run_agent requires "agentId"' };
  }

  // Filter: pass through the declarative fields only — predicate is code-only
  // by design (config must never supply executable content).
  let filter: SessionHookFilter | undefined;
  if (def.filter && typeof def.filter === 'object') {
    const f = def.filter;
    filter = {
      modes: Array.isArray(f.modes) ? f.modes as SessionHookFilter['modes'] : undefined,
      projects: Array.isArray(f.projects) ? f.projects : undefined,
      phases: Array.isArray(f.phases) ? f.phases as SessionHookFilter['phases'] : undefined,
      fromPhases: Array.isArray(f.fromPhases) ? f.fromPhases as SessionHookFilter['fromPhases'] : undefined,
      sources: Array.isArray(f.sources) ? f.sources : undefined,
      requiresSession: typeof f.requiresSession === 'boolean' ? f.requiresSession : undefined,
    };
  }

  return {
    ok: true,
    hook: {
      id: def.id,
      name: def.name ?? def.id,
      description: def.description,
      hooks: points,
      action: def.action,
      filter,
      priority: typeof def.priority === 'number' ? def.priority : undefined,
      timeoutMs: typeof def.timeoutMs === 'number' ? def.timeoutMs : undefined,
      enabled: def.enabled,
      source: 'config',
    },
  };
}

/** Parse config.hooks.defs into hook definitions. Never throws. */
export function loadConfigHooks(config: Config): HookDefinition[] {
  const defs = config.hooks?.defs;
  if (!Array.isArray(defs) || defs.length === 0) return [];

  const out: HookDefinition[] = [];
  for (const def of defs) {
    const result = validateDef(def);
    if (result.ok) {
      out.push(result.hook);
    } else {
      log.session.warn('config hook def dropped — invalid', {
        id: (def as { id?: unknown })?.id ?? '(no id)',
        reason: result.reason,
      });
    }
  }
  return out;
}

/** Merge legacy session_hooks.overrides UNDER hooks.overrides (new key wins).
 *  The legacy `session_hooks.hooks` array is deliberately NOT activated — it
 *  was declared but never read; silently honoring years-old forgotten entries
 *  could start firing subagents nobody expects. */
export function mergedOverrides(config: Config): Record<string, { enabled?: boolean; priority?: number; timeoutMs?: number }> {
  const legacy = config.session_hooks?.overrides ?? {};
  const current = config.hooks?.overrides ?? {};
  if (config.session_hooks?.hooks?.length) {
    log.session.warn('config session_hooks.hooks is inert — move entries to hooks.defs', {
      count: config.session_hooks.hooks.length,
    });
  }
  return { ...legacy, ...current };
}
