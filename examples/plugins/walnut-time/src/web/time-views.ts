/**
 * Per-view geometry for the three timeline sub-views — PURE, so the rules that
 * decide "is this segment tall enough for text" are unit tested without a
 * browser. This app is the Time UI, so this is the ONLY copy of these rules;
 * unit tests (tests/web/time-views.test.ts) import this file directly.
 *
 * The three views answer three different questions and therefore draw at three
 * different scales, but they share ONE axis (time-timeline.ts axisRange), so
 * switching between them never moves the day under the reader's eye.
 *
 *   Tape      vertical, one serial ribbon      — "what was I doing at 14:07?"
 *   Chapters  vertical flow of cards           — "what is the story of my day?"
 *   Lanes     horizontal, one row per task     — "when was THIS task touched?"
 *
 * THE TAPE IS STRICTLY PROPORTIONAL, and that is a hard rule rather than an
 * accident. Its predecessor inflated every short block to a readable minimum and
 * packed overlaps into parallel columns; on a real day that manufactured both a
 * lie (side-by-side work that never happened) and a mess. In a serial ribbon an
 * inflated segment has to PUSH its neighbours down, which would silently detach
 * the ribbon from the hour ruler beside it. So the floor here is 2px — enough that
 * 30 seconds is a visible stripe, small enough that the overdraw onto the next
 * segment is under a pixel.
 */

/** Minutes per hour, restated so this module needs no import to do axis math. */
const HOUR_MIN = 60;

// ── View A: attention tape ──

/** Tape hour height. 144px = 2.4px per minute, the mockup's scale. */
export const TAPE_HOUR_PX = 144;
export const TAPE_PX_PER_MIN = TAPE_HOUR_PX / HOUR_MIN;
/** Floor for a drawn segment. See the file header for why it is this small. */
export const SEG_MIN_PX = 2;
/** From here a 12px line fits, so the segment can carry its task title. */
export const SEG_LABEL_PX = 14;
/** From here the clock range and duration fit beside the title. */
export const SEG_RANGE_PX = 56;
/** Consecutive segments closer than this get the hairline that separates them. */
export const SEG_HAIRLINE_GAP_MS = 60 * 1000;

/** 0 = no text fits, 1 = title only, 2 = title + range + duration. */
export type SegLabel = 0 | 1 | 2;

export interface TapeSegment<T> {
  slice: T;
  topPx: number;
  heightPx: number;
  label: SegLabel;
  /** True when the previous segment ends where this one begins. */
  hairline: boolean;
}

/**
 * Lay the ribbon out. Input must be the SERIAL ribbon in ascending order (the
 * server's raw mode); this function does not resolve overlap, because by the time
 * geometry runs, a claim of two things at once has already been decided.
 */
export function layoutTape<T extends { startTs: string; endTs: string }>(
  slices: readonly T[],
  axisStartMin: number,
  minuteOf: (iso: string) => number,
  /** Zoom. An expanded chapter draws the same ribbon at a larger scale. */
  pxPerMin: number = TAPE_PX_PER_MIN,
): Array<TapeSegment<T>> {
  let prevEndMs = -Infinity;
  return slices.map((slice) => {
    const startMin = minuteOf(slice.startTs);
    const endMin = minuteOf(slice.endTs);
    const heightPx = Math.max((endMin - startMin) * pxPerMin, SEG_MIN_PX);
    const startMs = Date.parse(slice.startTs);
    const hairline = Number.isFinite(prevEndMs) && startMs - prevEndMs <= SEG_HAIRLINE_GAP_MS;
    prevEndMs = Date.parse(slice.endTs);
    return {
      slice,
      topPx: (startMin - axisStartMin) * pxPerMin,
      heightPx,
      label: segLabel(heightPx),
      hairline,
    };
  });
}

/** Text is drawn only when the box can hold it — never a clipped half-word. */
export function segLabel(heightPx: number): SegLabel {
  if (heightPx >= SEG_RANGE_PX) return 2;
  if (heightPx >= SEG_LABEL_PX) return 1;
  return 0;
}

// ── View B: chapters ──

/**
 * Chapters are a FLOW, not an absolute axis: a card carries four lines of text and
 * cannot shrink below them, and an expanded chapter has to push the rest of the day
 * down. Height still tracks span, between a floor that fits the text and a ceiling
 * that stops one three-hour stretch from becoming the whole view.
 */
export const CHAPTER_PX_PER_MIN = 2.3;
export const CHAPTER_MIN_PX = 86;
export const CHAPTER_MAX_PX = 260;

/** Zoom for an expanded chapter's ribbon, where a 5-minute slice must be readable. */
export const CHAPTER_ZOOM_PX_PER_MIN = TAPE_PX_PER_MIN * 3;

export function chapterHeightPx(spanMs: number): number {
  const raw = (spanMs / 60_000) * CHAPTER_PX_PER_MIN;
  return Math.round(Math.min(Math.max(raw, CHAPTER_MIN_PX), CHAPTER_MAX_PX));
}

// ── View C: swimlanes ──

/** Task rows before the aggregated "others" row. */
export const LANE_ROWS = 6;
/**
 * A bar shorter than this would be invisible. Enforced twice on purpose: as a
 * percentage floor here (so the visual merge knows how wide a bar will really be)
 * and as `min-width` in CSS, which is the guarantee — this module can only ever
 * GUESS the track's pixel width, and it guessed too wide the first time.
 */
export const LANE_BAR_MIN_PX = 5;
/** Assumed track width, for the merge scale only. Layout is percentage-based. */
export const LANE_TRACK_PX = 520;

export interface LaneBar {
  /** Percent from the left of the track, 0-100. */
  leftPct: number;
  widthPct: number;
  /** True for a sub-TICK_BELOW_MS touch: drawn shorter and quieter. */
  tick: boolean;
}

/**
 * One bar's horizontal geometry. Percent-based on purpose: the track is fluid, and
 * a px layout would have to re-measure on every resize.
 */
export function laneBar(
  startMin: number,
  endMin: number,
  axis: { startMin: number; endMin: number },
  opts: { tick: boolean },
): LaneBar {
  const span = Math.max(1, axis.endMin - axis.startMin);
  const leftPct = ((startMin - axis.startMin) / span) * 100;
  const rawPct = ((endMin - startMin) / span) * 100;
  const minPct = (LANE_BAR_MIN_PX / LANE_TRACK_PX) * 100;
  return {
    leftPct: Math.max(0, Math.min(100, leftPct)),
    widthPct: Math.max(rawPct, minPct),
    tick: opts.tick,
  };
}
