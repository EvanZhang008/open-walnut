/**
 * Cloud REPLICA: per session, the phone messages this companion relayed into
 * the Mac's queue that nobody has seen delivered yet.
 *
 * Why (gate r2, B2 and G3): the companion delivers a send by the host's direct
 * path when the host has no Mac behind it. A message relayed earlier may still
 * wait in the Mac's queue (the CLI was mid-turn, or the Mac's link to the host
 * died first), and a direct delivery would then overtake it. The Mac answers
 * that question when it can be asked (mobile-relay-ledger.ts, 'behind'); when
 * it cannot, these are the ids that may still be waiting there, and each one
 * stops counting once its delivery marker is seen on the host (the Mac's runner
 * writes one per message: send-direct-gate.ts) or the Mac says its queue holds
 * nothing earlier for the session.
 *
 * Files: cache/send-queue/relays/<sha256(session)>.json, at most MAX_IDS ids,
 * each kept SEND_HORIZON_MS (pruned with the outcomes).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SEND_QUEUE_DIR } from '../constants.js';
import { writeJsonFile } from '../utils/fs.js';
import { withFileLock } from '../utils/file-lock.js';
import { log } from '../logging/index.js';

const MAX_IDS = 200;
const HORIZON_MS = 24 * 60 * 60_000;

interface IndexFile { sessionId: string; relays: Array<[string, number]> }

function indexFile(sessionId: string): string {
  const key = createHash('sha256').update(sessionId).digest('hex');
  return path.join(SEND_QUEUE_DIR, 'relays', `${key}.json`);
}

async function read(sessionId: string): Promise<Array<[string, number]>> {
  try {
    const saved = JSON.parse(await fsp.readFile(indexFile(sessionId), 'utf-8')) as IndexFile;
    if (saved.sessionId !== sessionId || !Array.isArray(saved.relays)) return [];
    const now = Date.now();
    return saved.relays.filter(([id, at]) => typeof id === 'string' && typeof at === 'number' && now - at <= HORIZON_MS);
  } catch {
    return [];
  }
}

async function update(
  sessionId: string, fn: (relays: Array<[string, number]>) => Array<[string, number]>, strict = false,
): Promise<void> {
  const file = indexFile(sessionId);
  try {
    await withFileLock(file, async () => {
      const before = await read(sessionId);
      const after = fn(before).slice(-MAX_IDS);
      if (after.length === 0) await fsp.rm(file, { force: true });
      else await writeJsonFile(file, { sessionId, relays: after } satisfies IndexFile, { durable: true });
    });
  } catch (err) {
    log.session.warn('send-queue: could not update the relay index', { sessionId, err: String(err) });
    if (strict) throw err;
  }
}

/**
 * A relay of it goes out, or went out (answered or not): the Mac's queue may
 * hold it. `strict`: throw when it cannot be written (a relay about to go out
 * then does not).
 */
export async function noteSessionRelay(sessionId: string, messageId: string, opts: { strict?: boolean } = {}): Promise<void> {
  await update(sessionId, (relays) => [...relays.filter(([id]) => id !== messageId), [messageId, Date.now()]], opts.strict === true);
}

/** It is settled another way (direct, refused, withdrawn): it no longer waits in the Mac's queue. */
export async function settleSessionRelay(sessionId: string, messageId: string): Promise<void> {
  if ((await read(sessionId)).some(([id]) => id === messageId)) {
    await update(sessionId, (relays) => relays.filter(([id]) => id !== messageId));
  }
}

/**
 * These stop counting: seen delivered (their markers), or every one relayed
 * before `before` (ms) when the Mac said its queue holds nothing earlier.
 */
export async function confirmSessionRelays(sessionId: string, which: string[] | { before: number }): Promise<void> {
  if (Array.isArray(which) && which.length === 0) return;
  const gone = Array.isArray(which) ? new Set(which) : null;
  await update(sessionId, (relays) => relays.filter(([id, at]) => (gone ? !gone.has(id) : at >= (which as { before: number }).before)));
}

/** Relayed messages of the session nobody has seen delivered, oldest first, except `exceptId`. */
export async function unconfirmedSessionRelays(sessionId: string, exceptId?: string): Promise<string[]> {
  return (await read(sessionId)).map(([id]) => id).filter((id) => id !== exceptId);
}
