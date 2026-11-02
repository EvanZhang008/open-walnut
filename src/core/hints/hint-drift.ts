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
 * Every reply the user reads is judged: Main's, a lead's (its chat is on the Org
 * page) and an ask's always, anyone else's when a person sent the message. A turn of
 * another task nobody of his started still has its final message judged, since that is
 * what he reads when he opens the task later (2026-11-02, the user's org review); such a
 * turn may mark a drift, never clear one a turn he read left.
 */

import type { OnTurnCompletePayload, SessionHookDefinition } from '../session-hooks/types.js';
import { effectiveHints } from './hint-registry.js';
import { hintTargetOf, writeHintState } from './hint-send.js';
import { stripAboutTag } from '../org/message-about.js';

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
    if (!p.sessionId) return;
    // Corrected inside the turn (hint-drift-live.ts): read once, whatever happens below.
    const { takeLiveCorrection } = await import('./hint-drift-live.js');
    const live = await takeLiveCorrection(p.sessionId);
    // The tasks line (org/message-about.ts) is Walnut's, never the user's to read: judged without it.
    const replies = [...(p.replies ?? []), ...(p.result ? [p.result] : [])].map((r) => stripAboutTag(r));
    if (!replies.length) return;
    // A turn that ended on the no-action line is hidden whole in the chat unless a person
    // started it (web/src/utils/turn-shape.ts): nothing of it was read.
    const hiddenUnlessPerson = NO_ACTION_END.test(replies[replies.length - 1]);
    const { getConfig } = await import('../config-manager.js');
    const config = await getConfig().catch(() => null);
    const checks = effectiveHints(config).filter((h) => h.enabled && h.drifted && h.triggers.includes('on_drift'));
    if (!checks.length) return;
    // Per kind: drifted when one reply broke it, kept when the turn could not tell, cleared when
    // the turn was in the rule again (so a host's tail stops naming an old drift: hint-send.ts).
    const judge = (rows: readonly string[]) => {
      const out = new Map<string, boolean>();
      for (const h of checks) {
        const v = rows.map((r) => h.drifted!(config, r));
        if (v.includes(true)) out.set(h.kind, true);
        else if (v.includes(false)) out.set(h.kind, false);
      }
      return out;
    };
    const verdicts = judge(replies);
    // After a live correction only what came after it counts, judged as the live check judged it.
    if (live && checks.some((h) => h.kind === 'reply-language')) verdicts.set('reply-language', live.driftAfter);
    // A turn nobody of his started is still his to read later: its final message is judged
    // (2026-11-02, the user's org review: "also judge a task's final message when he is not watching").
    const finalOnly = judge(replies.slice(-1));
    if (!verdicts.size && !finalOnly.size) return;
    const at = new Date().toISOString();
    // Main, a lead and an ask talk to the user whoever started the turn; anyone else's whole turn is read only when a person started it.
    const role = hintTargetOf(p.sessionId, p.task).role;
    const userFacing = role === 'main' || role === 'lead' || role === 'ask';
    await writeHintState(p.sessionId, (cur) => {
      const state = cur.hintState;
      const byPerson = state?.lastSendBy === 'person';
      // A live correction proves a person started the turn (his message may be followed by notices).
      const personTurn = byPerson || !!live;
      if (!state || (hiddenUnlessPerson && !personTurn)) return null;
      const drift = { ...(state.drift ?? {}) };
      const read = userFacing || personTurn;
      for (const [kind, broke] of read ? verdicts : finalOnly) {
        if (broke) drift[kind] = at;
        else if (read) delete drift[kind];
      }
      if (JSON.stringify(drift) === JSON.stringify(state.drift ?? {})) return null;
      const { drift: _old, ...rest } = state;
      return { hintState: Object.keys(drift).length ? { ...rest, drift } : rest };
    });
  },
};
