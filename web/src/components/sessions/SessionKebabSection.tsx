/**
 * SessionKebabSection — the "Session" half of the session-panel kebab dropdown.
 *
 * Rendered as the `extraSection` of <TaskQuickActions slot="kebab">: the menu's Session
 * section holds the surface's rows (Open, Window, Columns), then this: ONE group (KebabGroup,
 * "Info & tools") holding Session info (Folder, Host, the time it took, Created, Updated; it
 * opens with the group), Copy & open, Debug and Restart / Terminate. The Task section follows.
 * `SessionViewItems` is the Open group's second half (Inbox, Code, Web, Notes, Msgs,
 * Usage, Background). Presentational only: the session panel owns the handlers.
 */
import { useState, useRef, useEffect } from 'react';
import { copyTextRobust } from '@/utils/clipboard';
import { ICON_CHAT, ICON_COPY, ICON_INFO, ICON_NOTE, ICON_REFRESH, ICON_STOP, ICON_VSCODE } from '../common/Icons';
import { openSessionInVscode } from './openSessionInVscode';
import { prefetchVscodeEmbed } from './vscodeEmbedPrefetch';
import { inboxChipTitle } from '@/components/inbox/session-letters';
import type { SessionSplitView } from './sessionSplitView';
import { sessionKebabMetaRows, shellWord } from './session-kebab-meta';
import { useBackgroundRunning } from '@/hooks/useBackgroundRunning';
import { useSessionServers } from '@/hooks/useSessionServers';
import { useHostDisplayLabel, useHostRoute } from '@/hooks/useHostDisplayLabel';
import { serversSummary, serversUnavailableNote } from './session-server-label';
import '@/styles/session-servers.css';
import { openBackgroundPanel } from '@/stores/background-panel-store';
import { openSessionRawView } from './SessionRawView';
import { backgroundRunningLabel } from './background-ledger';
import { KebabGroup } from './KebabGroup';
import { SegmentedControl, segmentIndexForKey } from '@/components/controls';
import { SessionMetaFacts } from './SessionMetaFacts';
import {
  useSessionPanelMode,
  useLiveAutoPanelCount,
  MIN_PANELS,
  MAX_PANELS,
  type SessionPanelMode,
} from '@/hooks/useSessionPanelMode';

const VIEWS_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M12 4v16" />
  </svg>
);
const DETAILS_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
  </svg>
);
const DEBUG_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="7" y="8" width="10" height="12" rx="5" /><path d="M12 8V5m-3 1 1.5 2m5-2L14 8M4 13h3m10 0h3M5 19l2.5-1.5M19 19l-2.5-1.5" />
  </svg>
);

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
 * Rendered in the kebab's `leadingSection`, at the top of the menu, above the
 * task rows: everything else in the menu is about this task or this session, the
 * panel count is about the strip itself, and it is the control people could not
 * find when it sat between the view toggles (2026-10-01). Being first also keeps
 * it far from Restart / Terminate at the bottom.
 *
 * Labelled "Columns", as the Display menu's "Session columns" row names the same setting.
 * One shared SegmentedControl (size sm) whose options are their plain names (Auto, 1, 2, ...);
 * what Auto gives in this window is a muted note beside it ("Auto: 2 columns now"), from the
 * count the home strip publishes (useLiveAutoPanelCount), so the breakpoints live in one place.
 * Every confirm (a click or tap, Enter / Space, an assistive tech's activation) applies and closes
 * the menu the same way: the control's onChange is the only place a pick lands. The arrows and
 * Home / End only move the focus between the choices (caught before the control's own keys), as
 * this row always did: each pick rewrites the app-wide count and can close columns, so walking
 * past "1" must not apply it.
 */
export function PanelCountRow({ onAfterAction }: { onAfterAction?: () => void }) {
  const { mode, setMode } = useSessionPanelMode();
  const autoCount = useLiveAutoPanelCount();
  const autoNote = autoCount === null ? null : `Auto: ${autoCount} column${autoCount === 1 ? '' : 's'} now`;
  return (
    <div className="task-kebab-panels" data-testid="kebab-panels">
      <span className="task-kebab-icon">{VIEWS_ICON}</span>
      <span className="task-kebab-panels-label" title="How many session columns sit side by side (applies to all sessions)">
        Columns
      </span>
      {autoNote && <span className="task-kebab-panels-note" data-testid="kebab-panels-auto-note">{autoNote}</span>}
      <div
        className="task-kebab-panels-track"
        // Captured before the segments' own keys: the arrows and Home / End move the focus only
        // (Enter / Space reach the control, which picks), and the menu around never acts on them.
        onKeyDownCapture={(e) => {
          const segs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('.task-kebab-panels-opt'));
          const at = segs.indexOf(document.activeElement as HTMLElement);
          const next = at < 0 ? null : segmentIndexForKey(e.key, at, segs.length);
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || next === null) return;
          e.preventDefault();
          e.stopPropagation();
          const to = e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? Math.max(0, Math.min(segs.length - 1, at + (e.key === 'ArrowRight' ? 1 : -1))) : next;
          const seg = segs[to];
          // The shared control's keyboard ring (WebKit draws none for a script's focus otherwise).
          seg.setAttribute('data-keyed', 'true');
          seg.addEventListener('blur', () => seg.removeAttribute('data-keyed'), { once: true });
          seg.focus();
        }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
        // A pick is this row's own: the menu's row handlers never see it.
        onClick={(e) => e.stopPropagation()}
      >
        <SegmentedControl<SessionPanelMode>
          size="sm"
          // Up and Down stay the menu's (moving between its rows).
          horizontalKeys
          // A pick of the pressed one still closes the menu, without writing config again.
          reselect
          aria-label="Session columns side by side"
          value={mode}
          options={PANEL_CHOICES.map((value) => ({
            value,
            // The number itself, never that many drawn bars to count (2026-11-04, the user:
            // "just show numbers, people having to count is not reasonable").
            // tests/web/count-choice-guard.test.ts keeps it so.
            label: value === 'auto' ? 'Auto' : value,
            className: 'task-kebab-panels-opt',
            data: { 'data-value': value === 'auto' ? 'Auto' : value },
            ariaLabel: value === 'auto' ? 'Auto columns' : `${value} column${value === '1' ? '' : 's'}`,
            title: value === 'auto'
              ? `As many as fit the window width${autoCount === null ? '' : ` (${autoCount} now)`}`
              : `${value} session column${value === '1' ? '' : 's'} side by side`,
          }))}
          onChange={(value) => {
            // Re-picking the current value only closes the menu: no config write, no column eviction.
            if (value !== mode) setMode(value);
            onAfterAction?.();
          }}
        />
      </div>
    </div>
  );
}

/** What opens beside or over the chat besides the header's own views (the Open group's second half). */
export interface SessionViewItemsProps {
  sessionId: string;
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
  onOpenUsage?: () => void;
  /** Called after any item runs so the parent can close the dropdown. */
  onAfterAction?: () => void;
}

interface SessionKebabSectionProps {
  sessionId: string;
  /** The session's task: its plugin facts (the time it took) sit in Session info. */
  taskId?: string;
  /** The session's working folder: the Folder row of Session info, and Copy & open's copies. */
  cwd?: string;
  /** Its folder was gone at its last start or resume (the Folder row says so). */
  cwdGone?: boolean;
  /** SSH host alias for remote sessions (absent = this machine) — the Host row. */
  host?: string;
  hostname?: string;
  archived?: boolean;
  /** Session record times — the Created / Updated rows. */
  startedAt?: string;
  lastActiveAt?: string;
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
  /** Open Walnut's own Code view (the 'code' panel view): VS Code desktop's stand-in on a host with no SSH route. */
  onOpenCodeView?: () => void;
  /** Called after any item runs so the parent can close the dropdown. */
  onAfterAction?: () => void;
}

/**
 * A path that wraps at its "/" boundaries: each segment (its slash included) is an inline
 * block, kept whole on a line when it fits and broken inside only when it alone is wider.
 * Its text is the path itself, so selecting and copying it gives the path unchanged.
 */
function PathSegments({ path }: { path: string }) {
  return <>{(path.match(/[^/]*\/|[^/]+$/g) ?? [path]).map((seg, i) => <span key={i} className="task-kebab-meta-seg" data-choice-exempt="a piece of a path that wraps at its slashes, not a segmented control">{seg}</span>)}</>;
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

/**
 * The Open group's second half (SessionMenuOpen.tsx): the Inbox tab first, then Code, Web
 * preview, Notes, Msgs, Usage and the background list. Letters that need the user and work
 * still running in the background show their counts on the closed Open row (ViewsBadge).
 */
export function SessionViewItems({
  sessionId, activeView, onToggleView, unreadCount, decisionCount, attentionCount,
  notesOpen, onToggleNotes, messagesOpen, onToggleMessages, msgCount, onOpenUsage, onAfterAction,
}: SessionViewItemsProps) {
  const codeHoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(codeHoverTimer.current), [sessionId]);
  const { tasks: backgroundTasks, running: bgRunning } = useBackgroundRunning(sessionId);
  const inboxCount = attentionCount > 0 ? (
    <span className={`badge badge-count ${decisionCount > 0 ? 'badge-alert' : 'badge-accent'} session-action-chip-count`}
      title={inboxChipTitle(attentionCount, unreadCount, decisionCount)}>
      {attentionCount > 99 ? '99+' : attentionCount}
    </span>
  ) : null;
  return (
    <>
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
        {inboxCount}
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
        <span>Web preview<WebServersCount sessionId={sessionId} /></span>
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

      {onOpenUsage && (
        <button type="button" className="task-kebab-item" onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onAfterAction?.(); onOpenUsage(); }}>
          <span className="task-kebab-icon" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M7 16v-3m5 3V8m5 8v-5" /></svg>
          </span>
          <span>Usage &amp; Budget</span>
        </button>
      )}

      {/* The session's background commands and agents, finished ones too: the list the old
          Background bar's "View all" opened (2026-10-26). Only once there has been some. */}
      {backgroundTasks.length > 0 && (
        <button
          type="button"
          className="task-kebab-item"
          data-testid="session-kebab-background"
          onClick={(e) => { e.stopPropagation(); onAfterAction?.(); openBackgroundPanel(sessionId); }}
        >
          <span className="task-kebab-icon" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2.5" />
              <path d="M7 9l3 3-3 3M12.5 15H17" />
            </svg>
          </span>
          <span>Background tasks</span>
          {bgRunning.total > 0 && <span className="badge badge-count session-action-chip-count" title={`${backgroundRunningLabel(bgRunning)} running`}>{bgRunning.total}</span>}
        </button>
      )}

    </>
  );
}

/** The Web preview row's count, as the Open row and the phone rows say it (serversSummary): "· 3 web servers", "· 1 other server" when only those run, or "· none running" once it knows there are none; "· host not connected" or "· daemon needs an update" when it cannot know (the sentence on hover). */
function WebServersCount({ sessionId }: { sessionId: string }) {
  const { servers, state, why } = useSessionServers(sessionId, { enabled: true, fast: true });
  // What Web preview can open, else what else runs (a database is listed there too): never
  // "none running" while one of the session's servers holds a port.
  const summary = serversSummary(servers);
  const unavailable = !summary ? serversUnavailableNote(state) : null;
  if (unavailable) {
    return (
      <span className="session-menu-servers-count" data-testid="session-menu-servers-count" data-unavailable={state} title={why}>
        <span className="session-menu-servers-none">{` · ${unavailable}`}</span>
      </span>
    );
  }
  if (!summary && state !== 'ok') return null;
  return (
    <span className="session-menu-servers-count" data-testid="session-menu-servers-count"
      title={summary ? `${summary} this session started ${summary.startsWith('1 ') ? 'is' : 'are'} listening; Web preview lists every one` : 'No server of this session is listening'}>{/* empty-state-ok: tooltip of a menu row */}
      <span className={summary ? undefined : 'session-menu-servers-none'}>{summary ? ` · ${summary}` : ' · none running'}</span>
    </span>
  );
}

/** The counts the closed Open row carries: letters that need the user, background work running. */
export function ViewsBadge({ sessionId, unreadCount, decisionCount, attentionCount }: Pick<SessionViewItemsProps, 'sessionId' | 'unreadCount' | 'decisionCount' | 'attentionCount'>) {
  const { running: bgRunning } = useBackgroundRunning(sessionId);
  if (attentionCount <= 0 && bgRunning.total <= 0) return null;
  return (
    <>
      {attentionCount > 0 && (
        <span className={`badge badge-count ${decisionCount > 0 ? 'badge-alert' : 'badge-accent'} session-action-chip-count`}
          title={inboxChipTitle(attentionCount, unreadCount, decisionCount)}>
          {attentionCount > 99 ? '99+' : attentionCount}
        </span>
      )}
      {bgRunning.total > 0 && <span className="badge badge-count session-action-chip-count" title={`${backgroundRunningLabel(bgRunning)} running`}>{bgRunning.total}</span>}
    </>
  );
}

export function SessionKebabSection({
  sessionId, cwd, cwdGone, host, hostname, archived, startedAt, lastActiveAt,
  onRestart, restartBusy,
  onTerminate, terminateBusy,
  onInvestigate, investigating, investigateResult,
  onOpenVscodeError, onOpenCodeView, onAfterAction, taskId,
}: SessionKebabSectionProps) {
  // VS Code desktop opens a remote folder over SSH (Remote-SSH), inherently: a host reached
  // another way (the host network, the cloud box) keeps the row, which says so and opens
  // Walnut's own Code view there instead (the host's status frame names its route).
  const route = useHostRoute(host);
  const hostName = useHostDisplayLabel(host);
  const noSshRoute = route === 'host-network' || route === 'cloud';
  // Computed per render: the menu mounts when opened, so "2m ago" is fresh each time.
  const metaRows = sessionKebabMetaRows({ cwd, cwdGone, startedAt, lastActiveAt, host, hostname });
  const cdPrefix = cwd ? `cd ${shellWord(cwd)} && ` : '';
  const cwdLabel = cwd ? (cwd.split('/').filter(Boolean).pop() || 'CWD') : null;

  return (
    <div className="task-kebab-section">
      {/* One row for the session process itself (the user's pick of the menu redesign,
          2026-11-02): what opens beside the chat lives in Open at the top of the menu. It sits
          in the menu's Session section under Columns (TaskQuickActions), so its label names
          what it holds rather than repeating the heading. */}
      <KebabGroup label="Info & tools" hint="info · copy · debug · restart" icon={ICON_INFO} testId="session-kebab-session">
      {/* Session info: where the session works (its folder, whole and selectable, and its
          host) and its times, read-only. It leads the group (the UI audit, 2026-11-22: at the group's
          foot it took three clicks to read the folder) and starts closed like every group (open,
          it made the menu taller than a 1280 x 800 window). Copying or opening the folder stays
          in Copy & open. */}
      <KebabGroup label="Session info" hint="folder · host · time · dates" icon={DETAILS_ICON} testId="session-kebab-details">
        {/* Plugin facts about the session (the time it took), with their Header toggle. */}
        <SessionMetaFacts sessionId={sessionId} taskId={taskId} onAfterAction={onAfterAction} />
        <div className="task-kebab-meta" data-testid="session-kebab-meta">
          {metaRows.map((row) => (
            <div key={row.key} className="task-kebab-meta-row" data-meta={row.key} data-gone={row.gone ? 'true' : undefined} title={row.title}>
              <span className="task-kebab-meta-label">{row.label}</span>
              <span className="task-kebab-meta-value">
                {row.key === 'folder' ? <PathSegments path={row.value} /> : row.value}
                {row.gone && <span className="task-kebab-meta-gone"> (gone)</span>}
              </span>
            </div>
          ))}
        </div>
      </KebabGroup>
      <div className="task-kebab-divider" />

      {/* Copy & open: take the session somewhere else (an editor, a terminal, the
          clipboard), and the facts that go with it. */}
      <KebabGroup label="Copy & open" hint="VS Code · folder · ID" icon={ICON_COPY} testId="session-kebab-copy-open">
        {noSshRoute ? (
          <button
            className="task-kebab-item task-kebab-item-unavailable"
            data-testid="session-kebab-vscode-desktop"
            data-unavailable="no-ssh"
            onClick={(e) => { e.stopPropagation(); onAfterAction?.(); onOpenCodeView?.(); }}
            title="Open Walnut's Code view (VS Code in this window) instead"
          >
            <span className="task-kebab-icon">{ICON_VSCODE}</span>
            <span className="task-kebab-item-lines">
              <span>Open in VS Code</span>
              <span className="task-kebab-item-note">
                VS Code desktop opens remote folders over SSH, and {hostName} has no SSH. This opens the Code view here instead.
              </span>
            </span>
          </button>
        ) : (
          <button
            className="task-kebab-item"
            data-testid="session-kebab-vscode-desktop"
            onClick={(e) => {
              e.stopPropagation();
              void openSessionInVscode(sessionId).then(onAfterAction).catch(onOpenVscodeError);
            }}
            title="Open in VS Code"
          >
            <span className="task-kebab-icon">{ICON_VSCODE}</span>
            <span>Open in VS Code</span>
          </button>
        )}
        {cwdLabel && <CopyItem label={`Copy folder path (${cwdLabel})`} value={cwd!} onAfter={onAfterAction} />}
        <CopyItem label="Copy session ID" value={sessionId} onAfter={onAfterAction} />
        <CopyItem label="Copy resume command" value={`${cdPrefix}claude -r ${sessionId}`} onAfter={onAfterAction} />
      </KebabGroup>

      {/* Debug: only what is for finding out what went wrong. */}
      <KebabGroup label="Debug" hint="raw I/O · snapshot" icon={DEBUG_ICON} testId="session-kebab-debug">
        {/* Every turn's full input (Walnut's hints included) and output, as the model saw them. */}
        <button
          type="button"
          className="task-kebab-item"
          data-testid="session-kebab-raw-view"
          onClick={(e) => { e.stopPropagation(); onAfterAction?.(); openSessionRawView(sessionId); }}
          title="Show every turn's input exactly as the model received it (Walnut's hints included) and its output"
        >
          <span className="task-kebab-icon" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 6l-5 6 5 6M16 6l5 6-5 6" />
            </svg>
          </span>
          <span>Raw input &amp; output</span>
        </button>
        {/* It captures the evidence bundle, then copies every related id. */}
        <button
          className="task-kebab-item"
          data-testid="session-kebab-debug-snapshot"
          onClick={(e) => { e.stopPropagation(); onInvestigate(); }}
          disabled={investigating}
          title="Capture a debug snapshot: an evidence bundle (logs, CLI stream, daemon), an incident, and every related id copied to the clipboard"
        >
          <span className="task-kebab-icon">{ICON_COPY}</span>
          <span>
            {investigating
              ? 'Capturing…'
              : investigateResult?.kind === 'ok'
                ? `Copied — ${investigateResult.id} ✓`
                : investigateResult?.kind === 'error'
                  ? 'Capture failed'
                  : 'Capture debug snapshot'}
          </span>
        </button>
      </KebabGroup>

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

      </KebabGroup>
    </div>
  );
}
