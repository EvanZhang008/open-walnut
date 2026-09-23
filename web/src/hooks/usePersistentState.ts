import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * `useState` whose value survives the component unmounting — backed by localStorage.
 *
 * Every route except Home unmounts on navigation, so a filter tab, a search box or a
 * collapsed-group set held in plain state comes back reset. This hook is the one
 * line that fixes that for small view choices. Rules it encodes:
 *   - the stored value is validated by `accept` before use, so a shape from an older
 *     build (or a hand-edited key) degrades to `initial` instead of crashing render;
 *   - the write happens inside the setter, never in an effect, so a mount does not
 *     write the value it just read (and a first-boot mount does not create the key);
 *   - storage failures (private mode, quota) are swallowed: the page still works,
 *     it just forgets.
 *
 * Not for large or fast-changing data (it JSON-encodes on every set) and not for
 * anything that belongs to the server.
 */
export function usePersistentState<T>(
  key: string,
  initial: T | (() => T),
  accept: (v: unknown) => v is T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        if (accept(parsed)) return parsed;
      }
    } catch { /* fall through to initial */ }
    return typeof initial === 'function' ? (initial as () => T)() : initial;
  });

  const set = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    setValue((prev) => {
      const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
      try { localStorage.setItem(key, JSON.stringify(resolved)); } catch { /* forget */ }
      return resolved;
    });
  }, [key]);

  return [value, set];
}

/** Validators for the common shapes. */
export const isString = (v: unknown): v is string => typeof v === 'string';
export const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
/** One of a fixed set of literals, e.g. `oneOf(['all', 'builtin', 'user'])`. */
export function oneOf<const T extends readonly string[]>(allowed: T): (v: unknown) => v is T[number] {
  return (v: unknown): v is T[number] => typeof v === 'string' && (allowed as readonly string[]).includes(v);
}
