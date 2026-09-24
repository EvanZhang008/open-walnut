/**
 * Where the live-dictation draft window goes next, and whether this tick may
 * upload. Pure decision logic, lifted out of useSpeechToText so the invariant
 * below can be tested without a microphone.
 *
 * THE INVARIANT: when a bound is exceeded, the window ADVANCES. The window
 * boundary is a POSITION in the recording, never the result of a request.
 * Coupling the two produced a real incident (2026-09-01): the commit slice had
 * no size cap, the boundary moved only after a successful upload, and a 413 was
 * treated as retryable — so a single rejection froze the boundary while audio
 * kept accumulating behind it, and every following tick posted a strictly larger
 * body (3.9MB → 15.7MB, one every 2s) that could never succeed. Earlier in the
 * same recording the preview path did the mirror image: it skipped on its byte
 * cap without moving the boundary, so the draft went silent for four minutes
 * while the window grew. A bound that leaves the window where it is is not a
 * bound.
 *
 * The cost of advancing without uploading is preview quality, plus a span whose
 * text the segment assembly no longer has — the caller is told exactly which
 * span so it can compensate (useSpeechToText falls back to a whole-clip pass on
 * stop when a skipped span contained speech).
 */

export interface DraftTickInput {
  /** Absolute sample offset where the still-open window begins. */
  windowStart: number;
  /** Absolute sample position of "now" (samples captured so far). */
  totalSamples: number;
  /** Capture sample rate, for the samples ⇄ ms arithmetic. */
  sampleRate: number;
  /** Commit point for this tick (sample position), or null when there is none. */
  commitAt: number | null;
  /** Base64 length of the slice this tick would upload; 0 when there is none. */
  sliceBytes: number;
  /** Largest upload we will post, in base64 bytes. */
  maxBytes: number;
  /** Longest stretch of audio one tick may keep open, in ms. */
  maxWindowMs: number;
}

export type DraftTickAction =
  /** Freeze the segment before `commitAt` by transcribing it, then advance. */
  | 'commit-upload'
  /** Segment is over the byte cap (or empty): advance without transcribing. */
  | 'commit-skip'
  /** Refresh the preview of the open window; the window stays put. */
  | 'preview-upload'
  /** Nothing to preview, or the preview would be over the byte cap. */
  | 'preview-skip'
  /** The window has been open past the wall-clock bound: clamp it forward. */
  | 'force-advance';

export interface DraftTickDecision {
  action: DraftTickAction;
  /** Where the window must sit after this tick, whatever the upload does. */
  nextWindowStart: number;
  /** How long the open window is, for logging and warnings. */
  windowMs: number;
}

/**
 * One tick's decision. Order of the rules matters:
 *
 * 1. A commit point always moves the boundary — committing is the whole point,
 *    and an oversized segment is skipped rather than refused.
 * 2. The wall-clock bound is checked BEFORE anything that needs the encoded
 *    slice, because it is the rule that still holds when no commit point is ever
 *    found (pure silence, or unbroken speech with no usable cut). It also lets
 *    the caller skip the base64 encode of a window it is about to abandon.
 * 3. Byte bounds skip the upload — and still advance, per the invariant above.
 */
export function decideDraftTick(input: DraftTickInput): DraftTickDecision {
  const { windowStart, totalSamples, sampleRate, commitAt, sliceBytes, maxBytes, maxWindowMs } = input;
  const perMs = sampleRate / 1000;
  const windowMs = Math.max(0, (totalSamples - windowStart) / perMs);

  if (commitAt !== null) {
    const uploadable = sliceBytes > 0 && sliceBytes <= maxBytes;
    return {
      action: uploadable ? 'commit-upload' : 'commit-skip',
      nextWindowStart: Math.max(windowStart, commitAt),
      windowMs,
    };
  }

  /** Keep at most the last `maxWindowMs` of audio in the open window. */
  const clockClamped = Math.max(windowStart, totalSamples - Math.floor(maxWindowMs * perMs));
  if (windowMs > maxWindowMs) {
    return { action: 'force-advance', nextWindowStart: clockClamped, windowMs };
  }

  if (sliceBytes === 0) {
    // Nothing captured in the window yet — no bound was exceeded, and there is
    // no position to advance to.
    return { action: 'preview-skip', nextWindowStart: windowStart, windowMs };
  }

  if (sliceBytes > maxBytes) {
    // Bytes scale with samples, so keeping the last maxBytes/sliceBytes of the
    // window is exactly the upload budget expressed as a position — no
    // assumptions about the encoder's format. Strictly ahead of windowStart
    // whenever the slice is over cap, which is what keeps the invariant true
    // even if the wall-clock bound is configured loose.
    const budgetSamples = Math.floor((totalSamples - windowStart) * (maxBytes / sliceBytes));
    const byteClamped = Math.max(windowStart + 1, totalSamples - budgetSamples);
    return { action: 'preview-skip', nextWindowStart: Math.max(clockClamped, byteClamped), windowMs };
  }

  return { action: 'preview-upload', nextWindowStart: windowStart, windowMs };
}
