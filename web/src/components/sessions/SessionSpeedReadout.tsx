import { useEffect, useState } from 'react';
import type { SessionSpeedTotal, SessionTurnSpeed } from '@open-walnut/core';
import { foldTurnSpeed } from '@open-walnut/speed-totals';
import { turnSpeedStore, useTurnSpeed } from '@/stores/turn-speed-store';
import { formatModelName } from '@/utils/model-name';
import { computeReadout, computeLaneRows, speedAverage, turnModelSlot, type SpeedAverage } from './turn-speed-format';
import { parseAcpModelId } from './acp-model-id';
import '@/styles/session-speed.css';

/**
 * The speed readout row of a session: model, output tokens, time to first
 * token, tokens per second, turn wall time. One line, the same slots in
 * the same order on every panel, so two panels side by side (Session panels =
 * 2) compare at a glance. It lives in the composer's model picker (the row
 * under the live-settings strip), next to the model it describes, rather than
 * as a permanent row above the composer (user decision, 2026-09-30).
 *
 * Live while a turn streams (the server emits a frame at every message
 * boundary and throttled in between; this row ticks its clocks locally), then
 * frozen on the turn's final numbers. A reloaded page shows the last turn from
 * the session record. Nothing is drawn for a session that has not run a turn
 * this server measured.
 *
 * Every number is Walnut's own measurement or the CLI's own count; see
 * turn-speed-format.ts for what the "~" marks.
 *
 * Under the main row, one row per model the turn's subagents ran on (the
 * user ran a Haiku agent to see whether it is faster; the row shows it next
 * to the main model, 2026-11-01). A subagent does not stream, so its row's
 * "first" is its first whole message and its tokens are always an estimate
 * (the CLI reports none for an agent); see SessionTurnSpeedLane in core.
 */

interface SessionSpeedReadoutProps {
  sessionId: string;
  /** The panel's record (may still be loading). */
  session: {
    model?: string; acpModel?: string; process_status?: string; lastTurnSpeed?: SessionTurnSpeed;
    speedTotals?: Record<string, SessionSpeedTotal>;
  } | null | undefined;
  /** Where the row sits: inside the model picker (default) or on its own. */
  placement?: 'picker' | 'standalone';
  /** Names the turn's model when its id does not prettify (an ACP engine's
   *  "openai.gpt-6.1-sol"); undefined falls back to formatModelName. */
  modelLabel?: (model: string | undefined) => string | undefined;
}

/** A live frame older than this on a session whose process is gone (record
 *  status stopped/error) was never closed: freeze it as stopped rather than
 *  tick forever. Only terminal statuses count: 'idle' lags a running turn by
 *  seconds on a loaded server (a lagging record froze a live row as stopped
 *  mid-turn in the two-browser Playwright run), and the server now closes the
 *  readout itself on every death path, so this is the last net, not the first. */
const STALE_LIVE_MS = 30_000;
const GONE_STATUSES = new Set(['stopped', 'error']);

/** A clock that ticks only while `live`; the readout's elapsed slots read it. */
function useTicker(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [live]);
  return live ? now : 0;
}

/** "Input 12K (10K cached) · reasoning 300" when the engine reported its input side. */
function usageBreakdown(speed: SessionTurnSpeed): string {
  if (speed.inputTokens === undefined && speed.reasoningTokens === undefined) return '';
  const parts: string[] = [];
  if (speed.inputTokens !== undefined) {
    const cached = speed.cachedInputTokens ?? 0;
    parts.push(`Input ${(speed.inputTokens + cached).toLocaleString()} tokens${cached > 0 ? ` (${cached.toLocaleString()} cached)` : ''}.`);
  }
  if (speed.reasoningTokens !== undefined) parts.push(`Reasoning ${speed.reasoningTokens.toLocaleString()} of the output tokens.`);
  return parts.join(' ');
}

/** The session's turn speed as the readout shows it (live frames tick, a dead live frame freezes
 *  as stopped); null before a turn was measured. Shared by the readout and the picker's Speed toggle. */
function useTurnReadout(sessionId: string, session: SessionSpeedReadoutProps['session']): { speed: SessionTurnSpeed; clock: number } | null {
  const resolved = useTurnSpeed(sessionId, session?.lastTurnSpeed);
  const liveFrame = !!resolved && !resolved.final;
  const receivedAt = turnSpeedStore.receivedAt(sessionId);
  const stale = liveFrame && GONE_STATUSES.has(session?.process_status ?? '')
    && receivedAt > 0 && Date.now() - receivedAt > STALE_LIVE_MS;
  // A subagent may still run after the turn's final (a backgrounded Agent): its
  // row keeps ticking as long as the server keeps sending the final with it.
  const laneRunning = !!resolved?.lanes?.some((l) => l.status === 'running') && !stale
    && !GONE_STATUSES.has(session?.process_status ?? '');
  const now = useTicker((liveFrame && !stale) || laneRunning);
  if (!resolved) return null;
  const speed: SessionTurnSpeed = stale ? { ...resolved, final: true, interrupted: true, endedAt: receivedAt } : resolved;
  return { speed, clock: now || Date.now() };
}

/** What the average line says it covers. */
const AVERAGE_NOTE = 'Output tokens per second of model generation, averaged over this session\'s turns on this model '
  + '(thinking counted; tool waits and time to first token not).';

/**
 * The session's average on the model it runs on now (an ACP id without its effort, as the meter
 * keys it), with a final this page holds live folded into a record read before it landed, by the
 * server's own rule (speed-totals.ts), so the number moves the moment the turn ends.
 */
function sessionAverage(
  session: SessionSpeedReadoutProps['session'],
  speed: SessionTurnSpeed | undefined,
  name: (model: string) => string | undefined,
): { avg: SpeedAverage; model: string } | null {
  const totals = speed ? foldTurnSpeed(session?.speedTotals, speed) : session?.speedTotals;
  const model = session?.acpModel ? parseAcpModelId(session.acpModel).familyId : (session?.model || speed?.model);
  const avg = model ? speedAverage(totals, model, name) : null;
  return avg && model ? { avg, model } : null;
}

/**
 * The picker's Speed toggle: tokens per second, nothing else (the user, 2026-11-21: "spped is
 * token /s nto just time"), and the session's average on its model ("128 tok/s avg"; then: "the
 * speed can we shoudl the avg speed?"), since one turn swings widely. Until a turn was counted it
 * is the last turn's rate: "…" while the turn has produced too little to divide; "—" for a
 * finished turn with no real token count. A dash when no turn was measured.
 */
export function SessionSpeedHeadline({ sessionId, session }: Pick<SessionSpeedReadoutProps, 'sessionId' | 'session'>) {
  const t = useTurnReadout(sessionId, session);
  // No measured turn yet: the toggle still says so, never an empty value.
  if (!t) return <span data-testid="speed-headline-none" title="No turn measured yet">—</span>;
  const average = sessionAverage(session, t.speed, (m) => formatModelName(m) || undefined);
  if (average) {
    const { tps, turns } = average.avg;
    return <span data-testid="speed-headline" title={`${AVERAGE_NOTE} ${turns} turn${turns === 1 ? '' : 's'} counted.`}>{tps} avg</span>;
  }
  const r = computeReadout(t.speed, t.clock);
  const text = r.tps ?? (r.live ? '…' : '—');
  const why = r.tps
    ? (t.speed.tokenScope === 'last-call' ? 'Output tokens per second of the last model call (the engine reports that call only)' : 'Output tokens per second of the last turn')
    : (r.live ? 'Measuring: not enough output yet to divide' : 'This turn has no token count to divide');
  return <span data-testid="speed-headline" title={why}>{text}</span>;
}

export function SessionSpeedReadout({ sessionId, session, placement = 'picker', modelLabel }: SessionSpeedReadoutProps) {
  const t = useTurnReadout(sessionId, session);
  if (!t) return null;
  const { speed, clock } = t;
  const r = computeReadout(speed, clock);
  const lanes = computeLaneRows(speed.lanes, clock);
  // An ACP engine's ids are named by its catalog (modelLabel), which the record's
  // model may not match, so only a Claude Code session is told of a pending switch.
  const slot = turnModelSlot(speed, modelLabel ? undefined : session?.model,
    (m) => modelLabel?.(m) || formatModelName(m) || undefined);
  const model = slot.label || formatModelName(session?.model) || 'Model';
  const label = (m: string) => modelLabel?.(m) || formatModelName(m) || undefined;
  const average = placement === 'picker' ? sessionAverage(session, speed, label) : null;
  const title = [
    'Measured by Walnut from the CLI stream.',
    speed.models && speed.models.length > 1 ? 'The model was switched during this turn: the row names each model it ran on, in order; the numbers cover all of them.' : '',
    slot.next ? `Switched to ${slot.next}: it takes over from this turn's next model call.` : '',
    'first: your message to the first visible token (a fresh session includes its startup). tok/s: CLI output tokens, thinking included, over the time the model spent generating (tool runs excluded).',
    r.partial ? 'This turn was only partly observed (server attached mid-turn), so tok/s covers what it saw.' : '',
    speed.tokenScope === 'last-call'
      ? `The engine reports usage for its last model call only: tokens and tok/s describe that call (1 of ${speed.messages}).`
      : '',
    usageBreakdown(speed),
    r.tokensEstimated || r.tpsEstimated
      ? (r.live
        ? '~ marks an estimate that the CLI’s own count replaces at the next message boundary.'
        : '~ marks an estimate: the CLI never counted this part (the turn was stopped before it finished).')
      : '',
  ].filter(Boolean).join(' ');

  const laneTitle = 'Subagents of this turn, one row per model. A subagent does not stream: first is its first whole message, '
    + 'tok/s is its tokens over the time each of its model calls took (its own tool runs excluded). Its tokens are always '
    + 'an estimate (characters ÷ 4 of its messages and final answer): the CLI reports no output count for an agent.';

  return (<>
    {average && (
      <div className="session-speed-readout session-speed-readout-picker session-speed-average" data-testid="speed-average"
        aria-label={`Average ${average.avg.tps} over ${average.avg.turns} turns on ${label(average.model) ?? average.model}`}>
        <span className="session-speed-kicker">Average</span>
        <span className="session-speed-average-value" data-testid="speed-average-tps">{average.avg.tps}</span>
        <span className="session-speed-stat" data-testid="speed-average-scope">
          {average.avg.turns.toLocaleString('en-US')} turn{average.avg.turns === 1 ? '' : 's'} on {label(average.model) ?? average.model}
        </span>
      </div>
    )}
    <div
      className={`session-speed-readout session-speed-readout-${placement}${r.live ? ' is-live' : ''}${r.interrupted ? ' is-interrupted' : ''}${lanes.length ? ' has-lanes' : ''}`}
      data-testid="session-speed-readout"
      data-live={r.live ? 'true' : 'false'}
      title={title}
      aria-label={`Turn speed: ${model}${slot.next ? `, ${slot.next} from the next call` : ''}, ${r.tokens}${r.ttft ? `, first token ${r.ttft}` : ''}${r.tps ? `, ${r.tps}` : ''}${r.duration ? `, ${r.duration}` : ''}`}
    >
      <span className="session-speed-kicker">{r.live ? 'This turn' : 'Last turn'}</span>
      <span className="session-speed-model" data-testid="speed-model">{model}</span>
      {slot.next && (
        <span className="session-speed-stat session-speed-label" data-testid="speed-next-model">
          {'\u2192'} {slot.next} next call
        </span>
      )}
      <span className={`session-speed-stat${r.tokensEstimated ? ' is-estimate' : ''}`} data-testid="speed-tokens">
        {r.tokens}{speed.tokenScope === 'last-call' && <span className="session-speed-label"> last call</span>}
      </span>
      {r.ttft && (
        <span className={`session-speed-stat${r.ttftPending ? ' is-pending' : ''}`} data-testid="speed-ttft">
          <span className="session-speed-label">first</span> {r.ttft}
        </span>
      )}
      {r.tps && (
        <span className={`session-speed-stat${r.tpsEstimated ? ' is-estimate' : ''}`} data-testid="speed-tps">{r.tps}</span>
      )}
      {r.duration && (
        <span className="session-speed-stat" data-testid="speed-duration">{r.duration}</span>
      )}
      {r.interrupted && <span className="session-speed-stat session-speed-flag" data-testid="speed-flag">stopped</span>}
      {r.partial && !r.interrupted && <span className="session-speed-stat session-speed-flag" data-testid="speed-flag">partial</span>}
    </div>
    {lanes.map((lane, i) => {
      const name = (lane.model && (modelLabel?.(lane.model) || formatModelName(lane.model))) || lane.label || 'Agent';
      const live = lane.status === 'running';
      return (
        <div
          key={lane.key}
          className={`session-speed-readout session-speed-readout-${placement} session-speed-lane${live ? ' is-live' : ''}${i === lanes.length - 1 ? ' is-last' : ''}`}
          data-testid="speed-lane"
          data-model={lane.model ?? ''}
          data-live={live ? 'true' : 'false'}
          title={laneTitle}
          aria-label={`Subagent${lane.count > 1 ? 's' : ''} on ${name}: ${lane.tokens}${lane.first ? `, first message ${lane.first}` : ''}${lane.tps ? `, ${lane.tps}` : ''}${lane.duration ? `, ${lane.duration}` : ''}, ${lane.status}`}
        >
          <span className="session-speed-kicker">{lane.count > 1 ? `Agents ×${lane.count}` : 'Agent'}</span>
          <span className="session-speed-model" data-testid="speed-lane-model">{name}</span>
          <span className={`session-speed-stat${lane.tokensEstimated ? ' is-estimate' : ''}`} data-testid="speed-lane-tokens">{lane.tokens}</span>
          {lane.first && (
            <span className={`session-speed-stat${lane.firstPending ? ' is-pending' : ''}`} data-testid="speed-lane-first">
              <span className="session-speed-label">first</span> {lane.first}
            </span>
          )}
          {lane.tps && <span className={`session-speed-stat${lane.tpsEstimated ? ' is-estimate' : ''}`} data-testid="speed-lane-tps">{lane.tps}</span>}
          {lane.duration && <span className="session-speed-stat" data-testid="speed-lane-duration">{lane.duration}</span>}
          {lane.status !== 'done' && (
            <span className={`session-speed-stat${live ? ' session-speed-label' : ' session-speed-flag'}`} data-testid="speed-lane-status">{lane.status}</span>
          )}
        </div>
      );
    })}
    {average && <div className="session-speed-note" data-testid="speed-average-note">{AVERAGE_NOTE}</div>}
  </>);
}
