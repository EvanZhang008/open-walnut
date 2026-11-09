/**
 * Oversized-paste spill: text too big for a WebSocket frame goes to disk over
 * HTTP, and the message carries the file path instead.
 *
 * Same reasoning as api/image-upload.ts: the WS server caps a frame at 4MB and
 * `ws` enforces the cap by CLOSING the socket (1009) before any handler runs.
 * A pasted log file easily exceeds that. Spilling keeps the socket alive AND
 * keeps the conversation lean — the agent reads the file with its Read tool
 * instead of holding megabytes in context. A session on another host gets the
 * file too: RemoteSessionManager.prepareOutbound() ships Walnut's own files
 * named on a `- <path>` line there first (src/providers/outbound-uploads.ts).
 */

import { attachmentParts, withFilePaths } from './file-upload';
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

  // Attached files stay in front, in the message itself: the server finds them
  // there (to copy them to a remote session's host), never inside the spilled file.
  const parts = attachmentParts(text);
  const files = parts?.files ?? [];
  const body = files.length > 0 && parts ? parts.body : text;
  if (body.length <= PASTE_SPILL_THRESHOLD) return text;
  const res = await apiPost<{ path: string; chars: number }>(
    '/api/pastes',
    { text: body },
    { timeoutMs: 60_000 },
  );
  return withFilePaths(
    `[Large text attached — ${res.chars.toLocaleString()} chars, spilled to a file. `
    + `Use the Read tool to view it]\n- ${res.path}`,
    files,
  );
}
