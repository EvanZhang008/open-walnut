import { useEffect, useRef, useState } from 'react';
import { serverNow, useHostLimitFrame, limitHostKey, LOCAL_LIMIT_HOST } from '@/stores/subscription-limits-store';
import { computeLimitReadout, AGE_SHOWN_AFTER_MS } from '@/utils/subscription-limit-format';
import type { HostLimitFrame } from '@/api/subscription-limits';
import { log } from '@/utils/log';
import '@/styles/subscription-limits.css';

/**
 * The Claude subscription limits of a session's host: one line per usage
 * window (5-hour, weekly, per-model weekly) with its percentage and reset
 * time, plus extra usage when it matters. It sits in the Switch Model popover
 * under the turn speed row; the model pill carries only a dot, and only while a
 * limit warns or is reached (SubscriptionLimitPillHint). A host that never
 * reported a reading (Bedrock, Vertex, an API key) renders nothing at all.
 *
 * The readings are the CLI's own `rate_limit_event` lines, kept per host by the
 * server (core/sessions/subscription-limits.ts); see
 * utils/subscription-limit-format.ts for every wording rule.
 */

/** Reset times and age labels move with the clock: re-render at the next moment one does. */
function nextChangeAt(frame: HostLimitFrame | null, now: number): number | null {
  if (!frame) return null;
  const times: number[] = [];
  for (const w of Object.values(frame.windows ?? {})) {
    if (w.resetsAt !== undefined && w.resetsAt > now) times.push(w.resetsAt);
    if (w.seenAt + AGE_SHOWN_AFTER_MS > now) times.push(w.seenAt + AGE_SHOWN_AFTER_MS);
  }
  const c = frame.current;
  if (c?.resetsAt !== undefined && c.resetsAt > now) times.push(c.resetsAt);
  if (frame.overage?.resetsAt !== undefined && frame.overage.resetsAt > now) times.push(frame.overage.resetsAt);
  return times.length ? Math.min(...times) : null;
}

/** The server's clock, re-read at the frame's next change (and every `tickMs` when given). */
function useLimitClock(frame: HostLimitFrame | null, tickMs?: number): number {
  const [tick, setTick] = useState(0);
  const now = serverNow();
  useEffect(() => {
    const t = serverNow();
    const next = nextChangeAt(frame, t);
    // setTimeout tops out near 24.8 days; an hour is plenty between re-checks.
    const wait = Math.min(tickMs ?? Infinity, next !== null ? next - t + 250 : Infinity, 60 * 60_000);
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(1_000, wait));
    return () => clearTimeout(timer);
  }, [frame, tickMs, tick]);
  return now;
}

interface ReadoutProps {
  /** The session record's host (undefined = this machine). */
  host: string | null | undefined;
}

export function SubscriptionLimitReadout({ host }: ReadoutProps) {
  const frame = useHostLimitFrame(host);
  // Open popover: the age labels tick by the minute.
  const now = useLimitClock(frame, 30_000);
  const readout = computeLimitReadout(frame, now);
  if (!readout) return null;
  const key = limitHostKey(host);
  return (
    <div
      className="subscription-limit-readout"
      data-testid="subscription-limit-readout"
      data-host={key}
      aria-label="Claude subscription limits"
    >
      <div className="subscription-limit-kicker">
        Usage limits{key !== LOCAL_LIMIT_HOST ? <span className="subscription-limit-host"> · {key}</span> : null}
      </div>
      {readout.rows.map((r) => (
        <div
          key={r.type}
          className={`subscription-limit-row is-${r.state}`}
          data-testid="limit-row"
          data-limit-type={r.type}
          data-state={r.state}
          title={r.title}
        >
          <span className="subscription-limit-label" data-testid="limit-label">{r.label}</span>
          {r.value && <span className="subscription-limit-value" data-testid="limit-value">{r.value}</span>}
          {r.when && <span className="subscription-limit-stat" data-testid="limit-when">{r.when}</span>}
          {r.age && <span className="subscription-limit-stat subscription-limit-age" data-testid="limit-age">{r.age}</span>}
        </div>
      ))}
      {readout.overage && (
        <div className={`subscription-limit-row subscription-limit-overage is-${readout.overage.state}`} data-testid="limit-overage" data-state={readout.overage.state}>
          {readout.overage.text}
        </div>
      )}
    </div>
  );
}

interface HintProps extends ReadoutProps {
  /** The live session the pill belongs to (for the log line). */
  sessionId?: string;
}

/** The model pill's dot: nothing at all unless a limit warns or is reached. */
export function SubscriptionLimitPillHint({ host, sessionId }: HintProps) {
  const frame = useHostLimitFrame(host);
  const now = useLimitClock(frame);
  const hint = computeLimitReadout(frame, now)?.hint ?? null;
  const shown = useRef<string | null>(null);
  const level = hint?.level ?? null;
  useEffect(() => {
    if (shown.current === level) return;
    shown.current = level;
    if (level) log.info('subscription-limits', 'model pill limit hint shown', { host: limitHostKey(host), sessionId, level });
  }, [level, host, sessionId]);
  if (!hint) return null;
  return (
    <span
      className={`composer-limit-hint is-${hint.level}`}
      data-testid="limit-pill-hint"
      data-level={hint.level}
      role="img"
      aria-label={hint.text}
      title={`${hint.text}. Open to see every limit.`}
    />
  );
}
