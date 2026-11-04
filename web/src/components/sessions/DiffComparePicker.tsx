import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  fetchSessionGitRefs,
  type GitCompareInfo, type SessionDiffCompare, type SessionGitRefs,
} from '@/api/session-changes';
import { timeAgo } from '@/utils/time';
import { log } from '@/utils/log';

/**
 * The Changed tab's "Compare" control: a button naming the current comparison
 * and a popover to pick another one.
 *
 *   - the three working-tree comparisons (this session's edits, uncommitted,
 *     not yet pushed) and "Branch vs <default branch>";
 *   - any local or remote branch (merge-base with it, as a pull request shows);
 *   - one of the newest 100 commits (that commit vs its first parent).
 *
 * One filter box narrows the branches and commits together (name, sha,
 * subject, author). ↑/↓ move, Enter picks, Esc closes. Branches and commits
 * are read when the popover opens (one git run on the session's host), and
 * kept for a short while per session.
 */

const SESSION_HINTS = {
  session: 'Everything this session edited, rebuilt from its own history',
  uncommitted: 'Those files as they differ from your last commit',
  remote: 'Those files as they differ from what is pushed',
} as const;

type QuickBase = keyof typeof SESSION_HINTS;
/** How many trailing characters of a branch name always show (the rest is cut with an ellipsis). */
const REF_TAIL = 14;
/** The server lists at most this many commits (git-diff-core.ts MAX_COMMITS). */
const COMMITS_LISTED = 100;
const QUICK: ReadonlyArray<{ base: QuickBase; label: string }> = [
  { base: 'session', label: 'What this session changed' },
  { base: 'uncommitted', label: 'Uncommitted changes' },
  { base: 'remote', label: 'Not yet pushed' },
];

/** Refs per session, kept briefly: reopening the picker paints at once, then refreshes. */
const refsCache = new Map<string, { at: number; refs: SessionGitRefs }>();
const REFS_FRESH_MS = 30_000;

/** A Re-scan: the next open reads the branches and commits again (one may have been made since). */
export function forgetGitRefs(sessionId: string): void {
  refsCache.delete(sessionId);
}
const POP_W = 420;
const SHOW_REFS_MAX = 200;

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** The button's text for a comparison. `resolved` is what the server answered for it. */
export function compareLabel(c: SessionDiffCompare, resolved?: GitCompareInfo, defaultRef?: string): string {
  if (c.base === 'session') return 'What this session changed';
  if (c.base === 'uncommitted') return 'Uncommitted changes';
  if (c.base === 'remote') return 'Not yet pushed';
  if (c.base === 'previous') return 'Last commit and uncommitted';
  if (c.base === 'branch') {
    const ref = c.ref || resolved?.ref || defaultRef;
    return ref ? `Branch vs ${ref}` : 'Branch vs default branch';
  }
  const subject = resolved?.commit && c.commit && resolved.commit.sha.startsWith(c.commit) ? resolved.commit.subject : '';
  return `Commit ${shortSha(c.commit ?? '')}${subject ? ` · ${subject}` : ''}`;
}

type Item =
  | { kind: 'quick'; key: string; compare: SessionDiffCompare; label: string; hint: string }
  | { kind: 'ref'; key: string; compare: SessionDiffCompare; name: string; refKind: 'local' | 'remote'; time: number; isCurrent: boolean }
  | { kind: 'commit'; key: string; compare: SessionDiffCompare; sha: string; subject: string; author: string; time: number; onBranch: boolean; parents: number };

function sameCompare(a: SessionDiffCompare, b: SessionDiffCompare): boolean {
  if (a.base !== b.base) return false;
  if (a.base === 'branch') return (a.ref ?? '') === (b.ref ?? '');
  if (a.base === 'commit') return !!a.commit && !!b.commit && (a.commit.startsWith(b.commit) || b.commit.startsWith(a.commit));
  return true;
}

function unixAgo(t: number): string {
  return t > 0 ? timeAgo(new Date(t * 1000).toISOString()) : '';
}

export function DiffComparePicker({ sessionId, compare, resolved, onChange }: {
  sessionId: string;
  compare: SessionDiffCompare;
  /** What the shown comparison resolved to (from the changes answer). */
  resolved?: GitCompareInfo;
  onChange: (c: SessionDiffCompare) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [refs, setRefs] = useState<SessionGitRefs | null>(() => refsCache.get(sessionId)?.refs ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const loadSeq = useRef(0);
  /** The session whose lists are being fetched now (a second ask waits for that answer). */
  const pendingRef = useRef<string | null>(null);
  const idBase = useId().replace(/:/g, '');
  const optId = (i: number) => `${idBase}-opt-${i}`;
  const listId = `${idBase}-list`;

  // Another session in the same panel: its own lists.
  useEffect(() => { setRefs(refsCache.get(sessionId)?.refs ?? null); setError(null); }, [sessionId]);

  const loadRefs = useCallback((force = false) => {
    const cached = refsCache.get(sessionId);
    if (!force && cached && Date.now() - cached.at < REFS_FRESH_MS) { setRefs(cached.refs); return () => {}; }
    if (!force && pendingRef.current === sessionId) return () => {};
    pendingRef.current = sessionId;
    const seq = ++loadSeq.current;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fetchSessionGitRefs(sessionId, { signal: ctrl.signal })
      .then((r) => {
        refsCache.set(sessionId, { at: Date.now(), refs: r });
        if (loadSeq.current === seq) setRefs(r);
      })
      .catch((err) => {
        if (ctrl.signal.aborted || loadSeq.current !== seq) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        log.warn('session-changes', 'git refs fetch failed', { sessionId, error: msg });
      })
      .finally(() => { if (loadSeq.current === seq) { setLoading(false); pendingRef.current = null; } });
    return () => { ctrl.abort(); if (loadSeq.current === seq) pendingRef.current = null; };
  }, [sessionId]);

  // Fetched as the Changed tab opens, so the picker opens on its full lists
  // instead of rows arriving under the pointer.
  useEffect(() => loadRefs(false), [loadRefs]);
  useEffect(() => {
    if (!open) return;
    loadRefs(false);
  }, [open, loadRefs]);

  const place = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(POP_W, window.innerWidth - 16);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    const top = r.bottom + 6;
    setPos({ left, top, width, maxHeight: Math.max(220, Math.min(560, window.innerHeight - top - 12)) });
  }, []);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setPos(null);
    setQuery('');
    if (refocus) triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onResize = () => place();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && (popRef.current?.contains(t) || triggerRef.current?.contains(t))) return;
      close(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open, close]);

  // Placed in the same update that opens it, so the popover and its focused
  // filter exist before the next key: typing right after the click is not lost.
  const openPicker = useCallback(() => { place(); setOpen(true); }, [place]);
  const placed = pos !== null;
  useLayoutEffect(() => { if (open && placed) inputRef.current?.focus(); }, [open, placed]);

  const defaultRef = refs?.defaultRef || (resolved?.isDefault ? resolved.ref : undefined) || '';
  const q = query.trim().toLowerCase();
  // Every word must match (in any order): "pars err" finds "Parse errors ...".
  const terms = useMemo(() => q.split(/\s+/).filter(Boolean), [q]);

  const { items, refCount, refHidden, commitCount } = useMemo(() => {
    const out: Item[] = [];
    const quick: Array<Extract<Item, { kind: 'quick' }>> = QUICK.map((o) => ({ kind: 'quick', key: `q:${o.base}`, compare: { base: o.base }, label: o.label, hint: SESSION_HINTS[o.base] }));
    // An older remembered view may still compare with the commit before HEAD.
    if (compare.base === 'previous') {
      quick.push({ kind: 'quick', key: 'q:previous', compare: { base: 'previous' }, label: 'Last commit and uncommitted', hint: 'The latest commit plus uncommitted work, vs the commit before it' });
    }
    if (refs?.repoRoot !== null) {
      quick.push({
        kind: 'quick', key: 'q:branch', compare: { base: 'branch' },
        label: defaultRef ? `Branch vs ${defaultRef}` : 'Branch vs default branch',
        hint: 'Every file this branch changes since it left the default branch, uncommitted work included',
      });
    }
    const all = (text: string) => terms.every((t) => text.includes(t));
    // A working-tree row is about the checked-out branch, and "Branch vs" about the default one:
    // typing either name finds them (those two are not listed as branches below).
    const quickText = (it: Extract<Item, { kind: 'quick' }>) => `${it.label} ${it.compare.base === 'branch' ? defaultRef : it.compare.base === 'session' ? '' : refs?.current ?? ''}`.toLowerCase();
    for (const it of quick) if (!q || all(quickText(it))) out.push(it);
    let refCount = 0;
    let refHidden = 0;
    // Newest first; equal times in natural order (bulk-2 before bulk-10).
    const sortedRefs = [...(refs?.refs ?? [])].sort((a, b) => (b.time - a.time) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const r of sortedRefs) {
      // The checked-out branch against itself is only the uncommitted work: not a target.
      if (r.kind === 'local' && r.name === refs?.current) continue;
      // The default branch is the "Branch vs <default>" row above (a filter finds it there).
      if (r.name === defaultRef) continue;
      const hit = !q || all(r.name.toLowerCase());
      if (!hit) continue;
      refCount++;
      if (refCount > SHOW_REFS_MAX) { refHidden++; continue; }
      out.push({
        kind: 'ref', key: `r:${r.kind}:${r.name}`, compare: { base: 'branch', ref: r.name },
        name: r.name, refKind: r.kind, time: r.time, isCurrent: r.kind === 'local' && r.name === refs?.current,
      });
    }
    let commitCount = 0;
    // A word may match the sha, the subject or the author; commits that match
    // without the author come first (a short word often hits an author's name).
    // Ranked: the typed words as one phrase in the subject, then every word in the subject,
    // then words that also match the sha (by prefix), then the author.
    const bySubjectPhrase: Item[] = [];
    const bySubject: Item[] = [];
    const byText: Item[] = [];
    const byAuthor: Item[] = [];
    for (const c of refs?.commits ?? []) {
      const sha = c.sha.toLowerCase();
      const subject = c.subject.toLowerCase();
      const author = c.author.toLowerCase();
      const inText = (t: string) => sha.startsWith(t) || subject.includes(t);
      if (q && !terms.every((t) => inText(t) || author.includes(t))) continue;
      commitCount++;
      const item: Item = {
        kind: 'commit', key: `c:${c.sha}`, compare: { base: 'commit', commit: c.sha },
        sha: c.sha, subject: c.subject, author: c.author, time: c.time, onBranch: c.onBranch, parents: c.parents,
      };
      if (!q || subject.includes(q)) bySubjectPhrase.push(item);
      else if (terms.every((t) => subject.includes(t))) bySubject.push(item);
      else (terms.every(inText) ? byText : byAuthor).push(item);
    }
    out.push(...bySubjectPhrase, ...bySubject, ...byText, ...byAuthor);
    return { items: out, refCount, refHidden, commitCount };
  }, [q, terms, refs, defaultRef, compare.base]);

  // Open on the current comparison (again once the first lists arrive, unless
  // the reader already moved); a new filter starts at the top.
  const hasRefs = refs !== null;
  const movedRef = useRef(false);
  useEffect(() => { if (open) movedRef.current = false; }, [open, q]);
  useEffect(() => {
    if (!open || movedRef.current) return;
    // A remembered "branch vs the default branch, by name" is the default row.
    const cur: SessionDiffCompare = compare.base === 'branch' && compare.ref === defaultRef ? { base: 'branch' } : compare;
    const idx = items.findIndex((it) => sameCompare(it.compare, cur));
    setActive(q || idx < 0 ? 0 : idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q, hasRefs]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const pick = useCallback((it: Item) => {
    onChange(it.compare);
    close();
  }, [onChange, close]);

  // Enter typed before the branches and commits arrived picks once they do
  // (the filter's first match), instead of doing nothing.
  const pendingEnterRef = useRef(false);
  useEffect(() => { pendingEnterRef.current = false; }, [open, q]);
  useEffect(() => {
    if (!open || !pendingEnterRef.current || loading) return;
    pendingEnterRef.current = false;
    const it = items[active] ?? items[0];
    if (it) pick(it);
  }, [open, loading, items, active, pick]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    // Tab leaves the picker: it closes and focus goes back to the Compare button.
    if (e.key === 'Tab') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); movedRef.current = true; setActive((a) => Math.min(items.length - 1, a + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); movedRef.current = true; setActive((a) => Math.max(0, a - 1)); return; }
    // Home/End walk the list while the filter is empty (with text they move the caret).
    if ((e.key === 'Home' || e.key === 'End') && !query) {
      e.preventDefault();
      movedRef.current = true;
      setActive(e.key === 'Home' ? 0 : Math.max(0, items.length - 1));
      return;
    }
    if (e.key === 'Enter') {
      // Enter that ends an input-method composition is not a pick.
      if (e.nativeEvent.isComposing) return;
      e.preventDefault();
      const it = items[active];
      if (!refs && loading && (!it || q)) { pendingEnterRef.current = true; return; }
      if (it) pick(it);
    }
  };

  // Focus leaving the popover (Tab, another window control) closes it.
  const onBlur = (e: ReactFocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (!next || popRef.current?.contains(next) || triggerRef.current?.contains(next)) return;
    close(false);
  };

  // A commit's subject: from the answer, else from the commit list (while it loads).
  const listed = compare.base === 'commit' && compare.commit ? refs?.commits.find((c) => c.sha.startsWith(compare.commit!)) : undefined;
  const listedInfo: GitCompareInfo | undefined = listed ? { base: 'commit', baseSha: listed.parent, commit: listed } : undefined;
  const label = compareLabel(compare, resolved?.commit || !listedInfo ? resolved : listedInfo, defaultRef);
  const firstQuick = items.findIndex((it) => it.kind === 'quick' && it.compare.base !== 'branch');
  const branchQuick = items.findIndex((it) => it.key === 'q:branch');
  const firstRef = items.findIndex((it) => it.kind === 'ref');
  const firstCommit = items.findIndex((it) => it.kind === 'commit');
  const noRepo = refs?.repoRoot === null;

  const row = (it: Item, i: number) => {
    const selected = sameCompare(it.compare, compare);
    const common = {
      id: optId(i),
      role: 'option' as const,
      'aria-selected': selected,
      'data-index': i,
      className: `sdc-item sdc-item-${it.kind}${i === active ? ' is-active' : ''}${selected ? ' is-selected' : ''}`,
      onMouseMove: () => { if (active !== i) { movedRef.current = true; setActive(i); } },
      onClick: () => pick(it),
    };
    if (it.kind === 'quick') {
      return (
        <div {...common}>
          <span className="sdc-check" aria-hidden>{selected ? '✓' : ''}</span>
          <span className="sdc-main">
            <span className="sdc-title">{it.label}</span>
            <span className="sdc-hint">{it.hint}</span>
          </span>
        </div>
      );
    }
    if (it.kind === 'ref') {
      return (
        // Named whole (the cut name is two pieces on screen, which would read as two words).
        <div {...common} aria-label={`${it.name}${it.isCurrent ? ', current' : ''}${it.refKind === 'remote' ? ', remote' : ''}${it.time ? `, ${unixAgo(it.time)}` : ''}`} title={`${it.name}\nEvery file your branch changes since it split from ${it.name}, uncommitted work included`}>
          <span className="sdc-check" aria-hidden>{selected ? '✓' : ''}</span>
          <span className="sdc-main sdc-main-row">
            {/* A long name is cut in the middle: its end is what tells similar branches apart. */}
            <span className="sdc-ref-name">
              <span className="sdc-ref-head">{it.name.slice(0, -REF_TAIL)}</span>
              <span className="sdc-ref-tail">{it.name.slice(-REF_TAIL)}</span>
            </span>
            {it.isCurrent && <span className="sdc-badge">current</span>}
            {it.refKind === 'remote' && <span className="sdc-badge sdc-badge-remote">remote</span>}
          </span>
          <span className="sdc-time">{unixAgo(it.time)}</span>
        </div>
      );
    }
    return (
      <div {...common} title={`${it.sha}\n${it.subject}\n${it.author}${it.parents > 1 ? '\nMerge commit: shown against its first parent' : ''}`}>
        <span className="sdc-check" aria-hidden>{selected ? '✓' : ''}</span>
        <span className="sdc-main sdc-main-row">
          <code className="sdc-sha">{shortSha(it.sha)}</code>
          <span className="sdc-subject">{it.subject || '(no message)'}</span>
          {it.onBranch && <span className="sdc-onbranch" title="On this branch, not yet on the default branch" aria-label="on this branch" />}
        </span>
        <span className="sdc-time">{unixAgo(it.time)}</span>
      </div>
    );
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`session-diff-compare-trigger${open ? ' is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Compare: ${label}. Choose what the diff compares against.`}
        onClick={() => (open ? close() : openPicker())}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); openPicker(); } }}
      >
        <span className="session-diff-base-label">Compare:</span>
        <span className="session-diff-compare-value">{label}</span>
        <svg className="session-diff-compare-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && pos && createPortal(
        <div
          ref={popRef}
          className="session-diff-compare-pop"
          role="dialog"
          aria-label="Compare with"
          style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight }}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
        >
          <div className="sdc-search">
            <input
              ref={inputRef}
              type="text"
              value={query}
              data-no-draft="search"
              placeholder="Filter branches and commits"
              aria-label="Filter branches and commits"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={items[active] ? optId(active) : undefined}
              // The top row is the pick from the same render on: an Enter that follows the
              // new text at once (a paste) never acts on a row of the old list.
              onChange={(e) => { setQuery(e.target.value); setActive(0); movedRef.current = false; }}
              spellCheck={false}
              autoComplete="off"
            />
            {loading && <span className="sdc-spinner" aria-label="Loading" />}
          </div>
          <div className="sdc-list" role="listbox" id={listId} ref={listRef} aria-label="Comparisons">
            {items.map((it, i) => (
              <div key={it.key} className="sdc-row-wrap" role="none">
                {i === firstQuick && <div className="sdc-section" role="presentation">Files this session edited</div>}
                {i === branchQuick && <div className="sdc-section" role="presentation">Every file on this branch</div>}
                {i === firstRef && <div className="sdc-section" role="presentation">Branches <span className="sdc-count">{refCount}</span></div>}
                {i === firstCommit && (
                  <div className="sdc-section" role="presentation">
                    {refs?.current ? <>Commits on <span className="sdc-section-ref">{refs.current}</span></> : 'Commits'}
                    <span className="sdc-count">{q ? commitCount : `latest ${commitCount}`}</span>
                    {refs?.current && <span className="sdc-legend"><span className="sdc-onbranch" aria-hidden /> not on {defaultRef || 'the default branch'} yet</span>}
                  </div>
                )}
                {row(it, i)}
              </div>
            ))}
            {refHidden > 0 && <div className="sdc-note">{refHidden} more branches: type to narrow</div>}
            {error && (
              <div className="sdc-note sdc-error">
                Couldn't list branches and commits: {error}
                <button type="button" className="sdc-retry" onClick={() => loadRefs(true)}>Retry</button>
              </div>
            )}
            {!error && loading && !refs && <div className="sdc-note">Loading branches and commits…</div>}
            {noRepo && <div className="sdc-note">This session's folder is not a git repository, so there are no branches or commits to compare with.</div>}
            {q && items.length === 0 && !loading && (
              <div className="sdc-note">
                No branch or commit matches “{query.trim()}”.
                {(refs?.commits.length ?? 0) >= COMMITS_LISTED && ` Only the newest ${COMMITS_LISTED} commits${refs?.current ? ` on ${refs.current}` : ''} are listed.`}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
