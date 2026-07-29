/**
 * SessionKebabSection — the "Session" half of the session-panel kebab dropdown.
 *
 * Rendered as the `extraSection` of <TaskQuickActions slot="kebab">, below a
 * divider, so a single dropdown holds Task actions (top) + Session actions
 * (bottom). Presentational only: both session panels own the actual handlers
 * (restart / investigate / open-notes …) and pass them down.
 */
import { useState, useRef, useEffect } from 'react';
import { ICON_SEARCH, ICON_REFRESH, ICON_STOP, ICON_VSCODE } from '../common/Icons';
import { openSessionInVscode } from './openSessionInVscode';
import {
  useSessionPanelMode,
  MIN_PANELS,
  MAX_PANELS,
  type SessionPanelMode,
} from '@/hooks/useSessionPanelMode';

/** 1..MAX_PANELS then Auto — same options, same order as Settings → General. */
const PANEL_CHOICES: SessionPanelMode[] = [
  ...Array.from({ length: MAX_PANELS - MIN_PANELS + 1 }, (_, i) => String(MIN_PANELS + i) as SessionPanelMode),
  'auto',
];

/**
 * How many session columns sit side by side — the same app-wide setting as
 * Settings → General → Session Panels, surfaced here because it is a
 * "change it constantly while working" control, not a configure-once one.
 *
 * It is deliberately NOT per-session (there is one strip, so a per-session count
 * would be meaningless), hence the "all sessions" hint in the title: switching it
 * from any session's menu changes the layout everywhere. Kept as its own component
 * so the hook's config fetch only runs when a menu is actually open.
 */
function PanelCountRow({ onAfterAction }: { onAfterAction?: () => void }) {
  const { mode, setMode } = useSessionPanelMode();
  return (
    <div className="task-kebab-tier">
      <span className="task-kebab-tier-label" title="How many session panels sit side by side (applies to all sessions)">
        Panels
      </span>
      <div className="task-kebab-tier-options">
        {PANEL_CHOICES.map((value) => (
          <button
            key={value}
            className={`task-kebab-tier-btn${mode === value ? ' active' : ''}`}
            title={value === 'auto' ? 'Adjust automatically to the window width' : `Show ${value} side by side`}
            onClick={(e) => {
              e.stopPropagation();
              // Re-picking the current value is a no-op beyond closing, so we don't
              // write config (and don't re-trigger column eviction) for nothing.
              if (value !== mode) setMode(value);
              onAfterAction?.();
            }}
          >
            {value === 'auto' ? 'Auto' : value}
          </button>
        ))}
      </div>
    </div>
  );
}

interface SessionKebabSectionProps {
  sessionId: string;
  cwd?: string;
  /** SSH host alias for remote sessions — shown as a read-only info line. */
  host?: string;
  hostname?: string;
  archived?: boolean;
  // Notes / Msgs toggles (owned by the panel)
  notesOpen: boolean;
  onToggleNotes: () => void;
  messagesOpen: boolean;
  onToggleMessages: () => void;
  msgCount?: number;
  // Restart
  onRestart: () => void;
  restartBusy: boolean;
  // Terminate — close the CLI process (no respawn)
  onTerminate: () => void;
  terminateBusy: boolean;
  // Investigate
  onInvestigate: () => void;
  investigating: boolean;
  investigateResult: { kind: 'ok'; id: string } | { kind: 'error' } | null;
  onOpenVscodeError: (error: unknown) => void;
  /** Called after any item runs so the parent can close the dropdown. */
  onAfterAction?: () => void;
}

/** A single copy-to-clipboard kebab item with a transient "Copied!" label. */
function CopyItem({ label, value, onAfter }: { label: string; value: string; onAfter?: () => void }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  return (
    <button
      className="task-kebab-item"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => { setCopied(false); onAfter?.(); }, 900);
        }).catch(() => {});
      }}
      title={`Copy: ${value}`}
    >
      <span className="task-kebab-icon">⧉</span>
      <span>{copied ? 'Copied!' : label}</span>
    </button>
  );
}

export function SessionKebabSection({
  sessionId, cwd, host, hostname, archived,
  notesOpen, onToggleNotes, messagesOpen, onToggleMessages, msgCount,
  onRestart, restartBusy,
  onTerminate, terminateBusy,
  onInvestigate, investigating, investigateResult,
  onOpenVscodeError, onAfterAction,
}: SessionKebabSectionProps) {
  const cdPrefix = cwd ? `cd ${cwd} && ` : '';
  const cwdLabel = cwd ? (cwd.split('/').filter(Boolean).pop() || 'CWD') : null;

  return (
    <div className="task-kebab-section">
      <div className="task-kebab-section-label">Session</div>

      <button
        className={`task-kebab-item${notesOpen ? ' task-kebab-item-active' : ''}`}
        onClick={(e) => { e.stopPropagation(); onToggleNotes(); onAfterAction?.(); }}
      >
        <span className="task-kebab-icon">📝</span>
        <span>Notes</span>
      </button>

      <button
        className={`task-kebab-item${messagesOpen ? ' task-kebab-item-active' : ''}`}
        onClick={(e) => { e.stopPropagation(); onToggleMessages(); onAfterAction?.(); }}
      >
        <span className="task-kebab-icon">💬</span>
        <span>Msgs{msgCount && msgCount > 0 ? ` (${msgCount})` : ''}</span>
      </button>

      {/* Layout control — grouped with the other view toggles above, deliberately far
          from Restart/Terminate so a mis-click near the destructive items can't land here. */}
      <PanelCountRow onAfterAction={onAfterAction} />

      <div className="task-kebab-divider" />

      {cwdLabel && <CopyItem label={`Copy dir (${cwdLabel})`} value={cwd!} onAfter={onAfterAction} />}
      <button
        className="task-kebab-item"
        onClick={(e) => {
          e.stopPropagation();
          void openSessionInVscode(sessionId).then(onAfterAction).catch(onOpenVscodeError);
        }}
        title="Open in VS Code"
      >
        <span className="task-kebab-icon">{ICON_VSCODE}</span>
        <span>Open in VS Code</span>
      </button>
      <CopyItem label="Copy session ID" value={sessionId} onAfter={onAfterAction} />
      <CopyItem label="Copy resume cmd" value={`${cdPrefix}claude -r ${sessionId}`} onAfter={onAfterAction} />

      <div className="task-kebab-divider" />

      {!archived && (
        <button
          className="task-kebab-item"
          onClick={(e) => { e.stopPropagation(); onRestart(); }}
          disabled={restartBusy}
          title="Respawn the CLI so it re-reads settings (CLAUDE.md, .claude, skills, MCP) and re-runs the SessionStart hook — no message sent, conversation preserved"
        >
          <span className="task-kebab-icon">{ICON_REFRESH}</span>
          <span>{restartBusy ? 'Restarting…' : 'Restart'}</span>
        </button>
      )}

      {!archived && (
        <button
          className="task-kebab-item"
          onClick={(e) => { e.stopPropagation(); onTerminate(); }}
          disabled={terminateBusy}
          title="Close the CLI process — does not respawn. The session goes stopped; your next message resumes it."
        >
          <span className="task-kebab-icon">{ICON_STOP}</span>
          <span>{terminateBusy ? 'Terminating…' : 'Terminate'}</span>
        </button>
      )}

      <button
        className="task-kebab-item"
        onClick={(e) => { e.stopPropagation(); onInvestigate(); }}
        disabled={investigating}
        title="Capture a debug snapshot — evidence bundle (logs + CLI stream + daemon), open an incident, and copy all related ids to the clipboard"
      >
        <span className="task-kebab-icon">{ICON_SEARCH}</span>
        <span>
          {investigating
            ? 'Capturing…'
            : investigateResult?.kind === 'ok'
              ? `Copied — ${investigateResult.id} ✓`
              : investigateResult?.kind === 'error'
                ? 'Capture failed'
                : 'Debug snapshot'}
        </span>
      </button>

      {/* SSH host — read-only info line for remote sessions. */}
      {host && (
        <>
          <div className="task-kebab-divider" />
          <div className="task-kebab-item task-kebab-info" title={hostname || host}>
            <span className="task-kebab-icon">🖥️</span>
            <span>SSH: {host}</span>
          </div>
        </>
      )}
    </div>
  );
}
