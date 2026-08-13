/**
 * One background-producer turn, run on a butler lane.
 *
 * The chat RPC can fire-and-forget a lane turn (its output streams on the
 * session's own channel and the browser is already subscribed there). The
 * BACKGROUND producers cannot: cron records job status from the turn's outcome,
 * the heartbeat runner needs the response string to decide "all clear", and
 * triage has to persist what the butler said. So this helper does the one thing
 * the chat path doesn't — it AWAITS the lane's turn-over event and hands the
 * producer the text.
 *
 * Failure posture is "degrade, never crash": a timeout or a `session:error`
 * resolves `resultText: null` and lets the caller decide (cron/heartbeat throw so
 * their runner records a failure; triage broadcasts an error). The turn promise
 * never rejects, and nothing here persists chat history — each producer owns its
 * own persistence, which differs per producer.
 */

import crypto from 'node:crypto';
import { bus, EventNames, type BusEvent } from '../event-bus.js';
import { eventData } from '../event-types.js';
import { log } from '../../logging/index.js';
import { getOrCreateLaneSession } from './butler-lane.js';

/** Default ceiling for one background lane turn (10 minutes). */
export const LANE_TURN_TIMEOUT_MS = 600_000;

/**
 * Cap on events held while the lane id is still unknown. The window is one
 * sqlite read wide, so this only exists so a burst on a busy box can't grow an
 * unbounded array.
 */
const EARLY_BUFFER_MAX = 50;

export interface LaneTurnResult {
  /** The lane session the turn ran on (valid even when the turn timed out). */
  sessionId: string;
  /** The turn's answer, or null when the turn errored or timed out. */
  resultText: string | null;
}

/**
 * Deliver `message` into the conversation's lane session and wait for the turn.
 *
 * @param opts.source     provenance tag for the send (e.g. 'cron' | 'heartbeat' | 'triage')
 * @param opts.timeoutMs  wait ceiling; defaults to {@link LANE_TURN_TIMEOUT_MS}
 */
export async function runLaneTurn(
  agentId: string,
  conversationId: string,
  message: string,
  opts: { source: string; timeoutMs?: number },
): Promise<LaneTurnResult> {
  const timeoutMs = opts.timeoutMs ?? LANE_TURN_TIMEOUT_MS;
  const subName = `lane-turn-${opts.source}-${crypto.randomUUID()}`;
  const startedAt = Date.now();

  /** Late-bound: the lane id is only known after the lane resolves below. */
  let sessionId: string | null = null;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Events that arrived before the lane id was known (see the drain below). */
  const early: BusEvent[] = [];

  let resolveTurn!: (r: LaneTurnResult) => void;
  const turn = new Promise<LaneTurnResult>((resolve) => { resolveTurn = resolve; });

  const finish = (resultText: string | null, why: string): void => {
    if (settled) return;
    settled = true;
    log.session.info('lane turn finished', {
      sessionId: sessionId ?? '', agentId, conversationId, source: opts.source, why,
      durationMs: Date.now() - startedAt,
      resultLength: resultText?.length ?? 0,
    });
    resolveTurn({ sessionId: sessionId ?? '', resultText });
  };

  const consider = (event: BusEvent): void => {
    if (settled || !sessionId) return;
    if (event.name === EventNames.SESSION_RESULT) {
      const d = eventData<'session:result'>(event);
      if (d.sessionId !== sessionId) return;
      // teamActive results are INTERMEDIATE (a Claude Code team is still
      // working), not turn-over — the same skip every other result consumer applies.
      if (d.teamActive) return;
      // ── Deliberate MVP approximation: message→result correlation ──
      // The lane is SHARED with user chat turns and the other producers, and
      // session:result carries no id of the message it answers. So the FIRST
      // non-teamActive result for this session after our send is taken as OUR
      // answer. If a neighbouring queued turn finishes first, we return its text
      // instead of ours. Acceptable for these callers: cron, heartbeat and triage
      // only summarize, and the real answer still lands in the session's own
      // transcript. A true fix needs a message id on the result payload — do NOT
      // paper over it here with heuristics that can silently drop a real answer.
      finish(d.result ?? '', 'result');
      return;
    }
    if (event.name === EventNames.SESSION_ERROR) {
      const d = eventData<'session:error'>(event);
      if (d.sessionId !== sessionId) return;
      // Producers degrade rather than crash — resolve null, never reject.
      finish(null, `error:${d.errorKind ?? 'unknown'}`);
    }
  };

  try {
    // Subscribe BEFORE the spawn/send. A turn can complete in the same tick the
    // message is delivered (hot CLI, cheap answer); a subscription registered
    // after would miss that result forever — the lost-wakeup race.
    //
    // Interest-scoped global subscription (the pattern every other session-event
    // consumer uses): without `interest` this handler would be woken on every
    // session:text-delta of every session in the process.
    bus.subscribe(subName, (event) => {
      if (settled) return;
      if (sessionId === null) {
        if (early.length < EARLY_BUFFER_MAX) early.push(event);
        return;
      }
      consider(event);
    }, { global: true, interest: [EventNames.SESSION_RESULT, EventNames.SESSION_ERROR] });

    const lane = await getOrCreateLaneSession(agentId, conversationId, { firstMessage: message });
    sessionId = lane.sessionId;

    // Only a JUST-CREATED lane may adopt a buffered event: its id was minted
    // microseconds ago inside the call above, so a result carrying it can only be
    // this turn's (the spawn took our message as its first turn). On a REUSED
    // lane, anything that arrived before our send belongs to an EARLIER turn —
    // adopting it would answer with stale text, so drop the buffer.
    if (lane.created) for (const event of early) consider(event);
    early.length = 0;

    timer = setTimeout(() => finish(null, 'timeout'), timeoutMs);
    timer.unref?.();

    // `created` means the message was consumed as the spawn's FIRST turn —
    // sending it again would deliver it twice (see butler-lane.ts).
    if (!lane.created) {
      try {
        const { sendMessageToSession } = await import('../session-message-queue.js');
        await sendMessageToSession(sessionId, message, { source: opts.source });
      } catch (err) {
        log.session.error('lane turn send failed', {
          sessionId, agentId, conversationId, source: opts.source,
          error: err instanceof Error ? err.message : String(err),
        });
        finish(null, 'send-failed');
      }
    }

    return await turn;
  } finally {
    bus.unsubscribe(subName);
    if (timer) clearTimeout(timer);
  }
}
