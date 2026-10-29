/**
 * The `on_drift` trigger's sensor: at each turn end, a hint with a drift check
 * (the reply language today) reads the turn's final reply, and a reply that broke
 * the hint's rule marks it on the session's hint state. The next message carries
 * the hint again (hint-schedule.ts), so the rule comes back exactly when it was
 * lost instead of riding every message.
 *
 * Only a reply the user reads is judged: Main's, a lead's (its chat is on the Org
 * page) and an ask's always, anyone else's when a person sent the message (a
 * worker answering its lead in English is not talking to the user).
 */

import type { OnTurnCompletePayload, SessionHookDefinition } from '../session-hooks/types.js';
import { effectiveHints } from './hint-registry.js';
import { hintTargetOf, writeHintState } from './hint-send.js';

export const hintDriftHook: SessionHookDefinition = {
  id: 'message-hint-drift',
  name: 'Message hint drift (onTurnComplete)',
  description: 'Marks a message hint (the reply language) as due again when a reply to the user broke its rule.',
  hooks: ['onTurnComplete'],
  priority: 80,
  source: 'builtin',
  enabled: true,
  timeoutMs: 10_000,

  handler: async (payload) => {
    const p = payload as OnTurnCompletePayload;
    const reply = p.result;
    if (!p.sessionId || !reply) return;
    const { getConfig } = await import('../config-manager.js');
    const config = await getConfig().catch(() => null);
    const checks = effectiveHints(config).filter((h) => h.enabled && h.drifted && h.triggers.includes('on_drift'));
    if (!checks.length) return;
    const drifted = checks.filter((h) => h.drifted!(config, reply)).map((h) => h.kind);
    if (!drifted.length) return;
    const at = new Date().toISOString();
    // Main, a lead and an ask talk to the user whoever started the turn; anyone else only answers a person.
    const role = hintTargetOf(p.sessionId, p.task).role;
    const userFacing = role === 'main' || role === 'lead' || role === 'ask';
    await writeHintState(p.sessionId, (cur) => {
      const state = cur.hintState;
      if (!state || (!userFacing && state.lastSendBy !== 'person')) return null;
      return { hintState: { ...state, drift: { ...(state.drift ?? {}), ...Object.fromEntries(drifted.map((k) => [k, at])) } } };
    });
  },
};
