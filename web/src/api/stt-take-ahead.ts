/**
 * Uploads a take's clip in parts while it records, so the server hears the
 * finished part ahead and the stop waits only for the tail (server:
 * src/core/stt/take-ahead.ts, route src/web/routes/stt-takes.ts).
 *
 * The parts are the take's own recorder chunks, the same bytes the stop sends
 * whole. One upload at a time, every ~15 s. Hearing ahead is only a speed-up:
 * any failure stops it for this take, logged, and the stop hears the whole clip
 * as before. Nothing here touches the live preview or the take itself.
 */

import { log } from '@/utils/log';
import { deadlineSignal } from '../utils/deadline-signal';

export const TAKE_AHEAD_EVERY_MS = 15_000;

/** The format name the server takes for a recorder's mime type (Safari records audio/mp4). */
export function formatOfMime(mime: string): string {
  return mime.includes('webm') ? 'webm'
    : mime.includes('mp4') ? 'mp4'
      : mime.includes('ogg') ? 'ogg'
        : 'webm';
}

function freshTakeId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class TakeAhead {
  readonly takeId = freshTakeId();
  /** Bytes the server holds. */
  private sent = 0;
  /** The upload on its way, if any; never two at once. */
  private uploading: Promise<void> | null = null;
  /** An upload was sent, so the server may hold the take. */
  private began = false;
  private stopped = false;
  private dropped = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly chunks: () => Blob[],
    private readonly mime: () => string,
    private readonly language: () => string | undefined,
    everyMs = TAKE_AHEAD_EVERY_MS,
  ) {
    this.timer = setInterval(() => { void this.tick(); }, everyMs);
  }

  /** Uploads the bytes not yet on the server; never two at once. */
  tick(): Promise<void> {
    if (this.uploading) return this.uploading;
    if (this.stopped) return Promise.resolve();
    const clip = new Blob(this.chunks());
    if (clip.size <= this.sent) return Promise.resolve();
    this.began = true;
    const run = this.upload(clip).finally(() => { this.uploading = null; });
    this.uploading = run;
    return run;
  }

  private async upload(clip: Blob): Promise<void> {
    try {
      const format = formatOfMime(this.mime());
      const language = this.language();
      const query = new URLSearchParams({ offset: String(this.sent), format, ...(language ? { language } : {}) });
      const res = await fetch(`/api/stt/takes/${this.takeId}/append?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: clip.slice(this.sent),
        signal: deadlineSignal(60_000),
      });
      const data = await res.json().catch(() => ({})) as { size?: number; error?: string };
      if (res.ok && typeof data.size === 'number') this.sent = data.size;
      else if (res.status === 409 && typeof data.size === 'number' && data.size <= clip.size) this.sent = data.size;
      else this.giveUp(`the server answered ${res.status}${data.error ? `: ${data.error}` : ''}`);
    } catch (err) {
      this.giveUp(err instanceof Error ? err.message : String(err));
    }
  }

  /** Hearing ahead failed for this take: the server forgets what it holds, and the stop hears the whole clip. */
  private giveUp(why: string): void {
    if (this.stopped) return;
    log.warn('stt', `hearing the take ahead stopped (${why}); the stop hears the whole clip`, { takeId: this.takeId });
    this.drop();
  }

  private end(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** At the stop: the take id to send with the whole clip, when the server holds part of it. */
  finish(): string | undefined {
    const held = !this.stopped && this.sent > 0;
    this.end();
    return held ? this.takeId : undefined;
  }

  /**
   * A take that will not be heard (discarded, no sound, the page went away,
   * hearing ahead failed): the server forgets it. Sent after the upload on its
   * way lands, so that upload cannot make the take again after it is gone.
   */
  drop(): Promise<void> {
    this.end();
    if (this.dropped || !this.began) return Promise.resolve();
    this.dropped = true;
    // Resolves once the delete is sent; its answer changes nothing here.
    const forget = () => { void fetch(`/api/stt/takes/${this.takeId}`, { method: 'DELETE' }).catch(() => {}); };
    return (this.uploading ?? Promise.resolve()).then(forget, forget);
  }
}
