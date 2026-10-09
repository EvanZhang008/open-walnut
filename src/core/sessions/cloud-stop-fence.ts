/**
 * Cloud REPLICA: has a stop overtaken a phone message the companion holds?
 *
 * The primary owns stops (session-stop.ts): every message carries the stop
 * fence it was sent under (the id of the latest stop then), and the primary's
 * queue refuses one whose fence is not its latest stop ("predates the latest
 * stop"). A message the companion delivers ITSELF, by the host's direct path
 * (direct-host-send.ts), never passes the primary, so the companion applies the
 * same rule at delivery time, from the two things it knows:
 *
 *  - the stop the primary last reported for the session (its projected
 *    `stopRequest`): a pending one, or a different id than the message's fence,
 *    means the message predates it;
 *  - a stop the phone asked for THROUGH this companion, recorded here when it
 *    was asked, which the projection may not carry yet (the primary exports it
 *    on its own schedule, up to seconds later). A message accepted before that
 *    ask predates it. When the primary answers the stop it names the stop it
 *    recorded, and that is kept here too: a message sent after the user saw the
 *    stop finish carries THAT stop as its fence, so the primary takes it. (It
 *    used to carry the projection's older stop, and every new message was
 *    refused as predating the stop for the 3 to 6 s the projection lagged.)
 *
 * A stop asked here whose answer was lost (the relay went out, then timed out
 * or its socket dropped) may still have landed. Until a stop recorded since the
 * ask shows up, or the phone's next stop is answered, no message goes by the
 * host's direct path (stopAskUnconfirmed, send-direct-gate.ts): only the
 * primary, which applies its own fence, may deliver one. (A send after such a
 * stop used to go directly to the host and run past it.) The hold is capped at
 * NOTE_MAX_AGE_MS (24 h, the bank's own horizon): every message it could hold
 * back has expired by then, so an ask nothing ever answers stops counting.
 *
 * A stop that provably never left (no bridge socket to the Mac: the Mac off
 * the companion) or that the primary provably did not record (it refused it,
 * or no primary was behind the daemon) closes the ask at once
 * (session-stop-v1.ts clearStopNote): nothing can have landed, and holding
 * every later send of the session for a day would be the bug (gate r3, N3).
 *
 * Files: cache/send-queue/stops/<sha256(sessionId)>.json (NON-git).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SEND_QUEUE_DIR } from '../../constants.js';
import { writeJsonFile } from '../../utils/fs.js';
import { log } from '../../logging/index.js';

/** A stop the primary reported for a session (the projection row's field). */
export interface ProjectedStop {
  id: string;
  state: string;
  /** When the primary recorded it (its own clock, ISO). */
  requestedAt?: string;
}

/**
 * The newer of two reports of a session's stop. One stop seen twice: its
 * confirmed copy (a stop only moves from pending to confirmed). Two stops: the
 * later one, by the primary's own clock (both reports come from it).
 */
export function newerStop(a: ProjectedStop | null | undefined, b: ProjectedStop | null | undefined): ProjectedStop | null {
  if (!a) return b ?? null;
  if (!b) return a;
  if (a.id === b.id) return a.state === 'confirmed' ? a : b;
  const ta = Date.parse(a.requestedAt ?? '');
  const tb = Date.parse(b.requestedAt ?? '');
  if (!Number.isFinite(ta)) return b;
  if (!Number.isFinite(tb)) return a;
  return tb > ta ? b : a;
}

function asStop(v: unknown): ProjectedStop | null {
  const s = v as { id?: unknown; state?: unknown; requestedAt?: unknown } | null | undefined;
  if (!s || typeof s.id !== 'string' || !s.id) return null;
  return { id: s.id, state: String(s.state ?? ''), ...(typeof s.requestedAt === 'string' ? { requestedAt: s.requestedAt } : {}) };
}

/** Older than the bank's own horizon: every message it could hold back has expired. */
const NOTE_MAX_AGE_MS = 24 * 60 * 60_000;

function noteFile(sessionId: string): string {
  const key = createHash('sha256').update(sessionId).digest('hex');
  return path.join(SEND_QUEUE_DIR, 'stops', `${key}.json`);
}

interface StopNote {
  at: number | null;
  stop: ProjectedStop | null;
  /** The ask is unanswered: the latest stop known when it was made (null = none). */
  asking: { before: string | null } | null;
}

/**
 * The note: when the phone last asked here (`at`, while it can still hold a
 * message back), and the latest stop the primary answered here (`stop`, kept
 * across later asks until a newer answer replaces it).
 */
async function readNote(sessionId: string): Promise<StopNote | null> {
  try {
    const saved = JSON.parse(await fsp.readFile(noteFile(sessionId), 'utf-8')) as { sessionId?: string; at?: unknown; stop?: unknown; asking?: unknown };
    if (saved.sessionId !== sessionId) return null;
    const at = typeof saved.at === 'number' && Date.now() - saved.at <= NOTE_MAX_AGE_MS ? saved.at : null;
    const asking = saved.asking && typeof saved.asking === 'object'
      ? { before: typeof (saved.asking as { before?: unknown }).before === 'string' ? (saved.asking as { before: string }).before : null }
      : null;
    return { at, stop: asStop(saved.stop), asking };
  } catch {
    return null;
  }
}

async function writeNote(sessionId: string, note: { at?: number; stop?: ProjectedStop | null; asking?: { before: string | null } }): Promise<void> {
  await writeJsonFile(noteFile(sessionId), {
    sessionId, ...(typeof note.at === 'number' ? { at: note.at } : {}), ...(note.stop ? { stop: note.stop } : {}),
    ...(note.asking ? { asking: note.asking } : {}),
  }, { durable: true });
}

/** Record that the phone asked this companion to stop the session (before relaying it). */
export async function noteStopRequested(sessionId: string, at: number = Date.now()): Promise<number> {
  try {
    const stop = (await readNote(sessionId))?.stop ?? null;
    const before = newerStop((await projectedStops()).get(sessionId) ?? null, stop)?.id ?? null;
    // Open until the primary answers (noteStopAnswered / clearStopNote write no `asking`).
    await writeNote(sessionId, { at, stop, asking: { before } });
  } catch (err) {
    log.session.warn('cloud-stop-fence: could not record a stop request', { sessionId, err: String(err) });
  }
  return at;
}

/** The primary refused the stop, so none was recorded: forget the ask, if it is still this one. */
export async function clearStopNote(sessionId: string, at: number): Promise<void> {
  try {
    const note = await readNote(sessionId);
    if (note?.at !== at) return;
    if (note.stop) await writeNote(sessionId, { stop: note.stop });
    else await fsp.rm(noteFile(sessionId), { force: true });
  } catch { /* nothing to clear */ }
}

/**
 * The primary answered a stop asked for here, naming the stop it recorded: keep
 * it (only while the note is still this ask's).
 */
export async function noteStopAnswered(sessionId: string, at: number, stop: unknown): Promise<void> {
  const recorded = asStop(stop);
  if (!recorded) return;
  try {
    const note = await readNote(sessionId);
    if (note?.at !== at) return;
    await writeNote(sessionId, { at, stop: newerStop(note.stop, recorded) });
  } catch (err) {
    log.session.warn('cloud-stop-fence: could not record the stop the primary answered', { sessionId, err: String(err) });
  }
}

/**
 * The Mac answered a withdraw with 'stopped' and named the stop that parked the
 * message: keep it as the session's latest known stop (stopSupersedes and the
 * next send's fence read it). The phone's own ask, if one is open, is left as
 * it is; a stop recorded since answers it the same way the list's would.
 */
export async function noteMacStop(sessionId: string, stop: unknown): Promise<void> {
  const recorded = asStop(stop);
  if (!recorded) return;
  try {
    const note = await readNote(sessionId);
    const next = newerStop(note?.stop ?? null, recorded);
    if (note?.stop && next === note.stop) return;
    await writeNote(sessionId, { ...(note?.at != null ? { at: note.at } : {}), stop: next, ...(note?.asking ? { asking: note.asking } : {}) });
  } catch (err) {
    log.session.warn('cloud-stop-fence: could not record a stop the Mac named', { sessionId, err: String(err) });
  }
}

/**
 * The session's latest stop as this companion knows it: the primary's list, or
 * the stop the primary answered when the phone asked here, whichever is newer.
 * A new message is fenced by this one.
 */
export async function latestKnownStop(sessionId: string, projected: unknown): Promise<ProjectedStop | null> {
  return newerStop(asStop(projected), (await readNote(sessionId))?.stop ?? null);
}

/**
 * Is a stop the phone asked for here still unanswered, with no stop recorded
 * since? Then a message must not go by the host's direct path: the stop may
 * have landed on the primary, which alone can tell. `projected` is the
 * session's listed stop when the caller has it (else the list is read, only
 * when an ask is open).
 */
export async function stopAskUnconfirmed(sessionId: string, projected?: unknown): Promise<boolean> {
  const note = await readNote(sessionId);
  if (!note?.asking || note.at === null) return false;
  const listed = projected !== undefined ? asStop(projected) : (await projectedStops()).get(sessionId) ?? null;
  const latest = newerStop(listed, note.stop);
  // A stop recorded since the ask (this one, or a later one) answers it.
  return !(latest && latest.id !== note.asking.before && latest.state !== 'pending');
}

/**
 * The stops the primary last reported, by session id. Read ONCE per sweep pass
 * (the projection is one file for every session; a read per row would parse it
 * once per held message). `null` = the session is on the list with no stop.
 */
export async function projectedStops(): Promise<Map<string, ProjectedStop | null>> {
  const out = new Map<string, ProjectedStop | null>();
  try {
    const { readSessionProjection } = await import('../session-projection.js');
    for (const row of (await readSessionProjection())?.sessions ?? []) {
      out.set(row.id, asStop(row.stopRequest));
    }
  } catch { /* nothing known from the projection */ }
  return out;
}

/**
 * Has a stop the companion knows of overtaken a message sent under `stopFence`
 * and accepted at `acceptedAt`? Returns the sentence the phone is told, or null.
 * `stops` is a pass's projectedStops(); omit it for a fresh read (the route's
 * single delivery).
 */
export async function stopSupersedes(
  sessionId: string, stopFence: string | null, acceptedAt: number,
  stops?: Map<string, ProjectedStop | null>,
): Promise<string | null> {
  const known = stops ?? await projectedStops();
  const note = await readNote(sessionId);
  if (known.has(sessionId) || note?.stop) {
    // The newer of the list's stop and the one the primary answered here: the
    // list lags, so a message fenced by a stop it does not show yet is current.
    const stop = newerStop(known.get(sessionId) ?? null, note?.stop ?? null);
    if (stop?.state === 'pending' || (stop?.id ?? null) !== stopFence) return STOPPED_AFTER_SEND;
  }
  const notedAt = note?.at ?? null;
  return notedAt !== null && notedAt >= acceptedAt ? STOP_ASKED_AFTER_SEND : null;
}

/** The phone's sentence for a message a stop overtook. */
export const STOPPED_AFTER_SEND = 'Not sent: the session was stopped after you sent this.';
/** The same, when only this companion knows of the stop (the phone asked for it here). */
export const STOP_ASKED_AFTER_SEND = 'Not sent: you asked to stop the session after sending this.';
