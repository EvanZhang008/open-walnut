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
export function noPictureLine(f: Pick<BrowserFrame, 'why' | 'window'> | null, hasPicture: boolean): string | null {
  switch (f?.why) {
    case 'behind':
      return f.window === 'person'
        ? 'This tab is behind another tab in your window. Walnut never switches your tabs to take a picture: it shows when the tab is in front.'
        : 'This tab is behind another tab in the agent window: the picture shows when it is in front.';
    case 'minimized': return "Walnut's agent window is minimized: the picture shows again when you restore it.";
    // Chrome draws nothing in a window other windows cover entirely, so the last picture is old.
    case 'covered': return "Chrome stops drawing Walnut's agent window while other windows cover all of it, so no new picture can be taken. It comes as soon as any part of that window is on screen.";
    case 'no_permission': return 'The Walnut extension may not take pictures of pages in this browser (it asks for that permission in its Settings).';
    case 'not_web': return 'The tab is not on a web page now.';
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
