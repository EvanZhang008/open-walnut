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
}

export type BrowserEndWhy = 'closed' | 'given_back' | 'stopped' | 'gone' | 'browser_left';

export interface BrowserViewState {
  tabs: BrowserViewTab[];
  ended?: { at: string; why: BrowserEndWhy };
}

export interface BrowserFrame {
  tab: number;
  shown: boolean;
  why?: string;
  image?: string;
  url?: string;
  title?: string;
  window?: 'agent' | 'person';
  windowState?: string;
  handed?: boolean;
  taken?: boolean;
  at?: string;
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
    case 'no_permission': return 'The Walnut extension may not take pictures of pages in this browser (it asks for that permission in its Settings).';
    case 'not_web': return 'The tab is not on a web page now.';
    case 'walnut_page': return "The tab shows Walnut's own page: no picture of it.";
    case 'old_extension': return "This browser's Walnut extension is older than the Browser view: update it (Settings, Browser extension).";
    case 'busy': case 'changed': case 'slow': case 'failed':
      return hasPicture ? null : 'Waiting for the next picture…';
    default: return null;
  }
}

/** The line once the session's last tab went. */
export function endedLine(why: BrowserEndWhy): string {
  switch (why) {
    case 'closed': return 'The agent closed its browser tab.';
    case 'given_back': return 'The agent gave your tab back. It stays open.';
    case 'stopped': return "You stopped the agent's use of the tab. It stays open.";
    case 'browser_left': return 'The browser left Walnut (agents turned off, or the extension disconnected).';
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

/** The tab the view follows: the one picked while it is still there, else the newest. */
export function followedTab(tabs: BrowserViewTab[], picked: number | null): BrowserViewTab | undefined {
  return tabs.find((t) => t.tab === picked) ?? tabs[tabs.length - 1];
}

/** How long after a frame's answer the next one is asked for. */
export const FRAME_EVERY_MS = 1200;
/** While the browser does not answer, a slower try. */
export const FRAME_RETRY_MS = 3000;
