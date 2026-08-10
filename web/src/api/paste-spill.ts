/**
 * Oversized-paste spill: text too big for a WebSocket frame goes to disk over
 * HTTP, and the message carries the file path instead.
 *
 * Same reasoning as api/image-upload.ts: the WS server caps a frame at 4MB and
 * `ws` enforces the cap by CLOSING the socket (1009) before any handler runs.
 * A pasted log file easily exceeds that. Spilling keeps the socket alive AND
 * keeps the conversation lean — the agent reads the file with its Read tool
 * instead of holding megabytes in context. Remote sessions work unchanged:
 * RemoteSessionManager.prepareOutbound() ships referenced local file paths to
 * the remote host the same way it ships image paths.
 */

import { apiPost } from './client';

/**
 * Spill threshold, in characters.
 *
 * Deliberately far below the 3.5MB ws.ts frame guard: a paste this size is a
 * document, not a message — no human types 200K chars. Spilling early also
 * spares the model a bloated context (the CLI reads the file lazily instead).
 */
export const PASTE_SPILL_THRESHOLD = 200_000;

/**
 * If `text` exceeds the spill threshold, upload it to the server and return a
 * short pointer message referencing the on-disk path. Otherwise return `text`
 * unchanged. Throws if the spill upload fails (caller keeps the user's input).
 */
export async function spillOversizedText(text: string): Promise<string> {
  if (text.length <= PASTE_SPILL_THRESHOLD) return text;

  const res = await apiPost<{ path: string; chars: number }>(
    '/api/pastes',
    { text },
    { timeoutMs: 60_000 },
  );
  return (
    `[Large text attached — ${res.chars.toLocaleString()} chars, spilled to a file. `
    + `Use the Read tool to view it]\n- ${res.path}`
  );
}
