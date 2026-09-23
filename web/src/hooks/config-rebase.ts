import type { Config } from '@open-walnut/core';

type Obj = Record<string, unknown>;

function isPlainObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Re-apply a Settings save onto the server's CURRENT config.
 *
 * A section builds its save by spreading the config the page rendered with
 * (`{ agent: { ...config.agent, language } }`), and updateConfig replaces the
 * whole top-level key. When another window, the composer, or an agent changed
 * a sibling field after this page loaded, that spread silently wrote the old
 * value back (2026-09-22: an open Settings window restored
 * `agent.main_provider: bedrock` twenty minutes after it was switched away).
 *
 * So each object-valued key keeps only what the section actually changed
 * relative to what it saw (`base`), laid over `fresh`, at every depth: two
 * writes to `providers.bedrock` (a new token, an added model) each touch only
 * their own field, and a plugin form that re-sends a field it no longer shows
 * never restores that field's old value. Scalars, arrays, and `null` (delete
 * the section) pass through as written.
 */
export function rebaseOnto(partial: Partial<Config>, base: Config, fresh: Config): Partial<Config> {
  const out: Obj = {};
  const b = base as unknown as Obj;
  const f = fresh as unknown as Obj;
  for (const [key, next] of Object.entries(partial as Obj)) out[key] = rebaseValue(next, b[key], f[key]);
  return out as Partial<Config>;
}

function rebaseValue(next: unknown, was: unknown, now: unknown): unknown {
  if (!isPlainObject(next) || !isPlainObject(was) || !isPlainObject(now)) return next;
  const merged: Obj = { ...now };
  for (const sub of new Set([...Object.keys(was), ...Object.keys(next)])) {
    const nextVal = next[sub];
    if (nextVal === undefined) {
      // Dropped by the section (e.g. `main_model: v || undefined`): a deletion,
      // but only if it existed when the section looked.
      if (was[sub] !== undefined) delete merged[sub];
      continue;
    }
    if (!same(nextVal, was[sub])) merged[sub] = rebaseValue(nextVal, was[sub], now[sub]);
  }
  return merged;
}
