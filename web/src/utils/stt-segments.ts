/**
 * Segment-commit logic for live dictation.
 *
 * The live draft used to re-transcribe the whole clip every tick, which made
 * each tick slower the longer the user spoke (O(n) per tick, O(n²) overall) and
 * made the final pass on stop re-do everything. Instead, the recording is cut at
 * silence gaps: once the user has paused for a beat, the audio up to that pause
 * is transcribed one last time and its text is "committed" — frozen, never
 * re-transcribed — and the draft window restarts after the pause. Ticks then
 * only ever process the current sentence, so a ten-minute dictation drafts as
 * fast as a ten-second one.
 *
 * These are the pure decision functions; the audio plumbing lives in
 * pcm-stream.ts and the orchestration in useSpeechToText.
 */

/** One analysis block of captured audio: where it starts and how loud it was. */
export interface PcmBlockInfo {
  /** Absolute start position, in samples since capture began. */
  startSample: number;
  /** Samples in the block. */
  length: number;
  /** Root-mean-square level of the block, 0..1. */
  rms: number;
}

export interface CommitPointOptions {
  sampleRate: number;
  /** RMS at/above which a block counts as speech (not just mic noise floor). */
  voiceRms: number;
  /** A pause must be at least this long to be a safe cut point. */
  minSilenceMs: number;
  /** Don't bother committing segments shorter than this. */
  minSegmentMs: number;
  /**
   * Once the open window is longer than this, start accepting shorter pauses
   * (see relaxAfterMs in the escalation note below). Omit to never relax.
   */
  relaxAfterMs?: number;
  /** Shortest pause the relaxed search will ever cut at. */
  minSilenceFloorMs?: number;
  /**
   * Beyond this window length, cut at the quietest point even with no
   * qualifying pause at all. Omit to never force a cut.
   */
  forceAfterMs?: number;
}

/**
 * Finds where to cut the current draft window: the midpoint of the LAST pause
 * (sustained run of sub-voice blocks) that is long enough to guarantee no word
 * is straddling it, provided enough audio precedes it to be worth committing.
 *
 * Cutting at the latest qualifying pause (rather than the first) commits as
 * much as possible in one transcription. The midpoint keeps a little silence on
 * both sides of the cut so neither the committed segment nor the new window
 * starts mid-phoneme. Returns the cut position in samples, or null if the
 * window has no qualifying pause yet.
 *
 * ESCALATION (relaxAfterMs / forceAfterMs). A fixed 800ms requirement assumes
 * the speaker eventually pauses that long. Fast continuous talkers do not: in a
 * measured 27s dictation not one gap qualified, so the window never advanced,
 * every 2s tick re-transcribed the whole thing, and tick cost grew from 0.6s to
 * 4.4s — the exact runaway the segment design exists to prevent. So the longer
 * the window stays open, the shorter a pause we accept (down to
 * minSilenceFloorMs), and past forceAfterMs we cut at the quietest point even
 * with no pause at all. A slightly awkward cut costs a word boundary once;
 * an unbounded window costs every remaining tick of the dictation.
 */
export function findSilenceCommitPoint(
  blocks: readonly PcmBlockInfo[],
  windowStartSample: number,
  opts: CommitPointOptions,
): number | null {
  const perMs = opts.sampleRate / 1000;
  const minSegmentSamples = opts.minSegmentMs * perMs;
  const windowEnd = blocks.length
    ? Math.max(windowStartSample, blocks[blocks.length - 1].startSample + blocks[blocks.length - 1].length)
    : windowStartSample;
  const windowMs = (windowEnd - windowStartSample) / perMs;

  // How long a pause we insist on, given how long this window has been open.
  // Interpolates from minSilenceMs at relaxAfterMs down to the floor at
  // forceAfterMs, so a talker who pauses only briefly still gets commits.
  const requiredSilenceMs = (() => {
    const { relaxAfterMs, forceAfterMs, minSilenceFloorMs, minSilenceMs } = opts;
    if (relaxAfterMs === undefined || windowMs <= relaxAfterMs) return minSilenceMs;
    const floor = Math.min(minSilenceFloorMs ?? minSilenceMs, minSilenceMs);
    const span = (forceAfterMs ?? relaxAfterMs * 2) - relaxAfterMs;
    if (span <= 0) return floor;
    const progress = Math.min(1, (windowMs - relaxAfterMs) / span);
    return minSilenceMs - (minSilenceMs - floor) * progress;
  })();
  const minSilenceSamples = requiredSilenceMs * perMs;

  let best: number | null = null;
  let runStart: number | null = null; // start of the current silent run
  let runEnd = 0;
  let sawVoice = false;

  const closeRun = () => {
    if (runStart === null) return;
    const runLen = runEnd - runStart;
    if (runLen >= minSilenceSamples && sawVoice) {
      const mid = runStart + Math.floor(runLen / 2);
      if (mid - windowStartSample >= minSegmentSamples) best = mid;
    }
    runStart = null;
  };

  for (const b of blocks) {
    if (b.startSample + b.length <= windowStartSample) continue;
    if (b.rms >= opts.voiceRms) {
      closeRun();
      sawVoice = true;
    } else {
      if (runStart === null) runStart = Math.max(b.startSample, windowStartSample);
      runEnd = b.startSample + b.length;
    }
  }
  // A run still open at the end of capture counts too: the user is pausing
  // right now, which is exactly when committing is cheapest.
  closeRun();
  if (best !== null) return best;

  if (opts.forceAfterMs !== undefined && windowMs >= opts.forceAfterMs && sawVoice) {
    return quietestCutPoint(blocks, windowStartSample, windowEnd, minSegmentSamples, perMs);
  }
  return null;
}

/**
 * Last resort for speech with no usable pause: cut between the two quietest
 * adjacent blocks in the committable stretch. That is the least-bad boundary
 * available — a dip in energy is usually a consonant or word edge rather than
 * the middle of a vowel.
 *
 * The last second is excluded so the cut never lands on the word the user is
 * saying right now, and the cut must still leave a worthwhile segment behind it.
 */
function quietestCutPoint(
  blocks: readonly PcmBlockInfo[],
  windowStartSample: number,
  windowEnd: number,
  minSegmentSamples: number,
  perMs: number,
): number | null {
  const earliest = windowStartSample + minSegmentSamples;
  const latest = windowEnd - 1000 * perMs;
  if (latest <= earliest) return null;

  let bestAt: number | null = null;
  let bestRms = Infinity;
  for (const b of blocks) {
    const mid = b.startSample + Math.floor(b.length / 2);
    if (mid < earliest || mid > latest) continue;
    if (b.rms < bestRms) {
      bestRms = b.rms;
      bestAt = mid;
    }
  }
  return bestAt;
}

/**
 * Joins committed text with the next segment's text. Qwen punctuates each
 * segment as a sentence, so mostly this is concatenation; the only judgment
 * call is the separator. CJK text takes no space at the boundary; everything
 * else (latin words, English sentences) gets one so nothing fuses.
 */
export function joinSegments(committed: string, next: string): string {
  const a = committed.trimEnd();
  const b = next.trimStart();
  if (!a) return b;
  if (!b) return a;
  // CJK ranges incl. their punctuation (、。！？) and fullwidth forms.
  const isCjk = (ch: string) => /[⺀-鿿豈-﫿＀-￯]/.test(ch);
  return isCjk(a[a.length - 1]) || isCjk(b[0]) ? a + b : `${a} ${b}`;
}
