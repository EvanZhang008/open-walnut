/**
 * The session header's row-1 actions as kebab rows, for the phone (C64): the
 * panel's own header is hidden there, so Changed, Files, Board, Terminal,
 * Plan and Close are reached from the top bar's kebab. Each row calls the same
 * handler as its header chip. Fork, Locate and Open in new tab are left out
 * on a phone (N12): a new tab is meaningless there, Locate is what Back does,
 * and Fork drew a greyed row with no reason. A disabled row says why.
 */
import type { SessionSplitView } from './sessionSplitView';
import { useBackgroundRunning } from '@/hooks/useBackgroundRunning';
import { openBackgroundPanel } from '@/stores/background-panel-store';

export interface PhoneSessionHeaderRowsProps {
  sessionId: string;
  close: () => void;
  activeView: SessionSplitView | null;
  onToggleView: (view: SessionSplitView) => void;
  board: 'live' | 'waiting' | 'none';
  terminal: boolean;
  plan: boolean;
  onPlan: () => void;
  onCloseSession?: () => void;
}

function Row({ label, active, disabled, why, onClick, testId }: {
  label: string; active?: boolean; disabled?: boolean; why?: string; onClick: () => void; testId?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`task-kebab-item phone-session-row${active ? ' is-active' : ''}`}
      disabled={disabled}
      aria-pressed={active || undefined}
      data-testid={testId}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      <span>{label}</span>
      {disabled && why && <span className="phone-session-row-why">{why}</span>}
    </button>
  );
}

export function PhoneSessionHeaderRows(p: PhoneSessionHeaderRowsProps) {
  const view = (v: SessionSplitView) => () => { p.close(); p.onToggleView(v); };
  // The desktop ⋮ menu's "Background tasks" row: the phone's menu does not draw that
  // section, and a background command has no chat chip to reach its list from.
  const { tasks: background, running: { total: running } } = useBackgroundRunning(p.sessionId);
  return (
    <div className="phone-session-rows" data-testid="phone-session-rows">
      <Row label="Changed" active={p.activeView === 'changed'} onClick={view('changed')} testId="phone-row-changed" />
      <Row label="Files" active={p.activeView === 'files'} onClick={view('files')} testId="phone-row-files" />
      {p.terminal && (
        <Row label="Terminal" active={p.activeView === 'terminal'} onClick={view('terminal')} testId="phone-row-terminal" />
      )}
      {/* A lead's row only (useBoardTab), after the rows every session has, as on the header. */}
      {p.board !== 'none' && (
        <Row label="Board" active={p.activeView === 'board'} disabled={p.board === 'waiting'} onClick={view('board')} testId="phone-row-board"
          why={p.board === 'waiting' ? 'Not written yet' : undefined} />
      )}
      {background.length > 0 && (
        <Row label={running > 0 ? `Background tasks (${running} running)` : 'Background tasks'}
          onClick={() => { p.close(); openBackgroundPanel(p.sessionId); }} testId="phone-row-background" />
      )}
      {p.plan && <Row label="Plan" onClick={() => { p.close(); p.onPlan(); }} testId="phone-row-plan" />}
      {p.onCloseSession && <Row label="Close session" onClick={() => { p.close(); p.onCloseSession?.(); }} testId="phone-row-close" />}
      <div className="task-kebab-divider" />
    </div>
  );
}
