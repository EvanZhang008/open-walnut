import { log } from './log';
import { detectInputClient } from './input-latency-monitor';
import { isHistoryUserTurn } from '@open-walnut/history-turn-window';
import { readTurnMarker } from './turn-end-marker';
import type { SessionHistoryMessage } from '@/types/session';

export type OpenHistorySource = 'memory' | 'idb' | 'snapshot' | 'ready' | 'preview' | 'network' | 'stream' | 'unknown';
interface OpenAttempt { at: number; source?: OpenHistorySource; entry: string; id: number; timeout?: ReturnType<typeof setTimeout>; engine?: () => string; settle?: () => void; hiddenDuringOpen?: boolean }
const attempts = new Map<string, OpenAttempt>();
const sources = new Map<string, OpenHistorySource>();
const OPEN_EVENT = 'walnut:session-open-measure';
const MAX_OPEN_WAIT_MS = 30_000;
let sequence = 0;

function finishAttempt(sessionId: string, attempt: OpenAttempt, outcome: 'content' | 'timeout'): void {
  if (attempts.get(sessionId) !== attempt) return;
  const source = attempt.source ?? 'unknown';
  log.info('session-open', `first content ${sessionId} open ${attempt.id}`, {
    sessionId, ms: Math.round(performance.now() - attempt.at),
    cache: source === 'unknown' ? 'unknown' : ['memory', 'idb', 'snapshot'].includes(source) ? 'cached' : 'cold',
    source, entry: attempt.entry, outcome, engine: attempt.engine?.() ?? 'unknown',
    client: detectInputClient(), userAgent: navigator.userAgent,
    hiddenDuringOpen: attempt.hiddenDuringOpen === true || document.visibilityState === 'hidden',
  });
  clearTimeout(attempt.timeout);
  attempts.delete(sessionId);
  attempt.settle?.();
}

function startAttempt(sessionId: string, entry: string, source?: OpenHistorySource): OpenAttempt {
  clearTimeout(attempts.get(sessionId)?.timeout);
  sources.delete(sessionId);
  const attempt: OpenAttempt = { at: performance.now(), entry, id: ++sequence, source,
    hiddenDuringOpen: document.visibilityState === 'hidden' };
  attempts.set(sessionId, attempt);
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

/** Only visible conversational content qualifies, not a spinner, tool run or notice fold. */
export function hasVisibleSessionContent(panel: HTMLElement): boolean {
  if (document.visibilityState === 'hidden') return false;
  const viewport = panel.getBoundingClientRect();
  if (viewport.width <= 0 || viewport.height <= 0 || viewport.bottom <= 0 || viewport.top >= innerHeight
    || viewport.right <= 0 || viewport.left >= innerWidth) return false;
  const bodies = panel.querySelectorAll<HTMLElement>(
    '.session-msg-user .session-msg-content > .markdown-body, .session-msg-assistant .session-msg-content > .markdown-body, .session-msg-assistant .session-msg-content > .rich-blocks .markdown-body, [data-stream-reply] .markdown-body',
  );
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
  let stopped = false;
  let reported = 0;
  if (mountAttempt && !attempts.has(sessionId)) startAttempt(sessionId, 'mount');
  const attachEngine = () => {
    const attempt = attempts.get(sessionId);
    if (attempt) { attempt.engine = engine; attempt.settle = () => observer.disconnect(); }
  };
  attachEngine();
  const report = (attempt: OpenAttempt) => {
    if (stopped || reported === attempt.id || attempts.get(sessionId) !== attempt) return;
    reported = attempt.id;
    finishAttempt(sessionId, attempt, 'content');
    observer.disconnect();
  };
  const check = () => {
    if (stopped || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const attempt = attempts.get(sessionId);
      if (!attempt || !hasVisibleSessionContent(panel)) return;
      // A second frame records the content after the preceding frame could paint it.
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (hasVisibleSessionContent(panel)) report(attempt);
      });
    });
  };
  const observer = new MutationObserver(check);
  observer.observe(panel, { childList: true, subtree: true, characterData: true });
  const onOpen = (event: Event) => {
    if ((event as CustomEvent<{ sessionId: string }>).detail.sessionId === sessionId) {
      observer.observe(panel, { childList: true, subtree: true, characterData: true });
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
    observer.disconnect();
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
