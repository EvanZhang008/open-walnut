import { log } from '../logging/index.js';

/** A first paint is not a history refresh: never wait for a multi-MB read or older turns. */
export const HISTORY_OPEN_PREVIEW_BYTES = 128 * 1024;
export const HISTORY_OPEN_PREVIEW_MS = 3_000;
/** The first screen is followed by the ordinary ten-turn refresh. */
export const HISTORY_OPEN_SCREEN_ROWS = 40;

/** Keep a small readable screen even when the newest tail contains only notices. */
export function historyOpenScreen<T>(rows: readonly T[], readable: (row: T) => boolean): T[] {
  const start = Math.max(0, rows.length - HISTORY_OPEN_SCREEN_ROWS);
  if (rows.slice(start).some(readable)) return rows.slice(start);
  for (let i = start - 1; i >= 0; i--) {
    if (readable(rows[i])) return rows.slice(Math.max(0, i + 1 - HISTORY_OPEN_SCREEN_ROWS));
  }
  return rows.slice(start);
}

/** A late read cannot update the response or its cursor; cache readers retain the most complete fresh entry. */
export async function boundHistoryPreview<T>(
  sessionId: string,
  read: () => Promise<T | null>,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), HISTORY_OPEN_PREVIEW_MS); });
  try {
    return await Promise.race([read().catch((error: unknown) => {
      log.web.debug('history open preview unavailable', { sessionId, error: String(error) });
      return null;
    }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
