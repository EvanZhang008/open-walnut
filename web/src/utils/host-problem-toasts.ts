/**
 * Which host problems get a toast now (HostProblemNotices), pure so the rule is
 * testable. A host toasts once when its problem first appears, and not again
 * until it heals: a new cause on a host still broken (a connect failure, then a
 * timeout, then a daemon that did not start) is the same thing and toasts
 * nothing (2026-11-17, the user: "if it show once don't show it so many times").
 * A reload does not toast it again (the memory is in localStorage), so a host
 * that is down for days toasts once, not on every page load. A dismissed row
 * ("I know") never reaches this list (the model leaves it out).
 */
import type { BannerRow } from '@/utils/attention-banner-model';

/** Problem key (problemKeyOf) -> the hosts it named, the last time it was a problem. */
export type ToastedProblems = ReadonlyMap<string, readonly string[]>;

/**
 * One problem as the toast memory knows it: the row, its cause and its hosts. A host whose
 * cause changes (a connect failure, then Claude Code missing) or a host joining a login
 * group is a new problem and toasts; the same problem in a new frame is not.
 */
export function problemKeyOf(r: BannerRow): string {
  return `${r.id}#${r.kind ?? r.problem?.kind ?? r.type}#${[...r.hosts].sort().join(',')}`;
}

export const TOASTED_STORAGE_KEY = 'walnut.host-problem-toasted.v1';

/** Same entries, same hosts: nothing to write. */
export function sameToasted(a: ToastedProblems, b: ToastedProblems): boolean {
  if (a.size !== b.size) return false;
  for (const [k, hosts] of a) {
    const other = b.get(k);
    if (!other || other.length !== hosts.length || other.some((h, i) => h !== hosts[i])) return false;
  }
  return true;
}

export interface ToastDecision {
  /** New problem rows to toast, in the model's order. */
  toast: BannerRow[];
  /** The memory after this frame. */
  known: ToastedProblems;
  /** Hosts that healed this frame (they were a known problem and are healthy now). */
  healed: string[];
}

/**
 * `problems`: the rows the panel lists now (no 'ready' or 'trying' row).
 * `isKnownHost` / `isHealthy`: a host still configured, and connected with no problem.
 * An auto retry in flight is not a new problem: a row that leaves while its hosts are
 * still unhealthy stays known under its last hosts.
 */
export function decideHostToasts(
  problems: readonly BannerRow[],
  known: ToastedProblems,
  isKnownHost: (host: string) => boolean,
  isHealthy: (host: string) => boolean,
): ToastDecision {
  const next = new Map<string, readonly string[]>(problems.map((r) => [problemKeyOf(r), r.hosts]));
  const healed = new Set<string>();
  for (const [id, hosts] of known) {
    if (next.has(id)) continue;
    for (const h of hosts) if (isKnownHost(h) && isHealthy(h)) healed.add(h);
    // A host that is gone from the config is forgotten with it.
    const open = hosts.filter((h) => isKnownHost(h) && !isHealthy(h));
    if (open.length) next.set(id, open);
  }
  // Once per host until it heals: a row toasts only for a host no known problem names.
  const shown = new Set<string>([...known.values()].flat())
  return { toast: problems.filter((r) => !known.has(problemKeyOf(r)) && r.hosts.some((h) => !shown.has(h))), known: next, healed: [...healed] };
}

export function readToasted(): ToastedProblems {
  try {
    const raw = localStorage.getItem(TOASTED_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return new Map();
    const out = new Map<string, string[]>();
    for (const [id, hosts] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(hosts)) out.set(id, hosts.filter((h): h is string => typeof h === 'string'));
    }
    return out;
  } catch {
    return new Map();
  }
}

export function writeToasted(known: ToastedProblems): void {
  try {
    localStorage.setItem(TOASTED_STORAGE_KEY, JSON.stringify(Object.fromEntries(known)));
  } catch { /* private mode or a full store: at worst a problem toasts again next load */ }
}

/** The toast's words for one or several new problem rows. */
export function hostToastText(rows: readonly BannerRow[]): { title: string; body?: string } {
  const lineOf = (r: BannerRow) => r.headline ?? r.problem?.message ?? `${r.labels.join(', ')} needs attention`;
  if (rows.length === 1) {
    const r = rows[0];
    const body = r.hint || r.summary;
    return body ? { title: lineOf(r), body } : { title: lineOf(r) };
  }
  const hosts = rows.reduce((n, r) => n + r.hosts.length, 0);
  return { title: `${hosts} remote hosts need attention`, body: rows.map(lineOf).join('. ') };
}
