import React, { useEffect, useState } from 'react';
import type { SessionSpeedTotal, SessionTurnSpeed } from '@open-walnut/core';
import { foldTurnSpeed } from '@open-walnut/speed-totals';
import { turnSpeedStore, useTurnSpeed } from '@/stores/turn-speed-store';
import { formatModelName } from '@/utils/model-name';
import { computeReadout, computeLaneRows, speedAverage, turnModelSlot, type SpeedAverage } from './turn-speed-format';
import { parseAcpModelId } from './acp-model-id';
import '@/styles/session-speed.css';

/**
 * The speed readout of a session, in the model picker's Speed fold: the session's average on its
 * model on top, then a small table (Model | Tokens | First token | Speed | Time) with one row for
 * the turn ("This turn" while it runs, "Last turn" once final, its state as a small grey word:
 * partial, stopped, last call) and one row per model the turn's subagents ran on (design A,
 * 2026-11-21: "the 2 bar below is so bad"). The same columns on every panel, so two panels side
 * by side (Session panels = 2) compare at a glance. It lives in the picker, next to the model it
 * describes, rather than as a permanent row above the composer (user decision, 2026-09-30).
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
    return (
      <span data-testid="speed-headline" title={`${AVERAGE_NOTE} ${turns} turn${turns === 1 ? '' : 's'} counted.`}>
        {tps} <span className="model-picker-fold-unit">avg</span>
      </span>
    );
  }
  const r = computeReadout(t.speed, t.clock);
  const text = r.tps ?? (r.live ? '…' : '—');
  const why = r.tps
    ? (t.speed.tokenScope === 'last-call' ? 'Output tokens per second of the last model call (the engine reports that call only)' : 'Output tokens per second of the last turn')
    : (r.live ? 'Measuring: not enough output yet to divide' : 'This turn has no token count to divide');
  return <span data-testid="speed-headline" title={why}>{text}</span>;
}

/** A count in the Tokens column: the header names the unit, the cell keeps the "~" of an estimate. */
const bare = (tokens: string) => tokens.replace(/ tok$/, '');

/** A name that may wrap between its words but never inside one ("GPT-6.2-" / "Sol" read badly). */
function Words({ text }: { text: string }) {
  const words = text.split(' ');
  return <>{words.map((w, i) => <React.Fragment key={i}>{i > 0 && ' '}<span className="session-speed-word">{w}</span></React.Fragment>)}</>;
}

/** A row's state words after its label ("partial", "last call", "running"), small and grey. */
function StateWords({ words, dot }: { words: { text: string; testId: string; title?: string }[]; dot?: boolean }) {
  if (words.length === 0 && !dot) return null;
  return (
    <span className="session-speed-states">
      {dot && <span className="session-speed-dot" aria-hidden />}
      {words.map((w) => <span key={w.testId} className="session-speed-state" data-testid={w.testId} title={w.title}>{w.text}</span>)}
    </span>
  );
}

const LAST_CALL_TITLE = 'The engine reports usage for its last model call only: tokens and tok/s describe that call.';

export function SessionSpeedReadout({ sessionId, session, modelLabel }: SessionSpeedReadoutProps) {
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
  const average = sessionAverage(session, speed, label);
  const lastCall = speed.tokenScope === 'last-call';
  const title = [
    'Measured by Walnut from the CLI stream.',
    speed.models && speed.models.length > 1 ? 'The model was switched during this turn: the row names each model it ran on, in order; the numbers cover all of them.' : '',
    slot.next ? `Switched to ${slot.next}: it takes over from this turn's next model call.` : '',
    'First token: your message to the first visible token (a fresh session includes its startup). Speed: CLI output tokens, thinking included, over the time the model spent generating (tool runs excluded).',
    r.partial ? 'This turn was only partly observed (server attached mid-turn), so tok/s covers what it saw.' : '',
    lastCall ? `The engine reports usage for its last model call only: tokens and tok/s describe that call (1 of ${speed.messages}).` : '',
    usageBreakdown(speed),
    r.tokensEstimated || r.tpsEstimated
      ? (r.live
        ? '~ marks an estimate that the CLI’s own count replaces at the next message boundary.'
        : '~ marks an estimate: the CLI never counted this part (the turn was stopped before it finished).')
      : '',
  ].filter(Boolean).join(' ');

  const laneTitle = 'Subagents of this turn, one row per model. A subagent does not stream: First token is its first whole message, '
    + 'Speed is its tokens over the time each of its model calls took (its own tool runs excluded). Its tokens are always '
    + 'an estimate (characters ÷ 4 of its messages and final answer): the CLI reports no output count for an agent.';

  // One label per row, by its state: "This turn" while it runs, "Last turn" once it is final.
  const turnWords = [
    ...(r.interrupted ? [{ text: 'stopped', testId: 'speed-flag' }] : r.partial ? [{ text: 'partial', testId: 'speed-flag' }] : []),
    ...(lastCall ? [{ text: 'last call', testId: 'speed-scope', title: LAST_CALL_TITLE }] : []),
  ];

  return (
    <div className="session-speed" data-testid="session-speed">
      {average && (
        <div className="session-speed-average" data-testid="speed-average"
          aria-label={`Average ${average.avg.tps} over ${average.avg.turns} turns on ${label(average.model) ?? average.model}`}>
          <span>Session average</span>
          <strong className="session-speed-average-value" data-testid="speed-average-tps">{average.avg.tps}</strong>
          <span data-testid="speed-average-scope">
            {average.avg.turns.toLocaleString('en-US')} turn{average.avg.turns === 1 ? '' : 's'} on {label(average.model) ?? average.model}
          </span>
        </div>
      )}
      <table className="session-speed-table" data-testid="session-speed-table">
        <thead>
          <tr>
            <th scope="col" aria-label="Run" />
            <th scope="col">Model</th>
            <th scope="col">Tokens</th>
            <th scope="col">First token</th>
            <th scope="col">Speed</th>
            <th scope="col">Time</th>
          </tr>
        </thead>
        <tbody>
          <tr
            className={`session-speed-readout${r.live ? ' is-live' : ''}${r.interrupted ? ' is-interrupted' : ''}`}
            data-testid="session-speed-readout"
            data-live={r.live ? 'true' : 'false'}
            title={title}
            aria-label={`Turn speed: ${model}${slot.next ? `, ${slot.next} from the next call` : ''}, ${r.tokens}${lastCall ? ' (last call)' : ''}${r.ttft ? `, first token ${r.ttft}` : ''}${r.tps ? `, ${r.tps}` : ''}${r.duration ? `, ${r.duration}` : ''}`}
          >
            <th scope="row">
              <span className="session-speed-kicker"><Words text={r.live ? 'This turn' : 'Last turn'} /></span>{' '}
              <StateWords words={turnWords} dot={r.live} />
            </th>
            <td className="session-speed-model-cell">
              <span className="session-speed-model" data-testid="speed-model"><Words text={model} /></span>
              {slot.next && <span className="session-speed-state session-speed-next" data-testid="speed-next-model">{'→'} {slot.next} next call</span>}
            </td>
            <td data-testid="speed-tokens">{bare(r.tokens)}</td>
            <td className={r.ttftPending ? 'is-pending' : undefined} data-testid={r.ttft ? 'speed-ttft' : undefined}>{r.ttft}</td>
            <td data-testid={r.tps ? 'speed-tps' : undefined}>{r.tps}</td>
            <td data-testid={r.duration ? 'speed-duration' : undefined}>{r.duration}</td>
          </tr>
          {lanes.map((lane) => {
            const name = (lane.model && (modelLabel?.(lane.model) || formatModelName(lane.model))) || lane.label || 'Agent';
            const live = lane.status === 'running';
            return (
              <tr
                key={lane.key}
                className={`session-speed-lane${live ? ' is-live' : ''}`}
                data-testid="speed-lane"
                data-model={lane.model ?? ''}
                data-live={live ? 'true' : 'false'}
                title={laneTitle}
                aria-label={`Subagent${lane.count > 1 ? 's' : ''} on ${name}: ${lane.tokens}${lane.first ? `, first message ${lane.first}` : ''}${lane.tps ? `, ${lane.tps}` : ''}${lane.duration ? `, ${lane.duration}` : ''}, ${lane.status}`}
              >
                <th scope="row">
                  <span className="session-speed-kicker"><Words text={lane.count > 1 ? `Agents ×${lane.count}` : 'Agent'} /></span>{' '}
                  <StateWords dot={live} words={lane.status === 'done' ? [] : [{ text: lane.status, testId: 'speed-lane-status' }]} />
                </th>
                <td className="session-speed-model-cell"><span className="session-speed-model" data-testid="speed-lane-model"><Words text={name} /></span></td>
                <td data-testid="speed-lane-tokens">{bare(lane.tokens)}</td>
                <td className={lane.firstPending ? 'is-pending' : undefined} data-testid={lane.first ? 'speed-lane-first' : undefined}>{lane.first}</td>
                <td data-testid={lane.tps ? 'speed-lane-tps' : undefined}>{lane.tps}</td>
                <td data-testid={lane.duration ? 'speed-lane-duration' : undefined}>{lane.duration}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {average && <div className="session-speed-note" data-testid="speed-average-note">{AVERAGE_NOTE}</div>}
    </div>
  );
}
