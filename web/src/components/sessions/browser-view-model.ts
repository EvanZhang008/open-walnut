/**
 * The words of a task's Browser view (SessionBrowserCard.tsx), pure so a test reads them all.
 * The server's side is src/web/routes/browser-view-v1.ts; the extension's agent-view.ts.
 */

import { pointInTime } from '../../utils/time';

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
  /** The task's recorded steps (the Browser replay, src/core/browser-control/replay-store.ts). */
  replay?: { steps: number; last?: string };
}

/** One recorded step of the Browser replay (GET /api/v1/browser/view/replay). */
export interface ReplayStep {
  id: string;
  at: string;
  action: string;
  label: string;
  ok: boolean;
  code?: string;
  url?: string;
  title?: string;
  tab: number;
  /** Its picture was taken (GET /api/v1/browser/view/replay/frame). */
  picture: boolean;
}

/** The replay's speeds: steps a second. */
export const REPLAY_SPEEDS = [1, 2, 4] as const;
/** While the replay is open, the list is read again this often (a running task adds steps). */
export const REPLAY_REREAD_MS = 5000;

/** The step whose picture shows at `i`: its own, else the last earlier step that has one (-1: none). */
export function pictureIndex(steps: readonly Pick<ReplayStep, 'picture'>[], i: number): number {
  for (let j = Math.min(i, steps.length - 1); j >= 0; j--) if (steps[j]?.picture) return j;
  return -1;
}

/** What a step's icon draws (SessionBrowserReplay.tsx STEP_ICONS). */
export type ReplayStepIcon = 'open' | 'click' | 'tab' | 'link' | 'type' | 'clear' | 'key' | 'down' | 'up' | 'go' | 'reload' | 'back' | 'form' | 'upload' | 'step';

/**
 * A step in plain words (2026-11-15, the user: "descriptions like click xx do xx"): what the agent
 * did, then where, from the step's recorded label (replay-store.ts stepLabel, the extension's
 * `said` words: page-agent.ts, agent-trusted.ts, page-input.ts). The label stays the tooltip.
 */
export function replayStepWords(step: Pick<ReplayStep, 'action' | 'label' | 'url' | 'title' | 'ok' | 'code' | 'tab'>, before?: Pick<ReplayStep, 'url' | 'title' | 'tab'>): { icon: ReplayStepIcon; title: string; detail: string } {
  const out = wordsOf(step, before);
  if (!step.ok) out.detail = `failed${step.code ? `: ${step.code.replace(/_/g, ' ')}` : ''}`;
  return out;
}

const quote = (s: string) => `“${s}”`;
const KEY_NAMES: Record<string, string> = { Enter: 'Return', Meta: 'Command', Control: 'Control', Alt: 'Option', ArrowDown: 'Down Arrow', ArrowUp: 'Up Arrow', ArrowLeft: 'Left Arrow', ArrowRight: 'Right Arrow' };
// "Shift++" is Shift and the + key.
const keyName = (k: string) => k.split(/\+(?=.)/).map((p) => KEY_NAMES[p] ?? (p.length === 1 ? p.toUpperCase() : p)).join('-');
const pageName = (s: Pick<ReplayStep, 'title' | 'url'>) => s.title?.trim() || (s.url ?? '').replace(/^https?:\/\//, '') || 'the page';
const hostOf = (u?: string) => (u ?? '').replace(/^https?:\/\//, '').split('/')[0];

function wordsOf(s: Pick<ReplayStep, 'action' | 'label' | 'url' | 'title' | 'tab'>, before?: Pick<ReplayStep, 'url' | 'title' | 'tab'>): { icon: ReplayStepIcon; title: string; detail: string } {
  const label = s.label ?? '';
  // "<role> "<name>"", as the page names an element.
  const named = /^(\w[\w ]*?) "(.*)"$/;
  switch (s.action) {
    case 'open': return { icon: 'open', title: `Opened ${pageName(s)}`, detail: hostOf(s.url) };
    case 'navigate':
      // A reload only when nothing differs: the address is kept without its query, so a new
      // search on the same page reads as a go by its new title.
      return before?.url && before.url === s.url && before.tab === s.tab && before.title === s.title
        ? { icon: 'reload', title: `Reloaded ${pageName(s)}`, detail: hostOf(s.url) }
        : { icon: 'go', title: `Went to ${pageName(s)}`, detail: hostOf(s.url) };
    case 'back': return { icon: 'back', title: 'Went back', detail: s.title ? `to ${s.title}` : '' };
    case 'click': {
      const m = named.exec(label.replace(/^Click /, ''));
      if (!m) return { icon: 'click', title: 'Clicked', detail: label.replace(/^Click ?/, '') };
      const [, role, name] = m;
      if (!name.trim()) return { icon: 'click', title: `Clicked a ${role}`, detail: '' };
      if (role === 'tab') return { icon: 'tab', title: `Clicked the ${quote(name)} tab`, detail: '' };
      if (role === 'link') return { icon: 'link', title: `Clicked the ${quote(name)} link`, detail: '' };
      if (role === 'option' || role === 'menuitem') return { icon: 'click', title: `Chose ${quote(name)}`, detail: '' };
      if (role === 'combobox' || role === 'listbox') return { icon: 'click', title: `Opened the ${quote(name)} list`, detail: '' };
      if (role === 'textbox' || role === 'searchbox') return { icon: 'click', title: `Clicked in ${quote(name)}`, detail: '' };
      if (role === 'checkbox' || role === 'radio' || role === 'switch') return { icon: 'click', title: `Clicked ${quote(name)}`, detail: role };
      return { icon: 'click', title: `Clicked ${quote(name)}`, detail: role === 'button' ? '' : role };
    }
    case 'type': {
      // "one key at a time" comes before the field (page-input.ts) or after it (agent-trusted.ts).
      const slow = /, one key at a time/.test(label);
      const m = /^Type (\d+) characters?(?:,? into (.*))?$/.exec(label.replace(/, one key at a time/, ''));
      if (!m) return { icon: 'type', title: 'Typed', detail: label.replace(/^Type ?/, '') };
      const field = m[2] ? named.exec(m[2])?.[2] ?? m[2] : '';
      if (m[1] === '0') return { icon: 'clear', title: field ? `Cleared ${quote(field)}` : 'Cleared the field', detail: '' };
      return { icon: 'type', title: `Typed ${m[1]} character${m[1] === '1' ? '' : 's'}`, detail: [field ? `in ${quote(field)}` : '', slow ? 'one key at a time' : ''].filter(Boolean).join(', ') };
    }
    case 'press': {
      const key = label.replace(/^Press ?/, '').trim();
      return { icon: 'key', title: key && key !== 'a key' ? `Pressed ${keyName(key)}` : 'Pressed a key', detail: '' };
    }
    case 'scroll': {
      const edge = /to the (top|bottom)/.exec(label);
      const dir = /^Scroll (up|down|left|right)/.exec(label)?.[1];
      const at = /at (\d+) of (\d+)/.exec(label);
      const px = /(\d+) px/.exec(label);
      const title = edge ? `Scrolled to the ${edge[1]}` : `Scrolled ${dir ?? ''}`.trim();
      const detail = at && Number(at[2]) > 0 && !edge ? `${Math.round((Number(at[1]) / Number(at[2])) * 100)}% into the page` : px ? `by ${px[1]} px` : '';
      return { icon: edge?.[1] === 'top' || dir === 'up' ? 'up' : dir === 'left' ? 'back' : dir === 'right' ? 'go' : 'down', title, detail };
    }
    case 'select': return { icon: 'click', title: `Chose ${label.replace(/^Select ?/, '').trim() || 'an option'}`, detail: '' };
    case 'hover': return { icon: 'click', title: label.replace(/^Hover ?/, '').trim() ? `Pointed at ${label.replace(/^Hover ?/, '').trim()}` : 'Pointed at the page', detail: '' };
    case 'drag': return { icon: 'click', title: `Dragged ${label.replace(/^Drag ?/, '').trim() || 'on the page'}`, detail: '' };
    case 'fill_form': return { icon: 'form', title: label.replace(/^Fill /, 'Filled '), detail: '' };
    case 'upload': return { icon: 'upload', title: label.replace(/^Upload /, 'Uploaded '), detail: '' };
    case 'fill_login': return { icon: 'form', title: 'Filled in the sign-in', detail: '' };
    case 'fill_code': return { icon: 'form', title: 'Filled in the one-time code', detail: '' };
    case 'dialog': return { icon: 'click', title: label.startsWith('Dismiss') ? 'Dismissed a dialog' : 'Answered a dialog', detail: '' };
    default: return { icon: 'step', title: label || s.action, detail: '' };
  }
}

/** On the ruler, a pause longer than this is drawn as this long, with its real length written on it. */
export const RULER_FOLD_S = 45;

/**
 * The replay's time ruler (design 4, 2026-11-15): each step at its real time from the first, a
 * long pause folded to RULER_FOLD_S (a task's steps may be days apart), and steps at least 1 s apart
 * (steps within one second never sit on each other). `at` is 0 to 1 per step;
 * each fold's middle and real length.
 */
export function replayRuler(steps: readonly Pick<ReplayStep, 'at'>[]): { at: number[]; folds: Array<{ at: number; seconds: number }>; seconds: number } {
  const t = steps.map((s) => Date.parse(s.at) / 1000);
  const drawn: number[] = [];
  const folds: Array<{ mid: number; seconds: number }> = [];
  let sum = 0;
  t.forEach((x, i) => {
    const gap = i && Number.isFinite(x) && Number.isFinite(t[i - 1]) ? Math.max(0, x - t[i - 1]) : 0;
    if (gap > RULER_FOLD_S) folds.push({ mid: sum + RULER_FOLD_S / 2, seconds: gap });
    // At least 1 s apart: steps within a second never draw on top of each other.
    if (i) sum += Math.max(1, Math.min(gap, RULER_FOLD_S));
    drawn.push(sum);
  });
  const total = sum || 1;
  const first = t.find(Number.isFinite) ?? 0;
  const last = [...t].reverse().find(Number.isFinite) ?? first;
  return { at: drawn.map((d) => (steps.length > 1 ? d / total : 0)), folds: folds.map((f) => ({ at: f.mid / total, seconds: f.seconds })), seconds: Math.max(0, last - first) };
}

/** A length of time, short: 87 s, 3 min, 5 h, 2 d. */
export function spanLine(seconds: number): string {
  if (seconds < 120) return `${Math.round(seconds)} s`;
  if (seconds < 120 * 60) return `${Math.round(seconds / 60)} min`;
  if (seconds < 48 * 3600) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} d`;
}

/** A step's time in the list: from the first step (m:ss) while the whole run is under an hour, else its day and clock. */
export function stepTimeLine(at: string, first: string, runSeconds: number, now: number): string {
  if (runSeconds >= 3600) return pointInTime(at, { now });
  const s = Math.max(0, Math.round((Date.parse(at) - Date.parse(first)) / 1000));
  if (!Number.isFinite(s)) return '';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Why a step has no picture of its own, for the line under the last one shown. */
export const NO_STEP_PICTURE = 'No picture of this step (the tab could not be pictured then): the last one before it shows.';
/** The replay with nothing in it. */
export const NO_REPLAY = 'No browser steps recorded for this task in the days kept.';

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

/**
 * Which window the tab is in, as the person reads it. Short for the view's one line; `full` adds
 * what the short form leaves out (the window is not minimized), for its tooltip.
 */
export function windowLine(t: { window?: string; windowState?: string; handed?: boolean; taken?: boolean }, full = false): string {
  if (t.window === 'person') {
    return t.taken ? 'Your own window: the agent took this tab of yours'
      : t.handed ? 'Your own window: you handed this tab over'
        : 'Your own window';
  }
  if (t.window === 'agent') {
    if (t.windowState === 'minimized') return "Walnut's agent window (you minimized it)";
    return full ? "Walnut's agent window, behind yours (not minimized)" : "Walnut's agent window, behind yours";
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
  const chosen = tabs.find((t) => tabKey(t) === picked) ?? tabs[tabs.length - 1];
  // A tab where the agent asks the person to sign in comes first: the header pill says "Sign in",
  // so opening the view must show that ask, not another tab (2026-11-09 review).
  if (chosen && chosen.signIn && !chosen.driving) return chosen;
  return [...tabs].reverse().find((t) => t.signIn && !t.driving) ?? chosen;
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
