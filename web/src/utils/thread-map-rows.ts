/**
 * Row arithmetic for the conversation map: the three derivations the always-open
 * outline needs that the thread tree does not already carry.
 *
 * Pure and here rather than inside the component because "has this branch grown
 * since I looked at it?" is shared with the child cards at the end of a thread (two
 * answers to that question would show a badge in one place and not the other), and
 * because a count-to-words rule only stays right if a test pins it.
 */

/** The root row's secondary text. Empty when there are no branches: a map of a
 *  conversation that has not branched yet has nothing to count. */
export function branchCountLabel(count: number): string {
  if (count <= 0) return '';
  return `${count} ${count === 1 ? 'branch' : 'branches'}`;
}

/** A thread's size, in the unit the transcript is made of. */
export function turnCountLabel(turns: number): string {
  return `${turns} ${turns === 1 ? 'turn' : 'turns'}`;
}

/**
 * Rows landed in a thread since it was last looked at.
 *
 * A thread with NO baseline has never been looked at, so it has nothing to
 * announce (the same rule the child cards use: a branch that already existed when
 * you arrived does not announce itself). A baseline above the current count means
 * the thread shrank (a /compact rewrote the transcript), which is not news either.
 */
export function hasNewRows(
  key: string,
  rows: ReadonlyMap<string, number>,
  seen: ReadonlyMap<string, number>,
): boolean {
  const baseline = seen.get(key);
  if (baseline === undefined) return false;
  return (rows.get(key) ?? 0) > baseline;
}
