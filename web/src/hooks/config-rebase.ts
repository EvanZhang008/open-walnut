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

/**
 * This page's own writes, so a save is measured against what the user saw
 * after them and not only against the last config painted.
 *
 * Two saves in a row (a switch turned off, then on again before the first
 * save's refresh came back) used to lose the second: it was diffed against the
 * painted config, which still showed the switch on, so "on" read as no change
 * and the server's "off" from the first save was kept (2026-11-11, the Backup
 * switch on a slow runner). Each landed write gets a number; a painted config
 * carries the number of the last write it reflects; a save replays what each
 * newer write CHANGED (its partial against the base it was measured on) over
 * its base before it diffs. Only the change, never the whole payload sent: that
 * also carries sibling fields read from the server, and replaying those would
 * make a section's stale copy of another writer's field look like an edit.
 */
export class OwnWrites {
  private seq = 0;
  private writes: { seq: number; partial: Partial<Config>; base: Config }[] = [];

  /** The write count now: a read issued now reflects every write up to it. */
  mark(): number {
    return this.seq;
  }

  /** A save of `partial`, measured against `base`, landed on the server. */
  wrote(partial: Partial<Config>, base: Config): void {
    this.writes.push({ seq: ++this.seq, partial, base });
    // A queued save holds a base a few writes old at most; keep a margin, never an unbounded list.
    if (this.writes.length > 50) this.writes.splice(0, this.writes.length - 50);
  }

  /** `base` (painted at `baseMark`) with what this page's later writes changed laid over it. */
  seen(base: Config, baseMark: number): Config {
    let out = base;
    for (const w of this.writes) {
      if (w.seq <= baseMark) continue;
      const changed = rebaseOnto(w.partial, w.base, out) as Obj;
      const next: Obj = { ...(out as unknown as Obj) };
      for (const [k, v] of Object.entries(changed)) if (v !== undefined) next[k] = v;
      out = next as unknown as Config;
    }
    return out;
  }
}
