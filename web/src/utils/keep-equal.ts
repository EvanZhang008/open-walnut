/**
 * Structural sharing for a value rebuilt from the task list: every part of `next` that equals the
 * same part of `prev` is replaced by `prev`'s own object, so a memoized child handed an unchanged
 * part sees the same reference and does not draw again.
 *
 * Why (2026-11-23, task 9bceb9f2): the Org page rebuilds its rows from the whole list on every
 * task update (about 13 a minute from agents' status writes); each rebuild made every row a new
 * object, so every row, the list and the node beside them drew again for one task's new words.
 *
 * Plain objects and arrays are compared by content, deeply (an array's elements that carry a
 * string `key` or `id` are matched by it, wherever they moved); a Set by its members, a Map by its
 * keys and (deeply) its values, each kept whole or replaced whole; anything else (functions,
 * Dates, class instances) by identity.
 */
import { useLayoutEffect, useMemo, useRef } from 'react';

export function keepEqual<T>(prev: T, next: T): T {
  return share(prev, next) as T;
}

function isPlain(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** A list element's own name, when it is a plain object with a string `key` or `id`. */
function nameOf(v: unknown): string | undefined {
  if (!isPlain(v)) return undefined;
  const n = typeof v.key === 'string' ? v.key : typeof v.id === 'string' ? v.id : undefined;
  return n === undefined ? undefined : `${typeof v.key === 'string' ? 'k' : 'i'}:${n}`;
}

function share(prev: unknown, next: unknown): unknown {
  if (Object.is(prev, next)) return prev;
  if (Array.isArray(prev) && Array.isArray(next)) {
    // Rows that name themselves (`key` or `id`) are matched by name, so a list re-sorted by one
    // row's change keeps every other row's object where it moved to.
    const byName = new Map<string, unknown>();
    for (const v of prev) { const n = nameOf(v); if (n !== undefined && !byName.has(n)) byName.set(n, v); }
    let same = prev.length === next.length;
    const out = next.map((v, i) => {
      const n = nameOf(v);
      const was = n !== undefined && byName.has(n) ? byName.get(n) : i < prev.length ? prev[i] : undefined;
      const kept = was === undefined ? v : share(was, v);
      if (kept !== prev[i]) same = false;
      return kept;
    });
    return same ? prev : out;
  }
  if (prev instanceof Set && next instanceof Set) {
    if (prev.size !== next.size) return next;
    for (const v of next) if (!prev.has(v)) return next;
    return prev;
  }
  if (prev instanceof Map && next instanceof Map) {
    if (prev.size !== next.size) return next;
    for (const [k, v] of next) if (!prev.has(k) || share(prev.get(k), v) !== prev.get(k)) return next;
    return prev;
  }
  if (isPlain(prev) && isPlain(next)) {
    const keys = Object.keys(next);
    let same = keys.length === Object.keys(prev).length;
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const kept = Object.prototype.hasOwnProperty.call(prev, k) ? share(prev[k], next[k]) : next[k];
      if (kept !== prev[k] || !Object.prototype.hasOwnProperty.call(prev, k)) same = false;
      out[k] = kept;
    }
    return same ? prev : out;
  }
  return next;
}

/**
 * `next`, sharing every part equal to what the last COMMITTED render returned (keepEqual). Against
 * the committed value, never a ref written during render: these pages render inside transitions,
 * where React may drop a render, and sharing with a dropped render's objects handed every memo'd
 * child an object it had never seen (2026-11-23: unchanged Org rows drew on each task update).
 */
export function useKeepEqual<T>(next: T): T {
  const committed = useRef(next);
  const kept = useMemo(() => keepEqual(committed.current, next), [next]);
  useLayoutEffect(() => { committed.current = kept; }, [kept]);
  return kept;
}
