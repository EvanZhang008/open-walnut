/**
 * Settings > Remote Hosts: the new SSH hosts typed and not saved yet, kept for the browser session
 * so they outlive the pane (2026-11-04 review: a hostname typed with no alias was dropped without
 * a word when the person opened another pane and came back). Written on every change, read when
 * the pane opens; a draft that saved (config.yaml has its alias with its hostname) or was
 * cancelled is no longer written, and an untouched one never is. A draft refused for an alias
 * another host has is kept: it is not that host. Pure on a storage, so it is tested without a DOM.
 */
import { emptyHost, type HostEntry } from './remote-hosts-model';
import { untouchedDraft } from './host-row-model';

export const SSH_DRAFTS_KEY = 'walnut.remote-hosts.ssh-drafts';

interface StoreLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

function store(): StoreLike | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}

type Kept = Omit<HostEntry, '_key' | 'savedAlias'>;
/** config.yaml's hosts: alias to hostname. */
export type SavedHosts = ReadonlyMap<string, string>;

const isSaved = (h: Pick<HostEntry, 'alias' | 'hostname'>, saved: SavedHosts) => !!h.alias && saved.get(h.alias) === h.hostname;

/** The drafts to keep: new rows someone typed in, not saved under their alias yet. */
export function draftsToKeep(hosts: HostEntry[], saved: SavedHosts): Kept[] {
  return hosts
    .filter((h) => h.savedAlias === undefined && !untouchedDraft(h) && !isSaved(h, saved))
    .map(({ _key: _k, savedAlias: _s, ...rest }) => rest);
}

export function writeSshDrafts(hosts: HostEntry[], saved: SavedHosts, s: StoreLike | null = store()): void {
  if (!s) return;
  const keep = draftsToKeep(hosts, saved);
  try {
    if (keep.length) s.setItem(SSH_DRAFTS_KEY, JSON.stringify(keep));
    else s.removeItem(SSH_DRAFTS_KEY);
  } catch { /* a full or blocked storage keeps nothing; the rows on screen are unchanged */ }
}

/** The kept drafts as new rows (fresh keys); one config.yaml already has under its alias is left out. */
export function readSshDrafts(saved: SavedHosts, s: StoreLike | null = store()): HostEntry[] {
  if (!s) return [];
  let raw: unknown;
  try { raw = JSON.parse(s.getItem(SSH_DRAFTS_KEY) ?? '[]'); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: HostEntry[] = [];
  for (const d of raw) {
    if (!d || typeof d !== 'object') continue;
    const h = { ...emptyHost(), ...(d as Partial<Kept>) } as HostEntry;
    if (typeof h.alias !== 'string' || typeof h.hostname !== 'string') continue;
    if (isSaved(h, saved)) continue;
    out.push(h);
  }
  return out;
}
