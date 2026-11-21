/**
 * The live draft of a take of any length, read from a recorder that is never
 * more than a few minutes long.
 *
 * The draft decodes its recorder's WebM from the start on every tick (a WebM only
 * decodes with its header), so a tick costs the whole take so far. It used to
 * stop at 5 minutes (2026-11-20, the user's mock interview: the text froze
 * mid-sentence while he went on talking). Now a second recorder on the same mic
 * starts halfway through a lane's length, and once the lane is full the draft
 * moves onto it, keeping its place by the clock. The take's own recorder, whose
 * whole clip is the text, is never touched: lanes are for the preview only.
 */

/** What a lane decodes into (RecorderPcm, or a stand-in in tests). */
export interface LanePcm {
  refresh(blob: Blob): Promise<void>;
  takeRebase(): number;
  readonly decodedSamples: number;
  readonly totalSamples: number;
  readonly sampleRate: number;
}

export interface DraftLane<P extends LanePcm = LanePcm> {
  pcm: P;
  /** The recorder's chunks so far. */
  chunks(): Blob[];
  /** When the recorder started, on the clock positions are mapped by (ms). */
  startedAt: number;
  /** Ends this lane's recorder; the take's own recorder ignores it. */
  stop(): void;
}

/** Audio a lane decodes before the draft moves on (repeats included: what a tick costs). */
export const LANE_MAX_MS = 4 * 60_000;

export class DraftLanes<P extends LanePcm = LanePcm> {
  private lanes: DraftLane<P>[];
  private openFailed = false;

  constructor(
    main: DraftLane<P>,
    /** A new recorder on the same mic, started now; null when the browser refuses one. */
    private readonly open: () => DraftLane<P> | null,
    private readonly maxMs = LANE_MAX_MS,
  ) {
    this.lanes = [main];
  }

  get pcm(): P {
    return this.lanes[0]!.pcm;
  }

  /** The current lane's recording so far. */
  blob(type: string): Blob {
    return new Blob(this.lanes[0]!.chunks(), { type });
  }

  private decodedMs(lane: DraftLane<P>): number {
    return lane.pcm.decodedSamples / (lane.pcm.sampleRate / 1000);
  }

  /**
   * After the current lane's refresh, with the draft window's start on it: opens
   * the next lane halfway through, and once the current one is full moves onto
   * it. Returns the window start on the new lane (its pcm already refreshed), or
   * null when the draft stays where it is.
   */
  async advance(windowStart: number, type: string): Promise<number | null> {
    const cur = this.lanes[0]!;
    const ms = this.decodedMs(cur);
    if (this.lanes.length === 1 && !this.openFailed && ms > this.maxMs / 2) {
      const next = this.open();
      if (next) this.lanes.push(next);
      else this.openFailed = true;
    }
    const next = this.lanes[1];
    if (!next || ms <= this.maxMs) return null;
    const chunks = next.chunks();
    if (chunks.length === 0) return null;
    try {
      await next.pcm.refresh(new Blob(chunks, { type }));
    } catch {
      // A second recorder whose audio does not decode is no lane: the draft
      // stays, and past the ceiling it says it paused (exhausted).
      next.stop();
      this.lanes.pop();
      this.openFailed = true;
      return null;
    }
    // A fresh lane's own repeat finding is about its own timeline, read as heard
    // from its start: nothing taken on it yet to move.
    next.pcm.takeRebase();
    const perMs = cur.pcm.sampleRate / 1000;
    const at = cur.startedAt + windowStart / perMs;
    const mapped = Math.round((at - next.startedAt) * (next.pcm.sampleRate / 1000));
    cur.stop();
    this.lanes.shift();
    return Math.max(0, Math.min(mapped, next.pcm.totalSamples));
  }

  /**
   * The current lane is past what a tick can afford and the draft cannot move:
   * the browser refused or broke the next lane, or that lane never gave audio.
   */
  get exhausted(): boolean {
    const ms = this.decodedMs(this.lanes[0]!);
    return ms > this.maxMs * (this.openFailed ? 1.25 : 1.5);
  }

  /** The take ended: every lane recorder stops. */
  stopAll(): void {
    for (const lane of this.lanes) lane.stop();
  }
}

/** A draft-only recorder on `stream`, started now; null when the browser refuses a second one. */
export function openRecorderLane<P extends LanePcm>(stream: MediaStream, mimeType: string, pcm: () => P, chunkMs: number): DraftLane<P> | null {
  try {
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.start(chunkMs);
    return {
      pcm: pcm(),
      chunks: () => chunks,
      startedAt: performance.now(),
      stop: () => { try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* already ended */ } },
    };
  } catch {
    return null;
  }
}

/** A lane length a browser test sets (`window.__walnutSttLaneMaxMs`), so a rotation shows in seconds. */
export function testLaneMaxMs(): number | undefined {
  const v = typeof window !== 'undefined' ? (window as unknown as { __walnutSttLaneMaxMs?: unknown }).__walnutSttLaneMaxMs : undefined;
  return typeof v === 'number' && v > 0 ? v : undefined;
}
