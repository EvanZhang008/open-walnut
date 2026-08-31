/**
 * Staged letter bodies — the "bytes arrive separately from the letter" lane.
 *
 * A 100MB HTML body (a digest with an inline podcast, a clip) must never be a
 * string inside a JSON request: the parser would hold it twice, and every hop
 * that frames JSON has a size at which it stops being a size error and becomes
 * a dropped connection. So the bytes go up FIRST, streamed straight to a file
 * under `human-inbox/staging/`, and the letter that follows carries only a ref.
 *
 * Two producers use this:
 *   - `POST /api/v1/human-inbox/body` — a browser or a hub-local CLI streams the
 *     document as a raw request body.
 *   - the agent gateway — the hub pulls a sender-side `argsFile` back from that
 *     host's daemon in bounded chunks and stages what it reassembles.
 *
 * A ref is deliberately NOT a path: it is matched against STAGED_REF_RE before
 * it is ever joined onto a directory, because it arrives from a caller. Refs are
 * single-use (taking one moves the file) and orphans are swept, so an upload
 * that never became a letter costs a few minutes of disk instead of forever.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';

const STAGING_DIR = path.join(WALNUT_HOME, 'human-inbox', 'staging');

/** `sb-<base36 time>-<hex>` — the only shape allowed near a path join. */
export const STAGED_REF_RE = /^sb-[0-9a-z]{6,12}-[0-9a-f]{8,16}$/;

/** An upload that never became a letter is junk after this long. */
export const STAGED_BODY_TTL_MS = 30 * 60 * 1000;

export class StagedBodyError extends Error {
  constructor(message: string, readonly code: 'invalid' | 'not_found' | 'too_large', readonly status: number) {
    super(message);
    this.name = 'StagedBodyError';
  }
}

export const stagingPaths = { dir: STAGING_DIR };

function newRef(): string {
  return `sb-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

/** Ref → absolute path, only after the shape check. Throws on anything else. */
export function stagedBodyPath(ref: string): string {
  if (typeof ref !== 'string' || !STAGED_REF_RE.test(ref)) {
    throw new StagedBodyError(`not a staged body ref: ${JSON.stringify(ref)}`, 'invalid', 400);
  }
  return path.join(STAGING_DIR, ref);
}

/**
 * Stream a document to staging without ever holding it whole.
 *
 * `maxBytes` is enforced as the bytes go past rather than from Content-Length: a
 * sender can lie about the header, and the point of this lane is that nothing
 * upstream had to count first. Over the limit, the partial file is removed.
 */
export async function stageBodyFromStream(
  source: Readable,
  maxBytes: number,
): Promise<{ ref: string; bytes: number }> {
  await fsp.mkdir(STAGING_DIR, { recursive: true });
  const ref = newRef();
  const target = path.join(STAGING_DIR, ref);
  let bytes = 0;
  let overflow = false;
  source.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > maxBytes && !overflow) {
      overflow = true;
      source.destroy(new StagedBodyError(
        `body is over the ${maxBytes}-byte letter cap`, 'too_large', 413,
      ));
    }
  });
  try {
    await pipeline(source, createWriteStream(target));
  } catch (err) {
    await fsp.rm(target, { force: true }).catch(() => {});
    if (err instanceof StagedBodyError) throw err;
    if (overflow) {
      throw new StagedBodyError(`body is over the ${maxBytes}-byte letter cap`, 'too_large', 413);
    }
    throw err;
  }
  return { ref, bytes };
}

/** Same lane for a body the hub already reassembled in memory (gateway pull). */
export async function stageBodyFromBuffer(buf: Buffer): Promise<{ ref: string; bytes: number }> {
  await fsp.mkdir(STAGING_DIR, { recursive: true });
  const ref = newRef();
  await fsp.writeFile(path.join(STAGING_DIR, ref), buf);
  return { ref, bytes: buf.length };
}

/** Size of a staged body, for the cap check before a letter is created. */
export async function statStagedBody(ref: string): Promise<{ path: string; bytes: number }> {
  const p = stagedBodyPath(ref);
  try {
    const st = await fsp.stat(p);
    if (!st.isFile()) throw new Error('not a file');
    return { path: p, bytes: st.size };
  } catch {
    throw new StagedBodyError(
      `staged body ${ref} is gone — upload it again (staged uploads expire after ${Math.round(STAGED_BODY_TTL_MS / 60000)} minutes)`,
      'not_found', 404,
    );
  }
}

/**
 * Move a staged body to its final home. A rename when they share a filesystem,
 * a copy when they don't (EXDEV — staging and bodies are both under WALNUT_HOME
 * today, but a bind-mounted data dir would break a rename-only version).
 */
export async function takeStagedBody(ref: string, destPath: string): Promise<number> {
  const { path: src, bytes } = await statStagedBody(ref);
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  try {
    await fsp.rename(src, destPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fsp.copyFile(src, destPath);
    await fsp.rm(src, { force: true }).catch(() => {});
  }
  return bytes;
}

/** Drop a staged body a caller decided not to use. */
export async function discardStagedBody(ref: string): Promise<void> {
  try {
    await fsp.rm(stagedBodyPath(ref), { force: true });
  } catch { /* an invalid ref has nothing to drop */ }
}

/** Reap uploads that never became letters. Safe to call on any schedule. */
export async function sweepStagedBodies(now = Date.now(), ttlMs = STAGED_BODY_TTL_MS): Promise<number> {
  let names: string[];
  try {
    names = await fsp.readdir(STAGING_DIR);
  } catch {
    return 0;
  }
  let swept = 0;
  for (const name of names) {
    if (!STAGED_REF_RE.test(name)) continue;
    try {
      const st = await fsp.stat(path.join(STAGING_DIR, name));
      if (now - st.mtimeMs < ttlMs) continue;
      await fsp.rm(path.join(STAGING_DIR, name), { force: true });
      swept += 1;
    } catch { /* raced with a take */ }
  }
  if (swept > 0) log.notif.info('human-inbox: swept staged bodies', { swept });
  return swept;
}
