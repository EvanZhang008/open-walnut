/**
 * Boot-cached server identity for crash/bug reports.
 *
 * Fetched once at boot (fire-and-forget) and mirrored to localStorage so a
 * crash report can still name the server version when the server is DOWN at
 * crash time (the localStorage copy is from the last healthy boot).
 */

interface ServerStatus {
  mode?: string;
  cloud?: boolean;
  version?: string;
  serverTime?: string;
}

const LS_KEY = 'walnut.serverStatus';

let cached: ServerStatus | null = null;

/** Fire-and-forget: probe /api/v1/status and cache the result. Never throws. */
export function initAppInfo(): void {
  try {
    void fetch('/api/v1/status', { signal: AbortSignal.timeout(5000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ServerStatus | null) => {
        if (!data || typeof data !== 'object') return;
        cached = data;
        try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch { /* quota */ }
      })
      .catch(() => { /* offline — keep last boot's localStorage copy */ });
  } catch { /* fetch unavailable — ignore */ }
}

/** Server status from this boot, or the last healthy boot's copy, or null. */
export function getAppInfo(): ServerStatus | null {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as ServerStatus;
    }
  } catch { /* corrupt — ignore */ }
  return null;
}
