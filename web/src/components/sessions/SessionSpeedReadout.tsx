import { useEffect, useState } from 'react';
import type { SessionTurnSpeed } from '@open-walnut/core';
import { turnSpeedStore, useTurnSpeed } from '@/stores/turn-speed-store';
import { formatModelName } from '@/utils/model-name';
import { computeReadout } from './turn-speed-format';
import '@/styles/session-speed.css';

/**
 * The speed readout row of a session: model, output tokens, time to first
 * token, tokens per second, turn wall time, cost. One line, the same slots in
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
 */

interface SessionSpeedReadoutProps {
  sessionId: string;
  /** The panel's record (may still be loading). */
  session: { model?: string; process_status?: string; lastTurnSpeed?: SessionTurnSpeed } | null | undefined;
  /** Where the row sits: inside the model picker (default) or on its own. */
  placement?: 'picker' | 'standalone';
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

export function SessionSpeedReadout({ sessionId, session, placement = 'picker' }: SessionSpeedReadoutProps) {
  const resolved = useTurnSpeed(sessionId, session?.lastTurnSpeed);
  const liveFrame = !!resolved && !resolved.final;
  const receivedAt = turnSpeedStore.receivedAt(sessionId);
  const stale = liveFrame && GONE_STATUSES.has(session?.process_status ?? '')
    && receivedAt > 0 && Date.now() - receivedAt > STALE_LIVE_MS;
  const now = useTicker(liveFrame && !stale);
  if (!resolved) return null;
  const speed: SessionTurnSpeed = stale ? { ...resolved, final: true, interrupted: true, endedAt: receivedAt } : resolved;
  const r = computeReadout(speed, now || Date.now());
  const model = formatModelName(speed.model ?? session?.model) || 'Model';
  const title = [
    'Measured by Walnut from the CLI stream.',
    'first: your message to the first visible token (a fresh session includes its startup). tok/s: CLI output tokens, thinking included, over the time the model spent generating (tool runs excluded).',
    r.partial ? 'This turn was only partly observed (server attached mid-turn), so tok/s covers what it saw.' : '',
    r.tokensEstimated || r.tpsEstimated || r.costEstimated
      ? (r.live
        ? '~ marks an estimate that the CLI’s own count replaces at the next message boundary.'
        : '~ marks an estimate: the CLI never counted this part (the turn was stopped before it finished).')
      : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={`session-speed-readout session-speed-readout-${placement}${r.live ? ' is-live' : ''}${r.interrupted ? ' is-interrupted' : ''}`}
      data-testid="session-speed-readout"
      data-live={r.live ? 'true' : 'false'}
      title={title}
      aria-label={`Turn speed: ${model}, ${r.tokens}${r.ttft ? `, first token ${r.ttft}` : ''}${r.tps ? `, ${r.tps}` : ''}${r.duration ? `, ${r.duration}` : ''}${r.cost ? `, ${r.cost}` : ''}`}
    >
      <span className="session-speed-kicker">{r.live ? 'This turn' : 'Last turn'}</span>
      <span className="session-speed-model" data-testid="speed-model">{model}</span>
      <span className={`session-speed-stat${r.tokensEstimated ? ' is-estimate' : ''}`} data-testid="speed-tokens">{r.tokens}</span>
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
      {r.cost && (
        <span className={`session-speed-stat${r.costEstimated ? ' is-estimate' : ''}`} data-testid="speed-cost">{r.cost}</span>
      )}
      {r.interrupted && <span className="session-speed-stat session-speed-flag" data-testid="speed-flag">stopped</span>}
      {r.partial && !r.interrupted && <span className="session-speed-stat session-speed-flag" data-testid="speed-flag">partial</span>}
    </div>
  );
}
