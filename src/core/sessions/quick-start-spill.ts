import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { QUICK_START_MESSAGE_SPILL_LIMIT } from '../../constants.js';

/**
 * Spill files live in /tmp (not os.tmpdir()) so the path is identical on
 * macOS and Linux. For remote sessions, the file is uploaded to the same
 * path on the remote host — using /var/folders/... (mac) would not resolve
 * on a Linux remote.
 */
const SPILL_DIR = '/tmp';

export interface SpillResult {
  /** Local path where the full message was saved */
  filePath: string;
  /** Rewritten prompt that references the file */
  promptWithPointer: string;
  /** Original message length in characters */
  originalLength: number;
}

/**
 * If a Quick Start message exceeds the inline limit, save the full content
 * to a temp file and return a short pointer prompt for the session.
 *
 * Returns null if the message is within the inline limit (no spill needed).
 */
export function spillLargePromptToFile(message: string): SpillResult | null {
  if (message.length <= QUICK_START_MESSAGE_SPILL_LIMIT) return null;

  const timestamp = Date.now();
  const rand = crypto.randomBytes(4).toString('hex');
  const fileName = `walnut-quick-start-${timestamp}-${rand}.md`;
  const filePath = path.join(SPILL_DIR, fileName);

  fs.mkdirSync(SPILL_DIR, { recursive: true });
  // 0o600: Quick Start pastes may contain sensitive content (stack traces, tokens,
  // logs). The file lives in a shared /tmp so restrict reads to the owning user.
  fs.writeFileSync(filePath, message, { encoding: 'utf-8', mode: 0o600 });

  // Build a pointer prompt with a head preview so Claude has immediate context
  const previewLength = 500;
  const preview = message.length > previewLength
    ? message.slice(0, previewLength) + '\u2026'
    : message;

  const promptWithPointer = [
    `User's full context has been saved to: ${filePath}`,
    `(${message.length.toLocaleString()} chars). Read it with the Read tool first, then proceed with the user's request.`,
    '',
    '\u2500\u2500\u2500 HEAD PREVIEW \u2500\u2500\u2500',
    preview,
  ].join('\n');

  return { filePath, promptWithPointer, originalLength: message.length };
}
