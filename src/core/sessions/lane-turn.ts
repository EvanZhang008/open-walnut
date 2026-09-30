/**
 * One background-producer turn, run on a Personal AI lane.
 *
 * The chat RPC can fire-and-forget a lane turn (its output streams on the
 * session's own channel and the browser is already subscribed there). The
 * BACKGROUND producers cannot: cron records job status from the turn's outcome,
 * the heartbeat runner needs the response string to decide "all clear", and
 * triage has to persist what the Personal AI said. So this helper does the one thing
 * the chat path doesn't — it AWAITS the lane's turn-over event and hands the
 * producer the text.
 *
 * Failure posture is "degrade, never crash": a dead CLI, a stalled stream or a
 * failed send resolves `resultText: null` with a `failure` kind and lets the
 * caller decide (cron/heartbeat throw so their runner records a failure; triage
 * broadcasts an error). The turn promise never rejects, and nothing here
 * persists chat history: each producer owns its own persistence.
 *
 * Liveness, not a wall clock (2026-09-26): a turn fails only when the CLI died
 * or its stream made no progress for LANE_TURN_STALL_MS (see
 * lane-turn-liveness.ts for the evidence). A stalled turn whose CLI is still
 * running hands the caller `laneStillRunning` plus a `lateResult` promise, and
 * the lane stays gated: the next turn on it waits until that turn has provably
 * ended (its answer, the lane idle, or the CLI's death), so a late answer can
 * never be glued onto the next turn. Giving up on the answer is not an end: the
 * CLI is interrupted and the gate stays closed until the turn is over
 * (lane-turn-gate.ts). The waiting turn gives up the agent's turn slot meanwhile
 * (core/turn-slot.ts).
 *
 * Result correlation is by turn generation: the send path stamps each delivery
 * with the generation of the turn that will answer it (SESSION_MESSAGES_DELIVERED
 * `turnGen`), and every CLI result carries the generation it closed. A result
 * older than our delivery belongs to an earlier turn and is ignored. Emitters
 * without generations (ACP lanes, old payloads) keep the old rule: the first
 * result after our send.
 */

import crypto from 'node:crypto';
import { bus, EventNames, type BusEvent } from '../event-bus.js';
import { eventData } from '../event-types.js';
import { log } from '../../logging/index.js';
import { getOrCreateLaneSession, type LaneSession } from './personal-ai-lane.js';
import { createStallClock, type StallClock } from './lane-turn-liveness.js';
import { lastSessionProgressAt } from './session-progress.js';
import { withCatchUpContext } from './lane-turn-catch-up.js';
import {
  closeLaneGate, openLaneGate, drainLaneGate, laneGate, readLaneProcess, laneProcessDead, _closedLaneGatesForTesting,
} from './lane-turn-gate.js';
import { releaseTurnSlotWhile } from '../turn-slot.js';

/**
 * A lane turn whose CLI stream produced NOTHING for this long has stalled.
 * 15 minutes: above every measured legitimate silence with margin (heartbeat
 * tools report every 30 s, non-heartbeat tools max 30 s, model latency p99.9
 * 375 s; lane-turn-liveness.ts), and above Claude Code's own 10-minute cap on
 * a foreground Bash call, whose heartbeat a future CLI could drop.
 */
export const LANE_TURN_STALL_MS = 15 * 60_000;

/** Liveness check cadence. */
export const LANE_TURN_TICK_MS = 30_000;

/**
 * How long a stalled-but-running turn's late answer is waited for. The watch
 * also ends on a second full stall or the CLI's death; this cap only bounds a
 * turn that keeps producing output without ever finishing. Ending the watch is
 * not ending the turn: the lane is then drained (lane-turn-gate.ts).
 */
export const LANE_LATE_ANSWER_MAX_MS = 60 * 60_000;

/** After this much silence, each tick also asks the session record whether
 *  the CLI is gone (a death whose session:error was lost). */
const DEATH_PROBE_AFTER_MS = 60_000;

/**
 * Cap on events held while the lane id is still unknown. The window is one
 * sqlite read wide, so this only exists so a burst on a busy box can't grow an
 * unbounded array.
 */
const EARLY_BUFFER_MAX = 50;

/** Cap on generation-stamped results held before our delivery is confirmed. */
const HELD_RESULTS_MAX = 20;

/**
 * A lane other than the conversation's own Personal AI lane.
 *
 * The cloud companion answers a phone turn on ITS OWN lane when the primary
 * provably cannot receive it (routes/cloud-chat-fallback.ts). That lane lives in
 * the companion's own session registry under a different key, and its catch-up
 * high-water mark must never be written into the git-synced conversation file,
 * so both halves are the caller's. Everything else (subscribe-before-send, the
 * early-event buffer, result correlation, liveness) is this module's, which is
 * the point: one turn runner, two lanes.
 */
export interface LaneTurnTarget {
  /** Resolve (or mint) the lane. `firstMessage` rides the spawn when it mints. */
  resolve: (firstMessage: string) => Promise<LaneSession>;
  /** Context to prepend to a send into an EXISTING lane, plus the commit that
   *  records it as delivered (called only after the send succeeded). */
  catchUp: (sessionId: string, message: string) => Promise<{ message: string; commit?: () => Promise<void> }>;
}

/**
 * Why a turn has no answer. 'busy': the lane was still in an earlier turn that
 * did not end even after an interrupt, so this turn was not sent at all.
 */
export type LaneTurnFailure = 'died' | 'stalled' | 'send-failed' | 'timeout' | 'busy';

export interface LaneTurnResult {
  /** The lane session the turn ran on (valid even when the turn failed). */
  sessionId: string;
  /** The turn's answer, or null when the turn has no answer (see `failure`). */
  resultText: string | null;
  /** Set exactly when resultText is null. */
  failure?: LaneTurnFailure;
  /**
   * The turn stalled but its CLI is still running, so it may still answer.
   * Callers must NOT persist an error row for it: tell the user, and wait on
   * `lateResult` instead.
   */
  laneStillRunning?: boolean;
  /** Present with laneStillRunning: this turn's late answer, or null once the
   *  lane dies, stalls again, or LANE_LATE_ANSWER_MAX_MS passes. */
  lateResult?: Promise<string | null>;
}

/**
 * Lanes still busy with a stalled turn (lane-turn-gate.ts). The next turn on the
 * lane waits at the gate before it sends: a send into a lane that is still busy
 * with an earlier turn would JOIN that turn, and its one result would then be
 * claimed by both. Tests only.
 */
export function _outstandingLateLanesForTesting(): string[] {
  return _closedLaneGatesForTesting();
}

/**
 * Deliver `message` into the conversation's lane session and wait for the turn.
 *
 * @param opts.source       provenance tag for the send (e.g. 'cron' | 'heartbeat' | 'triage')
 * @param opts.timeoutMs    optional ABSOLUTE ceiling. No caller in production passes
 *                          one: liveness (LANE_TURN_STALL_MS) is the rule. Kept for tests
 *                          and for a producer that genuinely needs a hard bound.
 * @param opts.stallMs      override LANE_TURN_STALL_MS (tests).
 * @param opts.tickMs       override LANE_TURN_TICK_MS (tests).
 * @param opts.onSessionId  called with the lane id once the lane is resolved and free,
 *                          BEFORE the send: the hook a caller needs to attach a live
 *                          relay to the lane's own stream events (they are keyed by
 *                          session id, and by the time this promise resolves the turn
 *                          is already over).
 * @param opts.onQueued     called once when this turn has to wait for an earlier,
 *                          stalled turn on the same lane (the gate below), so the
 *                          caller can show a wait instead of a hang.
 */
export async function runLaneTurn(
  agentId: string,
  conversationId: string,
  message: string,
  opts: {
    source: string;
    timeoutMs?: number;
    stallMs?: number;
    tickMs?: number;
    onSessionId?: (sessionId: string) => void;
    onQueued?: () => void;
    /** Run on this lane instead of the conversation's Personal AI lane. */
    target?: LaneTurnTarget;
  },
): Promise<LaneTurnResult> {
  const stallMs = opts.stallMs ?? LANE_TURN_STALL_MS;
  const tickMs = opts.tickMs ?? LANE_TURN_TICK_MS;
  const subName = `lane-turn-${opts.source}-${crypto.randomUUID()}`;
  const startedAt = Date.now();

  /** Late-bound: the lane id is only known after the lane resolves below. */
  let sessionId: string | null = null;
  let laneCreated = false;
  /** 'turn' until the turn settles; 'late' while a stalled turn's answer is awaited. */
  let mode: 'turn' | 'late' | 'done' = 'turn';
  /** Our send has started: results from here on may be ours. */
  let sendStarted = false;
  let ourMessageId: string | null = null;
  /** Set once our message is confirmed delivered; `turnGen` is the answering turn. */
  let delivered: { turnGen?: number } | null = null;
  /** Deliveries seen while our send was still in flight (id unknown yet). */
  const deliveredBeforeId = new Map<string, number | undefined>();
  /** Generation-stamped results that arrived before our delivery was confirmed. */
  const heldResults: Array<{ turnGen: number; text: string }> = [];
  /** Events that arrived before the lane id was known (see the drain below). */
  const early: BusEvent[] = [];
  let clock: StallClock | null = null;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
  let lateCapTimer: ReturnType<typeof setTimeout> | undefined;
  let probing = false;

  let resolveTurn!: (r: LaneTurnResult) => void;
  const turn = new Promise<LaneTurnResult>((resolve) => { resolveTurn = resolve; });
  let resolveLate: ((text: string | null) => void) | null = null;

  const cleanup = (): void => {
    mode = 'done';
    bus.unsubscribe(subName);
    if (tickTimer) clearInterval(tickTimer);
    if (ceilingTimer) clearTimeout(ceilingTimer);
    if (lateCapTimer) clearTimeout(lateCapTimer);
  };

  /**
   * End the late watch. `lane`: 'open' when the turn is provably over (its answer,
   * the CLI's death, the record reading idle); 'drain' when we stop waiting for
   * the answer but the CLI may still be in that turn (lane-turn-gate.ts).
   */
  const settleLate = (text: string | null, why: string, lane: 'open' | 'drain' = 'open'): void => {
    if (mode !== 'late' || !resolveLate) return;
    const resolve = resolveLate;
    resolveLate = null;
    log.session.info('lane turn late watch finished', {
      sessionId: sessionId ?? '', agentId, conversationId, source: opts.source, why, lane,
      durationMs: Date.now() - startedAt, resultLength: text?.length ?? 0,
    });
    cleanup();
    resolve(text);
    if (!sessionId) return;
    if (lane === 'open') openLaneGate(sessionId);
    else drainLaneGate({ sessionId, agentId, conversationId, source: opts.source, why, tickMs, windowMs: stallMs });
  };

  const finish = (resultText: string | null, why: string, failure?: LaneTurnFailure, stillRunning = false): void => {
    if (mode !== 'turn') return;
    let lateResult: Promise<string | null> | undefined;
    if (stillRunning && sessionId) {
      // Keep watching THIS turn: its answer may still come. The lane stays gated
      // so the next turn cannot join it (lane-turn-gate.ts).
      mode = 'late';
      lateResult = new Promise<string | null>((resolve) => { resolveLate = resolve; });
      closeLaneGate(sessionId);
      clock?.reset(Date.now());
      // An hour of output without an answer: stop waiting, but the CLI is still
      // in that turn, so the lane is drained, not opened.
      lateCapTimer = setTimeout(() => settleLate(null, 'late-cap', 'drain'), LANE_LATE_ANSWER_MAX_MS);
      lateCapTimer.unref?.();
      if (ceilingTimer) clearTimeout(ceilingTimer);
    }
    log.session.info('lane turn finished', {
      sessionId: sessionId ?? '', agentId, conversationId, source: opts.source, why,
      durationMs: Date.now() - startedAt,
      resultLength: resultText?.length ?? 0,
      ...(failure ? { failure, laneStillRunning: stillRunning } : {}),
    });
    const result: LaneTurnResult = { sessionId: sessionId ?? '', resultText };
    if (resultText === null && failure) result.failure = failure;
    if (lateResult) { result.laneStillRunning = true; result.lateResult = lateResult; }
    if (mode === 'turn') cleanup();
    resolveTurn(result);
  };

  /** Is a result closing generation `turnGen` the answer to OUR message? */
  const isOurs = (turnGen: number | undefined): boolean | 'hold' => {
    if (laneCreated) return true; // the spawn carried our message as its first turn
    if (turnGen === undefined) return true; // no generations: first result after our send
    if (!delivered) return 'hold';
    if (delivered.turnGen === undefined) return true;
    return turnGen >= delivered.turnGen;
  };

  const takeResult = (text: string): void => {
    if (mode === 'turn') finish(text, 'result');
    else if (mode === 'late') settleLate(text, 'late-result');
  };

  const confirmDelivery = (turnGen: number | undefined): void => {
    if (delivered) return;
    delivered = { turnGen };
    // A hot CLI can answer before the delivery event is emitted: adopt a held
    // result only if it closed the turn our message landed in (or a later one).
    const match = heldResults.find((r) => turnGen === undefined || r.turnGen >= turnGen);
    heldResults.length = 0;
    if (match) takeResult(match.text);
  };

  const consider = (event: BusEvent): void => {
    if (mode === 'done' || !sessionId) return;
    const d = event.data as { sessionId?: string };
    if (d?.sessionId !== sessionId) return;
    clock?.progress(Date.now());
    if (event.name === EventNames.SESSION_MESSAGES_DELIVERED) {
      if (!sendStarted) return;
      const dd = eventData<'session:messages-delivered'>(event);
      for (const id of dd.messageIds ?? []) {
        if (ourMessageId === null) {
          if (deliveredBeforeId.size < EARLY_BUFFER_MAX) deliveredBeforeId.set(id, dd.turnGen);
        } else if (id === ourMessageId) {
          confirmDelivery(dd.turnGen);
        }
      }
      return;
    }
    // Anything before our send (a gated wait, a reused lane's previous turn)
    // belongs to an EARLIER turn. A just-created lane is the exception: the spawn
    // took our message as its first turn.
    if (!sendStarted && !laneCreated) return;
    if (event.name === EventNames.SESSION_RESULT) {
      const r = eventData<'session:result'>(event);
      // teamActive results are INTERMEDIATE (a Claude Code team is still
      // working), not turn-over — the same skip every other result consumer applies.
      if (r.teamActive) return;
      const verdict = isOurs(r.turnGen);
      if (verdict === 'hold') {
        if (heldResults.length < HELD_RESULTS_MAX) heldResults.push({ turnGen: r.turnGen!, text: r.result ?? '' });
        return;
      }
      if (verdict) takeResult(r.result ?? '');
      return;
    }
    if (event.name === EventNames.SESSION_ERROR) {
      const e = eventData<'session:error'>(event);
      // delivery_failed is a connectivity status, not a death: the batch went
      // back to 'pending' and is redelivered on reconnect (event-types.ts). The
      // stall rule still bounds a delivery that never comes back.
      if (e.errorKind === 'delivery_failed') {
        log.session.warn('lane turn: delivery failed, waiting for redelivery', {
          sessionId, agentId, conversationId, source: opts.source,
        });
        return;
      }
      // Producers degrade rather than crash — resolve null, never reject.
      if (mode === 'turn') finish(null, `error:${e.errorKind ?? 'unknown'}`, 'died');
      else settleLate(null, 'died');
    }
  };

  const onTick = async (): Promise<void> => {
    if (mode === 'done' || !sessionId || !clock || probing) return;
    const sid = sessionId;
    const stamp = lastSessionProgressAt(sid);
    if (stamp !== undefined) clock.progress(stamp);
    const silentMs = clock.tick(Date.now());
    if (silentMs < DEATH_PROBE_AFTER_MS && silentMs < stallMs) return;
    probing = true;
    try {
      const proc = await readLaneProcess(sid);
      if ((mode as string) === 'done' || sessionId !== sid) return;
      // A remote lane in a tunnel flap reads 'error'/remote_unreachable: that is
      // unknown liveness, not a death (walnut-core-internals, Rule A guard).
      if (laneProcessDead(proc)) {
        if (mode === 'turn') finish(null, `process-${proc.status}`, 'died');
        else settleLate(null, `process-${proc.status}`);
        return;
      }
      if (silentMs < stallMs) return;
      if (mode === 'late') {
        // Silent again: stop waiting for the answer. Unless the record says the
        // turn is over, the CLI may still be in it: drain, never just open.
        settleLate(null, 'stalled-again', proc.status === 'idle' ? 'open' : 'drain');
        return;
      }
      const running = proc.status === 'running';
      log.session.warn('lane turn stalled: no stream progress', {
        sessionId: sid, agentId, conversationId, source: opts.source,
        silentMs, stallMs, processStatus: proc.status, delivered: delivered !== null,
      });
      finish(null, 'stalled', 'stalled', running && (delivered !== null || laneCreated));
    } finally {
      probing = false;
    }
  };

  try {
    // Subscribe BEFORE the spawn/send. A turn can complete in the same tick the
    // message is delivered (hot CLI, cheap answer); a subscription registered
    // after would miss that result forever — the lost-wakeup race.
    //
    // Interest-scoped global subscription (the pattern every other session-event
    // consumer uses). Deliberately NO streaming events (text/thinking deltas):
    // stream liveness comes from session-progress.ts, polled on the tick.
    bus.subscribe(subName, (event) => {
      if (mode === 'done') return;
      if (sessionId === null) {
        if (early.length < EARLY_BUFFER_MAX) early.push(event);
        return;
      }
      consider(event);
    }, {
      global: true,
      interest: [
        EventNames.SESSION_RESULT, EventNames.SESSION_ERROR, EventNames.SESSION_MESSAGES_DELIVERED,
        EventNames.SESSION_TOOL_USE, EventNames.SESSION_TOOL_RESULT,
      ],
    });

    const lane = opts.target
      ? await opts.target.resolve(message)
      : await getOrCreateLaneSession(agentId, conversationId, { firstMessage: message });
    sessionId = lane.sessionId;
    laneCreated = lane.created;

    // A reused lane still busy with a stalled earlier turn: wait for it first.
    // Sending now would join that turn, and its single result would be claimed
    // by both (the 2026-09-26 glued-answer bug).
    let gate = lane.created ? undefined : laneGate(sessionId);
    if (gate) {
      log.session.info('lane turn waiting for the earlier turn on this lane', {
        sessionId, agentId, conversationId, source: opts.source,
      });
      // Same rule as onSessionId: a throwing hook never fails the turn.
      try { opts.onQueued?.(); } catch (err) {
        log.session.warn('lane turn onQueued hook threw', {
          sessionId, agentId, conversationId, source: opts.source,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // The wait is not this agent's work: give up the agent's turn slot for it
      // (core/turn-slot.ts), so the agent's other conversations are not held
      // behind this lane (gate finding N2).
      while (gate) {
        if (await releaseTurnSlotWhile(gate) === 'busy') {
          // The earlier turn did not end even after an interrupt: sending now
          // would join it, so this turn is not sent at all.
          finish(null, 'lane-busy', 'busy');
          return await turn;
        }
        gate = laneGate(sessionId); // closed again meanwhile: wait again
      }
    }

    // Hand the lane id over BEFORE the wait (and before the send below, so a relay
    // subscribed here cannot miss this turn's first deltas). A throwing hook is the
    // caller's bug, never a reason to fail the turn.
    if (opts.onSessionId) {
      try { opts.onSessionId(sessionId); } catch (err) {
        log.session.warn('lane turn onSessionId hook threw', {
          sessionId, agentId, conversationId, source: opts.source,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Only a JUST-CREATED lane may adopt a buffered event: its id was minted
    // microseconds ago inside the call above, so a result carrying it can only be
    // this turn's (the spawn took our message as its first turn). On a REUSED
    // lane, anything that arrived before our send belongs to an EARLIER turn —
    // adopting it would answer with stale text, so drop the buffer.
    if (lane.created) for (const event of early) consider(event);
    early.length = 0;

    clock = createStallClock(Date.now(), tickMs);
    tickTimer = setInterval(() => { void onTick(); }, tickMs);
    tickTimer.unref?.();
    if (opts.timeoutMs !== undefined) {
      ceilingTimer = setTimeout(() => finish(null, 'timeout', 'timeout'), opts.timeoutMs);
      ceilingTimer.unref?.();
    }

    // `created` means the message was consumed as the spawn's FIRST turn —
    // sending it again would deliver it twice (see personal-ai-lane.ts). A fresh
    // mint also needs no catch-up: its spawn profile carries the conversation
    // seed, which covers everything on disk at that moment.
    if (!lane.created && mode === 'turn') {
      const caught = opts.target
        ? await opts.target.catchUp(sessionId, message)
        : await withCatchUpContext(agentId, conversationId, sessionId, message);
      try {
        const { sendMessageToSession } = await import('../session-message-queue.js');
        sendStarted = true;
        const queued = await sendMessageToSession(sessionId, caught.message, { source: opts.source });
        const id = typeof queued?.id === 'string' ? queued.id : null;
        if (id === null) {
          // No id to correlate on: fall back to "first result after our send".
          delivered = {};
        } else {
          ourMessageId = id;
          if (deliveredBeforeId.has(id)) confirmDelivery(deliveredBeforeId.get(id));
        }
        deliveredBeforeId.clear();
        // Advance the high-water mark only now: a send that threw must re-inject.
        if (caught.commit) {
          await caught.commit().catch((err) => log.session.warn('lane turn: recording the catch-up high-water mark failed', {
            sessionId, agentId, conversationId,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      } catch (err) {
        log.session.error('lane turn send failed', {
          sessionId, agentId, conversationId, source: opts.source,
          error: err instanceof Error ? err.message : String(err),
        });
        finish(null, 'send-failed', 'send-failed');
      }
    }

    return await turn;
  } catch (err) {
    cleanup();
    throw err;
  }
}
