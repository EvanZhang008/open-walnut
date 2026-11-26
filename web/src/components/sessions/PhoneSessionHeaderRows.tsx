/**
 * The session header's row-1 actions as kebab rows, for the phone (C64): the
 * panel's own header is hidden there, so Changed, Files, Board, Threads, Terminal,
 * Plan and Close are reached from the top bar's kebab (and Web preview while the session
 * serves a web page: its servers, to open or stop). Each row calls the same
 * handler as its header chip. Fork, Locate and Open in new tab are left out
 * on a phone (N12): a new tab is meaningless there, Locate is what Back does,
 * and Fork drew a greyed row with no reason. A disabled row says why.
 */
import type { SessionSplitView } from './sessionSplitView';
import type { ThreadsMenu } from './session-threads-model';
import { useBackgroundRunning } from '@/hooks/useBackgroundRunning';
import { useSessionServers } from '@/hooks/useSessionServers';
import { serversSummary, serversUnavailableNote } from './session-server-label';
import { openBackgroundPanel } from '@/stores/background-panel-store';
import type { ReactNode } from 'react';
import { ICON_CLOSE, ICON_FILE, ICON_FOLDER_OUTLINE, ICON_TERMINAL } from '../common/Icons';
import { BACKGROUND_TASKS_ICON, BOARD_ICON, PLAN_ICON, SessionMenuRow, THREADS_ICON, WEB_ICON } from './SessionMenuRow';

export interface PhoneSessionHeaderRowsProps {
  sessionId: string;
  close: () => void;
  activeView: SessionSplitView | null;
  onToggleView: (view: SessionSplitView) => void;
  board: 'live' | 'waiting' | 'none';
  /** A leader's Threads (session-threads-model.ts), as the desktop menu's Open group has them. */
  threads?: ThreadsMenu;
  terminal: boolean;
  plan: boolean;
  onPlan: () => void;
  onCloseSession?: () => void;
  /** Off where the menu has its own Background tasks row (the desktop menu's Views). */
  background?: boolean;
}

/** The shared session menu row (SessionMenuRow), as the phone's 44 px row. */
function Row(p: { icon: ReactNode; label: string; active?: boolean; disabled?: boolean; why?: string; onClick: () => void; testId?: string }) {
  return <SessionMenuRow {...p} role="menuitem" className="phone-session-row" />;
}

export function PhoneSessionHeaderRows(p: PhoneSessionHeaderRowsProps) {
  const view = (v: SessionSplitView) => () => { p.close(); p.onToggleView(v); };
  // The desktop session menu's "Background tasks" row: the phone's menu does not draw that
  // section, and a background command has no chat chip to reach its list from.
  const { tasks: background, running: { total: running } } = useBackgroundRunning(p.sessionId);
  const servers = useSessionServers(p.sessionId, { enabled: true, fast: true });
  // The list cannot be read (the host is away, its daemon too old): the row says so instead.
  const summary = serversSummary(servers.servers) ?? serversUnavailableNote(servers.state);
  return (
    <div className="phone-session-rows" data-testid="phone-session-rows">
      <Row icon={ICON_FILE} label="Changed" active={p.activeView === 'changed'} onClick={view('changed')} testId="phone-row-changed" />
      <Row icon={ICON_FOLDER_OUTLINE} label="Files" active={p.activeView === 'files'} onClick={view('files')} testId="phone-row-files" />
      {p.terminal && (
        <Row icon={ICON_TERMINAL} label="Terminal" active={p.activeView === 'terminal'} onClick={view('terminal')} testId="phone-row-terminal" />
      )}
      {summary && (
        <Row icon={WEB_ICON} label={`Web preview \u00B7 ${summary}`} active={p.activeView === 'web'} onClick={view('web')} testId="phone-row-web" />
      )}
      {/* A lead's row only (useBoardTab), after the rows every session has, as on the header. */}
      {p.board !== 'none' && (
        <Row icon={BOARD_ICON} label="Board" active={p.activeView === 'board'} disabled={p.board === 'waiting'} onClick={view('board')} testId="phone-row-board"
          why={p.board === 'waiting' ? 'Not written yet' : undefined} />
      )}
      {p.threads && (
        <Row icon={THREADS_ICON} label={p.threads.on ? 'Threads' : 'Turn on Threads'} active={p.activeView === 'threads'}
          onClick={() => { p.close(); p.threads!.onOpen(); }} testId="phone-row-threads" />
      )}
      {p.threads?.on && <Row icon={THREADS_ICON} label="Turn off Threads" onClick={() => { p.close(); p.threads!.onTurnOff(); }} testId="phone-row-threads-off" />}
      {p.background !== false && background.length > 0 && (
        <Row icon={BACKGROUND_TASKS_ICON} label={running > 0 ? `Background tasks (${running} running)` : 'Background tasks'}
          onClick={() => { p.close(); openBackgroundPanel(p.sessionId); }} testId="phone-row-background" />
      )}
      {p.plan && <Row icon={PLAN_ICON} label="Plan" onClick={() => { p.close(); p.onPlan(); }} testId="phone-row-plan" />}
      {p.onCloseSession && <Row icon={ICON_CLOSE} label="Close session" onClick={() => { p.close(); p.onCloseSession?.(); }} testId="phone-row-close" />}
      <div className="task-kebab-divider" />
    </div>
  );
}
