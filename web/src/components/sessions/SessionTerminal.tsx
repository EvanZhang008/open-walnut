/**
 * SessionTerminal — a session's terminals: tabs, split panes, and the header.
 *
 * Each terminal (SessionTerminalPane) is its own shell under dtach on the target
 * host (local or remote/SSH), so it survives disconnects and server restarts.
 * The layout (terminal-layout.ts: which terminals, in which tabs, split which
 * way) is kept per session in this browser, and met with what the host still
 * runs (`terminal:list`) when the view opens: a terminal opened on another device
 * gets a tab, one whose shell has gone loses its tab.
 *
 * Presentations (same inner content):
 * - default: a centered portal modal over a dim backdrop.
 * - `embedded`: renders inline (no portal, no backdrop) so it can fill the left
 *   column of the session full-screen split, matching Changed / Files.
 * - `dock`: embedded under the split's other view (Changed, Files), so the
 *   terminal and the diff show together; its header then offers "Terminal only"
 *   and "Hide" instead of "Show with Changed".
 * - `compact` (the phone): one terminal at a time, a tab per terminal, no split.
 *
 * When dtach can't be provisioned on the target, the server opens a PLAIN
 * shell instead: xterm mounts as usual, the header shows a "Not persistent"
 * badge and a notice above the terminal names the fix plus a Retry (see
 * TerminalModeNotices). Only an ssh failure blocks, with a card showing ssh's
 * own error.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { terminalList, terminalReserve } from '@/api/terminal';
import { useConfirm } from '@/hooks/useConfirm';
import { useHostDisplayLabel } from '@/hooks/useHostDisplayLabel';
import { remoteHostTag } from '@/utils/host-display-label';
import { log } from '@/utils/log';
import { ICON_CLOSE, ICON_EXPAND, ICON_PANEL_BOTTOM, ICON_PLUS, ICON_SPLIT_DOWN, ICON_SPLIT_RIGHT } from '../common/Icons';
import { TerminalStatusPill } from './TerminalModeNotices';
import { SessionTerminalPane, type TerminalPaneHandle, type TerminalPaneState } from './SessionTerminalPane';
import type { TerminalPathLink } from './terminal-links';
import {
  MAX_PANES_PER_TAB, activateTab, activeTab, addTab, allSlots, canAddTerminal, canSplit, focusSlot, focusedSlot, initialLayout,
  isPaneLeaf, loadLayout, paneRects, reconcileLayout, removeSlot, saveLayout, splitActive, type SplitDir, type TerminalLayout, type TerminalTab,
} from './terminal-layout';

/** How long the view waits for the host's list of terminals before it opens the stored ones. */
const LIST_WAIT_MS = 4_000;
/** How long a new terminal waits for the server's slot before it takes the lowest free one here. */
const RESERVE_WAIT_MS = 4_000;
/** The smallest pane a split may leave: about 30 columns wide, 5 rows tall. */
const MIN_SPLIT_W = 250;
const MIN_SPLIT_H = 110;

interface SessionTerminalProps {
  sessionId: string;
  /** Display label (host alias or cwd) for the header. */
  label?: string;
  host?: string;
  onClose: () => void;
  /**
   * When true, render inline (fills its parent) instead of a centered portal
   * modal — used by the session full-screen split's left column.
   */
  embedded?: boolean;
  /** Chat segment of the full-width bar (the panel's chat toggle) — see
   *  SessionFileExplorer.barRightSlot. Embedded mode only. */
  barRightSlot?: ReactNode;
  /**
   * Show the terminal together with the split's other view. `docked`: it is under
   * that view now. `onDock`: dock it (from the full view: "Show with Changed").
   * `onUndock`: take it out of the dock (hide it). `onMaximize`: the terminal alone.
   */
  dock?: { docked: boolean; viewLabel: string; onDock?: () => void; onUndock?: () => void; onMaximize?: () => void };
  /** The phone: one terminal at a time, no split. */
  compact?: boolean;
  /** "Add to chat" on a selection: the text and where it came from ("Terminal 2"). */
  onAddToChat?: (text: string, source: string) => void;
  /** A file path in the output was clicked. */
  onOpenPath?: (link: TerminalPathLink) => void;
  /** A clicked path no host has: a short note over the terminals (a new nonce shows it again). */
  pathNotice?: { text: string; nonce: number } | null;
  onDismissPathNotice?: () => void;
  /**
   * Docked: the height the shown tab needs so each stacked pane keeps a few
   * readable rows (the dock grows to it, as far as the column allows).
   */
  onDockWant?: (px: number) => void;
}

/** The least a stacked pane needs docked: its strip and about five rows. */
const PANE_ROW_PX = 112;

/** How long the note about a clicked path that does not exist stays. */
const PATH_NOTICE_MS = 6_000;

const EMPTY_STATE: TerminalPaneState = { ending: false, exited: false, plain: null, title: null };

const terminalName = (slot: number) => `Terminal ${slot}`;

/** What a key sends to a shell, for the keys kept while a new terminal opens; null: not kept. */
function keyText(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): string | null {
  if (e.metaKey || e.altKey) return null;
  if (e.ctrlKey) return /^[a-z]$/i.test(e.key) ? String.fromCharCode(e.key.toUpperCase().charCodeAt(0) - 64) : null;
  if (e.key === 'Enter') return '\r';
  if (e.key === 'Backspace') return '\x7f';
  if (e.key === 'Tab') return '\t';
  return e.key.length === 1 ? e.key : null;
}

function tabLabel(tab: TerminalTab, states: Record<number, TerminalPaneState>): string {
  if (tab.slots.length > 1) return `Terminals ${[...tab.slots].sort((a, b) => a - b).join(', ')}`;
  const slot = tab.slots[0]!;
  const t = states[slot]?.title;
  return t ? `${slot}: ${t}` : terminalName(slot);
}

export function SessionTerminal({ sessionId, label, host, onClose, embedded = false, barRightSlot, dock, compact = false, onAddToChat, onOpenPath, pathNotice, onDismissPathNotice, onDockWant }: SessionTerminalProps) {
  const confirm = useConfirm();
  const remote = host && host !== '__local__' ? host : null;
  const hostName = useHostDisplayLabel(remote);
  // A session with no cwd is labelled by its host: by its name then, never its alias.
  const fullTitle = remote && label === remote ? hostName : label;
  // The phone has room for the folder's own name only (a cut-off `/tm…` says nothing).
  const title = compact && fullTitle ? (fullTitle.split('/').filter(Boolean).pop() ?? fullTitle) : fullTitle;

  // The layout this browser kept, met with the host's terminals before the panes
  // open: a pane opened first would start a fresh shell in a slot whose shell has
  // gone, and the list would then count it as running.
  const [layout, setLayout] = useState<TerminalLayout>(() => loadLayout(sessionId) ?? initialLayout());
  const [listed, setListed] = useState(false);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useEffect(() => {
    let done = false;
    const asked = allSlots(layoutRef.current);
    const finish = () => { if (!done) { done = true; setListed(true); } };
    const timer = setTimeout(() => {
      log.warn('terminal', 'terminal list did not answer in time, opening the stored layout', { sessionId });
      finish();
    }, LIST_WAIT_MS);
    terminalList(sessionId)
      .then((r) => {
        if (done) return;
        // A host that could not be asked keeps the stored tabs as they are.
        if (r.listed || r.slots.length > 0) {
          setLayout((l) => reconcileLayout(l, r.slots, r.listed ? asked : []));
        }
      })
      .catch((err) => log.warn('terminal', 'terminal list failed', { sessionId, error: String(err) }))
      .finally(() => { clearTimeout(timer); finish(); });
    return () => { done = true; clearTimeout(timer); };
  }, [sessionId]);
  useEffect(() => { if (listed) saveLayout(sessionId, layout); }, [listed, sessionId, layout]);
  // Back to this window (another window may have opened a terminal): ask the
  // host again and add what it runs that no tab shows. Only adds: a terminal
  // this window is opening right now is not on the host's list yet.
  useEffect(() => {
    if (!listed) return;
    let alive = true;
    const relist = () => {
      if (document.visibilityState !== 'visible') return;
      terminalList(sessionId)
        .then((r) => { if (alive && r.slots.length > 0) setLayout((l) => reconcileLayout(l, r.slots, [])); })
        .catch(() => { /* the next focus asks again */ });
    };
    window.addEventListener('focus', relist);
    document.addEventListener('visibilitychange', relist);
    return () => {
      alive = false;
      window.removeEventListener('focus', relist);
      document.removeEventListener('visibilitychange', relist);
    };
  }, [listed, sessionId]);

  // Every pane's state (status, plain, title), for the header and the tabs.
  const [states, setStates] = useState<Record<number, TerminalPaneState>>({});
  const onPaneState = useCallback((slot: number, s: TerminalPaneState) => {
    setStates((prev) => {
      const p = prev[slot];
      if (p && p.ending === s.ending && p.exited === s.exited && p.plain === s.plain && p.title === s.title) return prev;
      return { ...prev, [slot]: s };
    });
  }, []);
  const panes = useRef(new Map<number, TerminalPaneHandle>());
  // One ref callback per slot, kept: a new one each render would detach and
  // reattach every pane's handle on every render.
  const paneRefs = useRef(new Map<number, (h: TerminalPaneHandle | null) => void>());
  const paneRef = useCallback((slot: number) => {
    let cb = paneRefs.current.get(slot);
    if (!cb) {
      cb = (h) => { if (h) panes.current.set(slot, h); else panes.current.delete(slot); };
      paneRefs.current.set(slot, cb);
    }
    return cb;
  }, []);

  // onClose toggles the panel's view from what it was when this rendered, so a
  // late End answer after the user moved to another view (Files, Changed, ...)
  // must not call it: that would close the view they opened.
  // The view stays mounted across Terminal and docked (TerminalDock), so the
  // close in effect when an End answers is the latest one, read through a ref.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const removePane = useCallback((slot: number) => {
    const next = removeSlot(layoutRef.current, slot);
    layoutRef.current = next;
    setLayout(next);
    setStates((prev) => {
      if (!(slot in prev)) return prev;
      const { [slot]: _gone, ...rest } = prev;
      return rest;
    });
    if (next.tabs.length === 0) {
      saveLayout(sessionId, next);
      if (mountedRef.current) onCloseRef.current();
    }
  }, [sessionId]);

  const focused = focusedSlot(layout);
  const focusedState = (focused !== null ? states[focused] : undefined) ?? EMPTY_STATE;
  const shown = activeTab(layout);

  /** End these terminals after one confirm; each pane leaves once its end is confirmed. */
  const endTerminals = useCallback(async (slots: number[]) => {
    const live = slots.filter((s) => !panes.current.get(s)?.exited());
    if (live.length > 0) {
      const many = live.length > 1;
      const plain = live.some((s) => states[s]?.plain);
      const message = plain
        ? `Ending ${many ? 'these terminals' : 'the terminal'} will terminate the shell and any running processes.`
        : `Ending ${many ? 'these terminals' : 'the terminal'} stops ${many ? 'their shells' : 'its shell'} and anything running in ${many ? 'them' : 'it'}. Closing the view instead keeps ${many ? 'them' : 'it'} running.`;
      const what = many ? `End ${live.length} terminals?` : 'End terminal?';
      if (!(await confirm({ title: what, message, confirmLabel: 'End', cancelLabel: 'Cancel', danger: true }))) return;
    }
    for (const slot of slots) {
      const pane = panes.current.get(slot);
      if (!pane) { removePane(slot); continue; }
      if (pane.exited()) { removePane(slot); continue; }
      // The pane calls onEndConfirmed (removePane) on a confirmed end; an
      // unconfirmed one stays with its notice and Try again.
      await pane.kill();
    }
  }, [confirm, removePane, states]);

  // A new terminal's slot comes from the server, so two windows of this session
  // never open the same one. null: the server says every slot is taken (this
  // page's layout may be behind another window's), so nothing opens. undefined:
  // no answer, so the lowest slot free here.
  const reserveSlot = useCallback(async (): Promise<number | null | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r = await Promise.race([
        terminalReserve(sessionId, allSlots(layoutRef.current)),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), RESERVE_WAIT_MS); }),
      ]);
      if (r === null) log.warn('terminal', 'terminal reserve did not answer in time, using a local slot', { sessionId });
      return r === null ? undefined : r.slot;
    } catch (err) {
      log.warn('terminal', 'terminal reserve failed, using a local slot', { sessionId, error: String(err) });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }, [sessionId]);
  // Keys typed between a click on New / Split and the new pane's mount (the
  // slot comes from the server first): the focus leaves the button at once
  // (a Space or Enter would press it again) for the body, which keeps the keys
  // and hands them to the new terminal, which sends them once it connects.
  const bodyRef = useRef<HTMLDivElement>(null);
  const typed = useRef<{ text: string; slot: number | null } | null>(null);
  const catchKeys = useCallback(() => {
    typed.current = { text: '', slot: null };
    bodyRef.current?.focus({ preventScroll: true });
  }, []);
  const onBodyKey = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const t = typed.current;
    if (!t || e.target !== bodyRef.current) return;
    const k = keyText(e);
    if (k === null) return;
    e.preventDefault();
    if (t.text.length + k.length <= 4096) t.text += k;
  }, []);
  const takeTyped = useCallback((slot: number): string => {
    const t = typed.current;
    if (!t || t.slot !== slot) return '';
    typed.current = null;
    return t.text;
  }, []);
  /** Put the next layout on screen; the keys caught meanwhile go to the slot it added. */
  const placeNew = useCallback((next: TerminalLayout) => {
    const before = new Set(allSlots(layoutRef.current));
    const added = allSlots(next).find((s) => !before.has(s));
    if (typed.current) typed.current.slot = added ?? null;
    layoutRef.current = next;
    setLayout(next);
  }, []);
  // The host has every slot in use (another window opened the rest): say so,
  // and show the terminals this window has no tab for.
  const [notice, setNotice] = useState<{ text: string; nonce: number } | null>(null);
  const slotsFull = useCallback(() => {
    typed.current = null;
    log.warn('terminal', 'every terminal slot is in use on the host', { sessionId });
    setNotice((p) => ({ text: 'Every terminal slot is in use (8). End one to open another.', nonce: (p?.nonce ?? 0) + 1 }));
    terminalList(sessionId)
      .then((r) => { if (mountedRef.current && r.slots.length > 0) setLayout((l) => reconcileLayout(l, r.slots, [])); })
      .catch(() => { /* the note says enough */ });
  }, [sessionId]);
  const newTab = useCallback(async () => {
    catchKeys();
    const slot = await reserveSlot();
    if (slot === null) { slotsFull(); return; }
    if (mountedRef.current) placeNew(addTab(layoutRef.current, slot));
  }, [catchKeys, placeNew, reserveSlot, slotsFull]);
  const split = useCallback(async (dir: SplitDir) => {
    // The tab the button was pressed in, even if another is shown by the time the slot comes.
    const tabId = layoutRef.current.active;
    catchKeys();
    const slot = await reserveSlot();
    if (slot === null) { slotsFull(); return; }
    if (mountedRef.current) placeNew(splitActive(activateTab(layoutRef.current, tabId), dir, slot));
  }, [catchKeys, placeNew, reserveSlot, slotsFull]);
  // Moving between tabs with the keyboard keeps the focus on the tabs; a click
  // (on a tab or in a pane) gives it to the shown terminal again.
  const [tabKeys, setTabKeys] = useState(false);
  const onPaneFocus = useCallback((slot: number) => { setTabKeys(false); setLayout((l) => focusSlot(l, slot)); }, []);
  const onClosePane = useCallback((slot: number) => { void endTerminals([slot]); }, [endTerminals]);
  const addToChat = useCallback((text: string, slot: number) => onAddToChat?.(text, terminalName(slot)), [onAddToChat]);

  // Compact (the phone): every terminal is a tab of its own, one shown at a time.
  const viewTabs = useMemo<TerminalTab[]>(() => (compact
    ? layout.tabs.flatMap((t) => t.slots.map((s) => ({ id: `s${s}`, root: { slot: s }, slots: [s], focus: s })))
    : layout.tabs), [compact, layout.tabs]);
  const viewActive = compact ? (focused !== null ? `s${focused}` : '') : layout.active;
  const activateViewTab = useCallback((tab: TerminalTab) => {
    setLayout((l) => (compact ? focusSlot(l, tab.slots[0]!) : activateTab(l, tab.id)));
  }, [compact]);

  const ending = focusedState.ending;
  // The focused pane puts its status pill (and plain badge) here.
  const [pillSlot, setPillSlot] = useState<HTMLSpanElement | null>(null);
  const canNew = canAddTerminal(layout);
  const canSplitNow = !compact && canSplit(layout);
  const splitLimit = shown && shown.slots.length >= MAX_PANES_PER_TAB
    ? `At most ${MAX_PANES_PER_TAB} terminals in a tab`
    : 'Every terminal slot is in use (8)';
  // A split that would leave panes too small to read is offered no more.
  const [bodySize, setBodySize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) setBodySize((p) => (p && p.w === el.clientWidth && p.h === el.clientHeight ? p : { w: el.clientWidth, h: el.clientHeight }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const focusedBox = shown && focused !== null ? paneRects(shown.root).find((r) => r.slot === focused) : undefined;
  const roomRight = !bodySize || !focusedBox || (focusedBox.w * bodySize.w) / 2 >= MIN_SPLIT_W;
  const roomDown = !bodySize || !focusedBox || (focusedBox.h * bodySize.h) / 2 >= MIN_SPLIT_H;
  const splitRightTitle = !canSplitNow ? splitLimit : roomRight ? 'Split right: a new terminal beside this one' : 'Too narrow to split this terminal again';
  const splitDownTitle = !canSplitNow ? splitLimit : roomDown ? 'Split down: a new terminal under this one' : 'Too short to split this terminal again';
  // In a split, the header's End names the pane it ends (the tab's x ends them all).
  // The phone header is narrow: its folder name keeps the room.
  const endLabel = compact ? 'End' : focused !== null && shown && shown.slots.length > 1 ? `End ${terminalName(focused)}` : 'End terminal';

  // The shown tab stays in view in a strip that scrolls (many tabs, the phone).
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = tabsRef.current;
    const tab = strip?.querySelector<HTMLElement>('.session-terminal-tab.is-active');
    if (!strip || !tab) return;
    const left = tab.offsetLeft - strip.offsetLeft;
    if (left < strip.scrollLeft) strip.scrollLeft = left - 6;
    else if (left + tab.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = left + tab.offsetWidth - strip.clientWidth + 6;
  }, [viewActive, viewTabs.length]);
  // A strip wider than its room fades at the side that has more tabs.
  const [tabsFade, setTabsFade] = useState('');
  const measureTabs = useCallback(() => {
    const el = tabsRef.current;
    if (!el) { setTabsFade(''); return; }
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setTabsFade(`${left ? ' fade-left' : ''}${right ? ' fade-right' : ''}`);
  }, []);
  useEffect(() => {
    measureTabs();
    const el = tabsRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measureTabs);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureTabs, viewTabs.length, viewActive]);
  // Arrow keys move between tabs (the strip is a tablist).
  const onTabKey = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    const at = viewTabs.findIndex((t) => t.id === viewActive);
    if (at < 0) return;
    const n = viewTabs.length;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (at + (e.key === 'ArrowRight' ? 1 : n - 1)) % n;
    e.preventDefault();
    setTabKeys(true);
    activateViewTab(viewTabs[next]!);
    tabsRef.current?.querySelectorAll<HTMLButtonElement>('.session-terminal-tab-btn')[next]?.focus();
  }, [viewTabs, viewActive, activateViewTab]);

  const header = (
    <div className="session-terminal-header">
      <div className="session-terminal-title">
        <span className="session-terminal-icon">&#x2328;</span>
        <span className="session-terminal-label" title={fullTitle ?? undefined}>{title ?? 'Terminal'}</span>
        {remote && <span className="session-terminal-host">{remoteHostTag(remote, hostName)}</span>}
        <span className="session-terminal-pill-slot" ref={setPillSlot}>
          {!listed && <TerminalStatusPill status="connecting" />}
        </span>
      </div>
      <div className="session-terminal-actions">
        <button type="button" className="session-terminal-icon-btn" onClick={() => { void newTab(); }} disabled={!canNew} title={canNew ? 'New terminal' : 'Every terminal slot is in use (8)'} aria-label="New terminal" data-testid="terminal-new">
          {ICON_PLUS}
        </button>
        {!compact && (
          <>
            <button type="button" className="session-terminal-icon-btn" onClick={() => { void split('row'); }} disabled={!canSplitNow || !roomRight} title={splitRightTitle} aria-label="Split right" data-testid="terminal-split-right">
              {ICON_SPLIT_RIGHT}
            </button>
            <button type="button" className="session-terminal-icon-btn" onClick={() => { void split('col'); }} disabled={!canSplitNow || !roomDown} title={splitDownTitle} aria-label="Split down" data-testid="terminal-split-down">
              {ICON_SPLIT_DOWN}
            </button>
          </>
        )}
        {dock && !dock.docked && dock.onDock && (
          <button type="button" className="session-terminal-btn session-terminal-dock-btn" onClick={dock.onDock} title={`Show with ${dock.viewLabel}: ${dock.viewLabel} above, the terminal below`} aria-label={`Show with ${dock.viewLabel}`} data-testid="terminal-dock">
            {ICON_PANEL_BOTTOM}<span>{`With ${dock.viewLabel}`}</span>
          </button>
        )}
        {dock?.docked && dock.onMaximize && (
          <button type="button" className="session-terminal-icon-btn" onClick={dock.onMaximize} title="Terminal only" aria-label="Terminal only" data-testid="terminal-maximize">
            {ICON_EXPAND}
          </button>
        )}
        {focused !== null && !focusedState.exited && (
          <button
            className="session-terminal-btn session-terminal-btn-kill"
            onClick={() => { void endTerminals([focused]); }}
            disabled={ending}
            title={`End ${terminalName(focused)}: stops its shell and anything running in it`}
            aria-label={ending ? `Ending ${terminalName(focused)}` : `End ${terminalName(focused)}`}
          >
            {ending ? 'Ending…' : endLabel}
          </button>
        )}
        {dock?.docked && dock.onUndock && (
          <button type="button" className="session-terminal-icon-btn" onClick={dock.onUndock} title="Hide the terminal (it keeps running)" aria-label="Hide terminal" data-testid="terminal-undock">
            {ICON_CLOSE}
          </button>
        )}
        {/* In embedded mode the split's header owns closing (Changed/Files/Terminal toggle). */}
        {!embedded && (
          <button className="session-terminal-close" onClick={onClose} title={focusedState.plain ? 'Close (Esc). Not persistent: the shell ends about 2 minutes after closing' : 'Close (Esc). The terminals keep running'}>
            &#x2715;
          </button>
        )}
        {barRightSlot}
      </div>
    </div>
  );

  // The strip sits on a backing of its own colour: its fade (a mask) shows that, not the terminal under it.
  const tabStrip = viewTabs.length > 1 && (
    <div className="session-terminal-tabs-wrap">
    <div className={`session-terminal-tabs${tabsFade}`} role="tablist" aria-label="Terminals" ref={tabsRef} onKeyDown={onTabKey} onScroll={measureTabs}>
      {viewTabs.map((tab) => {
        const on = tab.id === viewActive;
        const name = tabLabel(tab, states);
        return (
          <div key={tab.id} className={`session-terminal-tab${on ? ' is-active' : ''}`} data-testid="terminal-tab">
            <button
              type="button"
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              className="session-terminal-tab-btn"
              // A key (Enter, Space) keeps the focus on the tabs; a click hands it to the terminal.
              onClick={(e) => { setTabKeys(e.detail === 0); activateViewTab(tab); }}
              title={tab.slots.map(terminalName).join(', ')}
            >
              {!isPaneLeaf(tab.root) && <span className="session-terminal-tab-split">{tab.root.dir === 'row' ? ICON_SPLIT_RIGHT : ICON_SPLIT_DOWN}</span>}
              <span className="session-terminal-tab-name">{name}</span>
            </button>
            <button
              type="button"
              className="session-terminal-tab-close"
              onClick={() => { void endTerminals(tab.slots); }}
              title={tab.slots.length > 1 ? `Close this tab (ends ${tab.slots.length} terminals)` : `Close ${terminalName(tab.slots[0]!)} (ends its shell)`}
              aria-label={`Close ${name}`}
            >{ICON_CLOSE}</button>
          </div>
        );
      })}
    </div>
    </div>
  );

  // Every terminal stays mounted while the view is open (a hidden tab keeps its
  // shell, its scrollback and its connection); only the shown tab is laid out.
  const body = (
    <div className="session-terminal-tabs-body" ref={bodyRef} tabIndex={-1} onKeyDown={onBodyKey}>
      {listed ? viewTabs.map((tab) => {
        const on = tab.id === viewActive;
        return (
          <div
            key={tab.id}
            className={`session-terminal-group${on ? '' : ' is-hidden'}`}
            data-testid="terminal-group"
            data-active={on || undefined}
          >
            {/* Flat, placed by box: a split that regroups the tab never remounts a pane. */}
            {paneRects(tab.root).map(({ slot, x, y, w, h }) => (
              <SessionTerminalPane
                key={slot}
                box={{ x, y, w, h }}
                ref={paneRef(slot)}
                sessionId={sessionId}
                slot={slot}
                label={terminalName(slot)}
                showStrip={tab.slots.length > 1}
                pillTarget={on && focused === slot ? pillSlot : null}
                focused={on && focused === slot}
                grabFocus={!tabKeys}
                takeTyped={takeTyped}
                onFocus={onPaneFocus}
                onState={onPaneState}
                onClosePane={onClosePane}
                onDismissExited={removePane}
                onEndConfirmed={removePane}
                onAddToChat={onAddToChat ? addToChat : undefined}
                onOpenPath={onOpenPath}
                stopEscape={embedded}
              />
            ))}
          </div>
        );
      }) : (
        <div className="session-terminal-waiting" role="status">Connecting…</div>
      )}
    </div>
  );

  const dismissNoticeRef = useRef(onDismissPathNotice);
  dismissNoticeRef.current = onDismissPathNotice;
  useEffect(() => {
    if (!pathNotice) return;
    const t = setTimeout(() => dismissNoticeRef.current?.(), PATH_NOTICE_MS);
    return () => clearTimeout(t);
  }, [pathNotice]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), PATH_NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);
  const shownNotice = notice ?? pathNotice ?? null;
  const dismissNotice = notice ? () => setNotice(null) : onDismissPathNotice;

  // Docked, the shown tab asks for the height its stacked panes need.
  const panelRef = useRef<HTMLDivElement>(null);
  // In rows of the smallest pane: a pane a quarter of the height needs four times its room.
  const rows = !compact && shown ? Math.round(1 / Math.min(...paneRects(shown.root).map((r) => r.h))) : 1;
  const onDockWantRef = useRef(onDockWant);
  onDockWantRef.current = onDockWant;
  useEffect(() => {
    if (!dock?.docked || !onDockWantRef.current) return;
    const panelEl = panelRef.current;
    const bodyEl = bodyRef.current;
    const chrome = panelEl && bodyEl ? panelEl.clientHeight - bodyEl.clientHeight : 80;
    onDockWantRef.current(rows > 1 ? chrome + rows * PANE_ROW_PX : 0);
  }, [dock?.docked, rows, viewTabs.length, listed]);

  // Centered-modal mode: Escape closes (detach, dtach session kept).
  useEffect(() => {
    if (embedded) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, embedded]);

  const panel = (
    <div
      className={`session-terminal-panel${embedded ? ' session-terminal-panel-embedded' : ''}${dock?.docked ? ' is-docked' : ''}`}
      data-shown-tab={shown?.id}
      ref={panelRef}
    >
      {header}
      {tabStrip}
      {shownNotice && (
        <div className="session-terminal-path-notice" role="status" data-testid="terminal-path-notice">
          <span>{shownNotice.text}</span>
          <button type="button" className="session-terminal-pane-close" onClick={dismissNotice} aria-label="Dismiss">{ICON_CLOSE}</button>
        </div>
      )}
      {body}
    </div>
  );

  // Embedded: render inline so it fills the split's left column.
  if (embedded) return panel;

  // Default: centered portal modal over a dim backdrop.
  return createPortal(
    <div className="session-terminal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {panel}
    </div>,
    document.body,
  );
}
