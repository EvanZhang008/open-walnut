import { useEffect, useRef } from 'react';

/**
 * Runs `reset` when `key` (a session id, say) changes under a mounted view, and never at mount,
 * where the state already holds what a reset would set.
 *
 * Why (2026-11-25, task 9bceb9f2): "clear this when the session changes" was written as
 * `useEffect(() => { setX(new Map()); ... }, [sessionId])`, which also runs at mount and hands the
 * view new empty copies of what it already holds. Each one drew the session panel (over a thousand
 * hooks) again while it opened: a panel drew about 37 times to open.
 */
export function useResetOnChange(key: unknown, reset: () => void): void {
  const last = useRef(key);
  useEffect(() => {
    if (Object.is(last.current, key)) return;
    last.current = key;
    // The render that brought the new key made this `reset`: it sees that render's values.
    reset();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- runs on the key alone
}
