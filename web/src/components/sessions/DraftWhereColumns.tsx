/**
 * The Where picker's Finder columns (experiment `project_first_start`, design A): from the home
 * (`~`) or the root (`/`) down to the browsed folder, one column per level, each listing its
 * folders on the browsed machine. A click opens a folder (its column appears to the right); a
 * double click, or a second click on the same folder, uses it. Typing after the last `/` filters
 * the last column. As many whole columns show as fit; the newest stays in view.
 *
 * Listing: one list-dirs read per level (listDirsCached, aborted when the machine or the path
 * changes), a connecting machine polled a few times, a failure said in its column.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { listDirs, listDirsCached } from '@/api/sessions';
import { shownFailureSummary } from '@open-walnut/host-problem';
import { rememberHostHome } from '@/utils/home-folder';
import { useElementWidth } from '@/hooks/useElementWidth';
import { EmptyState, LoadingState, UnavailableState } from '@/components/common/EmptyState';
import { ICON_CHEVRON_RIGHT } from '@/components/common/Icons';
import { WhereIcon } from './DraftWhereIcons';
import { draftHostFor } from './draft-work-in';
import { childOf, nameOfPath, pathLevels, type UsedFolder } from './draft-where-find';

export interface FolderListing {
  status: 'loading' | 'done' | 'error';
  /** The folder's children's names, sorted. */
  names: string[];
  exists: boolean;
  /** The folder's absolute path, as the machine resolved it. */
  parent?: string;
  error?: string;
}

const COLUMN_PX = 180;
/** A machine still connecting (its first connect installs the daemon, up to a minute or so): asked again for about 90 s. */
const PENDING_TRIES = 30;
const PENDING_GAP_MS = 3000;
const DOUBLE_MS = 450;

const keyOf = (host: string, dir: string) => `${host}\t${dir}`;

/** The listings of `dirs` on `host` (each read once per open; the client cache keeps them 30 s). */
export function useFolderListings(host: string, dirs: readonly string[]): Map<string, FolderListing> {
  const [listings, setListings] = useState<Map<string, FolderListing>>(() => new Map());
  const want = dirs.join('\n');
  useEffect(() => {
    const ctrl = new AbortController();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const put = (dir: string, l: FolderListing) => setListings((m) => new Map(m).set(keyOf(host, dir), l));
    const read = (dir: string, tries: number) => {
      listDirsCached(`${dir === '/' ? '' : dir}/`, draftHostFor(host), { signal: ctrl.signal }).then((res) => {
        if (ctrl.signal.aborted) return;
        if (res.pending && tries > 0) {
          put(dir, { status: 'loading', names: [], exists: true, ...(res.pending.label ? { error: res.pending.label } : {}) });
          timers.push(setTimeout(() => read(dir, tries - 1), PENDING_GAP_MS));
          return;
        }
        if (res.pending || res.hostError) { put(dir, { status: 'error', names: [], exists: false, error: shownFailureSummary(res.hostError?.message) || 'The machine is still connecting' }); return; }
        if (dir === '~') rememberHostHome(draftHostFor(host), res.parent);
        const parent = res.parent.endsWith('/') ? res.parent : `${res.parent}/`;
        const names = res.dirs.filter((p) => p.startsWith(parent) && p.length > parent.length && !p.slice(parent.length).includes('/'))
          .map((p) => p.slice(parent.length)).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        put(dir, { status: 'done', names, exists: res.exists, parent: res.parent.replace(/\/+$/, '') || '/' });
      }).catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        put(dir, { status: 'error', names: [], exists: false, error: err instanceof Error ? err.message : String(err) });
      });
    };
    for (const dir of want.split('\n').filter(Boolean)) {
      if (listings.get(keyOf(host, dir))?.status === 'done') continue;
      put(dir, { status: 'loading', names: [], exists: true });
      read(dir, PENDING_TRIES);
    }
    return () => { ctrl.abort(); timers.forEach(clearTimeout); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listings is read to skip what is already in; a new list re-runs it
  }, [host, want]);
  return new Map(dirs.map((d) => [d, listings.get(keyOf(host, d)) ?? { status: 'loading', names: [], exists: true }]));
}

/** The search's own listing of a machine: still reading, read, or read only in part (a failed or connecting read). */
export interface SearchFolders { status: 'loading' | 'done' | 'partial'; dirs: string[] }
const STILL_LISTING: SearchFolders = { status: 'loading', dirs: [] };

/**
 * The folders the search looks through on `host` besides the used ones: three levels under its home
 * and two under each of its places outside the home (`/srv/data`), read once per open and machine,
 * uncached; the server caps each read (entries and time). A machine still connecting is asked again
 * (as the columns do), so a search typed while it connects fills in once it answers.
 */
export function useHomeFolders(host: string, on: boolean, places: readonly string[] = []): SearchFolders {
  const [found, setFound] = useState<{ key: string } & SearchFolders | null>(null);
  const key = [host, ...places].join('\n');
  useEffect(() => {
    if (!on || (found?.key === key && found.status === 'done')) return;
    const ctrl = new AbortController();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const reads = [{ prefix: '~/', depth: 3 }, ...places.map((p) => ({ prefix: `${p}/`, depth: 2 }))];
    const readAll = (tries: number) => {
      Promise.all(reads.map((r) => listDirs(r.prefix, draftHostFor(host), { signal: ctrl.signal, depth: r.depth })
        .then((res) => (res.pending ? 'pending' as const : res.hostError ? null : { dirs: res.dirs, whole: !res.incomplete })).catch(() => null))).then((all) => {
        if (ctrl.signal.aborted) return;
        const read = all.filter((d): d is { dirs: string[]; whole: boolean } => !!d && d !== 'pending');
        const dirs = read.flatMap((d) => d.dirs);
        const waiting = all.includes('pending') && tries > 0;
        // A read the server cut short (its entry or time cap) is a part, not the whole machine.
        setFound({ key, dirs, status: waiting ? 'loading' : read.length === all.length && read.every((d) => d.whole) ? 'done' : 'partial' });
        if (waiting) timers.push(setTimeout(() => readAll(tries - 1), PENDING_GAP_MS));
      });
    };
    if (found?.key !== key) setFound({ key, dirs: [], status: 'loading' });
    readAll(PENDING_TRIES);
    return () => { ctrl.abort(); timers.forEach(clearTimeout); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- key names host and places; found is read to skip a done read
  }, [key, on]);
  // The same object while nothing changed, so the search's memo holds.
  return found?.key === key ? found : STILL_LISTING;
}

/** The levels from the first one down to `dir`, as shown (`~`, `~/a`, `~/a/b`). */
export const columnChain = (dir: string): string[] => pathLevels(dir).map((l) => l.dir);

/** The last column's folders as shown (the typed filter applied). */
export function lastColumnFolders(dir: string, listing: FolderListing | undefined, filter: string): string[] {
  const f = filter.toLowerCase();
  return (listing?.names ?? []).filter((n) => !f || n.toLowerCase().includes(f)).map((n) => childOf(dir, n));
}

export function DraftWhereColumns({ host, hostName, dir, filter, listings, keyed, usedAt, onOpen, onUse }: {
  host: string;
  hostName: string;
  /** The browsed folder, as shown. */
  dir: string;
  filter: string;
  listings: Map<string, FolderListing>;
  /** The keyboard's folder in the last column ('' none). */
  keyed: string;
  /** A used folder's starts, by its path as shown. */
  usedAt: (shown: string) => UsedFolder | undefined;
  onOpen: (dir: string) => void;
  onUse: (dir: string) => void;
}) {
  // A machine whose first level cannot be listed shows that once, across the columns, never the
  // same failure in every level of the path.
  const fullChain = columnChain(dir);
  const firstFailed = listings.get(fullChain[0])?.status === 'error';
  const chain = firstFailed ? fullChain.slice(0, 1) : fullChain;
  const boxRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(boxRef);
  const fit = Math.max(1, Math.floor((width || COLUMN_PX * 3) / COLUMN_PX));
  const last = useRef<{ dir: string; at: number } | null>(null);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [dir, fit]);
  useLayoutEffect(() => {
    boxRef.current?.querySelectorAll('.is-target').forEach((e) => e.scrollIntoView({ block: 'nearest' }));
  }, [keyed, dir]);

  // One click opens; the second click of a double click uses the folder its FIRST click opened, even
  // when the columns moved under the pointer and the second click lands on another folder (its
  // child). Only a real double click (detail 2) uses: a click that saved and closed the picker
  // would leave the next click to fall through onto whatever is under it.
  // The second click counts wherever it lands in the columns (a column still listing, the space under
  // a short list): the first click's new column can sit under the pointer by then. One listener on
  // the columns for that; each folder stays a button that opens it.
  const handlers = useRef({ onOpen, onUse });
  useLayoutEffect(() => { handlers.current = { onOpen, onUse }; });
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const prev = last.current;
      const now = Date.now();
      if (e.detail >= 2 && prev && now - prev.at < DOUBLE_MS) { last.current = null; handlers.current.onUse(prev.dir); return; }
      const path = (e.target as Element).closest<HTMLElement>('.draft-v6-wc-item')?.dataset.path;
      if (!path) return;
      last.current = { dir: path, at: now };
      handlers.current.onOpen(path);
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, []);

  // Always as many columns as fit (empty ones on the right), so a new level never resizes the ones
  // under the pointer.
  return (
    <div ref={boxRef} className="draft-v6-wc" data-testid="draft-v6-where-columns" style={{ ['--cols' as string]: fit }}>
      {chain.map((level, ci) => {
        const listing = listings.get(level);
        const isLast = ci === chain.length - 1;
        const next = chain[ci + 1];
        const names = isLast ? lastColumnFolders(level, listing, filter) : (listing?.names ?? []).map((n) => childOf(level, n));
        const label = ci === 0 ? (level === '~' ? `Home on ${hostName}` : `/ on ${hostName}`) : nameOfPath(level);
        return (
          <div key={level} className={`draft-v6-wc-col${firstFailed ? ' is-across' : ''}`} role="group" aria-label={label}>
            <div className="draft-v6-wc-label wn-meta" title={level}>{ci === 0 && level === '~' && <WhereIcon kind="home" size={12} />}{label}</div>
            {isLast && filter && <div className="draft-v6-wc-filter wn-meta">matching “{filter}”</div>}
            <div className="draft-v6-wc-list" role="listbox" aria-label={`Folders in ${label}`}>
              {listing?.status === 'loading' && <LoadingState size="row" role="presentation" title={listing.error ? `${listing.error}…` : 'Listing…'} />}
              {listing?.status === 'error' && <UnavailableState size="row" role="presentation" title={`Could not list on ${hostName}`}
                detail={`${listing.error ? `${listing.error.replace(/\.+$/, '')}. ` : ''}Pick another machine on the left, or go back to Recent and most used.`} />}
              {listing?.status === 'done' && !listing.exists && <EmptyState size="row" role="presentation" title="No such folder" />}
              {listing?.status === 'done' && listing.exists && !names.length && <EmptyState size="row" role="presentation" title={filter ? 'No folder matches' : 'No folders inside'} />}
              {names.map((path) => {
                const on = path === next;
                // The folder the button saves now: the keyboard's folder in the last column, else the
                // browsed folder (its parents keep a quieter fill).
                const target = isLast ? keyed === path : on && ci === chain.length - 2 && !keyed;
                const used = usedAt(path);
                return (
                  <button key={path} type="button" role="option" aria-selected={target} tabIndex={-1}
                    className={`draft-v6-wc-item wn-pick-row${on ? ' is-on' : ''}${target ? ' is-target' : ''}`}
                    data-testid="draft-v6-column-folder" data-path={path} title={`${path} (double-click to use it)`}
                    onMouseDown={(e) => e.preventDefault()}>
                    <WhereIcon kind="folder" size={14} />
                    <span className="draft-v6-wc-name wn-title">{nameOfPath(path)}</span>
                    {used && <span className="draft-v6-wc-used wn-meta" title={`${used.count} tasks started here`}>{used.count}</span>}
                    <span className="draft-v6-wc-chev" aria-hidden="true">{ICON_CHEVRON_RIGHT}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
