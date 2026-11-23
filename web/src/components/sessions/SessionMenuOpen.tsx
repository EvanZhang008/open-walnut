/**
 * The session ⋮ menu's own first rows, above the task's (2026-11-02, the user's pick of the
 * menu redesign: "isn't the views the same as open?"): Open, Window, then the Panels switch.
 *
 * Open holds everything that opens beside the chat, in one place for every session (a Home
 * column, an Org node, a pop-out): the header's own views (Changed, Files, Terminal, Board,
 * Threads, Plan), then what the old Views group held (SessionViewItems). Window holds what moves the
 * panel itself (Locate, Open in new tab, Full screen). Panels stays on the first level: it is
 * changed constantly while working (PanelCountRow explains).
 *
 * Each row calls the same handler as its header chip, so the header and the menu never drift.
 *
 * `headerKeys`: a host that draws the header and keeps its line quiet (the Org node, 2026-11-23, the
 * user: "just move all these to the drop done") gets the header's window keys as the menu's first
 * rows instead: Watch, Locate, Minimize and the Tags list, each doing what its key does.
 * `headerPills`: a narrow host of that kind gets the header's state pills above them too.
 */
import type { MouseEvent, ReactNode } from 'react';
import type { Task } from '@open-walnut/core';
import { ICON_EXPAND, ICON_FILE, ICON_FOLDER_OUTLINE, ICON_LOCATE, ICON_MINIMIZE, ICON_NEW_TAB, ICON_TERMINAL } from '../common/Icons';
import { WatchMenuItem } from '../tasks/WatchToggle';
import { TAG_ICON } from './SessionHeaderLabels';
import { KebabGroup } from './KebabGroup';
import { useSessionServers } from '@/hooks/useSessionServers';
import { openable, serversSummary } from './session-server-label';
import { PanelCountRow, SessionViewItems, ViewsBadge, type SessionViewItemsProps } from './SessionKebabSection';
import type { SessionSplitView } from './sessionSplitView';
import type { ThreadsMenu } from './session-threads-model';
import { PaneAppIcon, useSessionPaneApps } from './SessionPluginAppPane';

const OPEN_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
  </svg>
);
const WINDOW_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 9h18" />
  </svg>
);
const BOARD_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 4v16M15 4v16" />
  </svg>
);
const THREADS_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 5h16v10H9l-5 4z" /><path d="M8 9h8M8 12h5" />
  </svg>
);
const APPS_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="3" /><path d="M12 8v8M8 12h8" />
  </svg>
);
const PLAN_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />
  </svg>
);

export interface SessionMenuOpenProps {
  close: () => void;
  views: SessionViewItemsProps;
  /** The header's own views: Board only for a lead (waiting = not written yet), Terminal where offered. */
  board: 'live' | 'waiting' | 'none';
  terminal: boolean;
  /** A plan to read (the header's Plan chip). */
  onPlan?: () => void;
  /** The Board row's own handler (a host that draws the board itself), else the split view. */
  onBoard?: () => void;
  onPopout?: () => void;
  onFullscreen?: () => void;
  /** A column shown inside another surface (a task opened from a Board): its views open by locating the task, so it offers none of the header's. */
  inset?: boolean;
  /** "Exit full screen" while the panel is full screen. */
  fullscreenLabel?: string;
  /**
   * The App view (plugin Apps with a session pane): the App it shows or would show, and
   * the opener (the same row again closes it, as every view row does). Absent: not offered here.
   */
  apps?: { keptKey: string | null; onOpen: (key: string) => void };
  /**
   * The task's Threads (SessionThreadsPane): offered on a leader. `on` false: the row turns them on
   * and opens them; on: it opens them, and a second row turns them off. Absent: not offered.
   */
  threads?: ThreadsMenu;
  /** The header's window keys as rows, where the host's header line has none (see the file's note). */
  headerKeys?: SessionHeaderKeyRows;
  /** The header's state pills (the wait, Trigger, the team), each as it is on the line, as the menu's
   *  first row: a narrow host keeps only the kebab at its right (SessionPanel headerPillsInMenu). */
  headerPills?: ReactNode;
}

export interface SessionHeaderKeyRows {
  /** The session's task, once known: the Watch row. */
  watch?: Task;
  /** Locate: `why` while it cannot work yet (the row is drawn disabled, saying why). */
  locate?: { label: string; why: string | null; onLocate: () => void };
  onMinimize?: () => void;
  /** The folded link tags: how many, and the opener of their list (`fromKeyboard` moves the focus in). */
  tags?: { count: number; onOpen: (fromKeyboard: boolean) => void };
}

function Row({ icon, label, active, disabled, why, onClick, testId, trailing }: {
  icon: ReactNode; label: string; active?: boolean; disabled?: boolean; why?: string;
  onClick: (e: MouseEvent) => void; testId?: string; trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`task-kebab-item${active ? ' task-kebab-item-active' : ''}`}
      aria-pressed={active || undefined}
      disabled={disabled}
      title={disabled ? why : undefined}
      data-testid={testId}
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
    >
      <span className="task-kebab-icon">{icon}</span>
      <span>{label}</span>
      {disabled && why && <span className="task-kebab-row-why">{why}</span>}
      {trailing}
    </button>
  );
}

export function SessionMenuOpen(p: SessionMenuOpenProps) {
  const { views, close } = p;
  // The Open row names the session's listening servers when there are any, and opens for them.
  const listed = useSessionServers(views.sessionId, { enabled: true, fast: true }).servers;
  const summary = serversSummary(listed);
  // The group's hint is a list of its rows' short names: the count only, as "web (3)".
  const webCount = listed.filter(openable).length;
  const hintCount = webCount > 0 ? String(webCount) : summary;
  const view = (v: SessionSplitView) => () => { close(); views.onToggleView(v); };
  // One row for the App view, never one per App: with one App it is that App, with several it
  // is Apps (the pane's own tabs switch between them), so the menu does not grow with plugins.
  const paneApps = useSessionPaneApps();
  const appsRow = p.apps && paneApps.length > 0 ? (() => {
    const only = paneApps.length === 1 ? paneApps[0] : null;
    const target = only?.key ?? (paneApps.some((a) => a.key === p.apps!.keptKey) ? p.apps!.keptKey! : paneApps[0].key);
    return (
      <Row
        icon={only ? <PaneAppIcon app={only} size={14} fallback={APPS_ICON} /> : APPS_ICON}
        label={only ? only.title : 'Apps'}
        active={views.activeView === 'app' && (!only || p.apps!.keptKey === only.key)}
        onClick={() => { close(); p.apps!.onOpen(target); }}
        testId="session-menu-apps"
      />
    );
  })() : null;
  const windows = [
    p.onPopout && <Row key="popout" icon={ICON_NEW_TAB} label="Open in new tab" onClick={() => { close(); p.onPopout!(); }} testId="session-menu-popout" />,
    p.onFullscreen && <Row key="full" icon={ICON_EXPAND} label={p.fullscreenLabel ?? 'Full screen'} onClick={() => { close(); p.onFullscreen!(); }} testId="session-menu-fullscreen" />,
  ].filter(Boolean);
  const keys = p.headerKeys;
  const keyRows = keys ? [
    keys.watch && <WatchMenuItem key="watch" task={keys.watch} afterAction={close} />,
    keys.locate && (
      <Row key="locate" icon={ICON_LOCATE} label={keys.locate.label} disabled={!!keys.locate.why} why={keys.locate.why ?? undefined}
        onClick={() => { close(); keys.locate!.onLocate(); }} testId="session-menu-locate" />
    ),
    keys.onMinimize && (
      <Row key="minimize" icon={ICON_MINIMIZE} label="Minimize" onClick={() => { close(); keys.onMinimize!(); }} testId="session-menu-minimize" />
    ),
    keys.tags && keys.tags.count > 0 && (
      <Row key="tags" icon={TAG_ICON} label="Tags" onClick={(e) => { close(); keys.tags!.onOpen(e.detail === 0); }} testId="session-menu-tags"
        trailing={<span className="task-kebab-row-why" data-testid="session-menu-tags-count">{keys.tags.count}</span>} />
    ),
  ].filter(Boolean) : [];
  return (
    <>
      {/* A pill that draws nothing leaves the row empty, and CSS hides it and its divider. Each pill's
          list opens beside the menu (data-flyouts-beside, useMenuPlacement), not over its rows. */}
      {p.headerPills && <><div className="session-menu-pills" data-testid="session-menu-pills" data-flyouts-beside="">{p.headerPills}</div><div className="task-kebab-divider" /></>}
      {keyRows.length > 0 && <>{keyRows}<div className="task-kebab-divider" /></>}
      {/* Locate and Watch are on the header itself (2026-11-19: the crosshair among the window
          buttons, the eye on the label row), or the rows above (headerKeys); Open in new tab lives
          only in the Window group below. */}
      <KebabGroup
        label="Open panel"
        // Four names, not every row: the hint's length sets the menu's width, and a wide menu
        // covers the chat it opens over (the UI audit, 2026-11-22). The group says the rest.
        hint={`changed · files · ${p.threads ? 'threads' : 'code'} · web${hintCount ? ` (${hintCount})` : ''}`}
        icon={OPEN_ICON}
        testId="session-kebab-open"
        openWhen={summary !== null}
        badge={<ViewsBadge {...views} />}
      >
        {!p.inset && <Row icon={ICON_FILE} label="Changed" active={views.activeView === 'changed'} onClick={view('changed')} testId="session-menu-changed" />}
        {!p.inset && <Row icon={ICON_FOLDER_OUTLINE} label="Files" active={views.activeView === 'files'} onClick={view('files')} testId="session-menu-files" />}
        {p.terminal && <Row icon={ICON_TERMINAL} label="Terminal" active={views.activeView === 'terminal'} onClick={view('terminal')} testId="session-menu-terminal" />}
        {p.board !== 'none' && (
          <Row icon={BOARD_ICON} label="Board" active={views.activeView === 'board'} disabled={p.board === 'waiting'} why="Not written yet"
            onClick={() => { close(); if (p.onBoard) p.onBoard(); else views.onToggleView('board'); }} testId="session-menu-board" />
        )}
        {p.threads && (
          <Row icon={THREADS_ICON} label={p.threads.on ? 'Threads' : 'Turn on Threads'} active={views.activeView === 'threads'}
            onClick={() => { close(); p.threads!.onOpen(); }} testId="session-menu-threads" />
        )}
        {p.threads?.on && (
          <Row icon={THREADS_ICON} label="Turn off Threads" onClick={() => { close(); p.threads!.onTurnOff(); }} testId="session-menu-threads-off" />
        )}
        {appsRow}
        {p.onPlan && <Row icon={PLAN_ICON} label="Plan" onClick={() => { close(); p.onPlan!(); }} testId="session-menu-plan" />}
        {!p.inset && <div className="task-kebab-group-sep" role="separator" />}
        <SessionViewItems {...views} onAfterAction={close} />
      </KebabGroup>
      {windows.length > 0 && (
        <KebabGroup label="Open in window" hint="new tab · full screen" icon={WINDOW_ICON} testId="session-kebab-window">
          {windows}
        </KebabGroup>
      )}
      <PanelCountRow onAfterAction={close} />
    </>
  );
}
