/**
 * Once per problem until it heals: an error the server reports again and again (the same
 * dedupKey) toasts the first time only, until a recovery says it healed. A dismissed toast or
 * card does not arm it again, nor does a reload (the memory is in localStorage); healed and
 * broken again is a new time. The person's own action is not held to it: each failure of a
 * click answers that click (2026-11-17, the user: "if it show once don't show it so many
 * times"). Host problems follow the same rule in host-problem-toasts.ts.
 */
const KEY = 'walnut.toasted-until-healed.v1';
const MAX = 300;

function read(): string[] {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

function write(keys: string[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(keys.slice(-MAX))); } catch { /* private mode: at worst it toasts again */ }
}

/** May this problem toast now? True once; then false until `healedOnce` releases it. */
export function firstToastUntilHealed(dedupKey: string): boolean {
  const keys = read();
  if (keys.includes(dedupKey)) return false;
  keys.push(dedupKey);
  write(keys);
  return true;
}

/** It healed (a recovery): the next time it breaks toasts again. */
export function healedOnce(dedupKey: string): void {
  const keys = read();
  if (!keys.includes(dedupKey)) return;
  write(keys.filter((k) => k !== dedupKey));
}
