/**
 * The session ⋮ menu's own first rows, above the task's (2026-11-02, the user's pick of the
 * menu redesign: "isn't the views the same as open?"): Open, Window, then the Panels switch.
 *
 * Open holds everything that opens beside the chat, in one place for every session (a Home
 * column, an Org node, a pop-out): the header's own views (Changed, Files, Terminal, Board,
 * Plan), then what the old Views group held (SessionViewItems). Window holds what moves the
 * panel itself (Locate, Open in new tab, Full screen). Panels stays on the first level: it is
 * changed constantly while working (PanelCountRow explains).
 *
 * Each row calls the same handler as its header chip, so the header and the menu never drift.
 */
import type { ReactNode } from 'react';
import { ICON_EXPAND, ICON_FILE, ICON_FOLDER_OUTLINE, ICON_LOCATE, ICON_NEW_TAB, ICON_TERMINAL } from '../common/Icons';
import { KebabGroup } from './KebabGroup';
import { useSessionServers } from '@/hooks/useSessionServers';
import { openable, serversSummary } from './session-server-label';
import { PanelCountRow, SessionViewItems, ViewsBadge, type SessionViewItemsProps } from './SessionKebabSection';
import type { SessionSplitView } from './sessionSplitView';

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
  /** Locate the task on Home ("Find on Home" off it); absent when there is no task to find. */
  locate?: { label: string; onClick: () => void };
  onPopout?: () => void;
  onFullscreen?: () => void;
  /** A column shown inside another surface (a task opened from a Board): its views open by locating the task, so it offers none of the header's. */
  inset?: boolean;
  /** "Exit full screen" while the panel is full screen. */
  fullscreenLabel?: string;
}

function Row({ icon, label, active, disabled, why, onClick, testId, trailing }: {
  icon: ReactNode; label: string; active?: boolean; disabled?: boolean; why?: string;
  onClick: () => void; testId?: string; trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`task-kebab-item${active ? ' task-kebab-item-active' : ''}`}
      aria-pressed={active || undefined}
      disabled={disabled}
      title={disabled ? why : undefined}
      data-testid={testId}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
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
  const windows = [
    p.onPopout && <Row key="popout" icon={ICON_NEW_TAB} label="Open in new tab" onClick={() => { close(); p.onPopout!(); }} testId="session-menu-popout" />,
    p.onFullscreen && <Row key="full" icon={ICON_EXPAND} label={p.fullscreenLabel ?? 'Full screen'} onClick={() => { close(); p.onFullscreen!(); }} testId="session-menu-fullscreen" />,
  ].filter(Boolean);
  return (
    <>
      {/* Locate is a row of its own, by its name, as Watch is among the task's rows below
          (2026-11-09, the user of the header's crosshair and eye: "this 2 put iot in the drop down"). */}
      {p.locate && <Row icon={ICON_LOCATE} label={p.locate.label} onClick={() => { close(); p.locate!.onClick(); }} testId="session-menu-locate" />}
      <KebabGroup
        label="Open"
        hint={`changed · files${p.board !== 'none' ? ' · board' : ''} · inbox · code · web${hintCount ? ` (${hintCount})` : ''}`}
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
        {p.onPlan && <Row icon={PLAN_ICON} label="Plan" onClick={() => { close(); p.onPlan!(); }} testId="session-menu-plan" />}
        {!p.inset && <div className="task-kebab-group-sep" role="separator" />}
        <SessionViewItems {...views} onAfterAction={close} />
      </KebabGroup>
      {windows.length > 0 && (
        <KebabGroup label="Window" hint="new tab · full screen" icon={WINDOW_ICON} testId="session-kebab-window">
          {windows}
        </KebabGroup>
      )}
      <PanelCountRow onAfterAction={close} />
    </>
  );
}
