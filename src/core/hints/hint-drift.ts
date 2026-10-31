/**
 * The `on_drift` trigger's sensor: at each turn end, a hint with a drift check
 * (the reply language today) reads every message of the turn the user saw (the
 * progress lines between tool calls too, `replies`, not only the final `result`),
 * and one that broke the hint's rule marks it on the session's hint state. The next
 * message carries the hint again with a correction (hint-schedule.ts, the render's
 * `on_drift` reason), so the rule comes back exactly when it was lost. 2026-10-31: a
 * lead that had the reply-language hint on every message still answered the user in
 * English in 12 of 45 replies, two of them mid-turn lines the final-reply check never saw.
 *
 * Only a reply the user reads is judged: Main's, a lead's (its chat is on the Org
 * page) and an ask's always, anyone else's when a person sent the message (a
 * worker answering its lead in English is not talking to the user).
 */

import type { OnTurnCompletePayload, SessionHookDefinition } from '../session-hooks/types.js';
import { effectiveHints } from './hint-registry.js';
import { hintTargetOf, writeHintState } from './hint-send.js';

/** The no-action line a turn ends on (web/src/utils/turn-end-marker.ts). */
const NO_ACTION_END = /(?:^|\n)[ \t]{0,3}<walnut-turn status="(?:agent-ack|no-action)"\/>\s*$/;

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
    const replies = [...(p.replies ?? []), ...(p.result ? [p.result] : [])];
    if (!p.sessionId || !replies.length) return;
    // A turn that ended on the no-action line is hidden whole in the chat unless a person
    // started it (web/src/utils/turn-shape.ts): nothing of it was read.
    const hiddenUnlessPerson = NO_ACTION_END.test(replies[replies.length - 1]);
    const { getConfig } = await import('../config-manager.js');
    const config = await getConfig().catch(() => null);
    const checks = effectiveHints(config).filter((h) => h.enabled && h.drifted && h.triggers.includes('on_drift'));
    if (!checks.length) return;
    // Per kind: drifted when one reply broke it, kept when the turn could not tell, cleared when
    // the turn was in the rule again (so a host's tail stops naming an old drift: hint-send.ts).
    const verdicts = new Map<string, boolean>();
    for (const h of checks) {
      const v = replies.map((r) => h.drifted!(config, r));
      if (v.includes(true)) verdicts.set(h.kind, true);
      else if (v.includes(false)) verdicts.set(h.kind, false);
    }
    if (!verdicts.size) return;
    const at = new Date().toISOString();
    // Main, a lead and an ask talk to the user whoever started the turn; anyone else only answers a person.
    const role = hintTargetOf(p.sessionId, p.task).role;
    const userFacing = role === 'main' || role === 'lead' || role === 'ask';
    await writeHintState(p.sessionId, (cur) => {
      const state = cur.hintState;
      const byPerson = state?.lastSendBy === 'person';
      if (!state || (!userFacing && !byPerson) || (hiddenUnlessPerson && !byPerson)) return null;
      const drift = { ...(state.drift ?? {}) };
      for (const [kind, broke] of verdicts) {
        if (broke) drift[kind] = at;
        else delete drift[kind];
      }
      if (JSON.stringify(drift) === JSON.stringify(state.drift ?? {})) return null;
      const { drift: _old, ...rest } = state;
      return { hintState: Object.keys(drift).length ? { ...rest, drift } : rest };
    });
  },
};
