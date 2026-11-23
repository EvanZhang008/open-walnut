/**
 * Uploads a take's clip in parts while it records, so the server hears the
 * finished part ahead and the stop waits only for the tail (server:
 * src/core/stt/take-ahead.ts, route src/web/routes/stt-takes.ts).
 *
 * The parts are the take's own recorder chunks, the same bytes the stop sends
 * whole. One upload at a time, every ~15 s. Hearing ahead is only a speed-up,
 * but losing it makes a long take's stop wait for the whole clip (2026-11-23: a
 * deploy restarted the server 3 minutes into a 4.5-minute take, the server
 * forgot the take, and the stop waited 10.8 s instead of about 2). So a take the
 * server lost is sent again from its first byte, and an upload that did not
 * arrive is tried again at the next tick; only a refusal (or too many misses)
 * stops it for this take, logged, and the stop hears the whole clip as before.
 * Nothing here touches the live preview or the take itself.
 */

import { log } from '@/utils/log';
import { deadlineSignal } from '../utils/deadline-signal';

export const TAKE_AHEAD_EVERY_MS = 15_000;

/**
 * What the client does with each answer of the append route (server:
 * `AppendOutcome` in src/core/stt/take-ahead.ts; a guard test fails when the
 * server gains an answer this table does not name).
 * - `resend-from-size`: the server holds a different length; send from there.
 * - `start-over`: the server does not know the take (it restarted and lost the
 *   takes it held in memory): send the whole clip again from byte 0.
 * - `retry`: busy for now; the next tick tries the same bytes again.
 * - `give-up`: refused for this take; the stop hears the whole clip.
 */
export const APPEND_ANSWER: Record<number, 'resend-from-size' | 'start-over' | 'retry' | 'give-up'> = {
  409: 'resend-from-size',
  404: 'start-over',
  503: 'retry',
  400: 'give-up',
  410: 'give-up',
  413: 'give-up',
};

/** A take is sent again from its start at most this many times. */
export const START_OVER_MAX = 3;
/** Uploads in a row that did not arrive (no answer, a gateway error) before giving up: about a minute. */
export const MISSES_MAX = 4;

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
  private startedOver = 0;
  private misses = 0;
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
    let res: Response;
    let data: { size?: number; error?: string };
    try {
      const format = formatOfMime(this.mime());
      const language = this.language();
      const query = new URLSearchParams({ offset: String(this.sent), format, ...(language ? { language } : {}) });
      res = await fetch(`/api/stt/takes/${this.takeId}/append?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: clip.slice(this.sent),
        signal: deadlineSignal(60_000),
      });
      data = await res.json().catch(() => ({})) as { size?: number; error?: string };
    } catch (err) {
      // No answer (the server restarting, the network gone a moment): the next tick tries again.
      this.miss(err instanceof Error ? err.message : String(err));
      return;
    }
    if (res.ok && typeof data.size === 'number') {
      this.sent = data.size;
      this.misses = 0;
      return;
    }
    // An answer that is not the route's own (a page served while the server boots): it did not arrive.
    if (res.ok) { this.miss(`the server answered ${res.status} without a size`); return; }
    const why = `the server answered ${res.status}${data.error ? `: ${data.error}` : ''}`;
    const answer = APPEND_ANSWER[res.status] ?? (res.status >= 500 ? 'retry' : 'give-up');
    if (answer === 'resend-from-size' && typeof data.size === 'number' && data.size <= clip.size) {
      this.sent = data.size;
      this.misses = 0;
    } else if (answer === 'start-over' && this.startedOver < START_OVER_MAX && !this.stopped) {
      this.startedOver += 1;
      this.misses = 0;
      log.info('stt', `the server lost the take heard ahead (${why}); sending it again from the start`, { takeId: this.takeId, bytes: clip.size });
      this.sent = 0;
      await this.upload(new Blob(this.chunks()));
    } else if (answer === 'retry') {
      this.miss(why);
    } else {
      this.giveUp(why);
    }
  }

  /** An upload that did not arrive: tried again at the next tick, until too many in a row. */
  private miss(why: string): void {
    this.misses += 1;
    if (this.misses >= MISSES_MAX) this.giveUp(`${this.misses} uploads in a row did not arrive, the last: ${why}`);
    else log.info('stt', `a part of the take did not arrive (${why}); trying again at the next tick`, { takeId: this.takeId });
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
    // Not named (a start-over on its way, say): the server forgets what that upload makes.
    if (!held) void this.drop();
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
