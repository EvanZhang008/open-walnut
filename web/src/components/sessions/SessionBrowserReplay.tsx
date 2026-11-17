/**
 * The Browser replay: a task's recorded browser steps played back in its Browser view (2026-11-14,
 * the user: "can we make sure the browser action screenshot or video is saved for 7 days
 * (configurable), and can be played back"). Each step an agent took in the person's browser (a
 * click, a type, an open...) has its picture, taken right after it (server:
 * src/core/browser-control/replay-store.ts; the extension's agent-replay.ts).
 *
 * The layout is the user's pick of 20 designs (2026-11-15, "4+2+also how list of timeline +
 * descriptions like click xx do xx", then "recommend is good, go"):
 *
 *   picture    the step's own, or the last earlier one when the tab could not be pictured then
 *   step line  what the step did in plain words (browser-view-model.ts replayStepWords), its time
 *   filmstrip  every step's thumbnail; Play / Pause and the speed (1, 2 or 4 steps a second) beside it
 *   ruler      a tick per step at its real time, long pauses folded with their length on them;
 *              the arrow keys, Home and End step through it
 *   step list  one row per step in the same words, always on screen: on the right in Larger, under
 *              the ruler in the small popover
 *
 * A click on a row, a thumbnail or a tick goes to that step, and all three show it. Pictures are
 * read one at a time as they are shown (the next few ahead while playing), thumbnails as they
 * scroll into the filmstrip; both kept for the card's life. The list is read again every few
 * seconds while the replay is open, so a running task's new steps join it; a replay left at its
 * last step follows them.
 */
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { apiGet } from '@/api/client';
import { BrowserRevealButton } from './BrowserRevealButton';
import { log } from '@/utils/log';
import {
  NO_REPLAY, NO_STEP_PICTURE, REPLAY_REREAD_MS, REPLAY_SPEEDS, agoLine, pictureIndex, replayRuler, replayStepWords, replayTimeLine, spanLine, stepTimeLine,
  type ReplayStep, type ReplayStepIcon,
} from './browser-view-model';

const CLOSE_GLYPH = (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2 8 8M8 2 2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
);
/** Pictures kept in memory at most (each is a JPEG data URL of 50 to 300 KB). */
const CACHE_MAX = 80;
/** Thumbnails kept at most (each about 10 KB). */
const THUMBS_MAX = 600;
/** Pictures read ahead while playing. */
const AHEAD = 3;
/** A thumbnail is asked for once its frame has been in the filmstrip this long (a fast scroll past asks for none). */
const THUMB_DWELL_MS = 150;

const icon = (d: ReactNode, fill = false) => (
  <svg viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const STEP_ICONS: Record<ReplayStepIcon, ReactNode> = {
  open: icon(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18" /></>),
  click: icon(<path d="M5 3l14 7.5-6 1.8-2.3 6.2z" />),
  tab: icon(<><rect x="3" y="6" width="18" height="13" rx="2.5" /><path d="M3 10h7V6" /></>),
  link: icon(<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>),
  type: icon(<><rect x="2.5" y="6" width="19" height="12" rx="2.5" /><path d="M6.5 10h1M10.5 10h1M14.5 10h1M8 14h8" /></>),
  clear: icon(<path d="M20 20H9L4 15l9.5-9.5a2 2 0 0 1 2.8 0l3.2 3.2a2 2 0 0 1 0 2.8L12 19" />),
  key: icon(<><rect x="3.5" y="5" width="17" height="14" rx="3" /><path d="M9 12h6" /></>),
  down: icon(<path d="M12 4v15M6 13l6 6 6-6" />),
  up: icon(<path d="M12 20V5M6 11l6-6 6 6" />),
  go: icon(<path d="M4 12h15M13 6l6 6-6 6" />),
  reload: icon(<><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 5v6h-6" /></>),
  back: icon(<><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></>),
  form: icon(<><rect x="4" y="3" width="16" height="18" rx="2.5" /><path d="M8 8h8M8 12h8M8 16h5" /></>),
  upload: icon(<><path d="M12 16V4M7 9l5-5 5 5" /><path d="M5 20h14" /></>),
  step: icon(<circle cx="12" cy="12" r="3" />),
};
const PLAY_GLYPH = icon(<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" />, true);
const PAUSE_GLYPH = icon(<><rect x="6" y="4" width="4" height="16" rx="1.2" /><rect x="14" y="4" width="4" height="16" rx="1.2" /></>, true);

/** Scroll `box` so `el` shows in it (centred along `axis`), the box only: never the popover or the page. */
function reveal(box: HTMLElement | null, el: HTMLElement | null | undefined, axis: 'x' | 'y', smooth: boolean) {
  if (!box || !el) return;
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const behavior: ScrollBehavior = smooth ? 'smooth' : 'auto';
  // Smooth only for a near move: a far jump (Home, End, a far tick) lands at once, without
  // sweeping the filmstrip past hundreds of frames.
  if (axis === 'x') {
    const by = (r.left - b.left) - (b.width - r.width) / 2;
    box.scrollTo?.({ left: box.scrollLeft + by, behavior: Math.abs(by) < b.width ? behavior : 'auto' });
  } else if (r.top < b.top + 4 || r.bottom > b.bottom - 4) {
    const by = (r.top - b.top) - (b.height - r.height) / 2;
    box.scrollTo?.({ top: box.scrollTop + by, behavior: Math.abs(by) < b.height ? behavior : 'auto' });
  }
}

/** One frame of the filmstrip; its thumbnail once it has one (asked for by the strip's observer). */
const Frame = memo(function Frame({ id, k, on, failed, src, none, tip, go }: {
  id: string; k: number; on: boolean; failed: boolean; src?: string; none: boolean; tip: string; go: (k: number) => void;
}) {
  return (
    <button type="button" className={`session-browser-replay-frame${on ? ' is-on' : ''}${failed ? ' is-failed' : ''}`} data-thumb={none || src ? undefined : id}
      aria-current={on ? 'step' : undefined} aria-label={`Step ${k + 1}`} title={tip} tabIndex={on ? 0 : -1} onClick={() => go(k)}>
      <span className={`session-browser-replay-thumb${none ? ' is-none' : ''}`}>{src ? <img src={src} alt="" draggable={false} /> : null}</span>
    </button>
  );
});

/** One row of the step list. */
const Row = memo(function Row({ k, on, failed, icon: kind, title, detail, time, tip, go }: {
  k: number; on: boolean; failed: boolean; icon: ReplayStepIcon; title: string; detail: string; time: string; tip: string; go: (k: number) => void;
}) {
  return (
    <li>
      <button type="button" className={`session-browser-replay-row${on ? ' is-on' : ''}${failed ? ' is-failed' : ''}`}
        aria-current={on ? 'step' : undefined} onClick={() => go(k)} title={tip}>
        <span className="session-browser-replay-n">{k + 1}</span>
        <span className="session-browser-replay-icon">{STEP_ICONS[kind]}</span>
        <span className="session-browser-replay-words">
          <span className="session-browser-replay-row-label">{title}</span>
          {detail && <span className="session-browser-replay-row-detail">{detail}</span>}
        </span>
        <span className="session-browser-replay-time">{time}</span>
      </button>
    </li>
  );
});

export function SessionBrowserReplay({ taskId, large, onLarge, onBack, onClose, liveTab }: {
  taskId: string;
  /** The task's tab while it still has one: Open in Chrome brings it forward (else the step's page opens again). */
  liveTab?: { tab: number; device: string };
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
  const thumbs = useRef(new Map<string, string>());
  const asking = useRef(new Set<string>());
  // Pictures that are gone (deleted after the days kept): never asked again.
  const missing = useRef(new Set<string>());
  const listRef = useRef<HTMLOListElement>(null);
  const [stripEl, setStripEl] = useState<HTMLDivElement | null>(null);
  const moved = useRef(false);

  const read = useLeanCallback(async () => {
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

  const fetchPicture = useLeanCallback(async (id: string, thumb = false) => {
    const store = thumb ? thumbs.current : cache.current;
    const key = thumb ? `t:${id}` : id;
    if (store.has(id) || asking.current.has(key) || missing.current.has(key)) return;
    asking.current.add(key);
    try {
      const r = await apiGet<{ image: string }>('/api/v1/browser/view/replay/frame', { task: taskId, id, ...(thumb ? { size: 'thumb' } : {}) }, { priority: 'low', timeoutMs: 15_000, quietStatuses: [404] });
      // Decoded first, so the picture never blinks while the next one loads.
      const img = new Image();
      img.src = r.image;
      await img.decode().catch(() => undefined);
      store.set(id, r.image);
      if (store.size > (thumb ? THUMBS_MAX : CACHE_MAX)) store.delete(store.keys().next().value!);
      setLoaded((n) => n + 1);
    } catch (err) {
      if ((err as { status?: number }).status === 404) { missing.current.add(key); setLoaded((n) => n + 1); return; }
      log.warn('session-panel', 'browser replay picture failed', { taskId, id, thumb, error: err instanceof Error ? err.message : String(err) });
    } finally {
      asking.current.delete(key);
    }
  }, [taskId]);

  // The filmstrip's thumbnails: one observer for the strip; a frame that stays in it a moment asks
  // for its thumbnail (a frame scrolled past fast asks for none; one that failed asks again when it
  // comes back into view).
  useEffect(() => {
    if (!stripEl || typeof IntersectionObserver === 'undefined') return undefined;
    const waiting = new Map<Element, number>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.thumb;
        if (e.isIntersecting && id && !waiting.has(e.target)) {
          waiting.set(e.target, window.setTimeout(() => { waiting.delete(e.target); void fetchPicture(id, true); }, THUMB_DWELL_MS));
        } else if (!e.isIntersecting && waiting.has(e.target)) {
          window.clearTimeout(waiting.get(e.target)); waiting.delete(e.target);
        }
      }
    }, { root: stripEl, rootMargin: '0px 120px' });
    // Frames come and go with the list (and lose data-thumb once theirs is in): watch the strip's children.
    const watch = () => { io.disconnect(); stripEl.querySelectorAll('[data-thumb]').forEach((el) => io.observe(el)); };
    watch();
    const mo = new MutationObserver(watch);
    mo.observe(stripEl, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-thumb'] });
    return () => { mo.disconnect(); io.disconnect(); waiting.forEach((t) => window.clearTimeout(t)); };
  }, [stripEl, fetchPicture]);

  const shownAt = steps ? pictureIndex(steps, i) : -1;
  const step = steps && i >= 0 ? steps[i] : undefined;
  const shownStep = steps && shownAt >= 0 ? steps[shownAt] : undefined;
  // Open in Chrome opens the page this step happened on: its own address, else the last one before
  // it (a read or a close has none); with none before it, the task's last page (the server's pick).
  const pageStep = steps && i >= 0 ? steps.slice(0, i + 1).reverse().find((s) => !!s.url) : undefined;
  const anyPage = !!steps?.some((s) => !!s.url);

  // The picture shown (once the step rests a moment: a run of arrow keys through hundreds of
  // steps asks for one, not each), and the next few while playing.
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

  // The current step stays in view in the list and the filmstrip (smoothly once the person moved).
  useEffect(() => {
    const smooth = moved.current;
    reveal(listRef.current, listRef.current?.querySelector<HTMLElement>('[aria-current="step"]'), 'y', smooth);
    reveal(stripEl, stripEl?.querySelector<HTMLElement>('[aria-current="step"]'), 'x', smooth);
    if (i >= 0) moved.current = true;
  }, [i, stripEl, large]);

  const play = () => {
    if (!steps?.length) return;
    // From the start again after the last step.
    if (i >= steps.length - 1) setI(0);
    setPlaying((p) => !p);
  };
  const go = useLeanCallback((n: number) => { setPlaying(false); if (steps) setI(Math.max(0, Math.min(steps.length - 1, n))); }, [steps]);
  const nextSpeed = () => setSpeed((s) => REPLAY_SPEEDS[(REPLAY_SPEEDS.indexOf(s as (typeof REPLAY_SPEEDS)[number]) + 1) % REPLAY_SPEEDS.length]);
  const keys = (e: KeyboardEvent) => {
    const n = steps?.length ?? 0;
    const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? i - 1
      : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : e.key === 'PageDown' ? i + 10 : e.key === 'PageUp' ? i - 10 : null;
    if (to === null || !n) return;
    e.preventDefault();
    go(to);
  };

  const listed = useMemo(() => steps ?? [], [steps]);
  const words = useMemo(() => listed.map((s, k) => replayStepWords(s, listed[k - 1])), [listed]);
  const ruler = useMemo(() => replayRuler(listed), [listed]);
  const picture = shownStep ? cache.current.get(shownStep.id) : undefined;
  const now = Date.now();
  const title = step?.title || (steps?.length ? 'Untitled page' : 'Browser replay');
  const daysLine = days === null ? '' : days === 0 ? 'Replays are off (Settings, Browser extension).' : `Kept ${days} day${days === 1 ? '' : 's'}, on this computer only.`;
  const count = listed.length;
  const said = i >= 0 ? words[i] : undefined;
  const timeOf = (s: ReplayStep) => stepTimeLine(s.at, listed[0]?.at ?? s.at, ruler.seconds, now);
  const tip = (s: ReplayStep, k: number) => `${k + 1}. ${words[k]?.title ?? s.label}${words[k]?.detail ? `, ${words[k].detail}` : ''} · ${replayTimeLine(s.at, now)} (recorded as: ${s.label})`;

  const list = count > 0 && (
    <ol className="session-browser-replay-list" ref={listRef} data-testid="session-browser-replay-list" aria-label="Steps">
      {listed.map((s, k) => (
        <Row key={s.id} k={k} on={k === i} failed={!s.ok} icon={words[k].icon} title={words[k].title} detail={words[k].detail} time={timeOf(s)} tip={tip(s, k)} go={go} />
      ))}
    </ol>
  );

  return (
    <section className={`session-browser-card session-browser-replay${large ? ' session-browser-card--large' : ''}`} data-testid="session-browser-replay" aria-label="Browser replay">
      <header className="session-browser-replay-head">
        <div className="session-browser-replay-names">
          <div className="session-browser-title" data-testid="session-browser-replay-title">{title}</div>
          <div className="session-browser-url" data-testid="session-browser-replay-url">{step?.url ?? ''}</div>
        </div>
        <span className="session-browser-replay-where" data-testid="session-browser-replay-where" title={step ? agoLine(step.at, now) : undefined}>
          {count ? `Replay · step ${i + 1} of ${count} · ${spanLine(ruler.seconds)}` : 'Replay'}
        </span>
        {onBack
          ? <button type="button" className="session-browser-btn" onClick={onBack} data-testid="session-browser-replay-back" title="The live picture of the agent's tab">Live</button>
          : null}
        {(liveTab || anyPage) && (
          <BrowserRevealButton taskId={taskId} tab={liveTab?.tab} device={liveTab?.device} step={liveTab ? undefined : pageStep?.id} testId="session-browser-replay-reveal" />
        )}
        <button type="button" className="session-browser-btn" onClick={onLarge} aria-pressed={large} data-testid="session-browser-replay-size">{large ? 'Smaller' : 'Larger'}</button>
        <button type="button" className="session-browser-btn session-browser-btn--icon" aria-label="Close the Browser view" title="Close"
          onClick={onClose} data-testid="session-browser-replay-hide">{CLOSE_GLYPH}</button>
      </header>
      <div className="session-browser-replay-body">
        <div className="session-browser-replay-main">
          <div className="session-browser-shot" data-testid="session-browser-replay-shot">
            {picture
              ? <img src={picture} alt={`Step ${shownAt + 1}: ${shownStep?.label ?? ''}`} className={shownAt !== i ? 'is-stale' : ''} data-testid="session-browser-replay-picture" data-step={shownStep?.id} draggable={false} />
              : <div className="session-browser-empty" data-testid="session-browser-replay-why">
                  {trouble ?? (steps === null ? 'Reading the steps…' : !count ? NO_REPLAY : shownAt < 0 || (shownStep && missing.current.has(shownStep.id)) ? 'No picture of this step.' : 'Loading the picture…')}
                </div>}
          </div>
          {step && said && (
            <div className={`session-browser-replay-step${step.ok ? '' : ' is-failed'}`} data-testid="session-browser-replay-step" title={step.label}>
              <span className="session-browser-replay-icon">{STEP_ICONS[said.icon]}</span>
              <span className="session-browser-replay-label">{said.title}</span>
              {said.detail && <span className="session-browser-replay-detail">{said.detail}</span>}
              {shownAt !== i && shownAt >= 0 && <span className="session-browser-muted" title={NO_STEP_PICTURE}>(no picture of this step)</span>}
              <span className="session-browser-replay-clock">{replayTimeLine(step.at, now)}</span>
            </div>
          )}
          {count > 0 && (
            <div className="session-browser-replay-film">
              <button type="button" className="session-browser-replay-play" onClick={play} aria-pressed={playing} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause' : 'Play'} data-testid="session-browser-replay-play">
                {playing ? PAUSE_GLYPH : PLAY_GLYPH}
              </button>
              <button type="button" className="session-browser-replay-speed" onClick={nextSpeed} title="Speed: steps a second" aria-label={`Speed ${speed} steps a second`} data-testid="session-browser-replay-speed">{speed}×</button>
              <div className="session-browser-replay-strip" ref={setStripEl} data-testid="session-browser-replay-strip">
                {listed.map((s, k) => (
                  <Frame key={s.id} id={s.id} k={k} on={k === i} failed={!s.ok} src={thumbs.current.get(s.id)}
                    none={!s.picture || missing.current.has(`t:${s.id}`)} tip={tip(s, k)} go={go} />
                ))}
              </div>
            </div>
          )}
          {count > 0 && (
            <div className="session-browser-replay-ruler" role="slider" tabIndex={0} aria-label="Step" aria-valuemin={1} aria-valuemax={count} aria-valuenow={i + 1}
              aria-valuetext={step && said ? `Step ${i + 1} of ${count}: ${said.title}` : undefined} onKeyDown={keys} data-testid="session-browser-replay-scrub">
              <span className="session-browser-replay-line" aria-hidden />
              {ruler.folds.map((f, k) => (
                <span key={`f${k}`} className="session-browser-replay-fold" style={{ left: `${f.at * 100}%` }} title={`A pause of ${spanLine(f.seconds)}`}>
                  <b />{/* Its length, unless it would sit on the start or end time. */}{f.at > 0.12 && f.at < 0.88 && <em>{spanLine(f.seconds)}</em>}
                </span>
              ))}
              {listed.map((s, k) => (
                <button key={s.id} type="button" tabIndex={-1} className={`session-browser-replay-tick${k === i ? ' is-on' : ''}${s.ok ? '' : ' is-failed'}`}
                  style={{ left: `${ruler.at[k] * 100}%` }} title={tip(s, k)} aria-label={`Step ${k + 1}`} onClick={() => go(k)} data-testid="session-browser-replay-tick" />
              ))}
              <span className="session-browser-replay-ends" aria-hidden>
                <span>{replayTimeLine(listed[0].at, now)}</span><span>{count > 1 ? replayTimeLine(listed[count - 1].at, now) : ''}</span>
              </span>
            </div>
          )}
          {!large && list}
          {!large && daysLine && <div className="session-browser-replay-days" data-testid="session-browser-replay-days">{daysLine}</div>}
        </div>
        {large && (
          <aside className="session-browser-replay-side">
            {list}
            {daysLine && <div className="session-browser-replay-days" data-testid="session-browser-replay-days">{daysLine}</div>}
          </aside>
        )}
      </div>
    </section>
  );
}
