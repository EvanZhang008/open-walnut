/**
 * The tree drawer (spec 6): an OVERLAY inside its session panel's left edge,
 * never a sidebar. It never changes the transcript's width or padding (C7):
 * absolute, clipped by the panel, opaque body (the prose under it is dense, so
 * glass would make the titles' contrast swing), glass only on the outer 12px
 * shadow band.
 *
 * Modes (6.1): `closed` renders only the 8px left-edge band (hover entry);
 * `peek` closes by pointer geometry (useDrawerPeekClose); `open` closes on Esc
 * (the search is cleared first), the toggle, the × and an outside click
 * (toast, selection pill, confirm and menu portals exempt). A row jump closes
 * either mode; focus goes back to what had it before the drawer opened.
 *
 * Props in, no fetching: writes go through `actions`, `meta.patch` (lazy
 * naming, 7.1) and the pins api only.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThreadDrawerFilter, ThreadTreeDrawerProps } from '@/components/sessions/thread-ui-contract';
import { THREAD_OVERLAY_SELECTOR } from '@/components/sessions/ThreadConfirm';
import { ThreadCloseIcon, ThreadSearchIcon } from '@/components/sessions/ThreadIcons';
import { ThreadTreeRows, type ThreadTreeRowsHandle } from '@/components/sessions/ThreadTreeRows';
import { useDrawerEdgePeek } from '@/hooks/useDrawerEdgePeek';
import { useDrawerPeekClose } from '@/hooks/useDrawerPeekClose';
import {
  chipCounts, counts as countQuestions, hiddenKeysOf, isOpenish, metaOf, openChipTitle, pluralQuestions, statusOf, summaryText,
} from '@/utils/thread-meta';
import { ROOT_THREAD_KEY, type ThreadTree } from '@/utils/thread-tree';
import { ancestorKeysOf, defaultDrawerFilter } from '@/utils/thread-tree-rows';
import { widthTier } from '@/utils/thread-stack-state';
import type { SessionThreadMetaPatch } from '@/types/session';
import { log } from '@/utils/log';
import { isModifierOnly, markKeyboardFocus } from '@/utils/keyboard-focus';
import '@/styles/thread-stack.css';

const EXIT_MS = 160;
const LAZY_NAME_LIMIT = 10;
const LAZY_NAME_CONCURRENCY = 2;
/** The drawer only needs to know "narrower than 420" (bucketed so a resize
 *  renders it once per crossing, not per pixel). */
const DRAWER_WIDTH_TIERS = [420] as const;
/** Clicks here are not "outside" (portals the drawer's own actions open). */
const OUTSIDE_EXEMPT = `${THREAD_OVERLAY_SELECTOR}, .quote-pin-pill, .thread-menu, .thread-drawer-toggle`;

/** Filter, search and fold state per session, for the panel's lifetime
 *  (closing the drawer keeps it; a reload starts fresh). */
interface DrawerMemory {
  filter?: ThreadDrawerFilter;
  query: string;
  collapsed: ReadonlySet<string>;
  doneGroupsOpen: ReadonlySet<string>;
}
const memory = new Map<string, DrawerMemory>();
function memoryOf(sessionId: string): DrawerMemory {
  let m = memory.get(sessionId);
  if (!m) { m = { query: '', collapsed: new Set(), doneGroupsOpen: new Set() }; memory.set(sessionId, m); }
  return m;
}

/** Lazy naming (7.1): `<sessionId>:<headId>` already asked, never twice. */
const lazyNamed = new Set<string>();

/** Up to `limit` visible questions with no meta, in tree order (pure). */
export function lazyNameCandidates(tree: ThreadTree, index: Parameters<typeof metaOf>[1], limit = LAZY_NAME_LIMIT): SessionThreadMetaPatch[] {
  const hidden = hiddenKeysOf(tree, index);
  const out: SessionThreadMetaPatch[] = [];
  for (const node of tree.threads) {
    if (out.length >= limit) break;
    if (node.key === ROOT_THREAD_KEY || hidden.has(node.key) || !node.headId || metaOf(node, index)) continue;
    const question = node.quote ? undefined : node.label || undefined;
    out.push({ headId: node.headId, status: 'older', titleState: 'pending', ...(question ? { question } : {}) });
  }
  return out;
}

/** Run `jobs` with at most `n` in flight. */
async function runLimited(jobs: Array<() => Promise<unknown>>, n: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try { await job(); } catch { /* a failed lazy name keeps the fallback title */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker));
}

export function ThreadTreeDrawer(p: ThreadTreeDrawerProps) {
  const { sessionId, panelRef, tree, index, pins, live, mode, setMode } = p;
  const mem = memoryOf(sessionId);
  const c = useMemo(() => countQuestions(tree, index, pins, live), [tree, index, pins, live]);
  const [filter, setFilterState] = useState<ThreadDrawerFilter>(mem.filter ?? p.initialFilter ?? defaultDrawerFilter(c));
  const [query, setQueryState] = useState(mem.query);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(mem.collapsed);
  const [doneGroupsOpen, setDoneGroupsOpen] = useState<ReadonlySet<string>>(mem.doneGroupsOpen);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [visible, setVisible] = useState(mode !== 'closed');
  const [panelWidth, setPanelWidth] = useState(0);
  /** Where the drawer starts: below the session header, so the header toggle
   *  (click again to close) and the session name stay visible (N13). */
  const [drawerTop, setDrawerTop] = useState<number | null>(null);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const rowsRef = useRef<ThreadTreeRowsHandle | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const prevMode = useRef(mode);

  const setFilter = useCallback((f: ThreadDrawerFilter) => { mem.filter = f; setFilterState(f); }, [mem]);
  const setQuery = useCallback((q: string) => { mem.query = q; setQueryState(q); }, [mem]);
  useEffect(() => { mem.collapsed = collapsed; mem.doneGroupsOpen = doneGroupsOpen; }, [mem, collapsed, doneGroupsOpen]);

  // Panel width picks the drawer width tier (< 420px: calc(100% - 24px)).
  useEffect(() => {
    const el = panelRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      setPanelWidth(widthTier(el.clientWidth, DRAWER_WIDTH_TIERS));
      const header = el.querySelector<HTMLElement>('.session-panel-header');
      if (!header) { setDrawerTop(null); return; }
      const bottom = header.getBoundingClientRect().bottom - el.getBoundingClientRect().top;
      setDrawerTop(bottom > 0 ? Math.round(bottom) + 6 : null);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const header = el.querySelector('.session-panel-header');
    if (header) ro.observe(header);
    measure();
    return () => ro.disconnect();
  }, [panelRef]);

  const expandTo = useCallback((key: string) => {
    const up = ancestorKeysOf(tree, key);
    setCollapsed((s) => (up.some((k) => s.has(k)) ? new Set([...s].filter((k) => !up.includes(k))) : s));
  }, [tree]);

  const close = useCallback((restoreFocus = true) => {
    setMode('closed');
    if (!restoreFocus) return;
    const back = opener.current;
    const active = document.activeElement;
    if (back && document.contains(back) && (!active || active === document.body || drawerRef.current?.contains(active))) {
      // WebKit never matches :focus-visible on a programmatic focus, so a
      // keyboard close marks the opener itself: its ring stays until it blurs.
      if (drawerRef.current?.dataset.kb === 'true') markKeyboardFocus(back);
      back.focus({ preventScroll: true });
    }
  }, [setMode]);

  // Mode transitions: remember the opener, expand to the current page, focus
  // the current row when opened straight into `open` (toggle or shortcut).
  useEffect(() => {
    const was = prevMode.current;
    prevMode.current = mode;
    if (mode === 'closed') {
      if (was === 'closed') return;
      const t = setTimeout(() => setVisible(false), EXIT_MS);
      return () => clearTimeout(t);
    }
    setVisible(true);
    if (was === 'closed') {
      // WebKit never focuses a clicked button, so a click on the toggle leaves
      // focus on <body>: the toggle is then the element to give focus back to.
      const active = document.activeElement;
      const toggle = panelRef.current?.querySelector<HTMLElement>('.thread-drawer-toggle') ?? null;
      opener.current = active instanceof HTMLElement && active !== document.body && !drawerRef.current?.contains(active) ? active : toggle;
      expandTo(p.currentKey);
      // Until a filter is picked, it follows the rule (Open when anything is open).
      if (mem.filter === undefined) setFilterState(p.initialFilter ?? defaultDrawerFilter(c));
      log.info('threads', 'drawer opened', { sessionId, mode, filter: mem.filter ?? 'default' });
      if (mode === 'open') requestAnimationFrame(() => rowsRef.current?.focusCursor());
    }
    return undefined;
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // A caller that opens the drawer ON a filter (`Show hidden questions` opens on
  // All, the rail's `<n> more` on Pinned) passes it here; a change wins once.
  const lastInitial = useRef(p.initialFilter);
  useEffect(() => {
    if (p.initialFilter === lastInitial.current) return;
    lastInitial.current = p.initialFilter;
    if (p.initialFilter) setFilter(p.initialFilter);
  }, [p.initialFilter, setFilter]);

  // `Show in tree`: expand the ancestors, make sure the current row can show.
  const lastReveal = useRef(p.revealNonce);
  useEffect(() => {
    if (lastReveal.current === p.revealNonce) return;
    lastReveal.current = p.revealNonce;
    expandTo(p.currentKey);
    if (query) setQuery('');
    const cur = tree.byKey.get(p.currentKey);
    const passes = filter === 'all' || (filter === 'open' && !!cur && isOpenish(statusOf(cur, index)));
    if (!passes && p.currentKey !== ROOT_THREAD_KEY) setFilter('all');
  }, [p.revealNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy naming (7.1): up to 10 unnamed questions, 2 writes in flight, once each.
  useEffect(() => {
    if (mode === 'closed') return;
    const jobs = lazyNameCandidates(tree, index)
      .filter((e) => !lazyNamed.has(`${sessionId}:${e.headId}`))
      .map((e) => {
        lazyNamed.add(`${sessionId}:${e.headId}`);
        return () => p.meta.patch([e]);
      });
    if (jobs.length === 0) return;
    log.info('threads', 'lazy naming older questions', { sessionId, count: jobs.length });
    void runLimited(jobs, LAZY_NAME_CONCURRENCY);
  }, [mode, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Open mode: an outside click closes (the drawer's own portals are exempt).
  useEffect(() => {
    if (mode !== 'open') return;
    const onDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (drawerRef.current?.contains(t) || t.closest(OUTSIDE_EXEMPT)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [mode, close]);

  const blocked = useCallback(() => overlayOpen
    || document.activeElement === searchRef.current
    || document.querySelector(`${THREAD_OVERLAY_SELECTOR}[data-thread-overlay="confirm"], .thread-menu`) !== null, [overlayOpen]);
  useDrawerPeekClose({ active: mode === 'peek', panelRef, drawerRef, blocked, onClose: () => close(false) });
  const edge = useDrawerEdgePeek({ panelRef, enabled: mode === 'closed' && tree.threads.length > 1, onPeek: () => setMode('peek') });

  const onJumped = useCallback(() => close(false), [close]);
  const clearSearch = useCallback(() => { setQuery(''); searchRef.current?.focus({ preventScroll: true }); }, [setQuery]);
  const showAll = useCallback(() => { setQuery(''); setFilter('all'); searchRef.current?.focus({ preventScroll: true }); }, [setQuery, setFilter]);

  // Finder-style type-to-search: the key lands at the END of the query.
  const typeToSearch = useCallback((ch: string) => {
    const next = query + ch;
    setQuery(next);
    const el = searchRef.current;
    el?.focus({ preventScroll: true });
    requestAnimationFrame(() => el?.setSelectionRange(next.length, next.length));
  }, [query, setQuery]);

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const take = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'ArrowDown') { take(); rowsRef.current?.focusFirstMatch(); }
    else if (e.key === 'Enter') { take(); rowsRef.current?.openFirstMatch(); }
    else if (e.key === 'Escape') { take(); if (query) setQuery(''); else close(); }
  };
  // Esc anywhere else in the drawer (chips, header buttons) closes it.
  const onDrawerKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.nativeEvent.isComposing || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  if (mode === 'closed' && !visible) {
    if (tree.threads.length <= 1) return null;
    return <div ref={edge.edgeRef} className="thread-drawer-edge" data-armed={edge.armed ? 'true' : undefined} aria-hidden="true" />;
  }

  const chips = chipCounts(c);
  const summary = summaryText(c);
  const olderKeys = c.older > 0 ? p.actions.olderKeys() : [];
  const loading = tree.threads.length <= 1;
  return (
    <div
      ref={drawerRef}
      className="thread-drawer"
      data-mode={mode}
      data-state={mode === 'closed' ? 'closing' : 'open'}
      data-narrow={panelWidth > 0 && panelWidth < 420 ? 'true' : undefined}
      style={drawerTop !== null ? { top: drawerTop } : undefined}
      role="dialog"
      aria-modal="false"
      aria-label="All questions"
      onKeyDown={onDrawerKey}
      onKeyDownCapture={(e) => { if (!isModifierOnly(e.key)) e.currentTarget.dataset.kb = 'true'; }}
      onPointerDownCapture={(e) => { delete e.currentTarget.dataset.kb; }}
      onPointerDown={() => { if (mode === 'peek') setMode('open'); }}
    >
      <div className="thread-drawer-body">
        <div className="thread-drawer-head">
          {/* Each `<n> word` segment is kept whole: a wrap goes between
              segments, never between a number and its noun (N10). */}
          <span className="thread-drawer-summary">
            {summary.split(' · ').map((seg, i) => (
              <Fragment key={seg}>{i > 0 && ' · '}<span className="thread-drawer-summary-seg">{seg}</span></Fragment>
            ))}
          </span>
          <button type="button" className="thread-drawer-close" title="Close (Esc)" aria-label="Close (Esc)" onClick={() => close()}>
            <ThreadCloseIcon size={12} />
          </button>
        </div>
        {olderKeys.length > 0 && (
          <div className="thread-drawer-older">
            <span>{pluralQuestions(olderKeys.length).replace(/question/, 'older question')}</span>
            <button type="button" className="thread-tree-text-btn" onClick={() => { void p.actions.markOlderDone(olderKeys); }}>
              Mark older questions done
            </button>
          </div>
        )}
        <div className="thread-drawer-search">
          <ThreadSearchIcon size={13} />
          <input
            ref={searchRef}
            type="search"
            className="thread-drawer-search-input"
            placeholder="Search questions and pins"
            aria-label="Search questions and pins"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
          {query && <button type="button" className="thread-drawer-search-clear" aria-label="Clear search" onClick={clearSearch}>Clear</button>}
        </div>
        <div className="thread-drawer-chips" role="group" aria-label="Filter">
          {(['all', 'open', 'pinned'] as const).map((f) => (
            <button key={f} type="button" className="thread-drawer-chip" aria-pressed={filter === f} onClick={() => setFilter(f)}
              title={f === 'open' ? openChipTitle(c) : undefined}>
              {f === 'all' ? 'All' : f === 'open' ? 'Open' : 'Pinned'} <span className="thread-drawer-chip-count">{chips[f]}</span>
            </button>
          ))}
        </div>
        <div className="thread-drawer-scroll">
          <ThreadTreeRows
            ref={rowsRef}
            sessionId={sessionId} tree={tree} index={index} pins={pins} pinsApi={p.pinsApi} live={live}
            drafts={p.drafts} pending={p.pending} currentKey={p.currentKey} unreadKeys={p.unreadKeys}
            answeredAt={p.answeredAt} actions={p.actions} filter={filter} query={query}
            collapsed={collapsed} doneGroupsOpen={doneGroupsOpen} showHidden={p.showHidden} loading={loading}
            onToggleCollapsed={(k) => setCollapsed((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
            onToggleDoneGroup={(k) => setDoneGroupsOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
            revealNonce={p.revealNonce} onNavigate={p.onNavigate} onJumpPin={p.onJumpPin} onJumped={onJumped}
            onEscape={() => close()} onShowAll={showAll} onOverlayChange={setOverlayOpen}
            onFocusSearch={() => searchRef.current?.focus({ preventScroll: true })}
            onTypeToSearch={typeToSearch}
          />
        </div>
      </div>
    </div>
  );
}
