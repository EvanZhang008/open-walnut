/**
 * A queue row as the queue card shows it (the phone's card, the web's waiting
 * bubbles): where the message is on its way, and what the person attached.
 *
 * 2026-11-06, the user's phone: a message sat as "Delivering…" for many seconds
 * after it reached the agent, a picture showed as the header text Walnut writes
 * for the CLI, and the count kept growing. A row stays in the queue after the
 * CLI took its line, until the model answers it (line-answer-v1,
 * providers/line-consumption.ts), so "in the queue" never meant "not delivered".
 *
 * `stage`:
 *   waiting  not written to the CLI yet (pending, held, parked, after the turn);
 *   written  written to the CLI's stdin, which reads it after its current step;
 *   taken    the CLI read it (the line is in its transcript); only the answer is
 *            still to come. `delivered` is true exactly then.
 * `written` when the runner holds the row's line as written into the CLI's
 * stdin (line-consumption.ts awaitedRowIds), or as a cold resume's first line
 * that the new process reads once it has booted (resumeLineRowIds): that line is
 * reported delivered at the spawn, and a stage of `waiting` there made the web
 * and the phone flip the bubble back to Queued for those seconds (2026-11-11,
 * the user: "the new conversation take like 7 second to even get the message
 * delivered"). A row the runner cannot vouch for (an idle session, a resume
 * still spawning, an engine whose lines it does not track, a row mid-delivery)
 * reads `waiting`, whatever its queue status.
 */
import path from 'node:path';
import { splitAttachmentHeaders } from '../../lib/attachment-headers.js';
import { withoutLeadingRiders } from '../../lib/history-walnut-riders.js';
import { displayQueueRow } from './reference-cards.js';

/** Every stage, in order. The phone's QueueStage enum names the same (a test compares them). */
export const QUEUE_STAGES = ['waiting', 'written', 'taken'] as const;
export type QueueStage = typeof QUEUE_STAGES[number];
export interface QueueRowImage { path: string; url: string }
export interface QueueRowFile { path: string; name: string }

// A type, not an interface: a row with these facts still reads as a plain record (Record<string, unknown>).
export type QueueRowFacts = {
  stage: QueueStage;
  delivered: boolean;
  images?: QueueRowImage[];
  files?: QueueRowFile[];
};

/** The URL path every client GETs a session picture from (routes/media-v1.ts, the phone's mediaURL). */
export function queueImageUrl(imagePath: string, sessionId: string): string {
  const session = sessionId ? `&session=${encodeURIComponent(sessionId)}` : '';
  return `/api/v1/media?path=${encodeURIComponent(imagePath)}${session}`;
}

/**
 * What the runner knows of a session's lines, in memory: the rows whose line the
 * CLI took (`taken`), the rows whose line is in its stdin waiting to be read
 * (`awaited`), and the rows held back behind a line still being confirmed
 * (`held`: processing in the queue, but never written).
 */
export interface LiveLineWords {
  taken: ReadonlySet<string>; awaited: ReadonlySet<string>; held: ReadonlySet<string>;
  /** A cold resume's first line, in its new process's stdin until it boots (resumeLineRowIds). Absent: none. */
  resume?: ReadonlySet<string>;
}

export const NO_LINE_WORDS: LiveLineWords = { taken: new Set(), awaited: new Set(), held: new Set(), resume: new Set() };

export function queueStageOf(row: { id: string; status?: string }, live: LiveLineWords): QueueStage {
  if (live.taken.has(row.id)) return 'taken';
  if (live.held.has(row.id)) return 'waiting';
  // Written when the runner holds its line as in the CLI's stdin.
  if (live.awaited.has(row.id)) return 'written';
  // A cold resume's first line: the spawn carried it (and reported it delivered); the new
  // process reads it once it has loaded the session.
  return row.status === 'processing' && live.resume?.has(row.id) ? 'written' : 'waiting';
}

/**
 * The runner's word on this session's rows (memory only, never a read of disk or a
 * host). Read it AFTER the queue rows it describes. A row taken AND answered between
 * the two reads is still in those rows but no longer in either map, so for one read
 * it shows `waiting` (or `written`, had it only been written meanwhile) though it is
 * done; the next read no longer lists it.
 */
export async function liveLineWordsOf(sessionId: string): Promise<LiveLineWords> {
  const { takenRowIds, awaitedRowIds, heldRows, resumeLineRowIds } = await import('../../providers/line-consumption.js');
  return {
    taken: takenRowIds(sessionId), awaited: awaitedRowIds(sessionId), held: new Set(heldRows(sessionId)?.keys() ?? []),
    resume: resumeLineRowIds(sessionId),
  };
}

/** What the person attached, read off the row's own words (after Walnut's notices in front). */
function attachmentsOf(words: string, sessionId: string): { text: string; images: QueueRowImage[]; files: QueueRowFile[] } {
  const split = splitAttachmentHeaders(withoutLeadingRiders(words));
  return {
    text: split.text,
    images: split.images.map((p) => ({ path: p, url: queueImageUrl(p, sessionId) })),
    files: split.files.map((p) => ({ path: p, name: path.basename(p) })),
  };
}

/** The stage and attachments of a row whose shown words (displayQueueRow) are `shownWords`. */
function factsOf(row: { id: string; status?: string }, shownWords: string | undefined, sessionId: string, live: LiveLineWords): QueueRowFacts {
  const stage = queueStageOf(row, live);
  const { images, files } = typeof shownWords === 'string' ? attachmentsOf(shownWords, sessionId) : { images: [], files: [] };
  return {
    stage,
    delivered: stage === 'taken',
    ...(images.length ? { images } : {}),
    ...(files.length ? { files } : {}),
  };
}

/**
 * The stage and attachments of a row, added to whatever form of the row a reader
 * keeps (the web's WS read keeps the composed text, which its bubbles strip
 * themselves and its edits rewrite).
 */
export function queueRowFacts(
  row: { id: string; status?: string; message: string },
  sessionId: string,
  live: LiveLineWords,
): QueueRowFacts {
  return factsOf(row, typeof row.message === 'string' ? displayQueueRow(row).message : undefined, sessionId, live);
}

/**
 * The row for the v1 queue read (the phone, the companion). `message` keeps its
 * frozen meaning (the text without hint blocks and reference cards, as before
 * 2026-11-06): an older phone resends it as it is (Undo), so it must still carry
 * the pictures' header. `words` is only what the person typed (no attachment
 * headers, no Walnut notices in front); `images`/`files` name what it carries.
 * An edit with `words` alone keeps the row's headers and notices (editMessage).
 */
export function queueRowView<T extends { id: string; status?: string; message: string }>(
  row: T,
  sessionId: string,
  live: LiveLineWords,
): T & QueueRowFacts & { rawMessage?: string; words?: string } {
  if (typeof row.message !== 'string') return { ...row, ...factsOf(row, undefined, sessionId, live) };
  const shown = displayQueueRow(row);
  const { text: words } = attachmentsOf(shown.message, sessionId);
  return { ...shown, words, ...factsOf(row, shown.message, sessionId, live) };
}
