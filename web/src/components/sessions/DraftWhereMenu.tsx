/**
 * The Where picker (experiment `project_first_start`, design A, picked 2026-11-24):
 *
 *   [● clouddev | search your folders, or type ~/ or /                 ×]
 *   Saved · clouddev  ~ › code › walnut           (a level cuts the path back to it)
 *   ┌ Recent and most used ┐ ┌ Auto, then Recent (10) or Most used (10) on every machine ┐
 *   │ Machines             │ │ or Finder columns from ~ or / on the browsed machine     │
 *   │ Places on clouddev   │ └──────────────────────────────────────────────────────────┘
 *   ↑↓ move  → open  ⌫ up a level        clouddev: ~/code/walnut   [Cancel] [Use this folder]
 *
 * Nothing is saved until "Use this folder" (or a click on a list row, a double click on a column
 * folder, Enter): picking a machine on the left only browses it, and Cancel leaves the draft as it
 * was. The footer always says which machine and folder the button saves. Mounted per open.
 * Rules and ranking: draft-where-find.ts; columns: DraftWhereColumns.tsx.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { SearchField } from '@/components/common/SearchField';
import { SegmentedControl } from '@/components/controls';
import { badge } from '@/components/common/badge';
import { EmptyState } from '@/components/common/EmptyState';
import { KeyHints } from '@/components/common/KeyHints';
import { knownHomeOf, tildePath, untildePath } from '@/utils/home-folder';
import { timeAgo } from '@/utils/time';
import { HostStatusDot } from './path-selector/HostStatusDot';
import { DraftWhereAuto } from './DraftWhereAuto';
import { DraftWhereSide } from './DraftWhereSide';
import { DraftPlaceRow, placeMeta, usePlaceOrder, type PlaceOrder } from './DraftPlaceRow';
import { DraftWhereLevels } from './DraftWhereLevels';
import { DraftWhereColumns, columnChain, lastColumnFolders, useFolderListings, useHomeFolders } from './DraftWhereColumns';
import type { DraftColumn } from './draft-column';
import type { DraftRowUpdate, DraftWhere } from './useDraftWhere';
import { detectProjectForFolder, draftHostFor } from './draft-work-in';
import { projectDisplayName } from '@/utils/project-display';
import {
  childOf, mostUsedFolders, nameOfPath, trimFolder as trim, parentLevel, pathLevels, placesOn, recentFolders, searchFolders, typedBrowse, usedFolders,
  type FolderMatch, type UsedFolder,
} from './draft-where-find';
import '@/styles/draft-v6-where.css';

/** One list row's height: the list shows whole rows only. */
const ROW_PX = 42;

interface ListItem { host: string; cwd: string; shown: string; used?: UsedFolder; match?: FolderMatch }
/** What the footer's button saves now. */
type Pending =
  | { kind: 'auto'; host: string; saved: boolean }
  | { kind: 'folder'; host: string; cwd: string; shown: string; verb: 'use' | 'keep' }
  | { kind: 'none'; host: string; shown: string; why: 'missing' | 'checking' | 'empty' | 'unreachable' };

/** The button's words when there is nothing to save, by why. */
const NONE_WORDS: Record<Extract<Pending, { kind: 'none' }>['why'], string> = {
  checking: 'Checking…', missing: 'No such folder', empty: 'Pick a folder', unreachable: 'Cannot list here', // empty-state-ok: a button's words
};

/** A folder shown under a listed level, by the path the machine resolved for that level. */
function resolvedIn(level: { status: string; parent?: string } | undefined, shown: string): string | undefined {
  return level?.status === 'done' && level.parent ? childOf(level.parent, nameOfPath(shown)) : undefined;
}

export function DraftWhereMenu({ draft, where, initialQuery, onClose, onPicked, onUpdate }: {
  draft: DraftColumn;
  where: DraftWhere;
  initialQuery: string;
  onClose: () => void;
  /** A pick, Keep or Cancel: the picker closes and the Where field takes the focus back. */
  onPicked: () => void;
  onUpdate: DraftRowUpdate;
}) {
  const homeOf = (key: string) => knownHomeOf(draftHostFor(key));
  const savedHost = where.hostKey;
  const savedShown = !where.autoCurrent && draft.cwd ? tildePath(trim(draft.cwd), homeOf(savedHost)) : '';
  const [host, setHost] = useState(savedHost);
  const [query, setQuery] = useState(initialQuery);
  const [sel, setSel] = useState(-1);
  const [keyed, setKeyed] = useState('');
  const [listKind, setListKind] = usePlaceOrder();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Whole rows under the list's last shown one, said in its title (more to scroll to).
  const [below, setBelow] = useState(0);

  const typed = typedBrowse(query);
  // Browsing is a typed path: a click on a column, a place or a level writes its path into the field
  // (`~/code/`), so typing goes on filtering that folder.
  const browsing = typed ? typed.dir : null;
  const filter = typed?.filter ?? '';
  const searching = !typed && !!query.trim();
  const used = useMemo(() => usedFolders(where.dirs), [where.dirs]);
  const listings = useFolderListings(host, browsing ? columnChain(browsing) : []);
  const outside = useMemo(() => placesOn(host, used, homeOf(host)), [host, used]); // eslint-disable-line react-hooks/exhaustive-deps -- homeOf reads a module cache
  const homeFolders = useHomeFolders(host, searching, outside);
  const items = useMemo<ListItem[]>(() => {
    if (searching) {
      const listed = homeFolders.dirs.map((cwd) => ({ host, cwd }));
      return searchFolders(query, used, listed, homeOf).map((h) => ({ host: h.host, cwd: h.cwd, shown: h.shown, match: h.match, ...(h.used ? { used: h.used } : {}) }));
    }
    return (listKind === 'most' ? mostUsedFolders(used) : recentFolders(used)).map((u) => ({ host: u.host, cwd: u.cwd, shown: tildePath(u.cwd, homeOf(u.host)), used: u }));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- homeOf reads a module cache
  }, [searching, query, used, homeFolders, host, listKind]);
  const showAuto = !browsing && !searching && !!where.project && where.verdict.ok;
  const autoShown = !browsing && !searching;
  const rows: Array<'auto' | ListItem> = browsing ? [] : [...(showAuto ? ['auto' as const] : []), ...items];
  const lastListing = browsing ? listings.get(browsing) : undefined;
  const kids = browsing ? lastColumnFolders(browsing, lastListing, filter) : [];

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => { listRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' }); }, [sel]);
  // Another list (Recent, Most used, a new search) starts at its top row.
  useLayoutEffect(() => { if (listRef.current) listRef.current.scrollTop = 0; }, [listKind, query]);

  const focusEnd = () => requestAnimationFrame(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  });
  const goBrowse = (dir: string, onHost = host) => {
    setHost(onHost); setQuery(dir === '/' ? '/' : `${dir}/`); setKeyed(''); setSel(-1);
    focusEnd();
  };
  const toList = () => { setQuery(''); setKeyed(''); setSel(-1); focusEnd(); };
  const onType = (v: string) => {
    setQuery(v); setKeyed('');
    const tb = typedBrowse(v);
    // A word picks its first hit for Enter; an empty field picks nothing (the footer keeps the saved folder).
    setSel(v.trim() && !tb ? 0 : -1);
  };

  const pending = ((): Pending => {
    if (browsing) {
      // Saved by the path the machine resolved for this level (a remote `~` is never saved as typed).
      const parent = lastListing?.status === 'done' ? lastListing.parent : undefined;
      const abs = (shown: string) => (parent ? (shown === browsing ? parent : childOf(parent, nameOfPath(shown))) : untildePath(shown, homeOf(host)));
      if (lastListing?.status === 'error') return { kind: 'none', host, shown: browsing, why: 'unreachable' };
      if (keyed && kids.includes(keyed)) return { kind: 'folder', host, cwd: abs(keyed), shown: keyed, verb: 'use' };
      if (!lastListing || lastListing.status === 'loading') return { kind: 'none', host, shown: browsing, why: 'checking' };
      if (!lastListing.exists) return { kind: 'none', host, shown: browsing, why: 'missing' };
      if (filter) {
        const exact = kids.find((k) => nameOfPath(k).toLowerCase() === filter.toLowerCase()) ?? (kids.length === 1 ? kids[0] : undefined);
        return exact ? { kind: 'folder', host, cwd: abs(exact), shown: exact, verb: 'use' } : { kind: 'none', host, shown: childOf(browsing, filter), why: 'missing' };
      }
      return { kind: 'folder', host, cwd: abs(browsing), shown: browsing, verb: 'use' };
    }
    // A search with no hit saves nothing: Enter keeps the picker open (review: it closed on the saved folder).
    if (searching && !items.length) return { kind: 'none', host: savedHost, shown: '', why: homeFolders.status === 'loading' ? 'checking' : 'empty' };
    const r = sel >= 0 ? rows[sel] : undefined;
    if (r === 'auto') return { kind: 'auto', host: savedHost, saved: where.autoCurrent };
    if (r) return { kind: 'folder', host: r.host, cwd: r.cwd, shown: r.shown, verb: 'use' };
    if (where.autoCurrent) return { kind: 'auto', host: savedHost, saved: true };
    if (savedShown && draft.cwd) return { kind: 'folder', host: savedHost, cwd: trim(draft.cwd), shown: savedShown, verb: 'keep' };
    return { kind: 'none', host: savedHost, shown: '', why: 'empty' };
  })();

  const saveFolder = (onHost: string, cwd: string) => {
    const u = used.find((x) => x.host === onHost && x.cwd === trim(cwd));
    where.pickFolder(trim(cwd), onHost, u?.hostLabel, u?.lastLaunch);
    onPicked();
  };
  const commit = (p: Pending) => {
    if (p.kind === 'none') return;
    if (p.kind === 'auto') { if (!p.saved) where.pickAuto(p.host); onPicked(); return; }
    if (p.verb === 'keep') { onPicked(); return; }
    saveFolder(p.host, p.cwd);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const atEnd = inputRef.current?.selectionStart === query.length;
    if (browsing) {
      const at = kids.indexOf(keyed);
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && kids.length) {
        e.preventDefault();
        setKeyed(kids[e.key === 'ArrowDown' ? Math.min(kids.length - 1, at + 1) : Math.max(0, at - 1)]);
      } else if (e.key === 'ArrowRight' && atEnd && pending.kind === 'folder' && pending.shown !== browsing) {
        e.preventDefault(); goBrowse(pending.shown);
      } else if (e.key === 'Backspace' && atEnd && query.endsWith('/') && pathLevels(browsing).length > 1) {
        // A whole level at a time (`~/code/` -> `~/`); inside a name it deletes letters as usual.
        e.preventDefault(); goBrowse(parentLevel(browsing));
      } else if (e.key === 'Enter') {
        e.preventDefault(); commit(pending);
      }
      return;
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && rows.length) {
      e.preventDefault();
      setSel((s) => (e.key === 'ArrowDown' ? Math.min(rows.length - 1, s + 1) : Math.max(0, s - 1)));
    } else if (e.key === 'ArrowRight' && atEnd && sel >= 0 && rows[sel] && rows[sel] !== 'auto') {
      e.preventDefault();
      const r = rows[sel] as ListItem;
      goBrowse(r.shown, r.host);
    } else if (e.key === 'Enter') {
      e.preventDefault(); commit(pending);
    } else if (e.key === 'Backspace' && !query && savedShown) {
      e.preventDefault(); goBrowse(parentLevel(savedShown), savedHost);
    }
  };

  const hostName = where.hostName(host);
  // The saved folder's levels, when there is a level to cut back to (`~` alone has none: the footer
  // still says it), so the list keeps the room.
  const levels = browsing ? { label: `In ${hostName}`, path: browsing }
    : savedShown && pathLevels(savedShown).length > 1 ? { label: `Saved · ${where.hostName(savedHost)}`, path: savedShown } : null;
  const usedHere = new Map(used.filter((u) => u.host === host).map((u) => [tildePath(u.cwd, homeOf(host)), u]));
  const places = ['~', '/', ...outside];

  // The project whose code the folder is, said before the pick (the draft then files the task there).
  const found = pending.kind === 'folder' ? detectProjectForFolder(pending.cwd, pending.host, where.rows, { home: homeOf(pending.host) }) : null;
  const hostChip = (
    <span className="draft-v6-wp-host" data-testid="draft-v6-where-host">
      {host === '__local__' ? <span className="draft-v6-dot is-on" /> : <HostStatusDot host={host} label={hostName} className="draft-v6-host-dot" />}
      <span className="draft-v6-wp-host-name wn-meta">{hostName}</span>
    </span>
  );

  return (
    <div className="draft-v6-wm draft-v6-wp" data-testid="draft-v6-where-menu-body">
      <div className="draft-v6-wm-search">
        {/* The one search field (standard.md "Fields"); its first part is the machine it browses. */}
        <SearchField fieldClassName="draft-v6-wm-field"
          ref={inputRef}
          className={typed ? 'draft-v6-wm-path' : undefined}
          icon={hostChip}
          data-no-draft="search"
          data-testid="draft-v6-where-search"
          placeholder="Search your folders, or type ~/ or /"
          aria-label={`Search folders on every machine, or type a path on ${hostName}`}
          title="Esc closes"
          value={query}
          spellCheck={false}
          autoComplete="off"
          setText={onType}
          onClear={() => { onType(''); inputRef.current?.focus(); }}
          onKeyDown={onKey}
        />
      </div>
      {levels && <DraftWhereLevels label={levels.label} path={levels.path} onLevel={(dir) => goBrowse(dir, browsing ? host : savedHost)} />}
      <div className="draft-v6-wp-body">
        <DraftWhereSide hosts={where.hosts} host={host} hostName={where.hostName} listOn={!browsing && !searching} browsing={browsing ?? ''}
          places={places} onList={toList} onHost={(k) => goBrowse('~', k)} onPlace={(p) => goBrowse(p)} />
        <div className="draft-v6-wp-main" data-testid="draft-v6-where-main">
          {browsing ? (
            <DraftWhereColumns host={host} hostName={hostName} dir={browsing} filter={filter} listings={listings} keyed={keyed}
              usedAt={(shown) => usedHere.get(shown)} onOpen={(dir) => goBrowse(dir)} onUse={(dir) => saveFolder(host, resolvedIn(listings.get(parentLevel(dir)), dir) ?? untildePath(dir, homeOf(host)))} />
          ) : (
            <>
              <div className="draft-v6-wp-top">
                <span className="draft-v6-wp-title">{searching ? `${items.length} ${items.length === 1 ? 'folder' : 'folders'}` : listKind === 'most' ? 'Most used' : 'Recent'}</span>
                {!searching && items.length > 0 && <span className="draft-v6-wp-count" data-testid="draft-v6-where-count">{items.length}</span>}
                {below > 0 && <span className="draft-v6-wp-more wn-meta" data-testid="draft-v6-where-more">+{below} more</span>}
                <span className={`draft-v6-wp-line wn-meta${searching && homeFolders.status !== 'done' ? ' is-status' : ''}`} data-testid="draft-v6-where-line">{searching
                  ? homeFolders.status === 'loading' ? `Your folders; still looking through ${hostName}…`
                    : homeFolders.status === 'partial' ? `Your folders; ${hostName} could be read only in part`
                      : `Folders you used first, by use; then the rest on ${hostName}`
                  : listKind === 'most' ? 'Most tasks started, every machine' : 'Last 10 used, every machine'}</span>
                {!searching && (
                  <SegmentedControl size="sm" horizontalKeys aria-label="Which folders" value={listKind} data-testid="draft-v6-where-list"
                    options={[{ value: 'recent', label: 'Recent' }, { value: 'most', label: 'Most used' }]}
                    onChange={(v) => { setListKind(v); setSel(-1); inputRef.current?.focus({ preventScroll: true }); }} />
                )}
              </div>
              {/* Auto stays above the list (it is not one of the folders), so the list keeps whole rows. */}
              {autoShown && <div className="draft-v6-wp-auto" role="listbox" aria-label="Auto">
                <DraftWhereAuto draft={draft} where={where} homeOf={homeOf} active={sel === 0 && showAuto}
                  onActive={() => undefined} onPick={(k) => { if (!(where.autoCurrent && k === savedHost)) where.pickAuto(k); onPicked(); }} onUpdate={onUpdate} />
              </div>}
              <WholeRows listRef={listRef} onBelow={setBelow}>
                {items.map((it, i) => (
                  <FolderRow key={`${it.host}\t${it.cwd}`} item={it} order={searching ? 'search' : listKind} active={sel === i + (showAuto ? 1 : 0)} hostName={where.hostName(it.host)}
                    project={detectProjectForFolder(it.cwd, it.host, where.rows, { home: homeOf(it.host) })?.project}
                    current={!where.autoCurrent && it.host === savedHost && it.cwd === trim(draft.cwd ?? '')}
                    onPick={() => saveFolder(it.host, it.cwd)} onOpen={() => goBrowse(it.shown, it.host)} />
                ))}
                {!items.length && (searching
                  ? <EmptyState size="row" role="presentation" title={`No folder matches “${query.trim()}”`} hint="Type ~/ or / to go to a path" />
                  : <EmptyState size="row" role="presentation" title="No folder used yet" hint="Pick a machine on the left, or type ~/ or /" />)}
              </WholeRows>
            </>
          )}
        </div>
      </div>
      <KeyHints className="draft-v6-wm-foot draft-v6-wp-foot" hints={[['↑↓', 'move'], ['→', 'open'], ['⌫', 'up a level']]}>
        <span className="draft-v6-wp-dest" data-testid="draft-v6-where-dest">
          {pending.kind === 'folder' && pending.verb === 'keep' && <span className="draft-v6-wp-saved">Saved ·</span>}
          <span className="draft-v6-wp-dest-host">{where.hostName(pending.host)}:</span>
          <span className="draft-v6-wp-dest-path" title={pending.kind === 'auto' ? 'Auto' : pending.shown}>
            <bdi>{pending.kind === 'auto' ? `Auto · ${where.what.words}` : pending.shown || 'no folder'}</bdi>{/* empty-state-ok: the footer's destination */}
          </span>
        </span>
        {found && <span className={`${badge()} draft-v6-tag`} data-testid="draft-v6-where-project" title="The project whose code this folder is"><span>{projectDisplayName(found.project)}</span></span>}
        <button type="button" className="btn btn-sm" data-testid="draft-v6-where-cancel" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-sm btn-primary" data-testid="draft-v6-use-path" data-state={pending.kind === 'none' ? pending.why : pending.kind === 'folder' ? 'valid' : 'auto'}
          disabled={pending.kind === 'none'} onClick={() => commit(pending)}>
          {pending.kind === 'none' ? NONE_WORDS[pending.why] // empty-state-ok: the button's words
            : pending.kind === 'auto' ? (pending.saved ? 'Keep Auto' : 'Use Auto')
              : pending.verb === 'keep' ? 'Keep this folder' : 'Use this folder'}
        </button>
      </KeyHints>
    </div>
  );
}

/** The list sized to whole rows (never half a row under the footer), scrolling by rows. A row's
 *  height is the menu family's (overlay-family.css), so it is measured, not assumed. */
function WholeRows({ listRef, onBelow, children }: { listRef: RefObject<HTMLDivElement | null>; onBelow: (rows: number) => void; children: ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number | undefined>(undefined);
  const read = () => {
    const el = boxRef.current;
    const list = listRef.current;
    if (!el) return;
    const row = list?.querySelector<HTMLElement>('.draft-v6-wp-row');
    const step = row?.offsetHeight || ROW_PX;
    const next = Math.max(1, Math.floor(el.clientHeight / step)) * step;
    setH((prev) => (prev === next ? prev : next));
    // The rows that start under the last whole row shown (rows differ a little in height).
    const bottom = list ? list.scrollTop + list.clientHeight : 0;
    onBelow(list ? [...list.querySelectorAll<HTMLElement>('.draft-v6-wp-row')].filter((r) => r.offsetTop + r.offsetHeight > bottom + 1).length : 0);
  };
  useLayoutEffect(read);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read only reads refs
  }, []);
  return (
    <div ref={boxRef} className="draft-v6-wp-rows-box">
      <div ref={listRef} className="draft-v6-wp-rows" role="listbox" aria-label="Folders" style={h ? { height: h } : undefined} onScroll={read}>{children}</div>
    </div>
  );
}

function Marked({ text, hits }: { text: string; hits: readonly number[] }) {
  if (!hits.length) return <>{text}</>;
  const on = new Set(hits);
  return <>{text.split('').map((c, i) => (on.has(i) ? <mark key={i} className="draft-v6-wp-hit">{c}</mark> : c))}</>;
}

function FolderRow({ item, order, active, hostName, project, current, onPick, onOpen }: {
  item: ListItem; order: PlaceOrder | 'search'; active: boolean; hostName: string; project?: string; current: boolean; onPick: () => void; onOpen: () => void;
}) {
  const name = item.shown === '~' ? '~ (home)' : nameOfPath(item.shown);
  const nameStart = item.shown.length - nameOfPath(item.shown).length;
  const hits = (item.match?.hits ?? []).filter((x) => x >= nameStart).map((x) => x - nameStart);
  const parent = parentLevel(item.shown);
  const u = item.used;
  return (
    <DraftPlaceRow kind="folder" name={item.shown === '~' ? name : <Marked text={name} hits={hits} />} tag={project ? projectDisplayName(project) : undefined}
      line={item.shown === parent ? '' : parent} hostName={hostName} meta={u ? placeMeta(order, u.count, timeAgo(u.last)) : 'not used yet'} /* empty-state-ok: a row's meta */
      current={current} active={active} title={`Use ${hostName}: ${item.shown}`} onPick={onPick} onOpen={onOpen} openLabel={`Open the folders in ${name}`}
      testId="draft-v6-folder-row" data={{ name, host: item.host }} />
  );
}
