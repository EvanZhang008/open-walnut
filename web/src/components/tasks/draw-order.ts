/**
 * The order the Home list draws its rows in: the order it holds (`sortOrder` in TodoPanel, which a
 * re-sort reaches only after 3 s, so rows do not move under the pointer), or the order the tasks
 * sort to now, for every change the list takes at once.
 *
 * `sortOrder` is state an effect refreshes after the render, so a change the effect takes at once
 * was drawn for one commit in the old order and moved in the next. A task that arrived was drawn at
 * the end of its project and then moved to its place, which keyed reconciliation turns into a move
 * of every row it passed, and Chromium's scroll anchoring loses the row being read on node moves (a
 * list scrolled into an open project landed near its top, 2026-11-10). A drop in a manual project
 * was drawn in the old order once more, and the list's scroll keeper held the row the drop then
 * moved, so the whole list followed it. The render takes those orders itself: new sort settings, a
 * task that arrived or left, any change in the order of manually sorted tasks. Pure, no React.
 */
export interface DrawOrderInputs {
  /** The held order was sorted with other settings than the live one. */
  settingsChanged: boolean;
  /** Tasks in a project sorted by hand. */
  manual: ReadonlySet<string>;
}

export function orderToDraw(held: readonly string[], live: readonly string[], opts: DrawOrderInputs): readonly string[] {
  if (opts.settingsChanged) return live;
  if (!sameMembers(held, live)) return live;
  if (manualMoved(held, live, opts.manual)) return live;
  return held;
}

/**
 * The same tasks in both orders. Compared between the two orders rather than against the task list,
 * so a task neither order holds (a parent cycle leaves it out) never sorts the list again.
 */
export function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const inA = new Set(a);
  return b.every((id) => inA.has(id));
}

/** Whether the manually sorted tasks come in another order. */
export function manualMoved(a: readonly string[], b: readonly string[], manual: ReadonlySet<string>): boolean {
  if (manual.size === 0) return false;
  const was = a.filter((id) => manual.has(id));
  const now = b.filter((id) => manual.has(id));
  return was.length !== now.length || was.some((id, i) => id !== now[i]);
}
