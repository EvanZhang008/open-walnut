/**
 * Cloud REPLICA: the pictures of a phone send.
 *
 * A picture reaches the CLI as a file on the SESSION'S HOST, saved through the
 * narrow bridge-allowlisted `image.save` daemon command (mediaType allowlist +
 * size cap + a fixed daemon-owned dir, deliberately NOT fs.write), and the
 * message text names the files, exactly like the primary-box path does.
 *
 * A send whose host cannot take the pictures right now is held like any other
 * (send-queue.ts): its pictures wait here, one base64 file each (no JSON
 * around 14 MB of text: a held row's list is read on every send), and are
 * saved on the host when the row drains. Before, an image send could not be
 * held at all: it failed after the save's 30 s timeout, or waited out the 45 s
 * relay, while every text send around it was held within seconds.
 *
 * Files: cache/send-queue/images/<opId>-<n>.b64 (NON-git).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { SEND_QUEUE_DIR } from '../../constants.js';
import { log } from '../../logging/index.js';
import { hostDisplayName } from '../hosts/host-display-name.js';

export interface SessionImage { data: string; mediaType: string }

/** The pictures could not be saved for a reason a retry will not fix. */
export class CloudImageError extends Error {
  constructor(public code: 'images_need_daemon_upgrade' | 'image_upload_failed', message: string) { super(message); }
}

/** Per picture: up to ~14 MB of base64 over the bridge WS. */
const IMAGE_SAVE_TIMEOUT_MS = 30_000;

/**
 * Save each picture on the host. Throws CloudImageError with a precise code
 * (never silently drops one); a transport failure (no bridge, a timeout, the
 * bridge going away) propagates as it is, and is the kind a held send waits out.
 */
export async function saveImagesViaBridge(host: string, sessionId: string, images: SessionImage[], label?: unknown): Promise<string[]> {
  const { bridgeRequest } = await import('../../web/ws/bridge-registry.js');
  const savedPaths: string[] = [];
  for (const img of images) {
    const saved = await bridgeRequest(host, 'image.save', { data: img.data, mediaType: img.mediaType }, IMAGE_SAVE_TIMEOUT_MS);
    if (saved.ok === true && typeof saved.path === 'string') {
      savedPaths.push(saved.path);
      continue;
    }
    const reason = String(saved.error ?? 'unknown');
    if (reason.startsWith('unknown command')) {
      throw new CloudImageError('images_need_daemon_upgrade',
        "This host's daemon predates image support. It upgrades on its own the next time your Mac connects to it.");
    }
    throw new CloudImageError('image_upload_failed', `${hostDisplayName(host, label)} couldn't save the picture (${reason}).`);
  }
  log.web.info('mobile session images saved via bridge', { sessionId, host, count: savedPaths.length });
  return savedPaths;
}

/**
 * The first line of a message with pictures: byte for byte the primary box's
 * own format (the CLI is told to read the files), the dash written as an escape.
 */
export const IMAGES_ATTACHED_LINE = '[Images attached \u2014 use the Read tool to view them]';

/** The message text naming the saved files (the primary box's own format). */
export function withImagePaths(text: string, savedPaths: string[]): string {
  const pathList = savedPaths.map((p) => `- ${p}`).join('\n');
  return `${IMAGES_ATTACHED_LINE}\n${pathList}\n\n${text}`;
}

/**
 * Sends held while the route's own save of their pictures is still out (a slow
 * link): the drain leaves them be, so the pictures are not sent twice; the
 * save's end hands the row its files (send-queue.ts adoptSavedImages).
 */
const savesInFlight = new Set<string>();

export function noteImageSaveInFlight(messageId: string): () => void {
  savesInFlight.add(messageId);
  return () => { savesInFlight.delete(messageId); };
}

export function imageSaveInFlight(messageId: string): boolean {
  return savesInFlight.has(messageId);
}

const IMAGES_DIR = (): string => path.join(SEND_QUEUE_DIR, 'images');
const imageFile = (opId: string, n: number): string => path.join(IMAGES_DIR(), `${opId}-${n}.b64`);

/**
 * All held pictures together stay under this (a companion is a small box; a
 * send is up to 5 pictures of ~14 MB of base64). Past it a picture send is not
 * held: the phone gets the honest 503 and retries on its own ladder.
 */
const MAX_HELD_IMAGE_BYTES = 256 * 1024 * 1024;

async function heldImageBytes(): Promise<number> {
  let total = 0;
  for (const name of await fsp.readdir(IMAGES_DIR()).catch(() => [] as string[])) {
    total += (await fsp.stat(path.join(IMAGES_DIR(), name)).catch(() => null))?.size ?? 0;
  }
  return total;
}

/** Keep a held send's pictures. Returns false when they could not all be written (nothing is kept then). */
export async function storeHeldImages(opId: string, images: SessionImage[]): Promise<boolean> {
  try {
    const adding = images.reduce((sum, img) => sum + img.data.length, 0);
    if (await heldImageBytes() + adding > MAX_HELD_IMAGE_BYTES) {
      log.session.warn('cloud-images: not holding a picture send, the held pictures are at their cap', { opId, adding });
      return false;
    }
    await fsp.mkdir(IMAGES_DIR(), { recursive: true });
    for (const [n, img] of images.entries()) await fsp.writeFile(imageFile(opId, n), img.data, 'utf8');
    return true;
  } catch (err) {
    log.session.error('cloud-images: could not keep a held send\'s pictures', { opId, err: String(err) });
    await removeHeldImages(opId, images.length);
    return false;
  }
}

/** A held send's pictures, or null when any is gone (the send cannot go as it was sent). */
export async function readHeldImages(opId: string, mediaTypes: string[]): Promise<SessionImage[] | null> {
  try {
    const out: SessionImage[] = [];
    for (const [n, mediaType] of mediaTypes.entries()) out.push({ data: await fsp.readFile(imageFile(opId, n), 'utf8'), mediaType });
    return out;
  } catch {
    return null;
  }
}

export async function removeHeldImages(opId: string, count: number): Promise<void> {
  for (let n = 0; n < count; n++) await fsp.rm(imageFile(opId, n), { force: true }).catch(() => {});
}
