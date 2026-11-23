/**
 * One streamed piece of speech (`audio/L16` from /api/v1/voice/speak with
 * `stream: true`: the local voice's raw 16-bit PCM, sent as it is made), read as
 * it arrives.
 *
 * Reading starts at once and keeps everything that came in memory, so a piece
 * fetched ahead while another plays never holds the server's stream back; the
 * speaker plays the samples from here once its turn comes (voice-speaker.ts).
 * `firstAudio` resolves at the first whole sample and rejects when the stream
 * ends or fails before one, which the speaker treats as a failed fetch. A stream
 * that fails part way just ends: `failed` says why.
 */

import { l16ToFloat, parseL16, type L16Format } from '@open-walnut/pcm-l16';

export { parseL16, type L16Format };

/** One run of samples, one array per channel, all the same length. */
export type PcmRun = Float32Array[];

export class PcmFeed {
  /** Resolves at the first audio; rejects when the stream ended or failed before any. */
  readonly firstAudio: Promise<void>;
  /** Resolves when the stream stopped coming: whole, broken or cancelled (never rejects). */
  readonly done: Promise<void>;
  private settleDone!: () => void;
  private runs: PcmRun[] = [];
  private carry: Uint8Array = new Uint8Array(0);
  private ended = false;
  private failure: unknown = null;
  private gotAudio = false;
  private wake: (() => void) | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private settleFirst!: { resolve: () => void; reject: (err: unknown) => void };

  constructor(body: ReadableStream<Uint8Array>, readonly format: L16Format, signal?: AbortSignal) {
    this.firstAudio = new Promise<void>((resolve, reject) => { this.settleFirst = { resolve, reject }; });
    this.firstAudio.catch(() => {});
    this.done = new Promise<void>((resolve) => { this.settleDone = resolve; });
    this.reader = body.getReader();
    const onAbort = () => this.cancel();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    void this.read().finally(() => signal?.removeEventListener('abort', onAbort));
  }

  /** Why the stream stopped before its end, or null (it ended whole, or still comes). */
  get failed(): unknown {
    return this.failure;
  }

  /** Stop reading; what came stays playable. */
  cancel(): void {
    void this.reader.cancel().catch(() => {});
    this.finish(this.ended ? null : new DOMException('The voice stream was stopped', 'AbortError'));
  }

  /**
   * The samples as they come: everything that arrived since the last run, as one
   * run (fewer, longer buffers to schedule); ends with the stream.
   */
  async *samples(): AsyncGenerator<PcmRun> {
    for (;;) {
      if (this.runs.length) {
        const all = this.runs;
        this.runs = [];
        yield all.length === 1 ? all[0]! : join(all);
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = null;
    }
  }

  private async read(): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done || this.ended) break;
        this.push(value);
      }
      this.finish(null);
    } catch (err) {
      this.finish(err);
    }
  }

  private push(bytes: Uint8Array): void {
    let data = bytes;
    if (this.carry.byteLength) {
      data = new Uint8Array(this.carry.byteLength + bytes.byteLength);
      data.set(this.carry);
      data.set(bytes, this.carry.byteLength);
    }
    const { samples, used } = l16ToFloat(data, this.format.channels);
    this.carry = data.slice(used);
    if (!used) return;
    this.runs.push(samples);
    if (!this.gotAudio) { this.gotAudio = true; this.settleFirst.resolve(); }
    this.wake?.();
  }

  private finish(err: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = err;
    if (!this.gotAudio) this.settleFirst.reject(err ?? new Error('The voice stream ended with no audio'));
    this.settleDone();
    this.wake?.();
  }
}

function join(runs: PcmRun[]): PcmRun {
  const channels = runs[0]!.length;
  const length = runs.reduce((n, r) => n + r[0]!.length, 0);
  return Array.from({ length: channels }, (_, c) => {
    const out = new Float32Array(length);
    let at = 0;
    for (const r of runs) { out.set(r[c]!, at); at += r[c]!.length; }
    return out;
  });
}
