import { log } from '../logging/index.js';

/** A first paint is not a history refresh: never wait for a multi-MB read or older turns. */
export const HISTORY_OPEN_PREVIEW_BYTES = 128 * 1024;
export const HISTORY_OPEN_PREVIEW_MS = 3_000;

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
