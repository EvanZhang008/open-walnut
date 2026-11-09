/**
 * The session's usage limit stopped its turn (server: src/core/sessions/usage-limit-wait.ts).
 * Shown above the composer in place of the error banner while `record.usageLimit` is set:
 *
 *   waiting   "Claude 5-hour limit · resets 3:00 PM"  Walnut continues it at 3:01 PM (in 2 h 14 min)
 *             [Continue now] [Don't auto-continue]
 *   off       the same head, "Auto-continue is off"            [Continue now] [Continue after reset]
 *   gave_up   the limit kept refusing the continue             [Continue now] [Continue after reset]
 *   resumed   hidden while the continued turn runs; "Continuing…" until it starts
 *
 * The countdown re-renders every 30 s; times are the browser's own clock and zone.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionUsageLimit, SessionUsageLimitContinued } from '@open-walnut/core';
import { usageLimitAction, type UsageLimitAction } from '@/api/sessions';
import { limitName, limitTimeWords } from '@open-walnut/user-status';
import { log } from '@/utils/log';
import '@/styles/usage-limit.css';

/** "3:00 PM", or "Thu 3:00 PM" when it is not today: the task row's words too (limitedLine). */
export function limitClock(iso: string | undefined, now: number): string {
  return limitTimeWords(iso, now);
}

/** "in 2 h 14 min", "in 5 min", "in under a minute", "now". */
export function limitIn(iso: string | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const min = Math.round((t - now) / 60_000);
  if (t - now <= 0) return 'now';
  if (min < 1) return 'in under a minute';
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return `in ${d} d${h ? ` ${h} h` : ''}`;
  return h > 0 ? `in ${h} h${m ? ` ${m} min` : ''}` : `in ${m} min`;
}

/** Past the reset, still waiting on Walnut's continue. */
export function passedReset(w: SessionUsageLimit, now: number): boolean {
  return w.state === 'waiting' && resetGone(w, now);
}

/** The limit's named reset has passed, whatever the wait's state. */
export function resetGone(w: SessionUsageLimit, now: number): boolean {
  return !!w.resetsAt && Date.parse(w.resetsAt) <= now;
}

/** The banner's tag: Limited while the limit holds; past the reset, Continuing while Walnut is
 *  about to go on, else Reset (the limit no longer holds it; it waits for the user). */
export function usageLimitTag(w: SessionUsageLimit, now: number): string {
  if (w.state === 'resumed' || !resetGone(w, now)) return 'Limited';
  return w.state === 'waiting' ? 'Continuing' : 'Reset';
}

/** The banner's words, kept pure for the unit test. */
export function usageLimitBannerText(w: SessionUsageLimit, now: number): { head: string; when: string; detail: string } {
  const name = limitName(w);
  const reset = limitClock(w.resetsAt, now);
  const resetFuture = !!w.resetsAt && Date.parse(w.resetsAt) > now;
  const due = limitClock(w.dueAt, now);
  const inWords = limitIn(w.dueAt, now);
  // Past the reset (still waiting on Walnut's continue): the head says so, and when it goes on.
  const passed = passedReset(w, now);
  // Past the reset the limit no longer holds it, whoever continues it.
  const gone = w.state !== 'resumed' && resetGone(w, now);
  const head = gone ? `${name} has reset` : `${name} reached`;
  // A reset read from the limit's own words ("try again in 2 hours") is an estimate: it says so.
  const about = w.resetsFrom === 'text' ? 'about ' : '';
  const when = passed ? (due && inWords !== 'now' ? `continuing at ${due}` : 'continuing now')
    : gone ? `at ${about}${reset}` : reset ? `${resetFuture ? 'resets' : 'reset'} ${about}${reset}` : '';
  if (w.state === 'off') {
    return { head, when, detail: gone
      ? 'Auto-continue is off, so this task now waits for you. The limit has reset: continue it whenever you want.'
      : 'Auto-continue is off, so this task now waits for you. Continue now tries it now; if the limit still holds, it stops again and waits for you.' };
  }
  if (w.state === 'gave_up') {
    const tried = `Walnut continued it ${w.resumes} time${w.resumes === 1 ? '' : 's'} and the limit still refused.`;
    return { head, when, detail: gone ? `${tried} It has reset since: continue it when you want.` : `${tried} Continue it once your limit allows.` };
  }
  if (w.state === 'resumed') return { head, when, detail: 'Continuing where it left off…' };
  // The continue's own clock time, its countdown beside it (never read as the time to the reset).
  const at = due ? `at ${due} (${inWords})` : 'shortly';
  const kept = 'Your conversation is kept; a message from you continues it too.';
  return {
    head,
    when,
    detail: passed
      ? `Walnut continues it shortly after the reset, once the new window is in effect. ${kept}`
      : reset
      // Continue now before the reset is a try: the words say what it costs if the limit holds.
      ? about
        ? `Walnut tries to continue it by itself ${at}, and again later if the limit still holds. Continue now tries sooner.`
        : `Walnut continues it by itself ${at}. Continue now tries sooner; if the limit still holds, it just waits again.`
      : `The limit did not say when it resets: Walnut tries again ${due ? at : 'later'}. ${kept}`,
  };
}

export function UsageLimitBanner({ sessionId, usageLimit, onChange }: {
  sessionId: string;
  usageLimit: SessionUsageLimit;
  onChange?: (next: SessionUsageLimit | null) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<UsageLimitAction | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // A switch replaces the button it was pressed on with its opposite: focus goes to the banner, so
  // a second Enter never undoes the first.
  const rootRef = useRef<HTMLDivElement>(null);
  // Every 30 s, every 5 s in the last two minutes, so "in under a minute" is said on time.
  const dueMs = usageLimit.dueAt ? Date.parse(usageLimit.dueAt) : NaN;
  const close = Number.isFinite(dueMs) && dueMs - now < 120_000;
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), close ? 5_000 : 30_000);
    return () => window.clearInterval(id);
  }, [close]);
  useEffect(() => { setFailure(null); }, [usageLimit.state]);

  const run = useCallback(async (action: UsageLimitAction) => {
    setBusy(action);
    setFailure(null);
    try {
      const out = await usageLimitAction(sessionId, action);
      log.info('session-panel', 'usage-limit action', { sessionId, action, state: out.usageLimit?.state ?? null });
      onChange?.(out.usageLimit);
      if (action !== 'continue') rootRef.current?.focus();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('session-panel', 'usage-limit action failed', { sessionId, action, error: message });
      setFailure(message);
    } finally {
      setBusy(null);
    }
  }, [sessionId, onChange]);

  const { head, when, detail } = usageLimitBannerText(usageLimit, now);
  const auto = usageLimit.state === 'waiting';
  // Past the reset Walnut's continue is a minute away: Don't auto-continue cancels that one.
  const passed = passedReset(usageLimit, now);
  // Continue now before the reset may meet the limit again: the banner says what happens then.
  const early = !!usageLimit.resetsAt && Date.parse(usageLimit.resetsAt) > now;
  const resumed = usageLimit.state === 'resumed';
  return (
    // session-error-banner: the base of every banner between the panel's glass header and the chat
    // (the rules that push it below the header key on it); usage-limit.css gives it its own look.
    <div className={`session-error-banner usage-limit-banner is-${usageLimit.state}`} data-testid="usage-limit-banner" data-state={usageLimit.state} role="status" ref={rootRef} tabIndex={-1}>
      <span className="usage-limit-banner-icon" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 4.5V8l2.4 1.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </span>
      <div className="usage-limit-banner-body">
        <div className="usage-limit-banner-head"><span className="usage-limit-tag">{usageLimitTag(usageLimit, now)}</span> {head}
          {when && <> · <span className="usage-limit-when">{when}</span></>}</div>
        <div className="usage-limit-banner-detail">{detail}</div>
        {failure && <div className="usage-limit-banner-failure" role="alert">{failure}</div>}
      </div>
      {!resumed && (
        <div className="usage-limit-banner-actions">
          {/* Before the reset it is a try (the limit may refuse it again), so not the primary button;
              past the reset it is the continue, a moment before Walnut's own. */}
          <button type="button" className={`usage-limit-btn${early ? '' : ' is-primary'}`} onClick={() => void run('continue')} disabled={busy !== null}
            title={early ? 'Send it a continue now. The limit has not reset yet, so it may stop again; then Walnut waits for the reset.' : 'Send it a continue now.'}>
            {busy === 'continue' ? 'Continuing…' : 'Continue now'}
          </button>
          {auto ? (
            <button type="button" className="usage-limit-btn" onClick={() => void run('off')} disabled={busy !== null}
              title="Walnut will not continue this session by itself. It then needs you.">
              {busy === 'off' ? 'Turning off…' : "Don't auto-continue"}
            </button>
          ) : early || !usageLimit.resetsAt ? (
            // Past the reset there is no reset to wait for: Continue now is the continue.
            <button type="button" className="usage-limit-btn" onClick={() => void run('auto')} disabled={busy !== null}
              title="Walnut continues this session by itself when the limit resets.">
              {busy === 'auto' ? 'Turning on…' : 'Continue after reset'}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** "Walnut continued this session at 11:51 AM, after the limit reset." Pure, for the
 *  unit test. */
export function usageLimitContinuedText(note: SessionUsageLimitContinued, now: number): string {
  // One short sentence, the same shape whoever continued it: who, then when.
  const at = limitClock(note.at, now);
  const who = note.by === 'your-message' ? 'Your message' : note.by === 'message' ? 'A new message' : note.by === 'user' ? 'You' : 'Walnut';
  return `${who} continued this session at ${at}${who === 'Walnut' ? ', after the limit reset' : ''}.`;
}

/** How long after a continue went in the panel lets the continued note speak for a session that
 *  still reads as ended: the new turn's process can take that long to start on a busy machine. */
export const CONTINUED_GRACE_MS = 60_000;

/** True while a session the usage limit held was just continued (Walnut, Continue now, or a new
 *  message) and still reads as ended with no recorded cause: its next turn is starting, so the
 *  generic "Session ended" error would only flash under the continued note. Past the grace, or
 *  with a cause recorded, the error shows as for any session. Pure, for the unit test. */
export function continuingAfterLimit(note: SessionUsageLimitContinued | undefined, processStatus: string | undefined,
  errorMessage: string | undefined, now: number): boolean {
  if (!note || processStatus !== 'error' || errorMessage) return false;
  const at = Date.parse(note.at);
  return Number.isFinite(at) && now - at < CONTINUED_GRACE_MS;
}

/** continuingAfterLimit, renewed when the grace ends. */
export function useContinuingAfterLimit(note: SessionUsageLimitContinued | undefined, processStatus: string | undefined,
  errorMessage: string | undefined): boolean {
  const [now, setNow] = useState(() => Date.now());
  const on = continuingAfterLimit(note, processStatus, errorMessage, now);
  const at = note?.at;
  useEffect(() => {
    if (!on || !at) return;
    const id = window.setTimeout(() => setNow(Date.now()), Math.max(0, Date.parse(at) + CONTINUED_GRACE_MS - Date.now()) + 50);
    return () => window.clearTimeout(id);
  }, [on, at]);
  return on;
}

/** Walnut's own continue after the reset ran: one quiet line, so a person coming back later reads
 *  why the session went on. Gone at the next message into it, or with its ×. */
export function UsageLimitContinuedNote({ sessionId, note, onDismiss }: {
  sessionId: string;
  note: SessionUsageLimitContinued;
  onDismiss: () => void;
}) {
  const dismiss = useCallback(() => {
    onDismiss();
    usageLimitAction(sessionId, 'dismiss').catch((err) => {
      log.warn('session-panel', 'usage-limit note dismiss failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
    });
  }, [sessionId, onDismiss]);
  return (
    // session-error-banner: placement under the glass header (see UsageLimitBanner).
    <div className="session-error-banner usage-limit-banner usage-limit-note" data-testid="usage-limit-continued" role="status">
      <span className="usage-limit-banner-icon" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="16" height="16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
      <div className="usage-limit-banner-body">{usageLimitContinuedText(note, Date.now())}</div>
      <button type="button" className="usage-limit-note-close" onClick={dismiss} aria-label="Dismiss" title="Dismiss">
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}
