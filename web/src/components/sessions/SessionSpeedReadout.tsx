import { useEffect, useState } from 'react';
import type { SessionTurnSpeed } from '@open-walnut/core';
import { turnSpeedStore, useTurnSpeed } from '@/stores/turn-speed-store';
import { formatModelName } from '@/utils/model-name';
import { computeReadout, computeLaneRows } from './turn-speed-format';
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
  session: { model?: string; process_status?: string; lastTurnSpeed?: SessionTurnSpeed } | null | undefined;
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

export function SessionSpeedReadout({ sessionId, session, placement = 'picker', modelLabel }: SessionSpeedReadoutProps) {
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
  const clock = now || Date.now();
  const r = computeReadout(speed, clock);
  const lanes = computeLaneRows(speed.lanes, clock);
  const model = modelLabel?.(speed.model) || formatModelName(speed.model ?? session?.model) || 'Model';
  const title = [
    'Measured by Walnut from the CLI stream.',
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
    <div
      className={`session-speed-readout session-speed-readout-${placement}${r.live ? ' is-live' : ''}${r.interrupted ? ' is-interrupted' : ''}${lanes.length ? ' has-lanes' : ''}`}
      data-testid="session-speed-readout"
      data-live={r.live ? 'true' : 'false'}
      title={title}
      aria-label={`Turn speed: ${model}, ${r.tokens}${r.ttft ? `, first token ${r.ttft}` : ''}${r.tps ? `, ${r.tps}` : ''}${r.duration ? `, ${r.duration}` : ''}`}
    >
      <span className="session-speed-kicker">{r.live ? 'This turn' : 'Last turn'}</span>
      <span className="session-speed-model" data-testid="speed-model">{model}</span>
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
  </>);
}
