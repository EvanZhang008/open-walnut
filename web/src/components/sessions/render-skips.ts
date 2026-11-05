/**
 * Stretches of the render window left out on purpose: "N turns not shown here".
 *
 * The render window is a tail of the transcript (render-window.ts). A jump far
 * back, the find bar stepping onto a match in an old turn, used to grow that
 * tail all the way down to the old turn, so one Enter rendered most of a long
 * session (measured on a 70-turn chat: 20 rows became 136, 5,000 px became
 * 32,000). Now the jump renders the target's own turn and leaves the stretch
 * between it and what was already on screen out, with a divider that shows it
 * on request. Another jump into that stretch shows just its turn again, and
 * splits the stretch in two.
 *
 * A stretch is named by row identity, never by index: the array's indexing
 * shifts under every older page (render-window.ts says why).
 */

/** Left out: from the row `from` up to, not including, the row `resume`. */
export interface RenderSkip { from: string; resume: string }

/** A skip placed in the current rows: [start, end), and how many turns it holds. */
export interface ResolvedSkip { skip: RenderSkip; start: number; end: number; turns: number }

/** A stretch shorter than this is rendered: a divider for two rows is noise. */
export const MIN_SKIP_ROWS = 6;

type Row = { msgId?: string; walnutMessageId?: string };
const idOf = (m: Row | undefined): string | undefined => m?.msgId ?? m?.walnutMessageId;

function indexById<T extends Row>(messages: readonly T[]): Map<string, number> {
  const at = new Map<string, number>();
  messages.forEach((m, i) => { const id = idOf(m); if (id && !at.has(id)) at.set(id, i); });
  return at;
}

/** The skips that still fit the rows (both ends present, in order), sorted, never overlapping. */
export function resolveSkips<T extends Row>(
  messages: readonly T[], skips: readonly RenderSkip[], isTurn: (m: T) => boolean,
): ResolvedSkip[] {
  if (!skips.length) return [];
  const at = indexById(messages);
  const out: ResolvedSkip[] = [];
  for (const skip of skips) {
    const start = at.get(skip.from);
    const end = at.get(skip.resume);
    if (start === undefined || end === undefined || end - start < 1) continue;
    let turns = 0;
    for (let i = start; i < end; i++) if (isTurn(messages[i]!)) turns++;
    out.push({ skip, start, end, turns });
  }
  out.sort((a, b) => a.start - b.start);
  return out.filter((s, i) => i === 0 || s.start >= out[i - 1]!.end);
}

/** The first row after the turn holding `t` (a turn starts at a row `isTurn` says yes to). */
function turnEnd<T>(messages: readonly T[], t: number, isTurn: (m: T) => boolean): number {
  for (let i = t + 1; i < messages.length; i++) if (isTurn(messages[i]!)) return i;
  return messages.length;
}

/** The row starting the turn that holds `t` (its person's message), not before `floor`. */
export function turnStart<T>(messages: readonly T[], t: number, isTurn: (m: T) => boolean, floor: number): number {
  for (let i = t; i > floor; i--) if (isTurn(messages[i]!)) return i;
  return floor;
}

/** A skip from row `a` to row `b` when it is long enough and both ends have ids. */
function skipBetween<T extends Row>(messages: readonly T[], a: number, b: number): RenderSkip | null {
  if (b - a < MIN_SKIP_ROWS) return null;
  // The first row left out must have an id; rows before it simply render.
  let from = a;
  while (from < b && !idOf(messages[from])) from++;
  const resume = idOf(messages[b]);
  const fromId = idOf(messages[from]);
  if (!resume || !fromId || b - from < MIN_SKIP_ROWS) return null;
  return { from: fromId, resume };
}

/**
 * The skips after a jump to row `target`, with the window starting at
 * `windowStart` before it. Above the window: the window will start at the
 * target, so everything from the end of the target's turn to the old start is
 * left out. Inside a skip: that skip splits around the target's turn.
 */
export function planSkipsForReveal<T extends Row>(
  messages: readonly T[], skips: readonly RenderSkip[], windowStart: number, target: number, isTurn: (m: T) => boolean,
): RenderSkip[] {
  if (target < 0 || target >= messages.length) return [...skips];
  const resolved = resolveSkips(messages, skips, isTurn);
  if (target < windowStart) {
    const gap = skipBetween(messages, turnEnd(messages, target, isTurn), windowStart);
    return gap ? [...resolved.map((r) => r.skip), gap] : resolved.map((r) => r.skip);
  }
  const inside = resolved.find((r) => target >= r.start && target < r.end);
  if (!inside) return resolved.map((r) => r.skip);
  const from = turnStart(messages, target, isTurn, inside.start);
  const to = Math.min(turnEnd(messages, target, isTurn), inside.end);
  const before = skipBetween(messages, inside.start, from);
  const after = skipBetween(messages, to, inside.end);
  return resolved.flatMap((r) => (r === inside ? [before, after].filter((s): s is RenderSkip => !!s) : [r.skip]));
}
