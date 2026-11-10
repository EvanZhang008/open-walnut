/**
 * The task's Browser view: when the task's session drives the person's browser (a tab it opened
 * in Walnut's agent window, or a tab of theirs handed over or taken), this card shows itself in
 * the session panel with a live picture of that tab, its title and address, which window it is
 * in, and a Stop that ends the agent's use (the tab stays open). 2026-11-07, the user: "if this
 * task is using browser, we also show a browser screen in the task, it can be a bit slow it is
 * fine, but at least we know".
 *
 * Pictures come only while the card is open and on screen (the page visible, the card in view),
 * never in the background. A browser that streams (2026-11-08, the user: "very laggy like it
 * doesn't show in real time") posts each picture to Walnut as it takes it, at the screen's own
 * pixels, and the card holds one request open for the next (`after`: the number of the picture it
 * has), so a picture shows as soon as it is taken; an older extension is asked once a second or so.
 * Each picture is decoded before it replaces the last, so the view never blinks. When the last tab
 * goes, the card says why. It is drawn only in the header pill's popover (SessionBrowserChip.tsx),
 * laid out as the servers pill's popover is: a bold title and a boxed ×, quiet bordered buttons,
 * and Stop on its own at the far left, away from Larger and Take over.
 *
 * Take over (the person's click) brings the tab forward in their browser and makes every agent
 * command there wait; Hand back (here or on the tab's own pill) gives it to the agent again. An
 * agent's request_sign_in shows as an ask over the picture: Take over, sign in, Done.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '@/api/client';
import { usePageViewOf } from '@/utils/view-memory';
import { log } from '@/utils/log';
import { useBrowserView } from './useBrowserView';
import {
  FRAME_EVERY_MS, FRAME_RETRY_MS, UNCHANGED_AGAIN_MS, agoLine, lateLine, endedLine, followedTab, handLine, liveGrantOffer, noPictureLine, tabKey, windowLine,
  type BrowserFrame,
} from './browser-view-model';
import '@/styles/session-browser-card.css';

/** The × of the popover's title row, the servers popover's own (SessionServerList.tsx). */
const CLOSE_GLYPH = (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2 8 8M8 2 2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
);

interface CardPrefs {
  /** The picture drawn large. */
  large: boolean;
  /** The tab followed when the task has several, as browser:tab (null: the newest). */
  pick: string | null;
  /** The end notice the person dismissed (its time). */
  dismissed: string | null;
}

// A view kept by an older build also carries `folded` (the card it drew in the chat could fold to
// one line); it is ignored, so its other choices still read.
const PREFS: CardPrefs = { large: false, pick: null, dismissed: null };
const isPrefs = (v: unknown): v is CardPrefs => {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return typeof p.large === 'boolean'
    && (p.pick === null || typeof p.pick === 'string') && (p.dismissed === null || typeof p.dismissed === 'string');
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

export function SessionBrowserCard({ taskId, view, onClose }: {
  taskId: string;
  /** The tabs, read by the host (the header pill, SessionBrowserChip.tsx): no second read here. */
  view?: ReturnType<typeof useBrowserView>;
  /** Closes the pill's popover: its ×, Dismiss, and nothing left to show. */
  onClose: () => void;
}) {
  const own = useBrowserView(view ? undefined : taskId);
  const { state, reread } = view ?? own;
  const [prefs, setPrefs] = usePageViewOf<CardPrefs>('panel', 'browser-card', taskId, PREFS, isPrefs);
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [picture, setPicture] = useState<{ image: string; at: string } | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [handing, setHanding] = useState<'take' | 'back' | null>(null);
  // "Show it live": the page asking for live pictures is opening (or opened) in Chrome.
  const [granting, setGranting] = useState<'opening' | 'opened' | null>(null);
  // Since when the browser has had no picture to give (every answer says, an unchanged one too).
  const [noPicSince, setNoPicSince] = useState<string | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  // When this card began asking for the tab's pictures (none yet: the wait for the first is late too).
  const [waitFrom, setWaitFrom] = useState<string | undefined>(undefined);
  const [shotEl, setShotEl] = useState<HTMLDivElement | null>(null);
  const onScreen = useOnScreen(shotEl);

  const tabs = state?.tabs ?? [];
  const followed = followedTab(tabs, prefs.pick);
  const followedId = followed?.tab;
  const followedDevice = followed?.device;
  // The picture belongs to this task, browser and tab: any of them changing starts it afresh.
  const shownKey = followed ? `${taskId}|${tabKey(followed)}` : undefined;
  const watching = !!followed && onScreen;

  // A new tab followed (another browser's, another task's): no picture of the old one under its title.
  const shownTab = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (shownTab.current !== shownKey) { shownTab.current = shownKey; setFrame(null); setPicture(null); setTrouble(null); setNoPicSince(undefined); setWaitFrom(undefined); }
  }, [shownKey]);

  // The picture loop: one request at a time. A streaming browser's next is asked at once (the
  // server holds it until a newer picture comes); an older one's FRAME_EVERY_MS after the answer.
  useEffect(() => {
    if (!watching || followedId === undefined || followedDevice === undefined) return undefined;
    let alive = true;
    let timer: number | undefined;
    let after: number | undefined;
    let epoch: string | undefined;
    const ctl = new AbortController();
    setWaitFrom((w) => w ?? new Date().toISOString());
    const tick = async () => {
      let wait = FRAME_EVERY_MS;
      try {
        const f = await apiGet<BrowserFrame>('/api/v1/browser/view/frame', {
          task: taskId, tab: String(followedId), device: followedDevice, ...(after !== undefined && epoch ? { after: String(after), epoch } : {}),
        }, { signal: ctl.signal, priority: 'low', timeoutMs: 10_000, quietStatuses: [404, 409] });
        if (!alive) return;
        // A streaming browser: the next at once after a new picture, a moment later after none.
        if (f.stream) wait = f.unchanged || !f.image ? UNCHANGED_AGAIN_MS : 0;
        if (typeof f.seq === 'number') after = f.seq;
        epoch = f.epoch;
        setTrouble(null);
        // An older extension says nothing of it: counted here from its answers.
        setNoPicSince((prev) => (f.stream ? f.noPictureSince : f.shown && f.image ? undefined : prev ?? new Date().toISOString()));
        if (f.unchanged) {
          // The same picture: only its time moves on.
          if (f.at) setPicture((p) => (p ? { ...p, at: f.at! } : p));
        } else {
          if (f.shown && f.image) {
            // Decoded first, so the picture never blinks while the next one loads.
            const img = new Image();
            img.src = f.image;
            await img.decode().catch(() => undefined);
            if (!alive) return;
            setPicture({ image: f.image, at: f.at ?? new Date().toISOString() });
          }
          setFrame(f);
        }
      } catch (err) {
        if (!alive) return;
        const status = (err as { status?: number }).status;
        if (status === 404) {
          // The holding moved on (Stop, a new hand-over): read the tabs again, and keep asking
          // while this tab is still the one shown (else the effect ends and starts afresh).
          reread();
          after = undefined;
          epoch = undefined;
          wait = FRAME_RETRY_MS;
        } else {
          setTrouble(status === 409 ? 'The browser does not answer right now. The picture comes back when it does.' : 'No picture right now. Trying again.');
          wait = FRAME_RETRY_MS;
        }
      }
      if (alive) timer = window.setTimeout(() => { void tick(); }, wait);
    };
    void tick();
    return () => { alive = false; ctl.abort(); if (timer) window.clearTimeout(timer); };
  }, [watching, followedId, followedDevice, taskId, reread]);

  // "3 s ago" stays true while the card is on screen.
  useEffect(() => {
    if (!watching) return undefined;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [watching]);

  const stop = useCallback(async () => {
    if (followedId === undefined || followedDevice === undefined) return;
    setStopping(true);
    try {
      await apiPost('/api/v1/browser/view/stop', { task: taskId, tab: followedId, device: followedDevice });
      log.info('session-panel', 'browser view stop', { taskId, tab: followedId, device: followedDevice });
    } catch (err) {
      setTrouble(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
      reread();
    }
  }, [taskId, followedId, followedDevice, reread]);

  // Take over / Hand back: the person's own clicks (the server refuses an agent's).
  const hand = useCallback(async (verb: 'take' | 'back') => {
    if (followedId === undefined || followedDevice === undefined) return;
    setHanding(verb);
    try {
      await apiPost(verb === 'take' ? '/api/v1/browser/view/takeover' : '/api/v1/browser/view/handback', { task: taskId, tab: followedId, device: followedDevice });
      log.info('session-panel', verb === 'take' ? 'browser view take over' : 'browser view hand back', { taskId, tab: followedId, device: followedDevice });
    } catch (err) {
      setTrouble(err instanceof Error ? err.message : String(err));
    } finally {
      setHanding(null);
      reread();
    }
  }, [taskId, followedId, followedDevice, reread]);

  // "Show it live" (the person's click): the extension opens its page that turns live pictures on.
  const showLive = useCallback(async () => {
    if (followedId === undefined || followedDevice === undefined) return;
    setGranting('opening');
    try {
      const out = await apiPost<{ opened?: boolean; already?: boolean; why?: string }>('/api/v1/browser/view/grant', { task: taskId, tab: followedId, device: followedDevice });
      log.info('session-panel', 'browser view grant page', { taskId, tab: followedId, device: followedDevice, opened: out?.opened === true });
      if (out?.why === 'no_window') { setTrouble('Open a Chrome window of your own first (not Walnut\'s agent window), then press Show it live again.'); setGranting(null); return; }
      setGranting('opened');
    } catch (err) {
      setTrouble(err instanceof Error ? err.message : String(err));
      setGranting(null);
    }
  }, [taskId, followedId, followedDevice]);
  // Once live pictures flow (or the window shows), the offer and its words go.
  const offerNow = liveGrantOffer(frame, followed);
  useEffect(() => { if (!offerNow) setGranting(null); }, [offerNow]);
  // In the pill's popover, nothing to show closes it (no empty popover left open).
  const nothing = !!state && !followed && (!state.ended || prefs.dismissed === state.ended.at);
  useEffect(() => { if (nothing) onClose(); }, [nothing, onClose]);

  if (!state) return null;

  if (!followed) {
    const ended = state.ended;
    if (!ended || prefs.dismissed === ended.at) return null;
    return (
      <div className="session-browser-card session-browser-card--ended" data-testid="session-browser-ended" role="status">
        <span className="session-browser-dot session-browser-dot--off" aria-hidden />
        <span className="session-browser-ended-text">Browser: {endedLine(ended.why)} <span className="session-browser-muted">{agoLine(ended.at, Date.now())}</span></span>
        <button type="button" className="session-browser-btn session-browser-btn--icon" aria-label="Dismiss" title="Dismiss"
          onClick={() => { setPrefs((p) => ({ ...p, dismissed: ended.at })); onClose(); }}>{CLOSE_GLYPH}</button>
      </div>
    );
  }

  const mineFrame = frame?.tab === followed.tab && (frame.device === undefined || frame.device === followed.device);
  const title = mineFrame && frame?.title ? frame.title : followed.title;
  const url = mineFrame && frame?.url ? frame.url : followed.url;
  const at = { window: frame?.window ?? followed.window, windowState: frame?.windowState ?? followed.windowState, handed: frame?.handed, taken: frame?.taken };
  // One line at the popover's width: which window, which browser. The tooltip has it all.
  const where = `${windowLine(at)} · ${followed.browser}`;
  const whereFull = `${windowLine(at, true)} · tab ${followed.tab} · ${followed.browser}`;
  const offer = offerNow;
  const noPicture = trouble ?? (followed.connected ? (followed.pictures ? noPictureLine(frame, !!picture, offer) : noPictureLine({ why: 'no_permission' }, false)) : 'The browser does not answer right now.');
  // Beside the covered line: the one button, or what to do in Chrome once its page is open.
  const liveOffer = offer && !trouble ? (
    granting === 'opened'
      ? <span className="session-browser-live-wait" data-testid="session-browser-live-wait"> Click Allow on the Walnut page in Chrome, then Allow in Chrome's box.</span>
      : <button type="button" className="session-browser-btn session-browser-btn--primary session-browser-live-btn" onClick={() => { void showLive(); }}
          disabled={granting !== null} data-testid="session-browser-show-live">{granting === 'opening' ? 'Opening…' : 'Show it live'}</button>
  ) : null;
  const late = lateLine(noPicSince ?? (picture ? undefined : waitFrom), now);
  const live = !!frame?.shown && !trouble && !late;
  // The tab list's word (re-read on every change of the tab), never a picture's, which an unchanged answer does not renew.
  const driving = !!followed.driving;
  const asks = handLine({ driving, signIn: followed.signIn });

  return (
    <section className={`session-browser-card${prefs.large ? ' session-browser-card--large' : ''}`} data-testid="session-browser-card" aria-label="Browser view">
      <header className="session-browser-head">
        <span className={`session-browser-dot${live ? '' : ' session-browser-dot--idle'}`} aria-hidden />
        <div className="session-browser-title" data-testid="session-browser-title" title={title}>{title || 'Untitled page'}</div>
        <button type="button" className="session-browser-btn session-browser-btn--icon" aria-label="Close the Browser view" title="Close"
          onClick={onClose} data-testid="session-browser-hide">{CLOSE_GLYPH}</button>
      </header>
      <div className="session-browser-names">
        <div className="session-browser-url" data-testid="session-browser-url" title={url}>{url}</div>
        <div className="session-browser-where" data-testid="session-browser-where" title={whereFull}>{where}</div>
      </div>
      {tabs.length > 1 && (
        <div className="session-browser-tabs" role="tablist" aria-label="The task's tabs">
          {tabs.map((t) => (
            <button key={tabKey(t)} type="button" role="tab" aria-selected={tabKey(t) === tabKey(followed)}
              className={`session-browser-tab${tabKey(t) === tabKey(followed) ? ' is-on' : ''}`}
              onClick={() => setPrefs((p) => ({ ...p, pick: tabKey(t) }))}>{t.title || t.url || `tab ${t.tab}`}{tabs.some((o) => o !== t && o.tab === t.tab) ? ` · ${t.browser}` : ''}</button>
          ))}
        </div>
      )}
      {asks && (
        <div className={`session-browser-hand${driving ? ' is-driving' : ''}`} role="status" data-testid="session-browser-hand">
          <span className="session-browser-hand-text">{asks}</span>
          {driving
            ? <button type="button" className="session-browser-btn session-browser-btn--primary" onClick={() => { void hand('back'); }} disabled={handing !== null}>{followed.signIn ? 'Done' : 'Hand back'}</button>
            : <button type="button" className="session-browser-btn session-browser-btn--primary" onClick={() => { void hand('take'); }} disabled={handing !== null || !followed.connected}>Take over to sign in</button>}
        </div>
      )}
      <div className="session-browser-shot" ref={setShotEl} data-testid="session-browser-shot">
        {picture
          ? <img src={picture.image} alt={`The agent's tab: ${title ?? ''}`} className={live ? '' : 'is-stale'} data-testid="session-browser-picture" draggable={false} />
          : <div className="session-browser-empty" data-testid="session-browser-why">{late ? `${late} ` : ''}{noPicture ?? 'Taking the first picture…'}{liveOffer}</div>}
      </div>
      <div className="session-browser-foot" data-testid="session-browser-foot">
        {picture && (live ? <span>Live · {agoLine(picture.at, now)}</span> : <span>Last picture {agoLine(picture.at, now)}</span>)}
        {picture && (noPicture || late) && <span className="session-browser-note" data-testid="session-browser-why">{[late, noPicture].filter(Boolean).join(' ')}{liveOffer}</span>}
      </div>
      {/* Stop on its own at the far left, so a click meant for Larger or Take over never ends the
          agent's use. All quiet: the ask row above holds the filled button when something is asked. */}
      <div className="session-browser-actions">
        <button type="button" className="session-browser-btn session-browser-btn--stop" onClick={() => { void stop(); }} disabled={stopping}
          title="The agent stops using this tab. The tab stays open, yours." data-testid="session-browser-stop">{stopping ? 'Stopping…' : 'Stop'}</button>
        <span className="session-browser-actions-gap" aria-hidden />
        <button type="button" className="session-browser-btn" onClick={() => setPrefs((p) => ({ ...p, large: !p.large }))}
          aria-pressed={prefs.large} data-testid="session-browser-size">{prefs.large ? 'Smaller' : 'Larger'}</button>
        {driving
          ? <button type="button" className="session-browser-btn" onClick={() => { void hand('back'); }} disabled={handing !== null}
              title="The agent may use this tab again" data-testid="session-browser-handback">{handing === 'back' ? 'Handing back…' : followed.signIn ? 'Done, hand back' : 'Hand back'}</button>
          : <button type="button" className="session-browser-btn" onClick={() => { void hand('take'); }} disabled={handing !== null || !followed.connected}
              title="Bring this tab up in your browser and use it yourself; the agent waits until you hand it back" data-testid="session-browser-takeover">{handing === 'take' ? 'Taking over…' : 'Take over'}</button>}
      </div>
    </section>
  );
}
