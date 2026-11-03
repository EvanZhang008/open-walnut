import { useEffect, useState } from 'react';

/**
 * Rows in the order `held` names (the order they had when the pointer came over the list),
 * then any row that arrived since, in its own order. `null` = no hold.
 */
export function holdOrder<T extends { key: string }>(rows: readonly T[], held: readonly string[] | null): readonly T[] {
  if (!held) return rows;
  const at = new Map(held.map((k, i) => [k, i]));
  const kept = rows.filter((r) => at.has(r.key)).sort((a, b) => at.get(a.key)! - at.get(b.key)!);
  return [...kept, ...rows.filter((r) => !at.has(r.key))];
}

/**
 * The hold to keep once the rows are `keys`: a hold taken while the list had no rows yet
 * holds nothing (every row would then move live under the pointer), so it becomes the rows'
 * order as soon as they arrive. The same hold otherwise.
 */
export function settleHold(held: readonly string[] | null, keys: readonly string[]): readonly string[] | null {
  return held && held.length === 0 && keys.length > 0 ? keys : held;
}

/**
 * A list that holds still under the pointer: spread the handlers on the element the pointer
 * is over, draw `shown`. A list drawn under a resting pointer (a reload while it loads) gets
 * its pointerenter before its rows, so the hold waits for them (settleHold): 2026-11-03, a
 * new project took the top of the Org list under a resting pointer and Down picked it.
 */
export function usePointerHold<T extends { key: string }>(rows: readonly T[]): {
  shown: readonly T[];
  onPointerEnter: () => void;
  onPointerLeave: () => void;
} {
  const [held, setHeld] = useState<readonly string[] | null>(null);
  const keys = rows.map((r) => r.key);
  const sig = JSON.stringify(keys);
  useEffect(() => {
    setHeld((h) => settleHold(h, keys));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sig` stands for the keys
  }, [sig]);
  const onPointerEnter = () => setHeld(keys);
  const onPointerLeave = () => setHeld(null);
  return { shown: holdOrder(rows, settleHold(held, keys)), onPointerEnter, onPointerLeave };
}
