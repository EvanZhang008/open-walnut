/**
 * The one line a leader, a VP or Main gets when the user answered a thread of a task below it
 * (thread-reply.ts; 2026-11-20, the user: "also send a buffer message to the main agent ... so
 * that agent won't constantly bombarded with noisy"). It rides the leader's next message
 * (status-riding.ts, never a wake), one item per leader however many he answered: the newest
 * ANSWERED_MAX each on a line, the older ones folded into "and N more".
 */
import { log } from '../../logging/index.js';

export const ANSWERED_MAX = 20;
/** The riding item that holds them, one per session. */
export const ANSWERED_KEY = 'threads-answered';
const HEAD = 'He answered threads of tasks below you; each reply went straight to its task (nothing to forward):';
const MORE_RE = /^- and (\d+) more answered earlier\.$/;

interface Held { lines: string[]; folded: number }
const held = new Map<string, Held>();

/** What rides now, read back from its text (after a restart the riding store kept it, this map did not). */
function readBack(text: string | undefined): Held {
  const out: Held = { lines: [], folded: 0 };
  for (const line of (text ?? '').split('\n')) {
    const more = MORE_RE.exec(line);
    if (more) out.folded += Number(more[1]);
    else if (line.startsWith('- ')) out.lines.push(line);
  }
  return out;
}

export function answeredText(h: Held): string {
  return [HEAD, ...(h.folded ? [`- and ${h.folded} more answered earlier.`] : []), ...h.lines].join('\n');
}

/** One answered thread, in the line `line` ("- ..."), added to what rides `sessionId`'s next message. Never throws. */
export async function rideAnswered(sessionId: string, line: string, now = Date.now()): Promise<void> {
  try {
    const { ridingKeys, ridingLine, rideLine } = await import('../sessions/status-riding.js');
    // Told since (the item is gone): a new batch starts.
    const riding = ridingKeys(sessionId).includes(ANSWERED_KEY);
    const h = riding ? held.get(sessionId) ?? readBack(ridingLine(sessionId, ANSWERED_KEY)) : { lines: [], folded: 0 };
    h.lines.push(line.startsWith('- ') ? line : `- ${line}`);
    while (h.lines.length > ANSWERED_MAX) { h.lines.shift(); h.folded++; }
    held.set(sessionId, h);
    rideLine(sessionId, ANSWERED_KEY, answeredText(h), now);
  } catch (err) {
    log.session.warn('org threads: answered line not kept', { sessionId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Test seam. */
export function _clearAnsweredForTest(): void { held.clear(); }
