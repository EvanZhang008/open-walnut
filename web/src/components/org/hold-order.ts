import { useEffect, useRef, useState } from 'react';

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

/** Why a list is held: the pointer is over it, the focus is in it. */
export interface HoldReasons { pointer: boolean; focus: boolean }

/**
 * One reason comes or goes: the first to come takes the order on screen (`take`), the last to go
 * lets it follow again (`free`), any other step keeps the hold it found. Pure.
 */
export function stepHold(r: HoldReasons, why: keyof HoldReasons, on: boolean): { reasons: HoldReasons; act: 'take' | 'free' | 'keep' } {
  const reasons = { ...r, [why]: on };
  const was = r.pointer || r.focus;
  const now = reasons.pointer || reasons.focus;
  return { reasons, act: now && !was ? 'take' : !now && was ? 'free' : 'keep' };
}

/**
 * A list that holds still under the pointer: spread the handlers on the element the pointer
 * is over, draw `shown`. A list drawn under a resting pointer (a reload while it loads) gets
 * its pointerenter before its rows, so the hold waits for them (settleHold): 2026-11-03, a
 * new project took the top of the Org list under a resting pointer and Down picked it.
 *
 * `onFocus`/`onBlur` (optional) hold it the same while the focus is inside, the pointer away (a
 * Threads card's Follow up box he types in: 2026-11-25). The hold is taken when the first reason
 * comes and let go when the last one goes; the focus is read again when the pointer leaves, since
 * a focused row that is removed takes the focus with it and sends no blur.
 */
export function usePointerHold<T extends { key: string }>(rows: readonly T[]): {
  shown: readonly T[];
  onPointerEnter: () => void;
  onPointerLeave: (e?: { currentTarget: Element }) => void;
  onFocus: () => void;
  onBlur: (e: { currentTarget: Element; relatedTarget: EventTarget | null }) => void;
} {
  const [held, setHeld] = useState<readonly string[] | null>(null);
  const reasons = useRef<HoldReasons>({ pointer: false, focus: false });
  const keys = rows.map((r) => r.key);
  const sig = JSON.stringify(keys);
  useEffect(() => {
    setHeld((h) => settleHold(h, keys));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sig` stands for the keys
  }, [sig]);
  const set = (why: keyof HoldReasons, on: boolean) => {
    const step = stepHold(reasons.current, why, on);
    reasons.current = step.reasons;
    if (step.act === 'take') setHeld(keys);
    else if (step.act === 'free') setHeld(null);
  };
  const onPointerEnter = () => set('pointer', true);
  const onPointerLeave = (e?: { currentTarget: Element }) => {
    if (e && reasons.current.focus && !e.currentTarget.contains(document.activeElement)) reasons.current = { ...reasons.current, focus: false };
    set('pointer', false);
  };
  const onFocus = () => set('focus', true);
  const onBlur = (e: { currentTarget: Element; relatedTarget: EventTarget | null }) => {
    if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) set('focus', false);
  };
  return { shown: holdOrder(rows, settleHold(held, keys)), onPointerEnter, onPointerLeave, onFocus, onBlur };
}
