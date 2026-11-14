import { log } from './log';
import { detectInputClient } from './input-latency-monitor';
import { isHistoryUserTurn } from '@open-walnut/history-turn-window';
import { readTurnMarker } from './turn-end-marker';
import type { SessionHistoryMessage } from '@/types/session';

export type OpenHistorySource = 'memory' | 'idb' | 'snapshot' | 'ready' | 'preview' | 'network' | 'stream' | 'unknown';
export type OpenHistoryStage = 'historyEffect' | 'idbStart' | 'idbReady' | 'historyReady' | 'historyAdopted' | 'contentDetected';
interface OpenAttempt { at: number; source?: OpenHistorySource; entry: string; id: number; stages: Partial<Record<OpenHistoryStage, number>>; timeout?: ReturnType<typeof setTimeout>; engine?: () => string; settle?: () => void; hiddenDuringOpen?: boolean; viewportSeen?: boolean; outsideViewportAtAttach?: boolean; viewportEnteredMs?: number; longestFrameGap?: { ms: number; endedMs: number }; notVisible?: NotVisibleProbe; chatHiddenNow?: () => boolean; hiddenByPage?: boolean }
const attempts = new Map<string, OpenAttempt>();
const sources = new Map<string, OpenHistorySource>();
const OPEN_EVENT = 'walnut:session-open-measure';
const MAX_OPEN_WAIT_MS = 30_000;
let sequence = 0;

function finishAttempt(sessionId: string, attempt: OpenAttempt, outcome: 'content' | 'timeout'): void {
  if (attempts.get(sessionId) !== attempt) return;
  const source = attempt.source ?? 'unknown';
  const hiddenAtEnd = outcome === 'timeout' && attempt.chatHiddenNow?.() === true;
  if (hiddenAtEnd) attempt.hiddenByPage = true;
  const measuredOutcome = outcome === 'timeout' && (hiddenAtEnd || attempt.outsideViewportAtAttach && !attempt.viewportSeen)
    ? 'not-visible' : outcome;
  log.info('session-open', `first content ${sessionId} open ${attempt.id}`, {
    sessionId, ms: Math.round(performance.now() - attempt.at),
    cache: source === 'unknown' ? 'unknown' : ['memory', 'idb', 'snapshot'].includes(source) ? 'cached' : 'cold',
    source, entry: attempt.entry, outcome: measuredOutcome, engine: attempt.engine?.() ?? 'unknown',
    stages: { ...attempt.stages }, measurementVersion: 2,
    outsideViewportAtAttach: attempt.outsideViewportAtAttach === true,
    viewportSeen: attempt.viewportSeen === true, viewportEnteredMs: attempt.viewportEnteredMs,
    client: detectInputClient(), userAgent: navigator.userAgent,
    hiddenDuringOpen: attempt.hiddenDuringOpen === true || document.visibilityState === 'hidden',
    ...(attempt.hiddenByPage ? { hiddenByPage: true } : {}),
    ...(attempt.longestFrameGap ? { longestFrameGap: attempt.longestFrameGap } : {}),
    ...(attempt.notVisible ? { notVisible: attempt.notVisible } : {}),
  });
  clearTimeout(attempt.timeout);
  attempts.delete(sessionId);
  attempt.settle?.();
}

/**
 * The longest gap between two animation frames while this open is in progress:
 * whether a slow open waited on the page's main thread (one long gap) or on
 * something else (short gaps throughout). WebKit has no long-task observer, so
 * frames are the measure. Ends by itself once the attempt is finished or replaced.
 */
const FRAME_WATCH_MS = 10_000;
let visibilityFlippedAt = 0;
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { visibilityFlippedAt = performance.now(); });
}

function watchFrames(sessionId: string, attempt: OpenAttempt): void {
  if (typeof requestAnimationFrame !== 'function') return;
  let last = performance.now();
  const tick = (now: number) => {
    if (attempts.get(sessionId) !== attempt || now - attempt.at > FRAME_WATCH_MS) return;
    const gap = now - last;
    const crossedHidden = visibilityFlippedAt > last || document.visibilityState === 'hidden';
    last = now;
    // A hidden page stops frames on purpose (the gap spans the hidden time): no main-thread hold.
    if (!crossedHidden && gap > (attempt.longestFrameGap?.ms ?? 0)) {
      attempt.longestFrameGap = { ms: Math.round(gap), endedMs: Math.round(now - attempt.at) };
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function startAttempt(sessionId: string, entry: string, source?: OpenHistorySource): OpenAttempt {
  clearTimeout(attempts.get(sessionId)?.timeout);
  sources.delete(sessionId);
  const attempt: OpenAttempt = { at: performance.now(), entry, id: ++sequence, source, stages: {},
    hiddenDuringOpen: document.visibilityState === 'hidden' };
  attempts.set(sessionId, attempt);
  watchFrames(sessionId, attempt);
  // The clock starts at the click even if no panel or metadata ever arrives.
  attempt.timeout = setTimeout(() => finishAttempt(sessionId, attempt, 'timeout'), MAX_OPEN_WAIT_MS);
  return attempt;
}

/** Called before the UI changes, so the measurement includes mounting and request admission. */
export function beginSessionOpen(sessionId: string, entry: string): void {
  const mounted = document.querySelector?.<HTMLElement>(`.session-panel[data-session-id="${CSS.escape(sessionId)}"]`);
  const alreadyVisible = !!mounted && hasVisibleSessionContent(mounted);
  startAttempt(sessionId, alreadyVisible ? `${entry}:visible` : entry,
    alreadyVisible ? 'memory' : undefined);
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { sessionId } }));
}

export function hasReadableOpenRows(rows: readonly SessionHistoryMessage[]): boolean {
  return rows.some(row => isHistoryUserTurn(row)
    || (row.role === 'assistant' && !row.cliError && !!readTurnMarker(row.text).text.trim()));
}

export function noteSessionOpenSource(sessionId: string, source: OpenHistorySource): void {
  // First content owns the classification; a background full refresh must not turn a cache hit cold.
  if (!sources.has(sessionId)) sources.set(sessionId, source);
  while (sources.size > 200) sources.delete(sources.keys().next().value!);
  const attempt = attempts.get(sessionId);
  if (attempt && !attempt.source) attempt.source = source;
}

/** Bind callbacks to this open, so a late read cannot annotate a subsequent reopen. */
export function sessionOpenStageRecorder(sessionId: string): (stage: OpenHistoryStage) => void {
  const attempt = attempts.get(sessionId);
  return (stage) => {
    if (!attempt || attempts.get(sessionId) !== attempt || attempt.stages[stage] !== undefined) return;
    attempt.stages[stage] = Math.round(performance.now() - attempt.at);
  };
}

/** Laid out but not drawn: Home mounted behind another page (`.main-page-wrapper-hidden`
 *  hides the whole panel), a chat under a peek tab (task-board.css hides the chat column's
 *  children, so the panel itself still shows). Its boxes keep their geometry, so only the
 *  style tells (2026-11-14: a Home column mounted on /org read as a visible 30 s timeout;
 *  its 9 rows had been adopted at 102 ms). Opacity is left out on purpose: a fade-in starts
 *  at 0 and must not exclude a real open from the budget. */
function hiddenByStyle(el: HTMLElement): boolean {
  const check = (el as HTMLElement & { checkVisibility?: (o?: { visibilityProperty?: boolean }) => boolean }).checkVisibility;
  if (typeof check === 'function') return !check.call(el, { visibilityProperty: true });
  return getComputedStyle(el).visibility === 'hidden';
}

/** The panel, or the conversation inside it, is hidden by the page. */
function chatHiddenByPage(panel: HTMLElement): boolean {
  if (hiddenByStyle(panel)) return true;
  const scroller = panel.querySelector?.<HTMLElement>('.session-history');
  return !!scroller && hiddenByStyle(scroller);
}

function panelInViewport(panel: HTMLElement): boolean {
  if (document.visibilityState === 'hidden' || chatHiddenByPage(panel)) return false;
  const box = panel.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight
    && box.right > 0 && box.left < innerWidth;
}

const CONTENT_BODIES = '.session-msg-user .session-msg-content > .markdown-body, .session-msg-assistant .session-msg-content > .markdown-body, .session-msg-assistant .session-msg-content > .rich-blocks .markdown-body, [data-stream-reply] .markdown-body';

/** Why rows handed to the view are not visible content yet: what the panel holds
 *  a moment after adoption (2026-11-12: cached rows adopted at 114 ms showed no
 *  content until the network answered 7.7 s later; nothing said why). */
interface NotVisibleProbe {
  atMs: number; panelInView: boolean; rows: number; bodies: number; withText: number;
  styledHidden: number; outOfView: number; scrollTop: number; scrollHeight: number; clientHeight: number;
  panelText: string;
}
const NOT_VISIBLE_PROBE_AFTER_MS = 400;

function probeNotVisible(panel: HTMLElement, atMs: number): NotVisibleProbe {
  const viewport = panel.getBoundingClientRect();
  let withText = 0; let styledHidden = 0; let outOfView = 0;
  const bodies = panel.querySelectorAll<HTMLElement>(CONTENT_BODIES);
  for (const body of bodies) {
    if (!body.textContent?.trim()) continue;
    withText++;
    const style = getComputedStyle(body);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') { styledHidden++; continue; }
    const box = body.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0 && box.bottom > Math.max(0, viewport.top) && box.top < Math.min(innerHeight, viewport.bottom))) outOfView++;
  }
  const scroller = panel.querySelector<HTMLElement>('.session-history');
  return {
    atMs, panelInView: panelInViewport(panel), rows: panel.querySelectorAll('.session-msg').length,
    bodies: bodies.length, withText, styledHidden, outOfView,
    scrollTop: Math.round(scroller?.scrollTop ?? -1), scrollHeight: scroller?.scrollHeight ?? -1, clientHeight: scroller?.clientHeight ?? -1,
    // The first words on screen (a status line, a placeholder), never message content:
    // only the text of the history's direct notices.
    panelText: Array.from(scroller?.querySelectorAll<HTMLElement>(':scope > [role="status"], :scope > .session-history-empty') ?? [])
      .map((n) => n.textContent?.trim() ?? '').join(' | ').slice(0, 120),
  };
}

/** Only visible conversational content qualifies, not a spinner, tool run or notice fold. */
export function hasVisibleSessionContent(panel: HTMLElement): boolean {
  if (!panelInViewport(panel)) return false;
  const viewport = panel.getBoundingClientRect();
  const bodies = panel.querySelectorAll<HTMLElement>(CONTENT_BODIES);
  for (const body of bodies) {
    if (!body.textContent?.trim() || body.closest?.('.task-earlier-sessions')) continue;
    const style = getComputedStyle(body);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
    const box = body.getBoundingClientRect();
    if (box.width > 0 && box.height > 0 && box.bottom > Math.max(0, viewport.top)
      && box.top < Math.min(innerHeight, viewport.bottom)
      && box.right > Math.max(0, viewport.left) && box.left < Math.min(innerWidth, viewport.right)) return true;
  }
  return false;
}

/** One structured record after a rendered frame, shared by every SessionPanel host. */
export function observeSessionOpen(panel: HTMLElement, sessionId: string, engine: () => string, mountAttempt = true): () => void {
  let frame = 0;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let reported = 0;
  if (mountAttempt && !attempts.has(sessionId)) startAttempt(sessionId, 'mount');
  const noteViewport = (attempt: OpenAttempt) => {
    const visible = panelInViewport(panel);
    if (attempt.outsideViewportAtAttach === undefined) attempt.outsideViewportAtAttach = !visible;
    if (visible && !attempt.viewportSeen) {
      attempt.viewportSeen = true;
      attempt.viewportEnteredMs = Math.round(performance.now() - attempt.at);
    }
  };
  const attachEngine = () => {
    const attempt = attempts.get(sessionId);
    if (attempt) { attempt.engine = engine; attempt.settle = disconnect; attempt.chatHiddenNow = () => chatHiddenByPage(panel); noteViewport(attempt); }
  };
  const report = (attempt: OpenAttempt) => {
    if (stopped || reported === attempt.id || attempts.get(sessionId) !== attempt) return;
    reported = attempt.id;
    finishAttempt(sessionId, attempt, 'content');
  };
  const check = () => {
    if (stopped || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const attempt = attempts.get(sessionId);
      if (!attempt) return;
      noteViewport(attempt);
      if (!hasVisibleSessionContent(panel)) {
        const adopted = attempt.stages.historyAdopted;
        const now = Math.round(performance.now() - attempt.at);
        if (adopted !== undefined && !attempt.notVisible) {
          const wait = adopted + NOT_VISIBLE_PROBE_AFTER_MS - now;
          if (wait <= 0) attempt.notVisible = probeNotVisible(panel, now);
          // Nothing may change on the page after adoption: look once anyway.
          else if (!probeTimer) probeTimer = setTimeout(() => { probeTimer = undefined; check(); }, wait);
        }
        return;
      }
      sessionOpenStageRecorder(sessionId)('contentDetected');
      // A second frame records the content after the preceding frame could paint it.
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (hasVisibleSessionContent(panel)) report(attempt);
      });
    });
  };
  const observer = new MutationObserver(check);
  const intersection = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(check);
  const onGeometry = () => check();
  const disconnect = () => {
    observer.disconnect();
    intersection?.disconnect();
    window.removeEventListener('scroll', onGeometry, true);
    window.removeEventListener('resize', onGeometry);
  };
  const watch = () => {
    observer.observe(panel, { childList: true, subtree: true, characterData: true });
    intersection?.observe(panel);
    window.addEventListener('scroll', onGeometry, true);
    window.addEventListener('resize', onGeometry);
  };
  watch();
  attachEngine();
  const onOpen = (event: Event) => {
    if ((event as CustomEvent<{ sessionId: string }>).detail.sessionId === sessionId) {
      watch();
      attachEngine();
      check();
    }
  };
  window.addEventListener(OPEN_EVENT, onOpen);
  const onVisibility = () => {
    const attempt = attempts.get(sessionId);
    if (attempt && document.visibilityState === 'hidden') attempt.hiddenDuringOpen = true;
    check();
  };
  document.addEventListener('visibilitychange', onVisibility);
  check();
  return () => {
    stopped = true;
    clearTimeout(probeTimer);
    disconnect();
    cancelAnimationFrame(frame);
    const attempt = attempts.get(sessionId);
    if (attempt?.engine === engine) {
      attempt.engine = undefined;
      attempt.settle = undefined;
      // StrictMode and a same-session move reattach before this tick ends.
      queueMicrotask(() => {
        if (attempts.get(sessionId) !== attempt || attempt.engine) return;
        clearTimeout(attempt.timeout);
        attempts.delete(sessionId);
        sources.delete(sessionId);
      });
    }
    window.removeEventListener(OPEN_EVENT, onOpen);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
