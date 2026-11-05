/**
 * The `on_drift` trigger's sensor: at each turn end, a hint with a drift check
 * (the reply language today) reads every message of the turn the user saw (the
 * progress lines between tool calls too, `replies`, not only the final `result`),
 * and one that broke the hint's rule marks it on the session's hint state. The next
 * message carries the hint again with a correction (hint-schedule.ts, the render's
 * `on_drift` reason), so the rule comes back exactly when it was lost, and only then
 * (2026-11-05, the user: never on every message). 2026-10-31: a lead still answered the
 * user in English in 12 of 45 replies, two of them mid-turn lines the final-reply check never saw.
 *
 * Every turn the chat shows is judged whole, in every session, whoever started it: the user
 * reads a worker's chat too, and asks every agent's every line in his language (2026-11-02, the
 * org review: a worker's turn a notice started was English from start to end). Only a turn the
 * chat hides is not (something else started it and it ended on the no-action line).
 */

import type { OnTurnCompletePayload, SessionHookDefinition } from '../session-hooks/types.js';
import { effectiveHints } from './hint-registry.js';
import { writeHintState } from './hint-send.js';
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
    if (!verdicts.size) return;
    const at = new Date().toISOString();
    await writeHintState(p.sessionId, (cur) => {
      const state = cur.hintState;
      if (!state || (hiddenUnlessPerson && state.lastSendBy !== 'person')) return null;
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
