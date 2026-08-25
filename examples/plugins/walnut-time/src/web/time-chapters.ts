/**
 * Chapters — PURE. Turns the day's serial ribbon into a handful of readable
 * "chapters", the narrative view of a day. This app is the Time UI, so this is
 * the ONLY copy of these rules; unit tests (tests/web/time-chapters.test.ts)
 * import this file directly.
 *
 * The premise: sixty slices is data, not a story. A person remembers a day as a
 * few stretches ("inbox, then the RFE, then alerts"), and the natural boundary
 * between two stretches is that you WEREN'T at the computer for a while. So the
 * day splits at idle gaps over CHAPTER_GAP_MS, and each chapter is described by
 * what dominated it.
 *
 * Two honesty rules are baked in:
 *
 * 1. A chapter with no dominant task is NOT given the biggest task's name. When the
 *    top share is under FRAGMENTED_SHARE, naming it "Manager Letter" would claim a
 *    focus that did not happen, so it is titled as fragmented work instead.
 * 2. The composition bar always adds up to the chapter. Whatever is not shown as a
 *    named part is shown as ONE remainder segment carrying its real width and count
 *    — never dropped to make the bar tidy.
 *
 * Input is the serial ribbon (foldDaySlices), which is non-overlapping by
 * construction; feeding it per-task merged blocks would double-count the overlap
 * that fold deliberately allows.
 */

/** Idle longer than this ends a chapter. */
export const CHAPTER_GAP_MS = 10 * 60 * 1000;
/** Below this share, the top task does not get to name the chapter. */
export const FRAGMENTED_SHARE = 0.4;
/** At or above this share, the chapter reads as one thing (a focused stretch). */
export const FOCUSED_SHARE = 0.7;
/** Named parts in the composition bar; the rest becomes one remainder segment. */
export const COMP_TOP_PARTS = 4;
/** A part under this is a "quick touch" for labelling purposes. */
export const QUICK_PART_MS = 2 * 60 * 1000;
/** A part thinner than this cannot be seen, so it joins the remainder. */
export const COMP_MIN_SHARE = 0.02;

/** The least a ribbon slice has to carry for the chapter fold to read it. */
export interface Sliceish {
  taskId: string;
  startTs: string;
  endTs: string;
  /** Recorded time inside the slice. Chapter math always uses THIS, not the span. */
  trackedMs: number;
}

export interface ChapterPart {
  taskId: string;
  ms: number;
  /** Of the chapter's worked time, 0-1. */
  share: number;
}

export interface Chapter {
  /** Stable across re-renders of the same day: the first slice's start. */
  key: string;
  startTs: string;
  endTs: string;
  /** Wall span of the chapter. */
  spanMs: number;
  /** Recorded time inside it (smaller than the span when slices had gaps). */
  workedMs: number;
  /** Descending by time. Complete: every slice in the chapter is in here. */
  parts: ChapterPart[];
  /** parts[0], or null for an empty chapter (which buildChapters never emits). */
  dominant: ChapterPart | null;
  /** True when no task held FRAGMENTED_SHARE of the chapter. */
  fragmented: boolean;
  /** True when the dominant task held FOCUSED_SHARE or more. */
  focused: boolean;
  /** Idle ms between the previous chapter and this one. 0 for the first. */
  idleBeforeMs: number;
  /** The slices themselves, in order — what an expanded chapter draws. */
  slices: Sliceish[];
}

/**
 * Split the day's ribbon into chapters. Slices must be in ascending time order;
 * they are sorted defensively because a caller that filtered the ribbon can easily
 * hand over a shuffled array, and a mis-ordered walk silently invents gaps.
 */
export function buildChapters(
  slices: readonly Sliceish[],
  opts: { gapMs?: number } = {},
): Chapter[] {
  const gapMs = opts.gapMs ?? CHAPTER_GAP_MS;
  const ordered = slices.slice().sort((a, b) => a.startTs.localeCompare(b.startTs));
  const groups: Sliceish[][] = [];
  const idleBefore: number[] = [];
  let prevEndMs = 0;

  for (const slice of ordered) {
    const startMs = Date.parse(slice.startTs);
    const endMs = Date.parse(slice.endTs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    const gap = startMs - prevEndMs;
    if (groups.length === 0 || gap > gapMs) {
      groups.push([slice]);
      idleBefore.push(groups.length === 1 ? 0 : Math.max(0, gap));
    } else {
      groups[groups.length - 1]!.push(slice);
    }
    // Never move the cursor backwards: an overlapping slice would otherwise make
    // the NEXT gap look large enough to break a chapter that never broke.
    prevEndMs = Math.max(prevEndMs, endMs);
  }

  return groups.map((group, i) => describeChapter(group, idleBefore[i] ?? 0));
}

function describeChapter(slices: Sliceish[], idleBeforeMs: number): Chapter {
  const startTs = slices[0]!.startTs;
  let endTs = slices[0]!.endTs;
  let workedMs = 0;
  const byTask = new Map<string, number>();
  for (const s of slices) {
    workedMs += s.trackedMs;
    byTask.set(s.taskId, (byTask.get(s.taskId) ?? 0) + s.trackedMs);
    if (s.endTs > endTs) endTs = s.endTs;
  }
  const parts: ChapterPart[] = [...byTask]
    .map(([taskId, ms]) => ({ taskId, ms, share: workedMs > 0 ? ms / workedMs : 0 }))
    .sort((a, b) => b.ms - a.ms || a.taskId.localeCompare(b.taskId));
  const dominant = parts[0] ?? null;
  return {
    key: startTs,
    startTs,
    endTs,
    spanMs: Math.max(0, Date.parse(endTs) - Date.parse(startTs)),
    workedMs,
    parts,
    dominant,
    fragmented: !dominant || dominant.share < FRAGMENTED_SHARE,
    focused: !!dominant && dominant.share >= FOCUSED_SHARE,
    idleBeforeMs,
    slices,
  };
}

export interface CompSegment {
  /** null = the aggregated remainder. */
  taskId: string | null;
  ms: number
  /** Width as a percentage of the bar, summing to 100. */
  pct: number;
  /** Only for the remainder: how many tasks it stands for. */
  count?: number;
  /** Only for the remainder: true when every task in it was a quick touch. */
  allQuick?: boolean;
}

/**
 * The composition bar: named parts, then ONE remainder.
 *
 * A part is named while it is both within the top COMP_TOP_PARTS and wide enough
 * to see; everything else joins the remainder, which keeps its true width. A bar
 * of eleven 2px stripes is not a composition, it is the confetti this whole
 * redesign exists to remove.
 */
export function composition(chapter: Chapter, opts: { topParts?: number } = {}): CompSegment[] {
  const topParts = opts.topParts ?? COMP_TOP_PARTS;
  const named: ChapterPart[] = [];
  const rest: ChapterPart[] = [];
  for (const part of chapter.parts) {
    if (named.length < topParts && part.share >= COMP_MIN_SHARE) named.push(part);
    else rest.push(part);
  }
  const segments: CompSegment[] = named.map((p) => ({ taskId: p.taskId, ms: p.ms, pct: p.share * 100 }));
  if (rest.length > 0) {
    const ms = rest.reduce((sum, p) => sum + p.ms, 0);
    segments.push({
      taskId: null,
      ms,
      pct: chapter.workedMs > 0 ? (ms / chapter.workedMs) * 100 : 0,
      count: rest.length,
      allQuick: rest.every((p) => p.ms < QUICK_PART_MS),
    });
  }
  return segments;
}
