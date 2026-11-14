/**
 * The Browser replay: a task's recorded browser steps played back in its Browser view (2026-11-14,
 * the user: "can we make sure the browser action screenshot or video is saved for 7 days
 * (configurable), and can be played back"). Each step an agent took in the person's browser (a
 * click, a type, an open...) has its picture, taken right after it (server:
 * src/core/browser-control/replay-store.ts; the extension's agent-replay.ts).
 *
 *   picture   the step's own, or the last earlier one when the tab could not be pictured then
 *   scrubber  one stop per step; the arrow keys step through it
 *   controls  previous, Play / Pause (one, two or four steps a second), next; Back to live
 *   steps     the list, each with its time and what it did; a click goes to it
 *
 * Pictures are read one at a time as they are shown (the next few ahead while playing), kept for
 * the card's life. The list is read again every few seconds while the replay is open, so a running
 * task's new steps join it; a replay left at its last step follows them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet } from '@/api/client';
import { log } from '@/utils/log';
import { NO_REPLAY, NO_STEP_PICTURE, REPLAY_REREAD_MS, REPLAY_SPEEDS, agoLine, pictureIndex, replayTimeLine, type ReplayStep } from './browser-view-model';

const CLOSE_GLYPH = (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2 8 8M8 2 2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
);
/** Pictures kept in memory at most (each is a JPEG data URL of 50 to 300 KB). */
const CACHE_MAX = 80;
/** Pictures read ahead while playing. */
const AHEAD = 3;

export function SessionBrowserReplay({ taskId, large, onLarge, onBack, onClose }: {
  taskId: string;
  large: boolean;
  onLarge: () => void;
  /** Back to the live view (only while the task still has a tab). */
  onBack?: () => void;
  onClose: () => void;
}) {
  const [steps, setSteps] = useState<ReplayStep[] | null>(null);
  const [days, setDays] = useState<number | null>(null);
  const [i, setI] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [, setLoaded] = useState(0);
  const cache = useRef(new Map<string, string>());
  const asking = useRef(new Set<string>());
  // Pictures that are gone (deleted after the days kept): never asked again.
  const missing = useRef(new Set<string>());
  const listRef = useRef<HTMLOListElement>(null);

  const read = useCallback(async () => {
    try {
      const r = await apiGet<{ steps: ReplayStep[]; days: number }>('/api/v1/browser/view/replay', { task: taskId }, { priority: 'low', timeoutMs: 15_000 });
      setSteps((prev) => {
        const next = r.steps ?? [];
        // Same list: no new render.
        if (prev && prev.length === next.length && prev[prev.length - 1]?.id === next[next.length - 1]?.id) return prev;
        return next;
      });
      setDays(r.days);
      setTrouble(null);
    } catch (err) {
      setTrouble(err instanceof Error ? err.message : String(err));
    }
  }, [taskId]);

  useEffect(() => {
    void read();
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void read(); }, REPLAY_REREAD_MS);
    return () => window.clearInterval(t);
  }, [read]);

  // First read: the last step. A replay left at the last step of the list before follows new ones;
  // any other stays on the same step (by its id: older steps may have been deleted meanwhile).
  const playingNow = useRef(false);
  playingNow.current = playing;
  const before = useRef<{ len: number; id?: string }>({ len: 0 });
  useEffect(() => {
    if (!steps) return;
    const was = before.current;
    setI((cur) => {
      if (cur < 0 || (cur === was.len - 1 && !playingNow.current)) return steps.length - 1;
      const k = was.id ? steps.findIndex((s) => s.id === was.id) : -1;
      return k >= 0 ? k : Math.min(cur, steps.length - 1);
    });
  }, [steps]);
  useEffect(() => { before.current = { len: steps?.length ?? 0, id: steps && i >= 0 ? steps[i]?.id : undefined }; }, [steps, i]);

  const fetchPicture = useCallback(async (id: string) => {
    if (cache.current.has(id) || asking.current.has(id) || missing.current.has(id)) return;
    asking.current.add(id);
    try {
      const r = await apiGet<{ image: string }>('/api/v1/browser/view/replay/frame', { task: taskId, id }, { priority: 'low', timeoutMs: 15_000, quietStatuses: [404] });
      // Decoded first, so the picture never blinks while the next one loads.
      const img = new Image();
      img.src = r.image;
      await img.decode().catch(() => undefined);
      cache.current.set(id, r.image);
      if (cache.current.size > CACHE_MAX) cache.current.delete(cache.current.keys().next().value!);
      setLoaded((n) => n + 1);
    } catch (err) {
      if ((err as { status?: number }).status === 404) { missing.current.add(id); setLoaded((n) => n + 1); return; }
      log.warn('session-panel', 'browser replay picture failed', { taskId, id, error: err instanceof Error ? err.message : String(err) });
    } finally {
      asking.current.delete(id);
    }
  }, [taskId]);

  const shownAt = steps ? pictureIndex(steps, i) : -1;
  const step = steps && i >= 0 ? steps[i] : undefined;
  const shownStep = steps && shownAt >= 0 ? steps[shownAt] : undefined;

  // The picture shown (once the scrubber rests a moment: a drag across hundreds of steps asks for
  // one, not each), and the next few while playing.
  useEffect(() => {
    if (!steps || !shownStep) return undefined;
    if (playing) {
      void fetchPicture(shownStep.id);
      for (let k = i + 1, n = 0; k < steps.length && n < AHEAD; k++) if (steps[k].picture) { void fetchPicture(steps[k].id); n++; }
      return undefined;
    }
    const t = window.setTimeout(() => { void fetchPicture(shownStep.id); }, cache.current.has(shownStep.id) ? 0 : 120);
    return () => window.clearTimeout(t);
  }, [steps, shownStep, i, playing, fetchPicture]);

  // Playing: the next step every 1/speed s; stops at the last.
  useEffect(() => {
    if (!playing || !steps) return undefined;
    if (i >= steps.length - 1) { setPlaying(false); return undefined; }
    const t = window.setTimeout(() => setI((x) => Math.min(x + 1, steps.length - 1)), 1000 / speed);
    return () => window.clearTimeout(t);
  }, [playing, i, steps, speed]);

  // The current step stays in view in the list.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[aria-current="step"]');
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [i]);

  const play = () => {
    if (!steps?.length) return;
    // From the start again after the last step.
    if (i >= steps.length - 1) setI(0);
    setPlaying((p) => !p);
  };
  const go = (n: number) => { setPlaying(false); if (steps) setI(Math.max(0, Math.min(steps.length - 1, n))); };

  const picture = shownStep ? cache.current.get(shownStep.id) : undefined;
  const now = Date.now();
  const title = step?.title || (steps?.length ? 'Untitled page' : 'Browser replay');
  const daysLine = days === null ? '' : days === 0 ? 'Replays are off (Settings, Browser extension).' : `Kept ${days} day${days === 1 ? '' : 's'}, on this computer only.`;
  const count = steps?.length ?? 0;
  const failed = step && !step.ok;
  const listed = useMemo(() => steps ?? [], [steps]);

  return (
    <section className={`session-browser-card session-browser-replay${large ? ' session-browser-card--large' : ''}`} data-testid="session-browser-replay" aria-label="Browser replay">
      <header className="session-browser-head">
        <span className="session-browser-dot session-browser-dot--off" aria-hidden />
        <div className="session-browser-title" data-testid="session-browser-replay-title" title={title}>{title}</div>
        <button type="button" className="session-browser-btn session-browser-btn--icon" aria-label="Close the Browser view" title="Close"
          onClick={onClose} data-testid="session-browser-replay-hide">{CLOSE_GLYPH}</button>
      </header>
      <div className="session-browser-names">
        <div className="session-browser-url" data-testid="session-browser-replay-url">{step?.url ?? ''}</div>
        <div className="session-browser-where" data-testid="session-browser-replay-where">
          {count ? `Replay · step ${i + 1} of ${count} · ${step ? replayTimeLine(step.at, now) : ''}` : 'Replay'}
          {step ? <span className="session-browser-muted"> · {agoLine(step.at, now)}</span> : null}
        </div>
      </div>
      <div className="session-browser-shot" data-testid="session-browser-replay-shot">
        {picture
          ? <img src={picture} alt={`Step ${shownAt + 1}: ${shownStep?.label ?? ''}`} className={shownAt !== i ? 'is-stale' : ''} data-testid="session-browser-replay-picture" data-step={shownStep?.id} draggable={false} />
          : <div className="session-browser-empty" data-testid="session-browser-replay-why">
              {trouble ?? (steps === null ? 'Reading the steps…' : !count ? NO_REPLAY : shownAt < 0 || (shownStep && missing.current.has(shownStep.id)) ? 'No picture of this step.' : 'Loading the picture…')}
            </div>}
      </div>
      {step && (
        <div className={`session-browser-replay-step${failed ? ' is-failed' : ''}`} data-testid="session-browser-replay-step">
          <span className="session-browser-replay-label">{step.label}</span>
          {failed && <span className="session-browser-replay-badge">failed{step.code ? `: ${step.code.replace(/_/g, ' ')}` : ''}</span>}
          {shownAt !== i && shownAt >= 0 && <span className="session-browser-muted"> {NO_STEP_PICTURE}</span>}
        </div>
      )}
      {count > 0 && (
        <input
          type="range"
          className="session-browser-replay-scrub"
          min={0}
          max={Math.max(0, count - 1)}
          step={1}
          value={Math.max(0, i)}
          onChange={(e) => go(Number(e.target.value))}
          aria-label="Step"
          aria-valuetext={step ? `Step ${i + 1} of ${count}: ${step.label}` : undefined}
          data-testid="session-browser-replay-scrub"
        />
      )}
      <div className="session-browser-actions session-browser-replay-controls">
        {onBack
          ? <button type="button" className="session-browser-btn" onClick={onBack} data-testid="session-browser-replay-back" title="The live picture of the agent's tab">Live</button>
          : null}
        <button type="button" className="session-browser-btn" onClick={() => go(i - 1)} disabled={i <= 0} aria-label="Previous step" title="Previous step" data-testid="session-browser-replay-prev">‹</button>
        <button type="button" className="session-browser-btn session-browser-replay-play" onClick={play} disabled={!count} aria-pressed={playing} data-testid="session-browser-replay-play">
          {playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" className="session-browser-btn" onClick={() => go(i + 1)} disabled={!steps || i >= count - 1} aria-label="Next step" title="Next step" data-testid="session-browser-replay-next">›</button>
        <span className="session-browser-replay-speeds" role="group" aria-label="Speed">
          {REPLAY_SPEEDS.map((s) => (
            <button key={s} type="button" className={`session-browser-tab${speed === s ? ' is-on' : ''}`} aria-pressed={speed === s}
              onClick={() => setSpeed(s)} data-testid={`session-browser-replay-speed-${s}`}>{s}×</button>
          ))}
        </span>
        <span className="session-browser-actions-gap" aria-hidden />
        <button type="button" className="session-browser-btn" onClick={onLarge} aria-pressed={large} data-testid="session-browser-replay-size">{large ? 'Smaller' : 'Larger'}</button>
      </div>
      {count > 0 && (
        <ol className="session-browser-replay-list" ref={listRef} data-testid="session-browser-replay-list" aria-label="Steps">
          {listed.map((s, k) => (
            <li key={s.id}>
              <button type="button" className={`session-browser-replay-row${k === i ? ' is-on' : ''}${s.ok ? '' : ' is-failed'}`}
                aria-current={k === i ? 'step' : undefined} onClick={() => go(k)}>
                <span className="session-browser-replay-time">{replayTimeLine(s.at, now)}</span>
                <span className="session-browser-replay-row-label">{s.label}</span>
                {!s.picture && <span className="session-browser-muted" title="No picture of this step"> ·</span>}
              </button>
            </li>
          ))}
        </ol>
      )}
      {daysLine && <div className="session-browser-replay-days" data-testid="session-browser-replay-days">{daysLine}</div>}
    </section>
  );
}
