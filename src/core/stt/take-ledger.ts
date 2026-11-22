/**
 * What the two ways of hearing a take while it records share: the phone's
 * (live-transcript.ts) and the web recorder's (take-ahead.ts).
 *
 *  - The ids of takes finished or dropped lately: a part still on its way when
 *    the take ended must not start it again (an orphan take, its audio kept).
 *  - The SHA-256 of 16 kHz samples, which says the finished clip holds exactly
 *    the samples a piece was heard from. Computed off the event loop (WebCrypto).
 */

import { webcrypto } from 'node:crypto';

/** How long a finished take's id is remembered. */
export const DONE_TTL_MS = 10 * 60_000;
const DONE_MAX = 64;

/** Ids finished lately, each forgotten after `ttlMs`, at most `max` of them (the oldest goes first). */
export class RecentIds {
  private readonly at = new Map<string, number>();

  constructor(private readonly ttlMs = DONE_TTL_MS, private readonly max = DONE_MAX) {}

  mark(id: string, now = Date.now()): void {
    this.at.delete(id);
    this.at.set(id, now);
    if (this.at.size > this.max) this.at.delete(this.at.keys().next().value!);
  }

  has(id: string): boolean {
    return this.at.has(id);
  }

  sweep(now = Date.now()): void {
    for (const [id, at] of this.at) if (now - at > this.ttlMs) this.at.delete(id);
  }

  get size(): number {
    return this.at.size;
  }

  clear(): void {
    this.at.clear();
  }
}

/** Hex SHA-256 of the samples' bytes (s16le, as they sit in memory). */
export async function pcmSha256(pcm: Int16Array | Uint8Array): Promise<string> {
  // Samples live in a plain ArrayBuffer here, never a shared one.
  const view = new Uint8Array(pcm.buffer as ArrayBuffer, pcm.byteOffset, pcm.byteLength);
  const digest = await webcrypto.subtle.digest('SHA-256', view);
  return Buffer.from(digest).toString('hex');
}
