/**
 * The line that broke the reply language in a session's last turn, kept in memory so the next
 * message's correction can quote it (hint-registry.ts `reply-language`). 2026-11-14: a VP read the
 * bare correction as a false positive and kept answering in English; quoting the line lets the
 * session see for itself. Lost on a restart: the correction then goes out without it.
 */
const QUOTE_MAX = 160;
const SESSIONS_MAX = 300;
const lines = new Map<string, string>();

/** One line, cut at QUOTE_MAX. */
export function quoteLine(line: string): string {
  const one = line.replace(/\s+/g, ' ').trim();
  return one.length > QUOTE_MAX ? `${one.slice(0, QUOTE_MAX - 1)}…` : one;
}

export function noteOffLine(sessionId: string, line: string): void {
  lines.delete(sessionId);
  if (lines.size >= SESSIONS_MAX) lines.delete(lines.keys().next().value as string);
  lines.set(sessionId, quoteLine(line));
}

export function offLineOf(sessionId: string | undefined): string | undefined {
  return sessionId ? lines.get(sessionId) : undefined;
}

export function clearOffLine(sessionId: string): void { lines.delete(sessionId); }

/** Tests: forget every line. */
export function _resetOffLinesForTesting(): void { lines.clear(); }
