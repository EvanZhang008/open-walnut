/**
 * The task's Browser view: when the task's session drives the person's browser (a tab it opened
 * in Walnut's agent window, or a tab of theirs handed over or taken), this card shows itself in
 * the session panel with a live picture of that tab, its title and address, which window it is
 * in, and a Stop that ends the agent's use (the tab stays open). 2026-11-07, the user: "if this
 * task is using browser, we also show a browser screen in the task, it can be a bit slow it is
 * fine, but at least we know".
 *
 * A picture is asked for only while the card is open and on screen (the page visible, the card in
 * view), about every 1.2 s after the last one came back; never in the background. The server
 * shares one capture between viewers, and the extension skips a frame rather than get in an
 * agent's way (packages/browser-extension/src/agent-view.ts). When the last tab goes, the card
 * says why. Hide folds it to one line (kept per task); the line still says the browser is in use.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '@/api/client';
import { usePageViewOf } from '@/utils/view-memory';
import { log } from '@/utils/log';
import { useBrowserView } from './useBrowserView';
import {
  FRAME_EVERY_MS, FRAME_RETRY_MS, agoLine, endedLine, followedTab, noPictureLine, windowLine,
  type BrowserFrame,
} from './browser-view-model';
import '@/styles/session-browser-card.css';

interface CardPrefs {
  /** Folded to one line by the person. */
  folded: boolean;
  /** The picture drawn large. */
  large: boolean;
  /** The tab followed when the task has several (null: the newest). */
  tab: number | null;
  /** The end notice the person dismissed (its time). */
  dismissed: string | null;
}

const PREFS: CardPrefs = { folded: false, large: false, tab: null, dismissed: null };
const isPrefs = (v: unknown): v is CardPrefs => {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return typeof p.folded === 'boolean' && typeof p.large === 'boolean'
    && (p.tab === null || typeof p.tab === 'number') && (p.dismissed === null || typeof p.dismissed === 'string');
};

/** Whether `el` is on screen (the page visible and the element in view). */
function useOnScreen(el: HTMLElement | null): boolean {
  const [intersecting, setIntersecting] = useState(false);
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  useEffect(() => {
    if (!el) { setIntersecting(false); return undefined; }
    if (typeof IntersectionObserver === 'undefined') { setIntersecting(true); return undefined; }
    const io = new IntersectionObserver((entries) => setIntersecting(entries.some((e) => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, [el]);
  return intersecting && visible;
}

export function SessionBrowserCard({ taskId }: { taskId: string }) {
  const { state, reread } = useBrowserView(taskId);
  const [prefs, setPrefs] = usePageViewOf<CardPrefs>('panel', 'browser-card', taskId, PREFS, isPrefs);
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [picture, setPicture] = useState<{ image: string; at: string } | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [shotEl, setShotEl] = useState<HTMLDivElement | null>(null);
  const onScreen = useOnScreen(shotEl);

  const tabs = state?.tabs ?? [];
  const followed = followedTab(tabs, prefs.tab);
  const followedId = followed?.tab;
  const watching = !!followed && !prefs.folded && onScreen;

  // A new tab followed: no picture of the old one under its title.
  const shownTab = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (shownTab.current !== followedId) { shownTab.current = followedId; setFrame(null); setPicture(null); setTrouble(null); }
  }, [followedId]);

  // The picture loop: one request at a time, the next one FRAME_EVERY_MS after the answer.
  useEffect(() => {
    if (!watching || followedId === undefined) return undefined;
    let alive = true;
    let timer: number | undefined;
    const ctl = new AbortController();
    const tick = async () => {
      let wait = FRAME_EVERY_MS;
      try {
        const f = await apiGet<BrowserFrame>('/api/v1/browser/view/frame', { task: taskId, tab: String(followedId) },
          { signal: ctl.signal, priority: 'low', timeoutMs: 12_000, quietStatuses: [404, 409] });
        if (!alive) return;
        setFrame(f);
        setTrouble(null);
        if (f.shown && f.image) setPicture({ image: f.image, at: f.at ?? new Date().toISOString() });
      } catch (err) {
        if (!alive) return;
        const status = (err as { status?: number }).status;
        if (status === 404) { reread(); return; }
        setTrouble(status === 409 ? 'The browser does not answer right now. The picture comes back when it does.' : 'No picture right now. Trying again.');
        wait = FRAME_RETRY_MS;
      }
      if (alive) timer = window.setTimeout(() => { void tick(); }, wait);
    };
    void tick();
    return () => { alive = false; ctl.abort(); if (timer) window.clearTimeout(timer); };
  }, [watching, followedId, taskId, reread]);

  // "3 s ago" stays true while the card is on screen.
  useEffect(() => {
    if (!watching) return undefined;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [watching]);

  const stop = useCallback(async () => {
    if (followedId === undefined) return;
    setStopping(true);
    try {
      await apiPost('/api/v1/browser/view/stop', { task: taskId, tab: followedId });
      log.info('session-panel', 'browser view stop', { taskId, tab: followedId });
    } catch (err) {
      setTrouble(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
      reread();
    }
  }, [taskId, followedId, reread]);

  if (!state) return null;

  if (!followed) {
    const ended = state.ended;
    if (!ended || prefs.dismissed === ended.at) return null;
    return (
      <div className="session-browser-card session-browser-card--ended" data-testid="session-browser-ended" role="status">
        <span className="session-browser-dot session-browser-dot--off" aria-hidden />
        <span className="session-browser-ended-text">Browser: {endedLine(ended.why)} <span className="session-browser-muted">{agoLine(ended.at, Date.now())}</span></span>
        <button type="button" className="session-browser-btn" aria-label="Dismiss" title="Dismiss"
          onClick={() => setPrefs((p) => ({ ...p, dismissed: ended.at }))}>&times;</button>
      </div>
    );
  }

  const title = frame?.tab === followed.tab && frame.title ? frame.title : followed.title;
  const url = frame?.tab === followed.tab && frame.url ? frame.url : followed.url;
  const where = windowLine({ window: frame?.window ?? followed.window, windowState: frame?.windowState ?? followed.windowState, handed: frame?.handed, taken: frame?.taken });
  const noPicture = trouble ?? (followed.connected ? (followed.pictures ? noPictureLine(frame, !!picture) : noPictureLine({ why: 'no_permission' }, false)) : 'The browser does not answer right now.');
  const live = !!frame?.shown && !trouble;

  if (prefs.folded) {
    return (
      <div className="session-browser-card session-browser-card--folded" data-testid="session-browser-folded">
        <span className="session-browser-dot" aria-hidden />
        <span className="session-browser-fold-text">Browser in use: <strong>{title || url || `tab ${followed.tab}`}</strong> <span className="session-browser-muted">· {where}</span></span>
        <button type="button" className="session-browser-btn" onClick={() => setPrefs((p) => ({ ...p, folded: false }))} data-testid="session-browser-show">Show</button>
      </div>
    );
  }

  return (
    <section className={`session-browser-card${prefs.large ? ' session-browser-card--large' : ''}`} data-testid="session-browser-card" aria-label="Browser view">
      <header className="session-browser-head">
        <span className={`session-browser-dot${live ? '' : ' session-browser-dot--idle'}`} aria-hidden />
        <div className="session-browser-names">
          <div className="session-browser-title" data-testid="session-browser-title" title={title}>{title || 'Untitled page'}</div>
          <div className="session-browser-url" data-testid="session-browser-url" title={url}>{url}</div>
          <div className="session-browser-where" data-testid="session-browser-where">{where} · tab {followed.tab} · {followed.browser}</div>
        </div>
        <div className="session-browser-actions">
          <button type="button" className="session-browser-btn" onClick={() => setPrefs((p) => ({ ...p, large: !p.large }))}
            aria-pressed={prefs.large} data-testid="session-browser-size">{prefs.large ? 'Smaller' : 'Larger'}</button>
          <button type="button" className="session-browser-btn session-browser-btn--stop" onClick={() => { void stop(); }} disabled={stopping}
            title="The agent stops using this tab. The tab stays open, yours." data-testid="session-browser-stop">{stopping ? 'Stopping…' : 'Stop'}</button>
          <button type="button" className="session-browser-btn" aria-label="Hide the Browser view" title="Hide (one line stays)"
            onClick={() => setPrefs((p) => ({ ...p, folded: true }))} data-testid="session-browser-hide">&times;</button>
        </div>
      </header>
      {tabs.length > 1 && (
        <div className="session-browser-tabs" role="tablist" aria-label="The task's tabs">
          {tabs.map((t) => (
            <button key={`${t.device}:${t.tab}`} type="button" role="tab" aria-selected={t.tab === followed.tab}
              className={`session-browser-tab${t.tab === followed.tab ? ' is-on' : ''}`}
              onClick={() => setPrefs((p) => ({ ...p, tab: t.tab }))}>{t.title || t.url || `tab ${t.tab}`}</button>
          ))}
        </div>
      )}
      <div className="session-browser-shot" ref={setShotEl} data-testid="session-browser-shot">
        {picture
          ? <img src={picture.image} alt={`The agent's tab: ${title ?? ''}`} className={live ? '' : 'is-stale'} data-testid="session-browser-picture" draggable={false} />
          : <div className="session-browser-empty">{noPicture ?? 'Taking the first picture…'}</div>}
      </div>
      <div className="session-browser-foot" data-testid="session-browser-foot">
        {picture && (live ? <span>Live · {agoLine(picture.at, now)}</span> : <span>Last picture {agoLine(picture.at, now)}</span>)}
        {picture && noPicture && <span className="session-browser-note">{noPicture}</span>}
      </div>
    </section>
  );
}
