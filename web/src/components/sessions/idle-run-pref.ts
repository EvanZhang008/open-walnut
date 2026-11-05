/**
 * Sessions whose reader closed an idle compaction's run (SessionMessage SystemGroupRun): that run opens
 * by itself to why it ran, and once the reader closed one in a session, the session's runs start closed,
 * across a reload too (2026-11-04 review: a closed run came back open after a reload).
 */
const KEY = 'walnut.idle-compact-runs-closed';
const MAX = 200;

function read(): string[] {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function idleRunsClosed(sessionId: string | null | undefined): boolean {
  return !!sessionId && read().includes(sessionId);
}

export function noteIdleRunsClosed(sessionId: string | null | undefined, closed: boolean): void {
  if (!sessionId) return;
  const ids = read().filter((id) => id !== sessionId);
  if (closed) ids.push(sessionId);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(ids.slice(-MAX)));
  } catch {
    // A full or blocked storage keeps only this page's state.
  }
}
