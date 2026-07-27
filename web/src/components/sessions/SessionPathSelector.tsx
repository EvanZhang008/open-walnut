/**
 * SessionPathSelector — popover above chat input for picking a working directory.
 *
 * Four-state input model (see path-selector/input-model.ts): history browse,
 * dir-browse (trailing /), segment fuzzy completion, scoped keyword search.
 * Unified ranking (path-selector/ranking.ts): history/frecency first, then
 * leaf-hit > mid-hit, prefix > substring > subsequence. All-tab fans out live
 * listings to every host in parallel (path-selector/useLiveDirs.ts).
 *
 * Extras: ghost-text inline completion (ArrowRight accepts), Option+Backspace
 * deletes the last path segment, "create & start" for nonexistent leaf dirs,
 * hidden dirs shown only when the typed segment starts with '.'.
 */
import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchWorkingDirs, prewarmWorkingDirs, type WorkingDirEntry, type ConfiguredHost } from '@/api/sessions';
import type { TaskPriority } from '@open-walnut/core';
import type { FocusTier } from '@/api/focus';
import { classifyInput, resolveSpaceAmbiguity, deleteLastSegment, ghostSuffix, segmentCompletion, pathValidity, type InputState } from './path-selector/input-model';
import { rankCandidates, buildSections, type Candidate, type RankedItem } from './path-selector/ranking';
import { useLiveDirs, type HostLiveState } from './path-selector/useLiveDirs';
import { GhostTextInput } from './path-selector/GhostTextInput';
import { PathList } from './path-selector/PathList';
import { MetaFooter } from './path-selector/MetaFooter';
import { freshLauncherMeta } from './task-meta-constants';

export interface QuickStartPath {
  cwd: string;
  host: string | null;
  hostLabel?: string;
  category: string;
  /** Launch intent — 'fix-walnut' routes through the server-side repair briefing. */
  intent?: 'fix-walnut';
  /** User opted into "create & start": quick-start mkdirs the cwd first. */
  createCwd?: boolean;
}

/** Task metadata the user sets in the session-launcher footer. Applied to the new task on quick-start.
 *  This is the UI state shape (all fields required so React controlled inputs stay stable).
 *  The wire-format counterpart in `@/api/sessions` has every field optional — see that file. */
export interface QuickStartTaskMeta {
  starred: boolean;
  needs_attention: boolean;
  priority: TaskPriority;
  pinTier: FocusTier | undefined;
  /** Session model alias (SESSION_MODELS id). undefined = Auto — let the CLI/config default decide. */
  model: string | undefined;
  /** Coding-agent engine. undefined = 'claude' (native path). 'codex' → ACP-backed, local-only. */
  engine: 'codex' | undefined;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (path: QuickStartPath, taskMeta: QuickStartTaskMeta) => void;
  /** Meta to seed the footer with on open (e.g. re-opening to edit an already
   *  confirmed Quick Start). undefined → defaults + the remembered pin tier. Lets a
   *  prior model/priority choice survive a reopen instead of silently resetting. */
  initialMeta?: QuickStartTaskMeta;
  /** Path to seed on open (e.g. re-opening to edit an already-confirmed Quick Start).
   *  When set, the picker opens directly in edit mode with this cwd pre-filled and the
   *  host tab selected — an "edit this selection" view, not a blank search. */
  initialPath?: { cwd: string; host: string | null };
  /** Whether dismissing (outside click / Esc) with a picked path CONFIRMS it
   *  (default true — chat flow, where confirm just sets an undoable Quick Start
   *  bar). Pass false when onSelect has an irreversible effect (todo launcher:
   *  select immediately creates a task + spawns a CLI) so dismiss = cancel. */
  confirmOnDismiss?: boolean;
}


export function SessionPathSelector({ open, onClose, onSelect, initialMeta, initialPath, confirmOnDismiss = true }: Props) {
  const navigate = useNavigate();
  const [dirs, setDirs] = useState<WorkingDirEntry[]>([]);
  // All hosts from config.hosts — a freshly added remote host must show as a tab
  // even before its first session exists (else the user can't ever start one).
  const [configuredHosts, setConfiguredHosts] = useState<ConfiguredHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  // How the current highlight was placed. Mouse hover must NOT expand the row
  // (content jumping under the pointer reads as flicker) — only keyboard/default
  // selection shows the full multi-line path.
  const [selectionByHover, setSelectionByHover] = useState(false);
  const [hostFilter, setHostFilter] = useState<string>('all');
  const [editMode, setEditMode] = useState(false);
  const [editingPath, setEditingPath] = useState('');

  // Task metadata the user picks in the footer — applied to the new task when the session starts.
  // A fresh open starts from the defaults with the LAST tier the user picked
  // (freshLauncherMeta) so the choice is sticky across launches and browsers.
  const [meta, setMeta] = useState<QuickStartTaskMeta>(initialMeta ?? freshLauncherMeta);
  // True once the user touches the model/engine controls during THIS open —
  // their explicit pick (including an explicit reset to Auto) beats the
  // per-directory launch memory applied at confirm time.
  const launchTouchedRef = useRef(false);
  const handleMetaChange = useCallback((updater: (m: QuickStartTaskMeta) => QuickStartTaskMeta) => {
    setMeta(prev => {
      const next = updater(prev);
      if (next.model !== prev.model || next.engine !== prev.engine) launchTouchedRef.current = true;
      return next;
    });
  }, []);
  // Read latest initialMeta inside the open effect without adding it to that effect's
  // deps (which would re-trigger the history fetch/pre-warm on every parent re-render).
  const initialMetaRef = useRef(initialMeta);
  initialMetaRef.current = initialMeta;
  // Same ref pattern for initialPath — read in the open effect, kept out of its deps.
  const initialPathRef = useRef(initialPath);
  initialPathRef.current = initialPath;

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const statusBtnRef = useRef<HTMLButtonElement>(null);
  const [statusBtnWidth, setStatusBtnWidth] = useState(0);

  // Programmatic path fill (Tab / click / Option+Backspace / seed / ~ rewrite) —
  // marks the change so the caret-to-end effect below runs ONLY for these,
  // never for plain typing (see comment on that effect).
  const programmaticFillRef = useRef(false);
  const fillPath = useCallback((p: string) => {
    programmaticFillRef.current = true;
    setEditingPath(p);
  }, []);

  // Fetch history + pre-warm SSH connections on open
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setQuery('');
    setSelectedIdx(0);
    setMeta(initialMetaRef.current ?? freshLauncherMeta());
    launchTouchedRef.current = false;
    // Re-opening to edit a confirmed selection: open straight into edit mode with the
    // path pre-filled and its host tab active — an "edit this selection" view. Without
    // a seed path, fall back to the blank browse view (fresh /session invocation).
    const seed = initialPathRef.current;
    if (seed?.cwd) {
      setEditMode(true);
      fillPath(seed.cwd);
      setHostFilter(seed.host ?? '__local__');
    } else {
      setHostFilter('all');
      setEditMode(false);
      setEditingPath('');
    }
    // Pre-warm per-host SSH connections now that the picker is actually opening
    // (moved off the unconditional module-import side effect that used to fire
    // on every page load and contend with the home critical path).
    prewarmWorkingDirs();
    // fetchWorkingDirs returns from cache if already prefetched
    fetchWorkingDirs()
      .then(({ dirs: d, hosts: h }) => { setDirs(d); setConfiguredHosts(h); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [open]);

  // Focus search on open
  useEffect(() => {
    if (open && !loading) {
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open, loading]);

  // New-user / new-host fallback: when the active tab has NO history at all,
  // browse mode is a dead end ("No session history yet"). Seed edit mode with ~/
  // so the live home-directory listing starts immediately — a first-run user (or a
  // freshly added remote host) can pick a folder without knowing to type a path.
  // Seeded once per tab per open (Set) so Escape-out isn't fought.
  const seededFiltersRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!open) { seededFiltersRef.current.clear(); return; }
    if (loading || editMode || initialPathRef.current?.cwd) return;
    if (seededFiltersRef.current.has(hostFilter)) return;
    const hasHistory = dirs.some(d => {
      if (hostFilter === 'all') return true;
      if (hostFilter === '__local__') return !d.host;
      return d.host === hostFilter;
    });
    if (dirs.length > 0 && hasHistory) return;
    seededFiltersRef.current.add(hostFilter);
    setEditMode(true);
    fillPath('~/');
  }, [open, loading, editMode, hostFilter, dirs, fillPath]);

  // Caret-to-end ONLY after PROGRAMMATIC fills (Tab / click / Option+Backspace / ~
  // rewrite). This effect used to run on EVERY editingPath change — i.e. every
  // keystroke — which teleported the caret to the end while the user was editing
  // mid-string, so continued Backspaces silently ate the END of the path
  // (reported as "the whole input changed while I was deleting").
  useEffect(() => {
    if (!programmaticFillRef.current) return;
    programmaticFillRef.current = false;
    if (editMode && searchRef.current) {
      const len = editingPath.length;
      searchRef.current.setSelectionRange(len, len);
    }
  }, [editMode, editingPath]);

  // ── Input classification (four-state model) ──
  const active = editMode ? editingPath : query;
  const preState = useMemo(() => classifyInput(active), [active]);

  // Path whose parent gets live-listed ('' = pure browse, no live listing)
  const activePath = preState.kind === 'browse' ? ''
    : preState.kind === 'scoped-search' ? preState.base
    : preState.kind === 'dir-browse' ? preState.dir
    : preState.dir + preState.partial;

  const { byHost, anyLoading } = useLiveDirs(activePath, hostFilter, configuredHosts);

  // Space-ambiguity: once live children of the base are known, a literal dir
  // named "b keyword" flips scoped-search back to a path interpretation.
  const inputState: InputState = useMemo(() => {
    if (preState.kind !== 'scoped-search') return preState;
    const allChildren: string[] = [];
    for (const s of byHost.values()) if (s.status === 'done') allChildren.push(...s.dirs);
    return resolveSpaceAmbiguity(preState, allChildren);
  }, [preState, byHost]);

  // ~ → resolved-path rewrite (single-host modes only; in All mode each host
  // expands ~ differently, so the raw ~ must stay in the input).
  useEffect(() => {
    if (!editMode || hostFilter === 'all') return;
    if (!editingPath.startsWith('~/') && editingPath !== '~') return;
    const key = hostFilter === '__local__' ? '__local__' : hostFilter;
    const state = byHost.get(key);
    if (state?.status === 'done' && state.parent && !state.parent.startsWith('~')) {
      // Replace the ~-prefix with the resolved parent, keeping any typed partial.
      const typedDir = editingPath.endsWith('/') ? editingPath : editingPath.slice(0, editingPath.lastIndexOf('/') + 1);
      const partial = editingPath.slice(typedDir.length);
      const parent = state.parent.endsWith('/') ? state.parent : state.parent + '/';
      fillPath(parent + partial);
    }
  }, [editMode, hostFilter, editingPath, byHost, fillPath]);

  // Host tabs — union of configured hosts (config.hosts, even with zero history)
  // and any host seen in history (covers hosts removed from config but still in history).
  const hostTabs = useMemo(() => {
    const labels = new Map<string, { label: string; rawName?: boolean }>();
    labels.set('all', { label: 'All' });
    labels.set('__local__', { label: 'Local' });
    for (const h of configuredHosts) {
      if (!labels.has(h.alias)) labels.set(h.alias, { label: h.label, rawName: h.rawName });
    }
    for (const d of dirs) {
      if (d.host && !labels.has(d.host)) labels.set(d.host, { label: d.hostLabel ?? d.host });
    }
    return Array.from(labels.entries()).map(([key, v]) => ({ key, label: v.label, rawName: v.rawName }));
  }, [dirs, configuredHosts]);

  const currentHost = hostFilter !== 'all' && hostFilter !== '__local__' ? hostFilter : null;
  const currentHostLabel = hostTabs.find(t => t.key === hostFilter)?.label;

  // ── Candidates: live children (+preloaded deep hits) merged with history ──
  const pathMode = inputState.kind !== 'browse';
  const sections = useMemo(() => {
    const hostFiltered = dirs.filter(d => {
      if (hostFilter === '__local__' && d.host) return false;
      if (hostFilter !== 'all' && hostFilter !== '__local__' && d.host !== hostFilter) return false;
      return true;
    });
    const historyByKey = new Map<string, WorkingDirEntry>();
    for (const d of hostFiltered) historyByKey.set(`${d.host ?? '__local__'}::${d.cwd}`, d);

    const candidates: Candidate[] = [];

    if (!pathMode) {
      // Browse: history only. Empty query → frecency top list (ranking sorts it).
      for (const d of hostFiltered) {
        candidates.push({ cwd: d.cwd, host: d.host, hostLabel: d.hostLabel, source: 'history', depth: 0, history: d });
      }
    } else {
      const partial = inputState.kind === 'segment' ? inputState.partial
        : inputState.kind === 'scoped-search' ? inputState.keyword : '';
      const showHidden = partial.startsWith('.');
      const seen = new Set<string>();

      for (const [hostKey, state] of byHost) {
        if (state.status !== 'done' || !state.exists) continue;
        const host = hostKey === '__local__' ? null : hostKey;
        const hostLabel = hostTabs.find(t => t.key === hostKey)?.label;
        const parent = state.parent.endsWith('/') ? state.parent : state.parent + '/';
        for (const p of state.dirs) {
          if (!p.startsWith(parent)) continue;
          const rest = p.slice(parent.length);
          if (!rest) continue;
          const depth = rest.split('/').length; // 1 = direct child
          // dir-browse and scoped-search list direct children; segment mode also
          // admits preloaded depth-2 "deep hits" (b/*/*c*) per the design.
          if (inputState.kind !== 'segment' && depth > 1) continue;
          const leaf = rest.slice(rest.lastIndexOf('/') + 1);
          if (leaf.startsWith('.') && !showHidden) continue;
          const key = `${hostKey}::${p}`;
          seen.add(key);
          candidates.push({
            cwd: p, host, hostLabel, source: 'live', depth,
            history: historyByKey.get(key),
          });
        }
        // History entries under this parent the live listing didn't cover (deeper
        // than the preload) — still admitted, tagged as history.
        for (const d of hostFiltered) {
          if ((d.host ?? '__local__') !== hostKey) continue;
          const key = `${hostKey}::${d.cwd}`;
          if (seen.has(key)) continue;
          if (!(d.cwd + '/').startsWith(parent)) continue;
          if (d.cwd.length <= parent.length) continue; // the parent itself isn't a candidate
          seen.add(key);
          const rest = d.cwd.slice(parent.length);
          candidates.push({
            cwd: d.cwd, host: d.host, hostLabel: d.hostLabel,
            source: 'history', depth: rest.split('/').length, history: d,
          });
        }
      }
    }

    const ranked = rankCandidates(inputState, candidates);
    const hostActivity = new Map<string, number>();
    for (const d of dirs) {
      const key = d.host ?? '__local__';
      hostActivity.set(key, (hostActivity.get(key) ?? 0) + d.count);
    }
    return buildSections(ranked, {
      hostGrouping: pathMode && hostFilter === 'all',
      hostActivity,
    });
  }, [dirs, hostFilter, inputState, pathMode, byHost, hostTabs]);

  const flatItems = useMemo(() => sections.flatMap(s => s.items), [sections]);

  // The first ranked candidate whose leaf prefix-extends the typed partial. This is
  // ONLY used to decide which row auto-highlights (see effect below) — the ghost
  // text and every completion key derive from the *highlighted* row, so the grey
  // prediction, the highlight, and Tab/Enter/→ can never point at different things.
  const ghostAutoIdx = useMemo(() => {
    if (!editMode) return -1;
    const scan = flatItems.slice(0, 10);
    for (let i = 0; i < scan.length; i++) {
      if (ghostSuffix(inputState, scan[i].cwd)) return i;
    }
    return -1;
  }, [editMode, inputState, flatItems]);

  // Ghost text = inline preview of the currently-highlighted row. Because Tab/Enter
  // complete that same row, what you see (grey suffix) is exactly what you get.
  const ghost = useMemo(() => {
    if (!editMode) return null;
    return ghostSuffix(inputState, flatItems[selectedIdx]?.cwd ?? null);
  }, [editMode, inputState, flatItems, selectedIdx]);

  // Live existence verdict for the typed path — drives the ✓ / "new" badge next
  // to the confirm button, and flips confirm into create-&-start when missing.
  const validity = useMemo(
    () => pathValidity(inputState, byHost.values()),
    [inputState, byHost],
  );

  // "Create & start" — path mode with an unambiguous target host (a specific
  // tab, or All when only one host exists), listing settled, exact path missing.
  const createTarget = useMemo(() => {
    if (hostFilter !== 'all') return hostFilter === '__local__' ? '__local__' : hostFilter;
    return byHost.size === 1 ? Array.from(byHost.keys())[0] : null;
  }, [hostFilter, byHost]);

  const createOption = useMemo(() => {
    if (!pathMode || !createTarget) return null;
    const state = byHost.get(createTarget);
    if (!state || state.status !== 'done') return null;
    if (inputState.kind === 'dir-browse') {
      return state.exists ? null : (inputState.dir.replace(/\/+$/, '') || '/');
    }
    if (inputState.kind === 'segment' && inputState.partial) {
      if (!state.exists) return inputState.dir + inputState.partial;
      const parent = state.parent.endsWith('/') ? state.parent : state.parent + '/';
      const hasExact = state.dirs.some(p => {
        if (!p.startsWith(parent)) return false;
        const rest = p.slice(parent.length);
        return !rest.includes('/') && rest === inputState.partial;
      });
      return hasExact ? null : parent + inputState.partial;
    }
    return null;
  }, [createTarget, pathMode, inputState, byHost]);

  useLayoutEffect(() => {
    const el = statusBtnRef.current;
    if (!el) { setStatusBtnWidth(0); return; }
    const measure = () => setStatusBtnWidth(el.offsetWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [validity, createOption, editMode, editingPath]);

  // Reset keyboard selection when the input context changes. Deliberately NOT
  // keyed on byHost — progressive per-host arrivals must not yank the cursor.
  // Also clears the "user drove the cursor with ↑↓" flag so the ghost row can
  // re-take the highlight for the freshly-typed segment.
  const manualNavRef = useRef(false);
  useEffect(() => { setSelectedIdx(0); setSelectionByHover(false); manualNavRef.current = false; }, [active, hostFilter, editMode]);

  // Auto-highlight the row that prefix-completes the typed segment, so the grey
  // ghost preview lands on the row the user will Tab into. Skip once the user has
  // manually moved with ↑↓ (their explicit pick wins until the input changes).
  useEffect(() => {
    if (manualNavRef.current) return;
    if (ghostAutoIdx >= 0) { setSelectedIdx(ghostAutoIdx); setSelectionByHover(false); }
  }, [ghostAutoIdx]);

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('.sps-path-item');
    items[selectedIdx]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  // Per-directory launch memory: merge the remembered model/engine of the picked
  // directory into the footer meta — unless the user explicitly touched those
  // controls this open (their pick wins, including an explicit reset to Auto),
  // or the picker was seeded with a prior confirmed meta (re-edit flow).
  // No memory on the picked dir → reset to Auto/Claude so a preview from a
  // previously highlighted row can't leak onto an unrelated directory.
  const withLaunchMemory = useCallback((launch: { model?: string; engine?: 'codex' } | undefined): QuickStartTaskMeta => {
    if (launchTouchedRef.current || initialMetaRef.current) return meta;
    return { ...meta, model: launch?.model, engine: launch?.engine };
  }, [meta]);

  // Live preview: the footer shows the remembered launch config of the CURRENT
  // TARGET directory — what you see is what will launch. The target is:
  //  - browse mode: the highlighted row
  //  - edit mode: the typed path itself (clicking a history row drills into
  //    edit mode where the highlight moves to live CHILD dirs — previewing
  //    those would wrongly reset the footer to Auto; the launch target is the
  //    typed path, so its memory drives the preview). Host match mirrors
  //    handleConfirm: the explicit tab is host authority, All infers.
  useEffect(() => {
    if (!open || launchTouchedRef.current || initialMetaRef.current) return;
    let launch: { model?: string; engine?: 'codex' } | undefined;
    if (editMode) {
      const trimmed = editingPath.replace(/\/+$/, '') || '/';
      const match = hostFilter === 'all'
        ? dirs.find(d => d.cwd === trimmed)
        : dirs.find(d => d.cwd === trimmed && (d.host ?? null) === currentHost);
      launch = match?.lastLaunch;
    } else {
      launch = flatItems[selectedIdx]?.history?.lastLaunch;
    }
    setMeta(m => (m.model === launch?.model && m.engine === launch?.engine)
      ? m : { ...m, model: launch?.model, engine: launch?.engine });
  }, [open, editMode, editingPath, dirs, hostFilter, currentHost, flatItems, selectedIdx]);

  const handleSelect = useCallback((d: RankedItem) => {
    onSelect({
      cwd: d.cwd, host: d.host, hostLabel: d.hostLabel,
      category: d.history?.category ?? 'Inbox',
    }, withLaunchMemory(d.history?.lastLaunch));
  }, [onSelect, withLaunchMemory]);

  // Confirm the current editingPath (Shift+Enter or the Start-session button).
  // The explicitly selected tab is the HOST AUTHORITY: a history row with the
  // same cwd on a different host (dotfiles, mirrored workspace layouts) must
  // never override it — history only supplies the category. Host inference
  // from a history match is allowed only under the All tab, where no host was
  // explicitly chosen.
  const handleConfirm = useCallback((opts?: { createCwd?: boolean }) => {
    if (!editingPath) return;
    const trimmed = editingPath.replace(/\/+$/, '') || '/';
    const anyTab = hostFilter === 'all';
    const match = anyTab
      ? dirs.find(d => d.cwd === trimmed)
      : dirs.find(d => d.cwd === trimmed && (d.host ?? null) === currentHost);
    onSelect({
      cwd: trimmed,
      host: anyTab ? (match?.host ?? null) : currentHost,
      hostLabel: anyTab ? match?.hostLabel : currentHostLabel,
      category: match?.category ?? 'Inbox',
      ...(opts?.createCwd ? { createCwd: true } : {}),
    }, withLaunchMemory(match?.lastLaunch));
  }, [editingPath, dirs, onSelect, hostFilter, currentHost, currentHostLabel, withLaunchMemory]);

  // "Create & start" row: confirm the missing path with the createCwd flag.
  // Host comes from createTarget (not hostFilter) so All-tab-with-one-host works.
  const handleCreate = useCallback(() => {
    if (!createOption || !createTarget) return;
    const trimmed = createOption.replace(/\/+$/, '') || '/';
    const host = createTarget === '__local__' ? null : createTarget;
    onSelect({
      cwd: trimmed,
      host,
      hostLabel: hostTabs.find(t => t.key === createTarget)?.label,
      category: 'Inbox',
      createCwd: true,
      // Brand-new dir → no launch memory; withLaunchMemory(undefined) clears any
      // leaked highlight preview (user-touched picks still win inside it).
    }, withLaunchMemory(undefined));
  }, [createOption, createTarget, onSelect, hostTabs, withLaunchMemory]);

  // Single confirm entry (⇧Enter + the status button): a path the live listing
  // says is MISSING never silently starts — it routes to create-&-start when a
  // target host is unambiguous, else no-ops (the per-host "does not exist" note
  // explains). 'unknown' (loading / host down) never blocks.
  const confirmCurrent = useCallback(() => {
    if (validity === 'missing') {
      if (createOption && createTarget) handleCreate();
      return;
    }
    handleConfirm();
  }, [validity, createOption, createTarget, handleCreate, handleConfirm]);

  // Item interaction: live dir → drill deeper (stay in picker); history → fill path.
  const drillOrFill = useCallback((d: RankedItem) => {
    if (!editMode) {
      setEditMode(true);
      setSelectedIdx(0);
    }
    if (d.source === 'live') {
      fillPath(d.cwd + '/');
      if (d.host && hostFilter === 'all') setHostFilter(d.host);
    } else {
      fillPath(d.cwd);
    }
  }, [editMode, hostFilter, fillPath]);

  // Dismiss by clicking outside / Esc.
  const handleDismiss = useCallback(() => {
    // A picked path IS the decision — dismissing (outside click / Esc) confirms
    // it as the Quick Start target instead of throwing the pick away; the user
    // shouldn't have to also hit ✓/⇧Enter. Applies to the re-edit flow
    // (initialPath) AND a fresh pick. Only exceptions: no path typed yet
    // (browse mode → plain close), or the live listing PROVED the path missing
    // (never silently target a nonexistent dir from a dismiss — create-&-start
    // stays an explicit button).
    if (confirmOnDismiss && editingPath && validity !== 'missing') {
      handleConfirm();
    } else {
      onClose();
    }
  }, [confirmOnDismiss, editingPath, validity, handleConfirm, onClose]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // Shift+Tab: cycle host tabs (works in both modes)
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      const idx = hostTabs.findIndex(t => t.key === hostFilter);
      const nextIdx = (idx + 1) % hostTabs.length;
      setHostFilter(hostTabs[nextIdx].key);
      return;
    }

    // Skip IME composition (e.g. Chinese input selecting candidate)
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    if (editMode) {
      // --- EDIT MODE ---
      if (e.key === 'Enter' && (e.shiftKey || e.metaKey)) {
        // Shift+Enter or Cmd+Enter: confirm and start session
        e.preventDefault();
        confirmCurrent();
      } else if (e.key === 'Enter') {
        // Enter: always select/autocomplete (never sends). Follows the highlighted
        // row, which the ghost effect keeps on the predicted completion.
        e.preventDefault();
        if (flatItems.length > 0) {
          drillOrFill(flatItems[Math.min(selectedIdx, flatItems.length - 1)]);
        }
        // If no items, Enter does nothing (path is incomplete)
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setEditMode(false);
        setEditingPath('');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        manualNavRef.current = true;
        setSelectionByHover(false);
        setSelectedIdx(prev => Math.min(prev + 1, Math.max(flatItems.length - 1, 0)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        manualNavRef.current = true;
        setSelectionByHover(false);
        setSelectedIdx(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'ArrowRight') {
        // Ghost accept — only when the caret sits at the end of the input;
        // otherwise let the default caret move happen. Same one-segment descend
        // as Tab, and same REAL-casing rule: never `editingPath + ghost` (typed
        // 'eksai' + suffix would fabricate a wrong-cased path that doesn't exist
        // on case-sensitive hosts) — rebuild from the candidate's actual segment.
        const input = e.currentTarget;
        if (ghost && input.selectionStart === input.value.length && input.selectionEnd === input.value.length) {
          e.preventDefault();
          const oneLevel = segmentCompletion(inputState, flatItems[selectedIdx]?.cwd ?? null);
          if (oneLevel) fillPath(oneLevel);
        }
      } else if (e.key === 'Backspace' && e.altKey) {
        // Option+Backspace: delete last path segment. Native word-delete already
        // treats '/' as a boundary, so this matches user intuition — we override
        // only to guarantee the trailing slash stays ('/a/b/c/' → '/a/b/').
        // Cmd+Backspace keeps its native delete-to-line-start.
        e.preventDefault();
        fillPath(deleteLastSegment(editingPath));
      } else if (e.key === 'Tab') {
        // Tab: shell-style — complete the CURRENT segment only and descend one
        // level, using the candidate's REAL casing (typed 'eksai' → the actual
        // 'EKSAI…' directory name, never `typed + ghost` concatenation, which
        // fabricates wrong-cased paths on case-sensitive hosts). Never jumps
        // deeper than one level, even when the highlighted row is a deep path.
        // Full-row cwd is the last resort (fuzzy/substring hits, no segment rule).
        e.preventDefault();
        const sel = flatItems[selectedIdx];
        if (sel) {
          const oneLevel = segmentCompletion(inputState, sel.cwd);
          fillPath(oneLevel ?? (sel.cwd.endsWith('/') ? sel.cwd : sel.cwd + '/'));
        }
      }
    } else {
      // --- BROWSE MODE ---
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        manualNavRef.current = true;
        setSelectionByHover(false);
        setSelectedIdx(prev => Math.min(prev + 1, Math.max(flatItems.length - 1, 0)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        manualNavRef.current = true;
        setSelectionByHover(false);
        setSelectedIdx(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' && (e.shiftKey || e.metaKey)) {
        // Shift+Enter: send selected item directly (skip edit mode)
        e.preventDefault();
        if (flatItems[selectedIdx] && flatItems[selectedIdx].source === 'history') {
          handleSelect(flatItems[selectedIdx]);
        }
      } else if (e.key === 'Enter') {
        // Enter: enter edit mode with selected item
        e.preventDefault();
        if (flatItems[selectedIdx]) drillOrFill(flatItems[selectedIdx]);
      } else if (e.key === 'Escape') {
        handleDismiss();
      }
    }
  }, [editMode, flatItems, selectedIdx, handleDismiss, confirmCurrent, handleSelect, drillOrFill, hostFilter, hostTabs, ghost, editingPath, inputState, fillPath]);

  // Close on outside click — saves edits when editing an existing selection (see handleDismiss).
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        handleDismiss();
      }
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 100);
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler); };
  }, [open, handleDismiss]);

  if (!open) return null;

  // Live host states drive per-host empty states / host-down rows in path mode.
  const visibleHostStates: Map<string, HostLiveState> = pathMode ? byHost : new Map();

  const emptyHint = editMode
    ? (anyLoading ? 'Listing directories...' : 'No matches. Press ⇧Enter or click Go to use this path.')
    : dirs.length === 0
      ? 'No session history yet — type a path (e.g. ~/projects) to browse.'
      : 'No paths match your search.';

  return (
    <div className="session-path-selector" ref={popoverRef}>
      {/* One-line concept explainer — new users repeatedly ask "task vs session?".
          A session is the live Claude Code run; the task is the tracking record
          Walnut auto-creates for it. Say it at the exact moment both get created. */}
      <div className="sps-header">
        <span className="sps-header-title">Start a coding session</span>
        <span className="sps-header-hint">
          Runs Claude Code in the folder you pick — a task is created automatically to track it.
        </span>
      </div>
      <div className="sps-search" style={{ '--sps-status-w': statusBtnWidth ? `${statusBtnWidth + 20}px` : '0px' } as React.CSSProperties}>
        <GhostTextInput
          ref={searchRef}
          value={editMode ? editingPath : query}
          ghost={ghost}
          editing={editMode}
          placeholder={editMode ? 'Type your path... (Enter select, ⇧Enter start session, Esc back)' : 'Type a path — start a Claude Code session there directly'}
          onChange={v => {
            if (editMode) { setEditingPath(v); return; }
            // Path-like input flips straight into edit mode (shell mental model) —
            // ghost text / Option+Backspace / create-row all live there.
            if (v.startsWith('/') || v.startsWith('~')) {
              setEditMode(true);
              setEditingPath(v);
              setQuery('');
            } else {
              setQuery(v);
            }
          }}
          onKeyDown={handleKeyDown}
        />
        {/* Compact status/confirm button — color answers "is this a real folder?":
            green ✓ = exists (start), amber "+ folder" = missing (create folder & start),
            neutral ↵ = no verdict yet (loading / host down — never blocks).
            Kept small on purpose: the header + keys-hint already say "start session".
            Label says "folder" explicitly — "+ new" read as "new session" to users. */}
        {editMode && editingPath && (
          <button
            ref={statusBtnRef}
            className={`sps-status-btn sps-status-${validity}`}
            disabled={validity === 'missing' && !createOption}
            onClick={confirmCurrent}
            title={
              validity === 'valid' ? 'Folder exists — start session here (⇧Enter)'
              : validity === 'missing'
                ? (createOption ? "Folder doesn't exist — create the folder, then start a session in it (⇧Enter)" : 'Folder not found on any host — pick a host tab to create it')
              : 'Start session (⇧Enter)'
            }
          >
            {validity === 'valid' ? '✓' : validity === 'missing' ? '+ folder' : '↵'}
          </button>
        )}
      </div>

      {hostTabs.length > 2 && (
        <div className="sps-host-filter">
          {hostTabs.map(tab => (
            <button
              key={tab.key}
              className={`sps-host-tab${hostFilter === tab.key ? ' active' : ''}`}
              onClick={() => setHostFilter(tab.key)}
              // Crowded tab row — the "give it a name" nudge lives in the tooltip
              // and in a one-line banner shown only when this tab is active.
              title={tab.rawName ? 'Auto-discovered from ~/.ssh/config — give it a friendly name in Settings → Remote Hosts' : undefined}
            >
              {tab.label}
              {tab.rawName && <span className="sps-host-tab-raw" aria-hidden>✎</span>}
            </button>
          ))}
          <span className="sps-host-hint">Shift+Tab</span>
        </div>
      )}

      {/* Nudge shown ONLY while a raw auto-discovered host tab is selected — zero
          cost to the crowded tab row, appears exactly when the user is looking
          at the ugly name and cares. */}
      {hostTabs.find(t => t.key === hostFilter)?.rawName && (
        <div className="sps-raw-host-nudge">
          Auto-discovered host —{' '}
          <a
            href="/settings#remote-hosts"
            onClick={(e) => {
              e.preventDefault();
              onClose();
              navigate('/settings#remote-hosts');
            }}
          >
            give it a friendly name in Settings
          </a>
        </div>
      )}

      <PathList
        ref={listRef}
        sections={sections}
        selectedIdx={selectedIdx}
        expandSelected={!selectionByHover}
        loading={loading || (anyLoading && flatItems.length === 0)}
        loadError={error}
        hostStates={visibleHostStates}
        pathMode={pathMode}
        activeHostLabel={currentHostLabel ?? 'Local'}
        createOption={createOption}
        emptyHint={emptyHint}
        onItemClick={drillOrFill}
        onItemHover={(idx) => { setSelectionByHover(true); setSelectedIdx(idx); }}
        onCreate={handleCreate}
      />

      {/* Key hints live here (not in the placeholder) so the placeholder can say
          what the popover is FOR — new users scan purpose first, keys later. */}
      <div className="sps-keys-hint">
        <kbd>↑↓</kbd> navigate · <kbd>Enter</kbd> select · <kbd>→</kbd> complete · <kbd>⇧Enter</kbd> start session · <kbd>Esc</kbd> close
      </div>

      {/* Task metadata footer — applied to the new task on quick-start.
          Compact single row in edit mode: space goes back to the path list.
          host: the active tab's host drives which catalog fills the model
          dropdown ('all' tab → local catalog, the overwhelmingly common case). */}
      <MetaFooter meta={meta} onChange={handleMetaChange} compact={editMode} host={currentHost} />
    </div>
  );
}
