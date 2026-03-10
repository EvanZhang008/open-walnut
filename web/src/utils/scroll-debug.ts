/**
 * Persistent scroll debug logger.
 *
 * Stores a ring buffer of scroll events in localStorage so logs survive
 * page reloads and can be dumped even after the bug has occurred.
 *
 * Usage:
 *   scrollLog('initial-scroll', { scrollTop: 100, scrollHeight: 5000 });
 *   scrollLog.dump()    — returns all logs as string
 *   scrollLog.clear()   — clears the buffer
 *
 * Keyboard shortcut: Ctrl+Shift+D — copies scroll logs to clipboard + downloads as file.
 */

const STORAGE_KEY = 'walnut_scroll_debug';
const MAX_ENTRIES = 500;
const T0_KEY = 'walnut_scroll_debug_t0';

interface ScrollLogEntry {
  /** ms since first log in this session */
  t: number;
  /** event tag */
  tag: string;
  /** arbitrary data */
  d: Record<string, unknown>;
}

let t0 = 0;

function getT0(): number {
  if (t0) return t0;
  const stored = sessionStorage.getItem(T0_KEY);
  if (stored) { t0 = Number(stored); return t0; }
  t0 = Date.now();
  sessionStorage.setItem(T0_KEY, String(t0));
  return t0;
}

function getBuffer(): ScrollLogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveBuffer(buf: ScrollLogEntry[]) {
  try {
    // Keep only the last MAX_ENTRIES
    const trimmed = buf.length > MAX_ENTRIES ? buf.slice(-MAX_ENTRIES) : buf;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch { /* storage full — silently drop */ }
}

/**
 * Log a scroll debug event. Also writes to console for live debugging.
 */
export function scrollLog(tag: string, data: Record<string, unknown> = {}) {
  const entry: ScrollLogEntry = {
    t: Date.now() - getT0(),
    tag,
    d: data,
  };
  // Console log for live debugging
  const isWarning = tag.includes('SKIP') || tag.includes('WARN') || tag.includes('MISS');
  const prefix = isWarning ? '⚠️' : '📜';
  // eslint-disable-next-line no-console
  console.log(`${prefix} [scroll] +${entry.t}ms ${tag}`, data);

  // Persist to localStorage ring buffer
  const buf = getBuffer();
  buf.push(entry);
  saveBuffer(buf);
}

/**
 * Dump all logs as a formatted string.
 */
scrollLog.dump = function dump(): string {
  const buf = getBuffer();
  if (buf.length === 0) return '(no scroll debug logs)';
  const lines = buf.map(e => {
    const ts = `+${String(e.t).padStart(6)}ms`;
    const data = Object.keys(e.d).length > 0 ? ' ' + JSON.stringify(e.d) : '';
    return `${ts} [${e.tag}]${data}`;
  });
  return `=== Scroll Debug Logs (${buf.length} entries, t0=${new Date(getT0()).toISOString()}) ===\n` + lines.join('\n');
};

/**
 * Clear the log buffer.
 */
scrollLog.clear = function clear() {
  localStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(T0_KEY);
  t0 = 0;
};

/**
 * Mark a new session navigation (visual separator in logs).
 */
scrollLog.mark = function mark(sessionId: string) {
  scrollLog('═══ SESSION-SWITCH ═══', { sessionId: sessionId.substring(0, 8) });
};

// ── Keyboard shortcut: Ctrl+Shift+D to dump logs ──
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      const text = scrollLog.dump();

      // Copy to clipboard
      navigator.clipboard.writeText(text).then(() => {
        // eslint-disable-next-line no-console
        console.log('[scroll-debug] Logs copied to clipboard!');
      }).catch(() => {});

      // Also download as file
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `scroll-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
      a.click();
      URL.revokeObjectURL(url);

      // eslint-disable-next-line no-console
      console.log(text);
    }
  });
}
