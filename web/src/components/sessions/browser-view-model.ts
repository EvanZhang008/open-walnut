/**
 * The words of a task's Browser view (SessionBrowserCard.tsx), pure so a test reads them all.
 * The server's side is src/web/routes/browser-view-v1.ts; the extension's agent-view.ts.
 */

export interface BrowserViewTab {
  device: string;
  browser: string;
  tab: number;
  url?: string;
  title?: string;
  window?: 'agent' | 'person';
  windowState?: string;
  connected: boolean;
  pictures: boolean;
  /** Its extension tells whether live pictures could show a covered window, and can open the page that turns them on. */
  liveGrant?: boolean;
  /** The person took the tab over (Take over): the agent waits until they hand it back. */
  driving?: boolean;
  /** The agent asked the person to sign in here themselves (request_sign_in). */
  signIn?: { id: string; at: string; site?: string; note?: string };
}

export type BrowserEndWhy = 'closed' | 'given_back' | 'stopped' | 'gone' | 'browser_left' | 'tidied';

export interface BrowserViewState {
  tabs: BrowserViewTab[];
  ended?: { at: string; why: BrowserEndWhy };
}

export interface BrowserFrame {
  tab: number;
  device?: string;
  shown: boolean;
  why?: string;
  image?: string;
  url?: string;
  title?: string;
  window?: 'agent' | 'person';
  windowState?: string;
  handed?: boolean;
  taken?: boolean;
  driving?: boolean;
  at?: string;
  /** The stream's picture number (a browser that streams): the next ask names it as `after`. */
  seq?: number;
  /** Which stream `seq` counts in (a restart or a new holding starts another). */
  epoch?: string;
  /** Since when the browser has had no picture to give (the card says how long). */
  noPictureSince?: string;
  /** Nothing new since `after` (the last picture stays). */
  unchanged?: boolean;
  /** The browser streams its pictures (asked again at once, never on a timer). */
  stream?: boolean;
  /**
   * A frame with no picture of an agent's tab (`covered`, `minimized`, `behind`): why the
   * extension's pictures through Chrome's debugger could not show it either
   * (packages/browser-extension/src/agent-live.ts LiveState); absent from an older extension, and
   * for a tab they never serve (one of the person's).
   */
  live?: 'off' | 'no_permission' | 'cancelled' | 'unavailable' | 'failed' | 'dialog' | 'devtools' | string;
}

/** Which window the tab is in, as the person reads it. */
export function windowLine(t: { window?: string; windowState?: string; handed?: boolean; taken?: boolean }): string {
  if (t.window === 'person') {
    return t.taken ? 'Your own window: the agent took this tab of yours'
      : t.handed ? 'Your own window: you handed this tab over'
        : 'Your own window';
  }
  if (t.window === 'agent') {
    return t.windowState === 'minimized' ? "Walnut's agent window (you minimized it)" : "Walnut's agent window, behind yours (not minimized)";
  }
  return 'Your browser';
}

/** Why there is no picture now; `null` when the last picture simply stays (a frame skipped). */
const COVERED_LINE = "Chrome stops drawing Walnut's agent window while other windows cover all of it, so no new picture can be taken. It comes as soon as any part of that window is on screen.";

/** What "Show it live" does, said beside the button. */
export const LIVE_GRANT_LINE = "Chrome opens a small Walnut page: click Allow there, then Allow in Chrome's box.";

/** The extension's switch for pictures through Chrome's debugger (packages/browser-extension/src/popup-settings.ts LIVE_PICTURES_TITLE). */
export const LIVE_PICTURES_SWITCH = "Live pictures through Chrome's debugger";

/** The frames whose picture Chrome's debugger can take when captureVisibleTab cannot. */
const LIVE_WHYS = new Set(['covered', 'minimized', 'behind']);

/**
 * The card offers "Show it live": the extension lacks the debugger permission (a copy that
 * somehow has not got it: the manifest requires it), and it can open the page that asks (an older
 * one cannot: its line stays).
 */
export function liveGrantOffer(f: Pick<BrowserFrame, 'why' | 'live'> | null, t: Pick<BrowserViewTab, 'liveGrant'> | undefined): boolean {
  return !!f?.why && LIVE_WHYS.has(f.why) && f.live === 'no_permission' && t?.liveGrant === true;
}

/**
 * Why Chrome's debugger gave no picture either, as one sentence, or null when the extension did
 * not say (an older one, or a tab it never pictures that way).
 */
function liveLine(live: string | undefined, grant: boolean): string | null {
  switch (live) {
    case 'no_permission': return grant
      ? `To see it live anyway, press Show it live. ${LIVE_GRANT_LINE}`
      : "This copy of the Walnut extension may not use Chrome's debugger, which would show it anyway: set the extension up again from Walnut (Settings, Browser extension).";
    case 'off': return `To see it anyway, turn on "${LIVE_PICTURES_SWITCH}" in the Walnut extension's Settings.`;
    case 'cancelled': return "You cancelled Chrome's debugging bar, so Walnut takes no pictures through it for 10 minutes.";
    case 'dialog': return 'A dialog (alert, confirm or prompt) is open on the page, and Chrome draws nothing new until it is answered: the agent answers it with dialog, or you can in that tab.';
    case 'devtools': return "DevTools is open on this tab, so Walnut cannot use Chrome's debugger there: close DevTools and the picture comes back.";
    case 'failed': return "Chrome's debugger gave no picture of the tab just now: Walnut tries again in half a minute.";
    default: return null;
  }
}

/** A covered window's line, by what the extension says of pictures through the debugger (`grant`: the card offers Show it live). */
function coveredLine(live: string | undefined, grant: boolean): string {
  const why = liveLine(live, grant);
  if (!why) return COVERED_LINE;
  return `Chrome stops drawing Walnut's agent window while other windows cover all of it. ${why}`;
}

export function noPictureLine(f: Pick<BrowserFrame, 'why' | 'window' | 'live'> | null, hasPicture: boolean, grant = false): string | null {
  switch (f?.why) {
    case 'behind': {
      if (f.window === 'person') return 'This tab is behind another tab in your window. Walnut never switches your tabs to take a picture: it shows when the tab is in front.';
      const why = liveLine(f.live, grant);
      return why ? `This tab is behind another tab in the agent window. ${why}` : 'This tab is behind another tab in the agent window: the picture shows when it is in front.';
    }
    case 'minimized': {
      const why = liveLine(f.live, grant);
      return why ? `Walnut's agent window is minimized. ${why}` : "Walnut's agent window is minimized: the picture shows again when you restore it.";
    }
    // Chrome draws nothing in a window other windows cover entirely, so the last picture is old.
    case 'covered': return coveredLine(f.live, grant);
    case 'discarded': return "Chrome put this tab to sleep to save memory, so it has nothing to show. It wakes when the agent acts in it again (Walnut does not wake it just to take a picture: that would load the page again).";
    case 'no_permission': return 'The Walnut extension may not take pictures of pages in this browser (it asks for that permission in its Settings).';
    case 'not_web': return 'The tab is not on a web page now (a browser page such as chrome://, or a file), which Chrome does not let extensions picture.';
    case 'walnut_page': return "The tab shows Walnut's own page: no picture of it.";
    case 'old_extension': return "This browser's Walnut extension is older than the Browser view: update it (Settings, Browser extension).";
    case 'busy': return hasPicture ? null : 'The agent is clicking or typing in another of its tabs, which needs the screen: the picture comes right after.';
    case 'changed': return hasPicture ? null : 'The page changed while its picture was taken: the next one comes in a moment.';
    case 'slow': return hasPicture ? null : 'The browser is slow to answer (the Mac is busy): the picture comes when it does.';
    case 'failed': return hasPicture ? null : 'Chrome gave no picture this time: trying again.';
    case 'starting': return hasPicture ? null : 'Taking the first picture…';
    default: return null;
  }
}

/** A picture this old or more, or none for this long, is said to be late. */
export const LATE_MS = 6000;

/** "No new picture for 14 s." once the last picture (or the wait for one) is LATE_MS old. */
export function lateLine(since: string | undefined, now: number): string | null {
  const t = since ? Date.parse(since) : NaN;
  if (!Number.isFinite(t) || now - t < LATE_MS) return null;
  return `No new picture for ${agoLine(since, now).replace(' ago', '')}.`;
}

/** The line once the session's last tab went. */
export function endedLine(why: BrowserEndWhy): string {
  switch (why) {
    case 'closed': return 'The agent closed its browser tab.';
    case 'given_back': return 'The agent gave your tab back. It stays open.';
    case 'stopped': return "You stopped the agent's use of the tab. It stays open.";
    case 'browser_left': return 'The browser left Walnut (agents turned off, or the extension disconnected).';
    case 'tidied': return 'Walnut closed the task\'s tab: the task finished, or no agent used the tab for 30 minutes.';
    default: return 'The agent stopped using the browser (the tab was closed, or given back with Stop).';
  }
}

/** "3 s ago", "2 min ago". */
export function agoLine(at: string | undefined, now: number): string {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/**
 * A tab as one browser's own: its id is unique within that browser only, so two connected browsers
 * can each have a tab 42 (review 2026-11-07: the view showed one and stopped the other).
 */
export const tabKey = (t: { device: string; tab: number }): string => `${t.device}:${t.tab}`;

/** The tab the view follows: the one picked (browser and tab) while it is still there, else the newest. */
export function followedTab(tabs: BrowserViewTab[], picked: string | null): BrowserViewTab | undefined {
  return tabs.find((t) => tabKey(t) === picked) ?? tabs[tabs.length - 1];
}

/** How long after a frame's answer the next one is asked for. */
export const FRAME_EVERY_MS = 1200;
/** A streaming browser's view asks again this soon after an answer with no new picture (the server holds each ask under half a second). */
export const UNCHANGED_AGAIN_MS = 150;
/** While the browser does not answer, a slower try. */
export const FRAME_RETRY_MS = 3000;

/** The line over the picture while the person has the tab, or the agent waits for their sign-in; null when neither. */
export function handLine(t: { driving?: boolean; signIn?: { site?: string; note?: string } }): string | null {
  const site = t.signIn?.site ? ` to ${t.signIn.site}` : '';
  const note = t.signIn?.note ? ` ${t.signIn.note.replace(/\s+$/, '')}` : '';
  if (t.driving) return t.signIn
    ? `You have this tab in your browser. Sign in${site} there, then press Done: the agent carries on.`
    : 'You have this tab in your browser. The agent waits until you hand it back.';
  if (t.signIn) return `The agent asks you to sign in${site} yourself.${note ? ` It says:${note}` : ''}`;
  return null;
}
