/**
 * SessionKebabSection — the "Session" half of the session-panel kebab dropdown.
 *
 * Rendered as the `extraSection` of <TaskQuickActions slot="kebab">, below a
 * divider, so a single dropdown holds Task actions (top) + Session actions
 * (bottom). Presentational only: both session panels own the actual handlers
 * (restart / investigate / open-notes …) and pass them down.
 */
import { useState, useRef, useEffect } from 'react';
import { copyTextRobust } from '@/utils/clipboard';
import { ICON_CHAT, ICON_COPY, ICON_NOTE, ICON_REFRESH, ICON_STOP, ICON_VSCODE } from '../common/Icons';
import { openSessionInVscode } from './openSessionInVscode';
import { prefetchVscodeEmbed } from './vscodeEmbedPrefetch';
import { inboxChipTitle } from '@/components/inbox/session-letters';
import type { SessionSplitView } from './sessionSplitView';
import { sessionKebabMetaRows } from './session-kebab-meta';
import { useSessionResources, hydrateResources } from '@/stores/session-resources-store';
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
 *
 * Rendered as the kebab's `leadingSection`, the FIRST row of the menu, above the
 * task rows: everything else in the menu is about this task or this session, the
 * panel count is about the strip itself, and it is the control people could not
 * find when it sat between the view toggles (2026-10-01). Being first also keeps
 * it far from Restart / Terminate at the bottom.
 */
export function PanelCountRow({ onAfterAction }: { onAfterAction?: () => void }) {
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
  /** SSH host alias for remote sessions (absent = this machine) — the Host row. */
  host?: string;
  hostname?: string;
  archived?: boolean;
  /** Session record times — the Created / Updated rows. */
  startedAt?: string;
  lastActiveAt?: string;
  activeView: SessionSplitView | null;
  onToggleView: (view: SessionSplitView) => void;
  unreadCount: number;
  decisionCount: number;
  attentionCount: number;
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
        void copyTextRobust(value).then((r) => {
          if (r === 'failed') return;
          setCopied(true);
          clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => { setCopied(false); onAfter?.(); }, 900);
        });
      }}
      title={`Copy: ${value}`}
    >
      <span className="task-kebab-icon">{ICON_COPY}</span>
      <span>{copied ? 'Copied!' : label}</span>
    </button>
  );
}

export function SessionKebabSection({
  sessionId, cwd, host, hostname, archived, startedAt, lastActiveAt, activeView, onToggleView,
  unreadCount, decisionCount, attentionCount,
  notesOpen, onToggleNotes, messagesOpen, onToggleMessages, msgCount,
  onRestart, restartBusy,
  onTerminate, terminateBusy,
  onInvestigate, investigating, investigateResult,
  onOpenVscodeError, onAfterAction,
}: SessionKebabSectionProps) {
  const codeHoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(codeHoverTimer.current), [sessionId]);
  // Computed per render: the menu mounts when opened, so "2m ago" is fresh each time.
  const resources = useSessionResources(sessionId);
  // The menu mounts when opened: ask the hosts for a fresh reading (one ps, shared
  // within 1.5s) so the Memory and CPU rows are seconds old, not up to 30s.
  useEffect(() => { void hydrateResources({ fresh: true }); }, [sessionId]);
  const metaRows = sessionKebabMetaRows({ startedAt, lastActiveAt, host, hostname, resources });
  const cdPrefix = cwd ? `cd ${cwd} && ` : '';
  const cwdLabel = cwd ? (cwd.split('/').filter(Boolean).pop() || 'CWD') : null;

  return (
    <div className="task-kebab-section">
      <div className="task-kebab-section-label">Session</div>

      <button
        className={`task-kebab-item${activeView === 'inbox' ? ' task-kebab-item-active' : ''}`}
        aria-pressed={activeView === 'inbox'}
        onClick={(e) => { e.stopPropagation(); onToggleView('inbox'); onAfterAction?.(); }}
        title={inboxChipTitle(attentionCount, unreadCount, decisionCount)}
      >
        <span className="task-kebab-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 4h16l2 10v6H2v-6L4 4Z" />
            <path d="M2 14h6l2 3h4l2-3h6" />
          </svg>
        </span>
        <span>Inbox</span>
        {attentionCount > 0 && (
          <span className={`session-action-chip-count${decisionCount > 0 ? ' session-action-chip-count-warn' : ''}`}>
            {attentionCount > 99 ? '99+' : attentionCount}
          </span>
        )}
      </button>

      <button
        className={`task-kebab-item${activeView === 'code' ? ' task-kebab-item-active' : ''}`}
        aria-pressed={activeView === 'code'}
        onClick={(e) => { e.stopPropagation(); onToggleView('code'); onAfterAction?.(); }}
        onMouseEnter={() => {
          clearTimeout(codeHoverTimer.current);
          codeHoverTimer.current = setTimeout(() => prefetchVscodeEmbed(sessionId), 400);
        }}
        onMouseLeave={() => clearTimeout(codeHoverTimer.current)}
        title="Embedded VS Code in the session working directory"
      >
        <span className="task-kebab-icon">{ICON_VSCODE}</span>
        <span>Code</span>
      </button>

      <button
        className={`task-kebab-item${activeView === 'web' ? ' task-kebab-item-active' : ''}`}
        aria-pressed={activeView === 'web'}
        onClick={(e) => { e.stopPropagation(); onToggleView('web'); onAfterAction?.(); }}
        title="Open a localhost or host:port service this session started, next to the chat"
      >
        <span className="task-kebab-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18" />
            <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z" />
          </svg>
        </span>
        <span>Web preview</span>
      </button>

      <button
        className={`task-kebab-item${notesOpen ? ' task-kebab-item-active' : ''}`}
        onClick={(e) => { e.stopPropagation(); onToggleNotes(); onAfterAction?.(); }}
      >
        <span className="task-kebab-icon">{ICON_NOTE}</span>
        <span>Notes</span>
      </button>

      <button
        className={`task-kebab-item${messagesOpen ? ' task-kebab-item-active' : ''}`}
        onClick={(e) => { e.stopPropagation(); onToggleMessages(); onAfterAction?.(); }}
      >
        <span className="task-kebab-icon">{ICON_CHAT}</span>
        <span>Msgs{msgCount && msgCount > 0 ? ` (${msgCount})` : ''}</span>
      </button>

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
      {/* A copy too: it captures the evidence bundle, then copies every related id. */}
      <button
        className="task-kebab-item"
        onClick={(e) => { e.stopPropagation(); onInvestigate(); }}
        disabled={investigating}
        title="Capture a debug snapshot — evidence bundle (logs + CLI stream + daemon), open an incident, and copy all related ids to the clipboard"
      >
        <span className="task-kebab-icon">{ICON_COPY}</span>
        <span>
          {investigating
            ? 'Capturing…'
            : investigateResult?.kind === 'ok'
              ? `Copied — ${investigateResult.id} ✓`
              : investigateResult?.kind === 'error'
                ? 'Capture failed'
                : 'Copy debug snapshot'}
        </span>
      </button>

      {!archived && (
        <>
          <div className="task-kebab-divider" />
          <button
            className="task-kebab-item"
            onClick={(e) => { e.stopPropagation(); onRestart(); }}
            disabled={restartBusy}
            title="Respawn the CLI so it re-reads settings (CLAUDE.md, .claude, skills, MCP) and re-runs the SessionStart hook — no message sent, conversation preserved"
          >
            <span className="task-kebab-icon">{ICON_REFRESH}</span>
            <span>{restartBusy ? 'Restarting…' : 'Restart'}</span>
          </button>
          <button
            className="task-kebab-item"
            onClick={(e) => { e.stopPropagation(); onTerminate(); }}
            disabled={terminateBusy}
            title="Close the CLI process — does not respawn. The session goes stopped; your next message resumes it."
          >
            <span className="task-kebab-icon">{ICON_STOP}</span>
            <span>{terminateBusy ? 'Terminating…' : 'Terminate'}</span>
          </button>
        </>
      )}

      {/* Read-only footer: the session's created / updated time and its host. */}
      <div className="task-kebab-divider" />
      <div className="task-kebab-meta" data-testid="session-kebab-meta">
        {metaRows.map((row) => (
          <div key={row.key} className="task-kebab-meta-row" data-meta={row.key} title={row.title}>
            <span className="task-kebab-meta-label">{row.label}</span>
            <span className="task-kebab-meta-value">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
