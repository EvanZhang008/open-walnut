import { apiPost } from '@/api/client';
import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, Component, lazy, Suspense, type ReactNode, type ErrorInfo, type MouseEvent as ReactMouseEvent, type MutableRefObject, type CSSProperties, memo } from 'react';
import { stableHtml } from '@/hooks/useStableHtml';
import { PauseGlyphIcon, PlayGlyphIcon, WarningTriangleIcon } from '@/components/common/PhoneIcons';
import { ContextFullBanner } from './ContextFullBanner';
import { needsContextRecovery } from '@/utils/context-full';
import { useNavigate } from 'react-router-dom';
import { copyTextDeferred } from '@/utils/clipboard';
import { SessionChatHistory } from './SessionChatHistory';
import { SessionSupervisionBar, useSessionSupervision } from './SessionSupervisionBar';
import { CronPill } from './CronPill';
import { TriggerPill } from '@/components/routines/TriggerPill';
import { SubtaskPill } from '@/components/tasks/SubtaskPill';
import { TaskTagPills } from '@/components/tasks/TaskTagPills';
import { LeaderPill } from '@/components/tasks/LeaderPill';
import { PrPill } from '@/components/tasks/PrPill';
import { CronJobsCard } from './CronJobsCard';
import { stopSupervisedSession } from '@/stores/session-supervision-store';
import { SessionNotesPill, SessionNotesBar, useSessionNote } from './SessionNotes';
import { OutputModePill } from './OutputModePill';
import { useSessionPins } from '@/hooks/useSessionPins';
import { useHidesHighlights } from '@/hooks/useHidesHighlights';
import { SessionPinsContext } from '@/contexts/SessionPinsContext';
import { SessionCommentsContext, type SessionCommentsApi } from '@/contexts/SessionCommentsContext';
import { useSessionComments } from '@/hooks/useSessionComments';
import { composeWithComments } from '@/utils/passage-comments';
import { PendingCommentsTray } from './PendingCommentsTray';
import { usePanelThreads } from '@/hooks/useSessionThreads';
import { SessionThreadsContext } from '@/contexts/SessionThreadsContext';
import { releaseSelectionHold, requestSelectionHold } from '@/utils/selection-hold';
import { useLatestUpdateEntry } from './useLatestUpdateEntry';
import { ThreadToastProvider } from './ThreadPanelToast';
import { ThreadToastBridge } from './ThreadStackFrame';
import { ThreadModePill } from './ThreadModePill';
import { ThreadTreeDrawer } from './ThreadTreeDrawer';
import { SessionRewindContext, type SessionRewindApi } from '@/contexts/SessionRewindContext';
import { SessionRewindDialog } from './SessionRewindDialog';
import { SessionBudgetStatus, SessionUsageDialog } from './SessionUsageDialog';
import { SessionUsageOpenContext, useSessionBudgetUsage } from '@/hooks/useSessionBudgetUsage';
import { useClickedPathOpener, locateClickedPath, missingPathLine, type ClickedPathTarget } from '@/hooks/useClickedPathOpener';
import { sessionScope } from '@/utils/file-view-state';
import { SessionCodeView } from './SessionCodeView';
import { SessionWebView, activeLocalPort, type WebViewRequest } from './SessionWebView';
import { SessionServersChip } from './SessionServersChip';
import { useSessionServers } from '@/hooks/useSessionServers';
import { classifyServiceHref, consoleCanEmbedServices, primeKnownServiceHosts } from '@/utils/service-link';
import { sessionGitStore, useSessionGitGlance } from '@/stores/session-git-store';
import { changedChipTitle } from '@/utils/git-glance-text';
import '@/styles/git-glance.css';
import { KANBAN_COLLAPSE_CHAT_BELOW } from '@/components/board/kanban/kanban-contract';
import { BoardTaskPeek } from '@/components/board/BoardTaskPeek';

/**
 * The split view's panes, each loaded the first time it opens: the editors, the terminal and the
 * Board weigh about 1.5 MB, and a session panel that only chats (the browser side panel, a
 * pop-out) never opens most of them (popout/popout-views.ts). The console has most of them loaded
 * by its other pages already.
 */
const SessionFileExplorer = lazy(() => import('./SessionFileExplorer').then((m) => ({ default: m.SessionFileExplorer })));
const SessionTerminal = lazy(() => import('./SessionTerminal').then((m) => ({ default: m.SessionTerminal })));
/** The views the terminal docks under, by the name its "Show with ..." button says. */
const DOCK_VIEW_LABEL: Partial<Record<SessionSplitView, string>> = { changed: 'Changed', files: 'Files', web: 'Web' };
const SessionChangedTab = lazy(() => import('./SessionChangedTab').then((m) => ({ default: m.SessionChangedTab })));
const SessionInboxPane = lazy(() => import('@/components/inbox/SessionInboxPane').then((m) => ({ default: m.SessionInboxPane })));
const TaskBoardPane = lazy(() => import('@/components/board/TaskBoardPane').then((m) => ({ default: m.TaskBoardPane })));
import { PeekTabBar } from '@/components/board/PeekTabBar';
import { usePeekTabs } from '@/components/board/usePeekTabs';
import { useSessionLetters } from '@/hooks/useSessionLetters';
import {
  consumeSessionInboxLink, SESSION_INBOX_LINK_EVENT,
} from '@/components/inbox/session-inbox-link';
import { buildPassagePrefill, buildSelectionPrefill, buildTerminalPrefill, displayPathForPrefill } from './diffPrefill';
import { TerminalDock } from './TerminalDock';
import type { TerminalPathLink } from './terminal-links';
import type { SessionSplitView } from './sessionSplitView';
import { ICON_ROBOT, ICON_EXPAND, ICON_COLLAPSE, ICON_CLOSE, ICON_MINIMIZE, ICON_LOCK, ICON_UNLOCK, ICON_NEW_TAB, ICON_PANEL_RIGHT, ICON_PANEL_RIGHT_FILLED, ICON_TERMINAL } from '../common/Icons';
import { openPopout } from '@/popout/openPopout';
import { locateTaskOnHome, navigateToTarget } from '@/utils/open-session';
import { UserMessagesSummary } from './UserMessagesSummary';
import { typedUserText } from '@open-walnut/history-injected-banner';
// PlanPreviewSection replaced by inline plan popover in meta bar
import { ChatInput } from '@/components/chat/ChatInput';
import { keepCommandFirst } from '@/components/chat/leading-command';
import type { PrefillMode } from '@/components/chat/prefill-place';
import { SideQuestionDrawer } from '@/components/sessions/SideQuestionDrawer';
import { useEntityLabelsVersion } from '@/hooks/useEntityLabels';
import { useAgentFileOpener, useSessionTextRender } from '@/hooks/useAgentFileOpener';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { stripSendPrefixes, useSessionSend } from '@/hooks/useSessionSend';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { useSessionHistory } from '@/hooks/useSessionHistory';
import { observeSessionOpen } from '@/utils/session-open-latency';
import type { ImageAttachment } from '@/api/chat';
import { useEvent } from '@/hooks/useWebSocket';
import { fetchSession, peekSessionRecord, keepSessionRecord, executePlanContinue, executePlanSession, updateSession, restartSession, recheckSession, investigateSession, type ContinueInNewFolderResult } from '@/api/sessions';
import { FolderGoneBanner } from './FolderGoneBanner';
import { SessionBrowserChip } from './SessionBrowserChip';
import { useBrowserView } from './useBrowserView';
import { UsageLimitBanner, UsageLimitContinuedNote, useContinuingAfterLimit } from './UsageLimitBanner';
import { EngineFallbackBanner, showsEngineFallback } from './EngineFallbackBanner';
import { useFallbackModels } from '@/components/settings/sections/FallbackEngineRow';
import { LaunchSourceNote } from './LaunchSourceNote';
import { engineName } from '@/components/settings/sections/DefaultEngineRow';
import { launchSourceRows, sessionLaunchFrom } from '@/utils/launch-source';
import { formatModelName } from '@/utils/model-name';
import { isFolderGoneReason } from '@/utils/folder-gone';
import { terminalPrewarm } from '@/api/terminal';
import { log } from '@/utils/log';
import { traceInteraction } from '@/utils/interaction-timer';
import { clearSessionCaches } from '@/cache/session-cache';
import { runWhenVisible } from '@/utils/page-visibility';
import { buildInvestigationClip } from '@/utils/investigation-clipboard';
import { fetchTask, updateTask } from '@/api/tasks';
import { EditableSessionTitle } from './EditableSessionTitle';
import { useFocusBarContext } from '@/contexts/FocusBarContext';
import { useStoreTask, useTasksContextSafe } from '@/contexts/TasksContext';
import type { FocusTier } from '@/api/focus';
import { timeAgo } from '@/utils/time';
import { SessionForkButton } from './SessionForkButton';
import { headerPlanFacts, headerTaskPresence, recordGateReason, TASK_SLOT_IDS, TASK_SLOT_SPACER } from './header-record-gate';
import { useTaskControlSlot } from './useTaskControlSlot';
import { useBoardTab } from './useBoardTab';
import { noteShownTask, panelTaskCopy } from './panel-task-copy';
import { SessionKebabSection, type SessionViewItemsProps } from './SessionKebabSection';
import { SessionMenuOpen } from './SessionMenuOpen';
import { PinnedSessionFacts } from './SessionMetaFacts';
import { ComposerModelPill } from './ComposerModelPill';
import { useCompactContext, useIdleCompacting } from './CompactContext';
import { factsFromHistory } from './compact-offer';
import { ComposerControlsBar, type ComposerControl, type ComposerControlsBarHandle } from '@/components/chat/ComposerControlsBar';
import { SESSION_MODE_LABELS } from '@open-walnut/core';
import { orgDisplayTitle } from '@open-walnut/org-tree';
import { TaskQuickActions } from './TaskQuickActions';
import { TransferLinks } from '../transfer/TransferLinks';
import { transferPlusAction } from '../transfer/transfer-plus-action';
import { useCanOpenTransfer } from '../transfer/transfer-events';
import { usePhoneBarSlot, usePhoneLayerWithBar, scrollToLatestTurnStart } from './phone-session-layer';
import { isPhoneLayout, usePhoneLayout } from '@/hooks/usePhoneLayout';
import { useHomeTaskTitleForSession } from '@/components/tasks/phone-row-behavior';
import { PhoneSessionHeaderRows } from './PhoneSessionHeaderRows';
import { createPortal } from 'react-dom';
import { phoneSessionLabel } from '@/utils/phone-session-label';
import { usePendingCardTool } from '@/hooks/usePendingCardTool';
import '@/styles/phone-session.css';
import { useFullscreen, useSheetPlace } from '@/hooks/useFullscreen';
import { fullscreenPlace } from '@/hooks/fullscreen-owner';
import { usePanelView, TERMINAL_DOCK_VIEWS } from './panel-view';
import { useResizablePanel } from '@/hooks/useResizablePanel';
import { useHeightVar } from '@/hooks/useHeightVar';
import { useSessionPlan } from '@/hooks/useSessionPlan';
import { PlanContentContext } from '@/contexts/PlanContentContext';
import { SessionRetryButton } from './SessionRetryButton';
import type { SessionPassageComment, SessionRecord, SessionThreadMeta, TaskPhase } from '@/types/session';
import { useEnabledModes } from '@/hooks/useEnabledModes';
import { getErrorSuggestion } from '@/utils/error-suggestions';
import { SessionHostDownBanner, SessionHostErrorText, useSessionHostHasProblem } from './SessionHostErrorBar';
import { ErrorSuggestionLink } from '@/components/common/ErrorSuggestionLink';
import { useResolvedSessionRecord, useSessionSettings, useSessionStatus } from '@/hooks/useSessionStatus';
import { ComposerThreadPill } from './ComposerThreadPill';
import { useHostStatus } from '@/hooks/useHostStatus';
import { applySessionSettings, clearSessionSettings } from '@/stores/session-status-store';
import { useSessionControls } from '@/hooks/useSessionControls';
import { useEngineCatalog } from '@/hooks/useEngineCatalog';
import { useEngineSettingsEntry } from './useEngineSettingsEntry';
import { engineCaps } from '@/utils/engine-capabilities';
import { EngineSwitchLine, useEngineSwitchPick } from './EngineSwitch';
import type { SessionEffort } from '@open-walnut/core';
import { minimizeHandler } from './panel-minimize';
import { taskNeedsAction } from '@/utils/session-status';
import { nextSessionControlValue, SessionControlPills, sessionModeLabel } from './SessionControlPills';
import { useNotifications } from '@/contexts/notifications';
import { useConfirm } from '@/hooks/useConfirm';
import { setActiveSession } from '@/stores/active-session';
import { markDeniedByMessage } from '@/stores/permission-request-store';
import { useTaskUndo } from '@/undo/TaskUndoContext';
import { COMPOSER_FOCUS_EVENT, COMPOSER_INSERT_EVENT, leadStoredDraft, sessionDraftKey, type ComposerFocusDetail, type ComposerInsertDetail } from '@/utils/composer-insert';
import { ROOT_THREAD_KEY } from '@/utils/thread-tree';
import { startsWithWaitUntil, waitUntilPrefix, WAIT_UNTIL_LABEL, WAIT_UNTIL_TITLE } from '@/utils/wait-until';
import { WAIT_UNTIL_ICON } from '@/components/tasks/TaskStatusControl';
import { WaitingChip } from '@/components/tasks/WaitingChip';
import { useTriggerPickerEntry } from './useTriggerPickerEntry';
import { MacAwayComposer } from '@/components/layout/AwayLine';
import { useMacSessionAway } from '@/hooks/useLeaderPresence';
import type { PlusMenuAction } from '@/components/chat/plus-menu-actions';
import { useMainQuickPlusActions } from '@/components/org/useMainQuickPlusActions';
import { SessionHeaderMoreMenu, SessionHeaderToolRow } from './SessionHeaderMore';
import { SessionHeaderLabels } from './SessionHeaderLabels';
import { useTitleRowTight } from './useTitleRowTight';
import { NoticeToken, PanelNotice } from './PanelNotice';
import '@/styles/session-header-fit.css';
import '@/styles/session-plain-chat.css';
import { IslandHostContext, type IslandHost } from '@/components/chat/island-host';
import { MessageAboutContext } from './message-about';
import { dropSavedColumn } from '@/utils/layout-record';
import { useTreeSplit } from '@/hooks/useTreeSplit';
import { answeringPages, paneColumns, type NavRetarget } from '@/utils/tree-split-state';
import { siblingRows } from '@/utils/tree-sibling';
import { TreeSplitDivider } from './TreeSplitDivider';
import { TreeSiblingDivider } from './TreeSiblingDivider';
import { ThreadPathBar } from './ThreadPathBar';
import { TreeSplitLeft } from './TreeSplitLeft';
import { TreeHalfContext, type TreeHalf } from './tree-half-context';
import { pathBarHeading, pathBarLevelItems, pathBarSegments } from './tree-path-model';
import { createTimelineShare } from './timeline-share';
import { SessionScriptsChip } from '@/components/workspaces/SessionScriptsChip';
import { workspaceOf } from '@/components/workspaces/workspace-text';
import { noteScriptDropped, noteScriptTyped } from '@/components/workspaces/script-results';

/**
 * Below this viewport width a split view opens with the chat column collapsed:
 * the content pane and the 280px-floor chat column don't both fit, and half a
 * letter is worse than one click on "show chat".
 */
const SPLIT_MIN_WIDTH = 900;

/**
 * The Board pane's width once its view opens with the chat beside it: the panel
 * goes full screen (96vw, `.open-walnut-fullscreen.is-changed-open`) and the chat
 * column takes `chatPct`% of it, at least 280px, plus the 1px divider.
 */
/** The Changed view (a file tree beside a diff) opens without the chat when the chat would leave it
 *  narrower than this: the width two code columns need (SessionDiffView's AUTO_SPLIT_MIN_W). */
const CHANGED_COLLAPSE_CHAT_BELOW = 720;
function boardPaneWidthWithChat(windowWidth: number, chatPct: number): number {
  const panel = windowWidth * 0.96;
  return panel - Math.max(280, (panel * chatPct) / 100) - 1;
}
/** How long a hidden (kept-alive) VS Code view survives before it is unmounted. */
const CODE_VIEW_HIDDEN_TTL_MS = 10 * 60_000;
/** No comments waiting on a page (one array, so a page's memo holds). */
const NO_COMMENTS: SessionPassageComment[] = [];
/** Keys that are not typing, so pressing one alone never marks the task read. */
const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn', 'OS']);

interface SessionPanelErrorBoundaryProps {
  sessionId: string;
  /** What "Close panel" does after a crash: a column closes itself, the embedded
   *  slot hides itself. Absent = no recovery button. */
  onClose?: (sessionId: string) => void;
  /** A COLUMN's close also drops the persisted home column layout, so the crash
   *  is not restored on the next load. An embedded panel is not in that layout
   *  and must leave it alone (its Close would otherwise wipe the user's unrelated
   *  session columns). */
  clearsColumnLayout: boolean;
  children: ReactNode;
}

interface SessionPanelErrorBoundaryState {
  hasError: boolean;
}

class SessionPanelErrorBoundary extends Component<SessionPanelErrorBoundaryProps, SessionPanelErrorBoundaryState> {
  constructor(props: SessionPanelErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): SessionPanelErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('SessionPanel crashed:', error, info.componentStack);
  }

  componentDidUpdate(prevProps: SessionPanelErrorBoundaryProps) {
    if (this.state.hasError && prevProps.sessionId !== this.props.sessionId) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      const { onClose, clearsColumnLayout } = this.props;
      return (
        <div className="session-panel" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '24px' }}>
          <p style={{ color: 'var(--fg-muted)', margin: 0 }}>Something went wrong loading this session.</p>
          {onClose && (
            <button
              className="btn btn-sm btn-primary"
              onClick={() => {
                // Only this column leaves the saved strip; the other columns and the pins stay.
                if (clearsColumnLayout) { dropSavedColumn('homeColumns', this.props.sessionId); dropSavedColumn('phoneColumns', this.props.sessionId); }
                onClose(this.props.sessionId);
              }}
            >
              Close panel
            </button>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

/** Plan markdown in the popover, rendered and opened as its writer's (the panel's own, or the from-plan source). */
function PlanPopoverContent({ content, writerSessionId, cwd, sessionId, sessionHost, onTaskClick, onSessionClick, onFileOpen }: {
  content: string;
  writerSessionId: string;
  cwd?: string;
  sessionId: string;
  sessionHost?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onFileOpen?: (path: string, line?: number) => void;
}) {
  const foreign = writerSessionId !== sessionId;
  const own = useSessionTextRender({ sessionId, sessionHost, sessionCwd: cwd });
  const writer = useAgentFileOpener(foreign ? { sessionId: writerSessionId } : undefined);
  const render = foreign ? writer.render : own;
  const labelsVersion = useEntityLabelsVersion();
  const html = useMemo(
    () => renderMarkdownWithRefs(content, render.cwd, render.host, render.images ? undefined : { inlineImages: false }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- labelsVersion invalidates the pill lookups inside
    [content, render.cwd, render.host, render.images, labelsVersion],
  );
  // Own plan: the panel's opener; another writer's: strictly that writer's machine.
  const onClick = useEntityClickHandler(
    onTaskClick, onSessionClick,
    foreign ? writer.onFileOpen : onFileOpen,
    foreign ? writer.fileHost : sessionHost,
    foreign ? writer.fileSessionId : sessionId,
    foreign ? writer.refusesAll : undefined,
  );
  return (
    <div
      className="markdown-body"
      onClick={onClick}
      dangerouslySetInnerHTML={stableHtml(html)}
    />
  );
}

/** A just-launched session's record lands when the daemon confirms the spawn.
 *  Poll a 404 for ~15s (local ≈1s, remote SSH can be 10s+) before giving up. */
const MISSING_SESSION_RETRIES = 30;
const MISSING_SESSION_RETRY_MS = 500;

/**
 * Connectivity recheck claim — ONE request per session per open, shared by every
 * panel instance. The same session can be mounted in two columns and React can
 * remount a panel (StrictMode double-invoke, column reshuffle), so the guard has
 * to live outside the component; the cooldown is what still allows a genuine
 * later re-open to ask again.
 */
const RECHECK_COOLDOWN_MS = 60_000;
const recheckClaimedAt = new Map<string, number>();

function claimRecheckSlot(sessionId: string): boolean {
  const now = Date.now();
  if (now - (recheckClaimedAt.get(sessionId) ?? 0) < RECHECK_COOLDOWN_MS) return false;
  // Bounded: a tab left open for days must not keep an entry per session ever seen.
  if (recheckClaimedAt.size > 200) {
    for (const [sid, at] of recheckClaimedAt) {
      if (now - at > RECHECK_COOLDOWN_MS) recheckClaimedAt.delete(sid);
    }
  }
  recheckClaimedAt.set(sessionId, now);
  return true;
}

interface SessionPanelProps {
  sessionId: string;
  /**
   * Where the panel is hosted (`home-column`, `ask-slot`, `org-node`, `plugin:<id>`, ...).
   * With the session it names the panel's place (useSheetPlace): its view (panel-view.ts) and
   * the tab's full screen are kept per place, so a panel that mounts again shows what it showed.
   */
  viewPlace: string;
  /** Stable close handler — receives the sessionId so the parent can identify
   *  which panel to close (a column removes itself; the embedded slot hides
   *  itself). Optional: without it the header renders no × and no recovery
   *  Close. */
  onClose?: (sessionId: string) => void;
  /**
   * Rendered INSIDE another surface (the home page's Ask Walnut slot) rather than
   * as a session column. The panel behaves exactly like a column's — close (the
   * host decides what closing means: the slot hides itself), popout, fullscreen,
   * and the kebab's Locate all stay. The ONE control hidden is lock: it pins a panel within the
   * column rotation, and there is no rotation here.
   */
  embedded?: boolean;
  /**
   * Rendered inside another panel's chat column (a task opened from a Board,
   * components/board/BoardTaskPeek.tsx). A nested column has no split and no
   * fullscreen of its own: the view chips, expand and popout are hidden, a view
   * request opens the task in its own column, a file opens in a new tab, and
   * the × means Back (onClose).
   */
  inset?: boolean;
  /**
   * Rendered at the start of the TITLE row, before the phase icon: the one spot
   * the host surface may put its own control (the Ask Walnut slot's ≡ session
   * switcher). The title row, not the chips row: the title ellipsizes to make
   * room, whereas the chips row wraps, and a leading button there pushed the
   * time-ago onto its own line in a narrow slot. Hidden in fullscreen, where the
   * panel is an overlay and a drawer opened from it would land behind it.
   */
  headerLeading?: ReactNode;
  /** Put the caret in the composer once, on mount: a host that opened this panel for someone about
   *  to type (an Ask drawer in Ask mode). */
  focusComposer?: boolean;
  /** Open the Inbox tab each time this turns to a new non-zero value: a host that sends the user to
   *  this session's letter (the Org page's Answer). Unlike the window-wide deep link, no other panel
   *  of the session hears it (a hidden Home column would go fullscreen over the page). */
  inboxRequest?: number;
  /** Whether this panel is locked — pinned to the rightmost region, not evicted by new sessions. */
  locked?: boolean;
  /** Toggle the lock state. Parent re-orders slots so locked panels sit on the right. */
  onToggleLock?: (sessionId: string) => void;
  /** Minimize to the app's taskbar, for a host that takes the panel away itself (Home's
   *  columns leave the strip). Every other panel minimizes by default (minimizeHandler):
   *  the session joins the taskbar and the panel closes when its host gave a close. */
  onMinimize?: (sessionId: string) => void;
  /** The person completed this panel's task from its header (the ring or the status menu). The
   *  home page's column answers by closing itself. Not called while the panel is fullscreen. */
  onTaskCompleted?: (sessionId: string, info: { taskId: string; from: TaskPhase; title?: string }) => void;
  onTaskClick?: (taskId: string) => void;
  /** The kebab's Locate row: find this panel's task in the task panel. Its session is
   *  already on screen, so unlike onTaskClick it must not open (and so reorder) any column. */
  onLocateTask?: (taskId: string) => void;
  /** Open the task's full-screen detail modal (shared with the home task panel). */
  onOpenTaskDetail?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  /** Called when "Clear Context & Execute" creates a new session — receives (oldId, newId). */
  onSessionReplaced?: (oldSessionId: string, newSessionId: string) => void;
  /** Fork opens a pre-bound draft column (the shared "+" surface) — this is
   *  MainPage's openDraftColumn, narrowed to the fork seed shape. */
  onOpenForkDraft?: (seed: {
    forkOf: { sessionId: string; title?: string };
    cwd: string; host: string | null; hostLabel?: string;
    project?: string; model?: string; cwdPinned: true;
  }) => void;
  /** Phone layout: this panel is the one open over the home screen, so it is a
   *  phone layer ('session:<id>') whose bar is the top bar (phone-session-layer). */
  phoneLayer?: boolean;
  /** Phone deep link on first load: back from the layer lands here (C26). */
  phoneDeepLinkBaseUrl?: string;
  /** Phone: the host surface is the layer (the Ask Walnut slot's 'chat'); the
   *  panel only hides its header and puts its kebab into that layer's bar. */
  phoneHostSlot?: string;
  /** The host draws this panel's header (the Org page's node header, 2026-11-02, the user: "hide all of
   *  them in the drop down button"): the panel's own two header rows take no room, and its status
   *  badge, its wait and its kebab are drawn into this element instead, the kebab led by the header's
   *  view rows (Changed, Files, Terminal, Board, Plan). Not on a phone layer, which has its own bar. */
  headerSlot?: HTMLElement | null;
  /** With headerSlot: the kebab's Board row opens the host's Board instead of this panel's own. */
  onHostBoard?: () => void;
  /** What an empty conversation says instead of "No conversation history found" (a router's page: why it is empty). */
  emptyHistory?: ReactNode;
  /**
   * A plain chat (the browser side panel's Ask, about the page the person is on): the
   * conversation and a composer, nothing of a coding session. No header (the host has its
   * own), no mode, model or "+" session controls, no slash commands, no unread tint on the
   * composer, and the live turn reads "Walnut is thinking…". Every other host leaves it off.
   */
  plainChat?: boolean;
  /** A host's pill in the composer, above the text (the side panel's page selection that goes
   *  with the next message). A question thread's own target pill wins over it. */
  composerPill?: ReactNode;
  /** In plain chat: the host's controls in the composer's bottom row, after its "+" (the side
   *  panel's page and Act in tab chips). */
  composerBar?: ReactNode;
}

/**
 * The panel, following its session when another replaces it (an engine switch, a rewind, a
 * plan run, a prefix id): a host that follows passes `onSessionReplaced` and shows the new id
 * itself; for every other host (a plugin page, a drawer, the Org page) the panel shows the new
 * session by itself (2026-11-05: a plugin page kept drawing the replaced Claude Code session,
 * so the switch read as "it go back automactily to claude code", its engines locked).
 */
export const SessionPanel = memo(function SessionPanel(props: SessionPanelProps) {
  const { sessionId, onSessionReplaced } = props;
  const [followed, setFollowed] = useState<{ from: string; to: string } | null>(null);
  const shown = followed?.from === sessionId ? followed.to : sessionId;
  const replaced = useCallback((oldId: string, newId: string) => {
    if (onSessionReplaced) { onSessionReplaced(oldId, newId); return; }
    log.info('session-panel', 'following the replacing session (the host does not)', { sessionId: oldId, newSessionId: newId, hostSessionId: sessionId });
    setFollowed({ from: sessionId, to: newId });
  }, [onSessionReplaced, sessionId]);
  return <SessionPanelBody {...props} sessionId={shown} onSessionReplaced={replaced} />;
});

/** The composer controls a plain chat (the browser side panel) shows: the mode and the model pill (its effort inside). */
const PLAIN_CHAT_CONTROLS: ReadonlySet<string> = new Set(['mode', 'model']);

/**
 * The title a replaced session's panel showed, by the session that replaced it: the new session's
 * panel names its task with it while its record loads, not "Untitled session" (2026-11-09 review:
 * after an engine switch the bar read "Untitled session" for a moment). Module-level: a host may
 * mount a new panel for the new id.
 */
const carriedTitles = new Map<string, string>();

const SessionPanelBody = memo(function SessionPanelBody({ sessionId, viewPlace, onClose, embedded, inset, headerLeading, focusComposer, inboxRequest, locked, onToggleLock, onMinimize, onTaskCompleted, onTaskClick, onLocateTask, onOpenTaskDetail, onSessionClick, onSessionReplaced: onSessionReplacedProp, onOpenForkDraft, phoneLayer, phoneDeepLinkBaseUrl, phoneHostSlot, headerSlot, onHostBoard, plainChat, composerPill, composerBar, emptyHistory }: SessionPanelProps) {
  // One place decides what "close this panel" means, so every exit (the header
  // button, the error boundary, the missing-session card) goes through the same
  // owner callback.
  const closePanel = useCallback((id: string) => { onClose?.(id); }, [onClose]);
  // Every replacement goes through here: the new session's panel keeps this one's title meanwhile.
  const shownTitle = useRef<string | null>(null);
  const onSessionReplaced = useMemo(() => (onSessionReplacedProp ? (oldId: string, newId: string) => {
    if (shownTitle.current && newId !== oldId) {
      carriedTitles.set(newId, shownTitle.current);
      if (carriedTitles.size > 20) carriedTitles.delete(carriedTitles.keys().next().value!);
    }
    onSessionReplacedProp(oldId, newId);
  } : undefined), [onSessionReplacedProp]);
  const navigate = useNavigate();
  const { notify } = useNotifications();
  const confirmDialog = useConfirm();
  const enabledModes = useEnabledModes();
  // A session this page fetched before draws from that copy in the first frame (peekSessionRecord);
  // the fetch below brings it current.
  const [sessionRecord, setSession] = useState<SessionRecord | null>(() => peekSessionRecord(sessionId));
  const session = useResolvedSessionRecord(sessionRecord);
  // A host replica with the Mac away: a session that runs on the Mac (or another host) cannot be written to.
  const macSessionAway = useMacSessionAway(session);
  // The host line explains a known host problem; the generic suggestion then stays quiet.
  const hostHasProblem = useSessionHostHasProblem(session?.host);
  const liveStatus = useSessionStatus(sessionId);
  // Key the open state by session: a replacement cannot inherit an old budget edit.
  const [usageDialogSession, setUsageDialogSession] = useState<string | null>(null);
  const usageDialogVisible = usageDialogSession === sessionId;
  const budgetUsage = useSessionBudgetUsage(sessionId, usageDialogVisible);
  const openUsageDialog = useCallback(() => {
    // The menu row disappears on open; give the dialog a durable focus return target.
    panelRef.current?.querySelector<HTMLButtonElement>('.task-kebab-btn')?.focus({ preventScroll: true });
    setUsageDialogSession(sessionId);
  }, [sessionId]);
  const closeUsageDialog = useCallback(() => setUsageDialogSession(null), []);
  // The picker's cost block opens the same dialog ("Set budget").
  const openUsageFor = useCallback((sid: string) => { if (sid === sessionId) openUsageDialog(); }, [sessionId, openUsageDialog]);
  useEffect(() => { setUsageDialogSession(null); }, [sessionId]);
  const pendingPermission = liveStatus?.pendingPermissionTool === undefined
    ? session?.pendingPermission
    : liveStatus.pendingPermissionTool === null
      ? undefined
      : sessionRecord?.statusRevision === liveStatus.statusRevision && sessionRecord.pendingPermission
        ? sessionRecord.pendingPermission
        : { toolName: liveStatus.pendingPermissionTool };
  // Every engine-shaped decision in this panel (rewind, mode surface, model
  // pane, model backfill) reads this capability view — never the engine id.
  const engineCatalog = useEngineCatalog();
  const engineUi = engineCaps(session?.engine, engineCatalog);
  const { controls: sessionControls, setControl: setSessionControlRaw } = useSessionControls(
    sessionId,
    session?.engine,
  );
  // A mode picked in this panel's controls (an engine with its own modes): the model picker's
  // "where these come from" reads it as the task's own before the record says so.
  const [modePickedFor, setModePickedFor] = useState<string | null>(null);
  const setSessionControl = useCallback((id: string, value: string) => {
    if (id === 'mode') setModePickedFor(sessionId);
    return setSessionControlRaw(id, value);
  }, [setSessionControlRaw, sessionId]);
  const [loading, setLoading] = useState(() => !peekSessionRecord(sessionId));
  // Live patches (thread meta, title) go into that copy too, so the next open is not a step behind.
  useEffect(() => { if (sessionRecord) keepSessionRecord(sessionId, sessionRecord); }, [sessionId, sessionRecord]);
  // Set once the ~15s retry window closes on a 404 — the id resolves to nothing.
  const [missing, setMissing] = useState(false);
  const { optimisticMsgs, sendError, redirectedTo, send, interruptSend, stopTurn, retryFailed, dismissFailed, handleMessagesDelivered, handleBatchCompleted, handleBatchFailed, handleDeliveryWaiting, handleEditQueued, handleDeleteQueued, addExternalQueued, queueSync } = useSessionSend(sessionId);
  // Only the read's failure reaches the timeline, as a stable object: a read that changes nothing re-renders nothing.
  const queueSyncError = queueSync.error;
  const queueSyncProp = useMemo(() => (queueSyncError ? { error: queueSyncError } : undefined), [queueSyncError]);
  // A message sent here went to the session an engine switch put in this one's place: show that one.
  useEffect(() => {
    if (redirectedTo && redirectedTo !== sessionId) onSessionReplaced?.(sessionId, redirectedTo);
  }, [redirectedTo, sessionId, onSessionReplaced]);
  // isStreaming is bubbled up from the single useSessionStream instance that lives
  // inside SessionChatHistory (via onStreamingChange). We used to mount a second
  // hook instance here, which doubled stream-subscribe RPCs and produced two
  // parallel defensive-clear paths that could wipe live stream blocks.
  const [isStreaming, setIsStreaming] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Track latest sessionId so async callbacks can detect navigation
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // Slash command autocomplete for session input. Keyed on the session id: the
  // list is what THIS session's CLI advertised in its init line (decorated with
  // descriptions), so a remote host's skills come from the CLI running there —
  // never from a Walnut re-discovery over SSH, and never the Mac's local ones.
  const {
    items: slashCommands, search: searchSlashCommands, refresh: refreshSlashCommands,
    status: slashCommandsStatus, onPaletteOpen: onSlashPaletteOpen,
  } = useSlashCommands(session?.cwd, session?.host, sessionId || undefined);

  // `/model` from the composer opens the model pill's picker — the pill owns the
  // open state, so this bumps the nonce it watches.
  const [modelPickerRequest, setModelPickerRequest] = useState(0);
  // The last request a pill opened for. Kept here, not in the pill: the pill
  // mounts only once the record has loaded, and `/model` can come before that.
  const modelPickerServed = useRef(0);
  // CSS-promotion fullscreen (same instance, no remount)
  // Full screen of the tab: it stays across a trip to another page (useFullscreen), and
  // is kept as this panel's place, so the panel showing it after a remount is full screen again.
  const sheetAt = useSheetPlace(viewPlace, sessionId);
  const { isFullscreen, enterFullscreen, exitFullscreen, fullscreenClass, FullscreenBackdrop } = useFullscreen({ keepAcrossRoutes: true, place: sheetAt });
  // What the panel shows beside its chat, kept for this place (panel-view.ts).
  const panelView = usePanelView(sheetAt);
  const { activeView, setActiveView, fileViewTarget: keptFileTarget, setFileViewTarget, webRequest, setWebRequest, inboxLetterId, setInboxLetterId, terminalDock, setTerminalDock } = panelView;
  // A file a click opened before this panel mounted is not a click now: the explorer reopens
  // what was read last (it keeps that itself, and the user may have browsed on), so the kept
  // target only roots it on another host. A click in this mount gets a new nonce.
  const mountedTarget = useRef({ at: sheetAt, nonce: keptFileTarget?.nonce ?? null });
  if (mountedTarget.current.at !== sheetAt) mountedTarget.current = { at: sheetAt, nonce: keptFileTarget?.nonce ?? null };
  const fileViewTarget = keptFileTarget && (keptFileTarget.onHost || keptFileTarget.nonce !== mountedTarget.current.nonce) ? keptFileTarget : null;
  const chatHiddenRef = useRef(panelView.chatHidden);
  chatHiddenRef.current = panelView.chatHidden;
  // A fullscreen panel is an overlay over its column: closing the column behind it would
  // show the person nothing, so the host hears about completions only from the normal view.
  const completedInColumn = useMemo(
    () => (onTaskCompleted && !isFullscreen
      ? (info: { taskId: string; from: TaskPhase; title?: string }) => onTaskCompleted(sessionId, info)
      : undefined),
    [onTaskCompleted, isFullscreen, sessionId],
  );


  // G4 liquid glass: the header overlays the chat column (position: absolute)
  // so content scrolls UNDER it; the scroll area pads its top by the measured
  // height (a CSS var on the panel root, it varies with chip-row wrap). The
  // composer is deliberately NOT measured: it sits in flow below the scroller,
  // so the scroller ends where the composer starts (globals.css, "Session
  // panel: composer").
  const panelRef = useRef<HTMLDivElement>(null);
  const glassHeaderRef = useHeightVar(panelRef, '--sp-header-h');
  // A narrow column keeps the tool row on one line: its items
  // leave by priority (window buttons into the kebab, view chips into a "..."
  // menu). Hidden items stay mounted under data-hidden="true"; the menu proxies to
  // them. The title row has nothing to fold: its labels are one control already.
  const toolRowRef = useRef<HTMLDivElement>(null);
  // A narrow title row puts its labels on a line under the title (useTitleRowTight.ts).
  const [titleRowRef, titleRowTight] = useTitleRowTight();
  // Fork and Board (and the kebab's Locate) need the session's task. Whether they exist is decided
  // on the first frame from what this page already knows (the status store, which
  // every list naming the session seeds); a session known to have no task gets
  // none of them, one with a task gets them in place, disabled until the record
  // lands. Only a session nothing here has named yet waits with all three drawn.
  const taskPresence = headerTaskPresence(session, liveStatus);
  // Once drawn, their places stay while this panel shows this session: a later
  // "no task" turns them into spacers (taskControlSlot), never removes them from
  // under a click. A panel that replaces this one for the same session (a prefix
  // adopting the full id) starts from what this one drew (handOverTaskSlots).
  const { slot: taskSlot, handOver: handOverTaskSlots } = useTaskControlSlot(sessionId, taskPresence);
  const boardWaitReason = recordGateReason('The Board', session, loading);
  // Board is a lead's tab: only a task with open subtasks or a Board of its own
  // gets it (board-tab-model.ts). The status store names the task before the record.
  // An inset column draws no split views, so it never asks.
  const boardTab = useBoardTab(inset ? undefined : (session?.taskId ?? liveStatus?.taskId));
  // Whether this panel drew the live chip for this session: only then does a later
  // "no task" leave its place as a spacer (taskControlSlot).
  const boardDrawn = useRef<{ sessionId: string; drawn: boolean }>({ sessionId, drawn: false });
  if (boardDrawn.current.sessionId !== sessionId) boardDrawn.current = { sessionId, drawn: false };
  const boardChipLive = taskSlot === 'live' && boardTab === 'shown';
  if (boardChipLive) boardDrawn.current.drawn = true;
  const locateWaitReason = recordGateReason('Locate', session, loading);

  const handleControlCommand = useCallback((command: string) => {
    if (command === 'model') {
      // The model picker is the main conversation's (Tree Mode): with no page of
      // Main on screen, Main comes into view first, and its composer opens it.
      if (!fullComposerShownRef.current) threadsForInsert.current.stack.api.popTo(ROOT_THREAD_KEY, 'model');
      setModelPickerRequest((n) => n + 1);
    }
  }, []);
  /** A composer with the "+" menu, mode and model is on screen (ownComposerLight). */
  const fullComposerShownRef = useRef(true);

  // The record's own id, not the prop: a deep link may address the session by a
  // unique PREFIX, and the shared store is keyed by the canonical provider id
  // every other surface resolves.
  const settingsSessionId = sessionRecord?.claudeSessionId ?? sessionId;

  // Optimistic / reverted record patches from the composer's model pill (it owns
  // the switch calls). They land in the SHARED session-settings store, not in
  // this panel's private copy: the same session can also be showing in the chat
  // lane composer and in the task detail rows, and a private patch left them on
  // the old value until each happened to refetch.
  const applyModelPillPatch = useCallback((patch: Partial<SessionRecord>) => {
    applySessionSettings(settingsSessionId, patch);
  }, [settingsSessionId]);

  // Permission-mode writes go through the same store. A private optimistic patch
  // here was doubly wrong: invisible (resolveSessionRecordStatus overwrites
  // `mode` from the status store, so `setSession({...session, mode})` never
  // showed) AND unshared, so the pill sat still until the PATCH — which also
  // reaches the live CLI — came back.
  const setModeOptimistic = useCallback((nextMode: SessionRecord['mode']) => {
    applySessionSettings(settingsSessionId, { mode: nextMode });
    updateSession(settingsSessionId, { mode: nextMode }).catch((err) => {
      clearSessionSettings(settingsSessionId, ['mode']);
      log.warn('session-panel', 'mode toggle failed', {
        sessionId: settingsSessionId, mode: nextMode, error: String(err),
      });
    });
  }, [settingsSessionId]);

  const openEngineRef = useRef(session?.engine);
  const measuredMountRef = useRef<string | null>(null);
  openEngineRef.current = session?.engine;
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const firstMount = measuredMountRef.current !== sessionId;
    measuredMountRef.current = sessionId;
    return observeSessionOpen(panel, sessionId, () => openEngineRef.current ?? 'unknown', firstMount);
  }, [sessionId]);

  const modeSwitchSession = useRef(settingsSessionId);
  modeSwitchSession.current = settingsSessionId;
  const [modeSwitchError, setModeSwitchError] = useState<string>();
  const [modeSwitchBusy, setModeSwitchBusy] = useState(false);
  const askAfterAutoDenial = async () => {
    setModeSwitchBusy(true); setModeSwitchError(undefined);
    try {
      await apiPost('/api/engines/claude/recover-permission', { sessionId: settingsSessionId }, { timeoutMs: 25000 });
      applySessionSettings(settingsSessionId, { mode: 'default' });
      if (modeSwitchSession.current === settingsSessionId) setSession(prev => prev ? { ...prev, autoPermissionDenial: null } : prev);
    } catch (err) { if (modeSwitchSession.current === settingsSessionId) setModeSwitchError(err instanceof Error ? err.message : String(err)); }
    finally { if (modeSwitchSession.current === settingsSessionId) setModeSwitchBusy(false); }
  };
  useEffect(() => { setModeSwitchError(undefined); setModeSwitchBusy(false); }, [settingsSessionId]);

  // Fetch messages for the UserMessagesSummary
  const {
    messages: historyMessages, loading: historyLoading,
    phase2Pending: historyPhase2Pending, olderHidden: historyOlderHidden,
    olderWindowed: historyOlderWindowed, initialUserText: historyInitialUserText,
  } = useSessionHistory(sessionId);
  // The pinned "Initial Prompt" bubble: prefer the server-computed TRUE first
  // user message. historyMessages is a lazy TAIL — its first user row can be
  // mid-conversation (the collapse-mode bubble used to show a recent message as
  // the "Initial Prompt"). Fall back to the window head ONLY when we provably
  // hold the full history (nothing hidden before messages[0], fetch settled).
  const initialPromptText = historyInitialUserText
    ?? (!historyPhase2Pending && historyOlderHidden === 0 && !historyOlderWindowed
      ? historyMessages.find(m => m.role === 'user')?.text
      : undefined);

  // Plan content for plan chip and execute buttons
  // Before the record, what the status store knows (headerPlanFacts): Plan is drawn from the first frame.
  const { hasPlan, isFromPlan, planMode } = headerPlanFacts(session, liveStatus);
  // mode === 'plan' covers sessions still actively planning — planCompleted is only set after the plan tool call finishes,
  // so without this the Plan chip would be hidden during active planning.
  const shouldFetchPlan = hasPlan || isFromPlan || planMode;
  const { plan, loading: planLoading, refresh: planRefresh } = useSessionPlan(sessionId || undefined, shouldFetchPlan);
  // Plan chip visibility is gated on whether a plan actually EXISTS — not on mode.
  // A bypass session that produced a plan (planCompleted / from-plan) still shows it;
  // a plan-mode session that hasn't produced one yet shows it once the content loads.
  const hasPlanContent = hasPlan || isFromPlan || !!plan?.content;

  // Last assistant message that carries a model — the composer pill's fallback
  // for the context percent when no live usage event has landed yet.
  const lastAssistant = !historyLoading && historyMessages.length > 0
    ? [...historyMessages].reverse().find(m => m.role === 'assistant' && m.model)
    : undefined;

  // Scroll-to-message handler for UserMessagesSummary
  const handleMessageClick = useCallback((messageIndex: number) => {
    const container = bodyRef.current?.querySelector('.session-history');
    if (!container) return;
    const target = container.querySelector(`[data-msg-index="${messageIndex}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('user-messages-highlight');
      setTimeout(() => target.classList.remove('user-messages-highlight'), 1500);
    } else {
      // Message is truncated — ask SessionChatHistory to expand and scroll to it
      container.dispatchEvent(new CustomEvent('expand-to-message', {
        detail: { messageIndex }, bubbles: false,
      }));
    }
  }, []);

  // The linked task. The shared task store is the truth inside this browser:
  // a rename or phase flip made on the board, in this header, or in the detail
  // pane lands in that store synchronously, so this header changes in the same
  // frame as every other surface instead of waiting for the REST round-trip
  // and its WS echo (which, on a stalled server, arrived seconds later while
  // the board still showed the old title). The private REST copy below is only
  // the fallback for a task the list does not carry, and the donor of the heavy
  // fields (`ext`) the minimal list payload drops.
  const [fetchedTask, setFetchedTask] = useState<import('@open-walnut/core').Task | null>(null);
  const storeTask = useStoreTask(session?.taskId);
  const taskStore = useTasksContextSafe();
  // The pop-out window's mark-read request in flight (it has no task store).
  const readRequestRef = useRef<string | null>(null);
  // The REST copy stands only for the task the session still names (the resolved record's, which a
  // live status updates before any refetch): panelTaskCopy.
  const linkedTaskId = session?.taskId;
  const sessionTask = useMemo(
    () => panelTaskCopy(storeTask, fetchedTask, linkedTaskId),
    [storeTask, fetchedTask, linkedTaskId],
  );
  // The keys acting on this column read it while the board's first list is still on the way.
  useEffect(() => noteShownTask(sessionId, sessionTask), [sessionId, sessionTask]);
  // The session ran in its task's workspace and that was removed: the terminal's folder is gone.
  const terminalFolderGone = useMemo(() => {
    const ws = workspaceOf(sessionTask as never);
    const cwd = session?.cwd;
    return !!ws && ws.state === 'removed' && !!ws.root && !!cwd && (cwd === ws.root || cwd.startsWith(`${ws.root}/`));
  }, [sessionTask, session?.cwd]);
  // Main reads as the CEO and a project's lead as its VP (display only).
  const taskTitle = sessionTask ? orgDisplayTitle(sessionTask) : null;
  // Another engine picked in the model picker: the next message switches the task to it.
  const engineSwitch = useEngineSwitchPick({ sessionId, session, task: sessionTask, catalog: engineCatalog, onSessionReplaced });
  // Where this session's engine, model and mode came from (the task's record of its last new
  // start, utils/launch-source.ts), in the model picker. A value changed since reads as the task's.
  // Only on that start's session, the task's current one: an older session started otherwise. A
  // task event names no session_id (only a full read does), so only a different one hides it.
  // An ACP engine's models by their names in the note (its catalog's list).
  const noteModels = useFallbackModels(engineUi.isAcp ? engineUi.id : null);
  const pillSettings = useSessionSettings(settingsSessionId);
  const pillModel = pillSettings?.model;
  const launchSource = sessionTask?.launch_source && session?.taskId === sessionTask.id
    && (!sessionTask.session_id || sessionTask.session_id === sessionId)
    ? sessionTask.launch_source : null;
  const launchSourceNote = useMemo(() => {
    if (!launchSource || !session) return undefined;
    // The claude CLI's model: one just picked in this browser's pill (the shared settings overlay,
    // before any refetch), else the record's --model value (absent = its default; the server
    // writes it on a switch). An ACP engine reports its model either way, so it is compared only
    // against a start that named one.
    const cliModel = pillModel || session.cliModel;
    // Before the CLI names its model, the one the start asked for.
    const nowModel = (engineUi.isAcp ? session.acpModel : cliModel) || launchSource.started?.model;
    const acp = session as { acpConfig?: Record<string, string>; acpStartMode?: string };
    // An ACP model is someone's pick once it is on the record's acpConfig (only a pick writes it)
    // or just picked in this browser's pill; before that it is the engine's own default.
    const acpModelPicked = !!pillSettings?.acpModel || !!acp.acpConfig?.model;
    const compared = engineUi.isAcp ? (launchSource.started?.model || acpModelPicked ? session.acpModel : undefined) : cliModel;
    const startFrom = sessionLaunchFrom(launchSource, {
      engine: engineUi.id, model: compared,
      mode: engineUi.configModes ? launchSource.started?.mode : session.mode, modeChosen: !engineUi.configModes && !!session.modeChosen,
    });
    // An engine with its own modes: its approval preset and, on Codex, its plan collaboration
    // mode. The start writes its own preset to acpConfig.mode (and as acpStartMode): only another
    // one, or a preset picked here just now, or plan turned on or off since, is the task's own.
    const startedMode = launchSource.started?.mode ?? session.mode;
    const modeControl = engineUi.configModes ? sessionControls.find((c) => c.id === 'mode') : undefined;
    const planControl = engineUi.configModes ? sessionControls.find((c) => c.id === 'collaboration_mode') : undefined;
    const planOn = planControl ? planControl.currentValue === 'plan' : startedMode === 'plan';
    // The live preset against the start's: one picked back to the start's is no pick (before a
    // reload as after). A record from before acpStartMode has only this panel's pick to go on.
    const presetNow = modeControl?.currentValue ?? acp.acpConfig?.mode;
    const presetPicked = acp.acpStartMode ? !!presetNow && presetNow !== acp.acpStartMode : modePickedFor === sessionId;
    const pickedMode = engineUi.configModes && (presetPicked || planOn !== (startedMode === 'plan'));
    const from = pickedMode ? { ...startFrom, mode: 'task' as const } : startFrom;
    // One name for one mode: Walnut's (as the draft said) with the preset the mode pill shows.
    const preset = modeControl ? sessionModeLabel(modeControl) : undefined;
    const walnutLabel = (SESSION_MODE_LABELS as Record<string, string>)[pickedMode ? (planOn ? 'plan' : '') : startedMode];
    const liveModeLabel = !preset ? undefined : walnutLabel && walnutLabel !== preset ? `${walnutLabel} (${preset})` : preset;
    const rows = launchSourceRows(from, {
      engineName: engineName(engineUi.displayName),
      ...(nowModel ? { modelName: noteModels.options.find((o) => o.value === nowModel)?.label || formatModelName(nowModel) || nowModel } : {}),
      mode: engineUi.configModes ? startedMode : session.mode,
      ...(liveModeLabel ? { modeLabel: liveModeLabel } : {}),
      showMode: true, project: launchSource.project,
    });
    return <LaunchSourceNote rows={rows} project={launchSource.project} />;
  }, [launchSource, session, pillModel, pillSettings, engineUi, noteModels.options, sessionControls, modePickedFor, sessionId]);
  // The fallback-engine note this panel closed (its `at`), hidden before the task's update arrives.
  const [fallbackGone, setFallbackGone] = useState<string | null>(null);

  // Pin state — read from the shared Focus Bar store (single source of truth,
  // same data every other surface renders). Mutations go through the shared
  // optimistic handlers, so a pin/tier/complete here updates the Homepage
  // pinned tiers in the same frame — no private fetch, no config:changed poll.
  const focusBar = useFocusBarContext();
  const pinned = session?.taskId ? focusBar.isPinned(session.taskId) : false;
  const pinnedTier: FocusTier | undefined = pinned && session?.taskId ? focusBar.tierOf(session.taskId) : undefined;

  // Through the undoable actions (an Undo toast and mod+z), as the task list's are.
  const taskUndo = useTaskUndo();
  const pinActions = taskUndo ?? focusBar;
  const handlePinTask = useCallback((id: string) => {
    pinActions.pin(id).catch((err) => console.error('Pin failed:', err));
  }, [pinActions]);

  const handleUnpinTask = useCallback((id: string) => {
    pinActions.unpin(id).catch((err) => console.error('Unpin failed:', err));
  }, [pinActions]);

  const handleSetTier = useCallback((id: string, tier: FocusTier) => {
    pinActions.setTier(id, tier).catch((err) => console.error('Set tier failed:', err));
  }, [pinActions]);

  // Fetch session metadata
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const known = peekSessionRecord(sessionId);
    setSession(known);
    setLoading(!known);
    setMissing(false);
    setFetchedTask(null);
    const load = (attempt: number) => {
      fetchSession(sessionId).then((s) => {
        if (!cancelled) {
          // 404 (s === null) is EXPECTED briefly on a freshly launched session:
          // quick-start/fork pre-assign the CLI session id and return it in the
          // HTTP response, so this panel mounts BEFORE the record is persisted
          // (persist happens once the daemon confirms the spawn — ~1s locally,
          // longer over SSH). Treat "not there yet" as retryable, otherwise the
          // panel settles permanently into an empty "Untitled session" header.
          // A genuinely deleted session just costs a few silent retries first.
          if (s === null && attempt < MISSING_SESSION_RETRIES) {
            retryTimer = setTimeout(() => { if (!cancelled) load(attempt + 1); }, MISSING_SESSION_RETRY_MS);
            return;
          }
          // Retries exhausted on a 404: this id does not resolve. Say so instead
          // of settling into an indistinguishable empty "Untitled session" header
          // — a dead column otherwise re-runs this 30-retry loop on every reload
          // and reads as "new sessions are broken".
          if (s === null) setMissing(true);
          // The server accepts a unique id PREFIX (the UI displays only 8 chars,
          // so prefixes reach us via deep links). Adopt the canonical id so the
          // column — and the WS stream/RPCs keyed off it — use the full id from
          // here on, instead of re-resolving a prefix on every request.
          if (s?.claudeSessionId && s.claudeSessionId !== sessionId) {
            log.info('session-panel', 'adopting canonical session id from prefix', {
              requestedId: sessionId, sessionId: s.claudeSessionId,
            });
            // The host replaces this panel by one under the full id: it starts from what this one drew.
            if (onSessionReplaced) handOverTaskSlots(s.claudeSessionId);
            onSessionReplaced?.(sessionId, s.claudeSessionId);
          }
          setSession(s);
          setLoading(false);
          // Prewarm the remote terminal transport (ssh ControlMaster + dtach) so a
          // later Terminal click is ~0.2s instead of ~2.5s. Fire-and-forget; the
          // server no-ops for local sessions. Cheap, idempotent, self-expires.
          if (s?.host) {
            terminalPrewarm(sessionId).catch(() => { /* best-effort; open will still work */ });
          }
          // Fetch associated task title + pin state
          if (s?.taskId) {
            fetchTask(s.taskId).then((t) => {
              if (!cancelled) setFetchedTask(t);
            }).catch(() => {});
          }
        }
      }).catch((err) => {
        if (cancelled) return;
        // Transient failure (fetchSession only throws for non-404) — the record
        // exists, this request lost a race. Retry instead of settling into the
        // "Untitled session" header (inc-1784686852150 / inc-1784752220440).
        if (attempt < 3) {
          log.warn('session-panel', 'session metadata fetch failed — retrying', {
            sessionId, attempt, error: String(err),
          });
          retryTimer = setTimeout(() => { if (!cancelled) load(attempt + 1); }, 500 * (attempt + 1));
        } else {
          log.error('session-panel', 'session metadata fetch failed after retries', {
            sessionId, error: String(err),
          });
          setLoading(false);
        }
      });
    };
    load(0);
    return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
  }, [sessionId]);

  // A task the store does not hold (a plugin's own task, Task.plugin_only, opened in its
  // plugin's view): the REST copy follows the task's own events instead.
  const followTaskEvent = useCallback((data: unknown) => {
    const t = (data as { task?: import('@open-walnut/core').Task | null } | undefined)?.task;
    if (!t || storeTask || t.id !== linkedTaskId) return;
    setFetchedTask((prev) => (prev && prev.id === t.id ? { ...prev, ...t } : t));
  }, [storeTask, linkedTaskId]);
  useEvent('task:updated', followTaskEvent);
  useEvent('task:completed', followTaskEvent);

  useEvent('session:status-changed', (data) => {
    const d = data as { sessionId?: string; threadMeta?: SessionThreadMeta[] };
    if (d.sessionId === sessionId) {
      // The background AI named a question, judged it answered or wrote its
      // takeaway: the event carries the stored list, adopt it in place (the
      // record is refetched only on result, error and reconnect).
      if (Array.isArray(d.threadMeta)) {
        const meta = d.threadMeta;
        setSession(prev => prev ? { ...prev, threadMeta: meta } : prev);
      }
      // Model backfill for idle launches (todo-launcher quick start): quick-start
      // pre-seeds the record model-less (Auto) and returns before the CLI's init
      // event writes the real model onto it. The status snapshot doesn't carry
      // model, and an idle session (empty first message) never produces the
      // assistant turn whose usage-update would deliver it — so without this
      // refetch the record's model stays invisible until the first real turn.
      // status-changed fires right after the init-model write; refetch while the
      // record is still model-less (self-limiting: stops once model is present).
      // ACP engines report their model as acpModel (the record's `model` field
      // stays empty by design), so the backfill is a native-engine repair.
      if (session && !session.model && !engineUi.isAcp) {
        fetchSession(sessionId).then((s) => { if (s) setSession(s); }).catch(() => {});
      }
    }
  });

  // Keep the fallback copy in sync with real-time task events. When the store
  // carries the row this is redundant (the store applies the same events); it
  // matters for a task the list does not have.
  useEvent('task:updated', (data) => {
    const d = data as { task?: import('@open-walnut/core').Task };
    if (d.task && session?.taskId && d.task.id === session.taskId) setFetchedTask(d.task);
  });
  useEvent('task:completed', (data) => {
    const d = data as { task?: import('@open-walnut/core').Task };
    if (d.task && session?.taskId && d.task.id === session.taskId) setFetchedTask(d.task);
  });

  useEvent('session:result', (data) => {
    const d = data as { sessionId?: string };
    if (d.sessionId === sessionId) {
      fetchSession(sessionId).then((s) => { if (s) setSession(s); }).catch(() => {});
    }
  });

  useEvent('session:error', (data) => {
    const d = data as { sessionId?: string };
    if (d.sessionId === sessionId) {
      fetchSession(sessionId).then((s) => { if (s) setSession(s); }).catch(() => {});
    }
  });

  // The usage-limit wait moved (server sessions/usage-limit-wait.ts): it is written after the
  // turn's result, so the refetch above can miss it; the event carries the stored wait.
  useEvent('session:usage-limit', (data) => {
    const d = data as { sessionId?: string; usageLimit?: SessionRecord['usageLimit'] | null; continued?: SessionRecord['usageLimitContinued'] | null };
    if (d.sessionId !== sessionId) return;
    setSession(prev => prev ? {
      ...prev, usageLimit: d.usageLimit ?? undefined,
      ...('continued' in d ? { usageLimitContinued: d.continued ?? undefined } : {}),
    } : prev);
  });

  // Applied-settings read-back (server pulled the CLI's get_settings). This is the
  // ONLY live delivery path for effectiveEffort: the panel fetches the record once
  // at mount, but the session-start read-back lands ~1.5s LATER, so without this
  // the composer's effort pill kept showing its default guess ('High') while the
  // picker — which live-pulls on open — showed the truth ('X-High'). Same event
  // also carries the true model, keeping the pill's model text honest after an
  // out-of-band switch.
  useEvent('session:settings-applied', (data) => {
    const d = data as {
      sessionId?: string;
      effectiveEffort?: import('@open-walnut/core').SessionEffort | null;
      requestedEffort?: import('@open-walnut/core').SessionEffort | null;
      model?: string;
      autoPermissionDenial?: SessionRecord['autoPermissionDenial'];
    };
    if (d.sessionId !== sessionId) return;
    setSession(prev => prev ? {
      ...prev,
      // null = "CLI reports no effort set" ⇒ clear the stale value so the badge
      // falls back to the documented API default instead of a dead reading.
      ...('effectiveEffort' in d ? { effectiveEffort: d.effectiveEffort ?? undefined } : {}),
      ...('autoPermissionDenial' in d ? { autoPermissionDenial: d.autoPermissionDenial } : {}),
      ...(d.requestedEffort ? { effort: d.requestedEffort } : {}),
      ...(d.model ? { model: d.model } : {}),
    } : prev);
  });

  // Re-fetch session state on WebSocket reconnect.
  // Events during disconnect (e.g. session:status-changed, session:result) are lost;
  // without this, the UI can show stale "Resuming session..." indefinitely.
  // Typical trigger: a `dev:prod` server restart drops the WS connection briefly.
  useEvent('_ws:reconnected', () => {
    if (sessionId) {
      // Hidden tabs defer until shown — every open tab reconnects at once on a
      // server restart; only the visible one should hit the API immediately.
      runWhenVisible(`session-panel:reconnect:${sessionId}`, () => {
        fetchSession(sessionId).then((s) => { if (s) setSession(s); }).catch(() => {});
      });
    }
  });

  // Execute plan buttons state
  const [executing, setExecuting] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [executeStarted, setExecuteStarted] = useState(false);

  // Action chip toggle state
  const [planPopoverOpen, setPlanPopoverOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  // Shared note state feeding both the pill (empty) and the bar (has note)
  const noteState = useSessionNote(sessionId, session?.human_note);
  // Pinned messages (the timeline outline) + the rewind entry point. Both reach
  // the memoized transcript rows through context, never props.
  const pinsApi = useSessionPins(sessionId, session?.pinnedMessages);
  // Quotes and comments on passages: marked in the timeline, listed above the
  // composer, and sent with its next message (utils/passage-comments.ts).
  const commentsStore = useSessionComments(sessionId, session?.passageComments, !!session);
  // ── Questions (conversation threads): wired by usePanelThreads below. The
  // composer's text and focus feed the stack's Esc rule and its draft flush.
  const composerTextRef = useRef('');
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const composerControlsRef = useRef<ComposerControlsBarHandle>(null);
  const planComposerControlsRef = useRef<ComposerControlsBarHandle>(null);
  const composerProbe = useMemo(() => ({
    focused: () => {
      const el = document.activeElement;
      return !!el && !!composerWrapRef.current?.contains(el) && el.tagName === 'TEXTAREA';
    },
    text: () => {
      // An EMPTY live box wins over the mirror: ChatInput writes the mirror in a
      // passive effect, so an Esc pressed right after Enter could still read the
      // sent words and refuse to pop (seen under machine load). A reference sits
      // in the box as its `@[label]` token, so an empty box is an empty draft.
      const wrap = composerWrapRef.current;
      const box = wrap?.querySelector<HTMLTextAreaElement>('textarea.chat-input-textarea');
      if (box && box.value.trim() === '') return '';
      return composerTextRef.current;
    },
  }), []);
  const handleComposerValue = useCallback((text: string) => { composerTextRef.current = text; }, []);
  // Tree Mode's split screen has a composer per page: Esc reads the one that
  // holds the focus, so words typed in a page left of the panel's keep it too.
  const sideComposerOf = useCallback((el: Element | null): HTMLTextAreaElement | null => {
    if (!(el instanceof HTMLTextAreaElement) || !panelRef.current?.contains(el)) return null;
    return el.closest('.tree-split-input') ? el : null;
  }, []);
  const escapeProbe = useMemo(() => ({
    focused: () => composerProbe.focused() || !!sideComposerOf(document.activeElement),
    text: () => sideComposerOf(document.activeElement)?.value ?? composerProbe.text(),
  }), [composerProbe, sideComposerOf]);
  /** Cmd+[ / Cmd+]: filled by useTreeSplit below (the stack registers the keys first). */
  const pairMoveRef = useRef<((dir: -1 | 1) => boolean) | null>(null);
  const onPairMove = useCallback((dir: -1 | 1) => pairMoveRef.current?.(dir) ?? false, []);
  /** A navigation while pages sit side by side: filled by useTreeSplit below. */
  const retargetRef = useRef<((toPath: readonly string[], via: string) => NavRetarget | null) | null>(null);
  const retargetNav = useCallback((toPath: readonly string[], via: string) => retargetRef.current?.(toPath, via) ?? null, []);
  // Focus-only composer request (Ask about a passage / Ask here). Separate from
  // prefillNonce on purpose: the quote must NOT be written into the draft — it
  // rides the chip and is composed at send time — so the user's typed text stays.
  const [composerFocusNonce, setComposerFocusNonce] = useState(0);
  /** Focus requests that should ALSO bring the timeline down to the composer. Split
   *  from the focus counter above because one caller must not: see the option. */
  const [composerScrollNonce, setComposerScrollNonce] = useState(0);
  const requestComposerFocus = useCallback((opts?: { keepTimelinePosition?: boolean }) => {
    setComposerFocusNonce((n) => n + 1);
    // `keepTimelinePosition` — the caller just TRAVELLED somewhere in the transcript
    // (an outline row jump) and the composer focus is only the second half of that
    // click. Without this the focus dragged the timeline to the bottom one frame
    // after the jump landed, so a map row looked like it always went to the newest
    // message — the exact symptom reported on 2026-09-04.
    if (!opts?.keepTimelinePosition) setComposerScrollNonce((n) => n + 1);
    // REVEAL the composer first: while the chat column is collapsed it is
    // `display:none` and focus() lands on <body>, losing every keystroke (same
    // trap as handleSelectCode).
    autoCollapsed.current = false;
    setChatCollapsed(false);
  }, []);
  // Once per mount, and without moving the timeline: the panel lands where it always lands.
  const composerFocusedOnMount = useRef(false);
  useEffect(() => {
    if (!focusComposer || composerFocusedOnMount.current) return;
    composerFocusedOnMount.current = true;
    requestComposerFocus({ keepTimelinePosition: true });
  }, [focusComposer, requestComposerFocus]);
  const focusComposerKeep = useCallback(() => requestComposerFocus({ keepTimelinePosition: true }), [requestComposerFocus]);
  const threads = usePanelThreads({
    sessionId,
    serverAnchors: session?.threadAnchors,
    serverMeta: session?.threadMeta,
    pins: pinsApi.pins,
    panelRef,
    // An anchor is only meaningful where the engine persists the uuid we
    // pre-assign for the user line (the stream-json contract); ACP does not.
    canAsk: !!sessionId && !engineUi.isAcp,
    send,
    interruptSend,
    composer: composerProbe,
    escapeProbe,
    onPairMove,
    retarget: retargetNav,
    focusComposer: focusComposerKeep,
  });
  const threadsApi = threads.api;
  const threadTree = threadsApi.tree;
  // Tree Mode's split screen (design 4, the path bar): useTreeSplit.
  const chatColRef = useRef<HTMLDivElement | null>(null);
  const derivedAnswered = threadsApi.derived.answeredAt;
  const answeredAtOf = useCallback((key: string) => derivedAnswered.get(key), [derivedAnswered]);
  const treeSplit = useTreeSplit({
    sessionId,
    tree: threadTree,
    hiddenKeys: threadsApi.hiddenKeys,
    metaIndex: threadsApi.metaIndex,
    stack: threads.stack.api,
    stackMode: threads.stack.enabled,
    record: panelView.treeSplit,
    setRecord: panelView.setTreeSplit,
    panelRef,
    chatColRef,
    markViewed: threadsApi.markViewed,
    answeredAtOf,
    // Back to the passage a page was asked about, on a page on screen: it lands there again.
    onFocusPane: (key, via) => focusPaneRef.current(key, true, via === 'quote-head'),
  });
  pairMoveRef.current = treeSplit.moveBy;
  retargetRef.current = treeSplit.retarget;
  // The panel's timeline publishes, the pages left of it read (timeline-share.ts).
  const timelineShare = useMemo(() => createTimelineShare(), [sessionId]);
  const treeLeftShown = treeSplit.splitShown;
  /** The pages left of the panel's own, left to right. */
  const sidePaneKeys = treeLeftShown ? treeSplit.paneKeys.slice(0, -1) : [];
  /** The sibling question above the panel's own page (tree-sibling.ts). */
  const treeSibling = treeSplit.sibling;
  /** The chat column is Tree Mode's grid: pages side by side, or a sibling above the page. */
  const treeGrid = treeLeftShown || !!treeSibling;
  // A move to a page already on screen: it flashes and its composer takes the
  // focus; the panel's own page asks for its composer as a click on it would.
  const [paneFocus, setPaneFocus] = useState<{ key: string; n: number; flash: boolean; land: boolean } | null>(null);
  const focusPaneRef = useRef<(key: string, flash?: boolean, land?: boolean) => void>(() => {});
  focusPaneRef.current = (key: string, flash = true, land = false) => {
    setPaneFocus((prev) => ({ key, n: (prev?.n ?? 0) + 1, flash, land }));
    if (key === threads.stack.api.currentKey) focusComposerKeep();
  };
  const pathSegments = useMemo(
    () => pathBarSegments(treeSplit.trail, treeSplit.roles, threadTree, threadsApi.metaIndex, treeSplit.labels),
    [treeSplit.trail, treeSplit.roles, threadTree, threadsApi.metaIndex, treeSplit.labels],
  );
  const pathLevelItems = useCallback((j: number) => pathBarLevelItems(threadTree, treeSplit.trail, j, {
    hidden: threadsApi.hiddenKeys, index: threadsApi.metaIndex, live: threadsApi.derived.live,
    unread: threadsApi.unreadKeys, labels: treeSplit.labels,
  }), [threadTree, treeSplit.trail, treeSplit.labels, threadsApi.hiddenKeys, threadsApi.metaIndex, threadsApi.derived.live, threadsApi.unreadKeys]);
  const pathHeading = useCallback((j: number) => pathBarHeading(treeSplit.trail, j, treeSplit.labels), [treeSplit.trail, treeSplit.labels]);
  const { closePane: closeTreePane, openSplit: openTreeSplit } = treeSplit;
  const rightKeyNow = treeSplit.rightKey;
  const closeRightHalf = useCallback(() => closeTreePane(rightKeyNow), [closeTreePane, rightKeyNow]);
  const rightNumber = treeSplit.labels.get(treeSplit.rightKey);
  // What the panel's own timeline is in the split: the right page, or (one page,
  // with room for two) the page whose row offers Split.
  const showTreeSibling = treeSplit.siblingClosed ? treeSplit.showSibling : undefined;
  const rightHalf = useMemo<TreeHalf | null>(() => {
    const sib = showTreeSibling ? { onShowSibling: showTreeSibling } : {};
    if (treeLeftShown) return { side: 'R', ...(rightNumber ? { number: rightNumber } : {}), onClose: closeRightHalf, ...sib };
    if (treeSplit.barShown && treeSplit.wide && treeSplit.shownIndex >= 1) return { side: 'only', onSplit: openTreeSplit, ...sib };
    if (showTreeSibling) return { side: 'only', ...sib };
    return null;
  }, [treeLeftShown, rightNumber, closeRightHalf, treeSplit.barShown, treeSplit.wide, treeSplit.shownIndex, openTreeSplit, showTreeSibling]);
  // Tree Mode: a comment waits on the page it was made on (its question's head
  // id), in that page's composer; one whose question is gone or hidden waits on Main.
  const treeMode = threads.stack.enabled;
  const treeModeRef = useRef(treeMode);
  treeModeRef.current = treeMode;
  const keyOfHead = useMemo(() => new Map(threadTree.threads.map((n) => [n.headId, n.key] as const)), [threadTree]);
  const hiddenThreadKeys = threadsApi.hiddenKeys;
  const commentPageOf = useCallback((c: SessionPassageComment): string => {
    const key = c.thread ? keyOfHead.get(c.thread) : undefined;
    return key !== undefined && !hiddenThreadKeys.has(key) ? key : ROOT_THREAD_KEY;
  }, [keyOfHead, hiddenThreadKeys]);
  const pendingCommentsOf = useCallback((page: string) => (treeMode
    ? commentsStore.pending.filter((c) => commentPageOf(c) === page)
    : commentsStore.pending), [treeMode, commentsStore.pending, commentPageOf]);
  const ownPendingComments = useMemo(
    () => pendingCommentsOf(treeMode ? threads.stack.api.currentKey : ROOT_THREAD_KEY),
    [pendingCommentsOf, treeMode, threads.stack.api.currentKey],
  );
  // The pages beside the panel's own: left of it, and the sibling above it.
  const besideKeys = treeSibling ? [...sidePaneKeys, treeSibling.key] : sidePaneKeys;
  const sidePaneSig = besideKeys.join('\n');
  const sidePending = useMemo(
    () => new Map(besideKeys.map((k) => [k, pendingCommentsOf(k)] as const)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read through its signature
    [sidePaneSig, pendingCommentsOf],
  );
  const openComposerTarget = useCallback((key: string) => threadsApi.requestCard(key, 'composer-chip'), [threadsApi]);
  // × lets go of the quoted question only: an open card stays (opening one never set it).
  const clearQuote = threadsApi.clearQuote;
  const clearComposerTarget = useCallback(() => {
    clearQuote('composer-chip');
    focusComposerKeep();
  }, [clearQuote, focusComposerKeep]);

  /**
   * Dictated text is about to take focus in the composer, which collapses the page's
   * selection. If the timeline's quote pill is up on a passage, ask it to HOLD: the
   * passage stays painted and Copy / Pin / Ask keep working after the selection is
   * gone (QuotePinSelectionBar, "HOLDING").
   *
   * Reported 2026-09-10: "I select text, use voice to text, and the selection gets
   * deselected." The first answer went further than the report and turned the
   * selection into the composer's thread anchor. Reported 2026-09-16, with a
   * screenshot of a chip nobody asked for: the reader had dragged over one word while
   * reading, dictated a question about something else, and got "asking about" that
   * word; sent as-is, the turn would have been filed under that reply with the word
   * quoted above the question. A selection is not a request; the pill's Ask is. So
   * nothing is inferred here any more: the passage stays reachable, and the chip
   * appears only when the user presses Ask.
   *
   * Runs once, when the FINAL text is about to take focus (not at the mic press, not
   * at a live draft): that is the one write that collapses the selection, and so the
   * last moment the pill can still read it. Sent from the panel root: the pill
   * answers for the timeline this panel contains.
   */
  const holdDictationSelection = useCallback(() => {
    if (requestSelectionHold(panelRef.current)) {
      log.info('session', 'dictation landed with a passage selected; the quote pill holds it', { sessionId });
    }
  }, [sessionId]);

  const [rewindTarget, setRewindTarget] = useState<{ msgId: string; label?: string } | null>(null);
  // Bumped after an IN-PLACE rewind: the transcript was truncated under the
  // same session id, so the timeline (SessionChatHistory) is remounted via its
  // key to rebuild history + streaming state from scratch. Client caches are
  // cleared first (see onRewound) so the remount's initial load can't adopt the
  // pre-rewind copy.
  const [rewindEpoch, setRewindEpoch] = useState(0);
  /**
   * Rewind is a TIME operation, and in the node view that is easy to forget: the
   * screen shows one thread, so "drops the 12 messages after it" reads as twelve
   * messages of THIS thread. Count how many of them are in other threads and let
   * the dialog say so. Only asked while the node view is on (the timeline already
   * shows every thread the rewind would touch) and only over rows this browser has
   * loaded — an approximation of the server's count, which is why the dialog caps
   * it at that number.
   */
  const rewindOtherThreads = useMemo(() => {
    if (!threads.stack.enabled || !rewindTarget) return 0;
    const rowIdOf = (m: { msgId?: string; walnutMessageId?: string }) => m.msgId ?? m.walnutMessageId;
    const at = historyMessages.findIndex((m) => rowIdOf(m) === rewindTarget.msgId);
    if (at < 0) return 0;
    const targetKey = threadTree.byRow.get(rewindTarget.msgId)?.key;
    if (targetKey === undefined) return 0;
    let other = 0;
    for (let i = at + 1; i < historyMessages.length; i++) {
      const id = rowIdOf(historyMessages[i]);
      const key = id ? threadTree.byRow.get(id)?.key : undefined;
      if (key !== undefined && key !== targetKey) other++;
    }
    return other;
  }, [threads.stack.enabled, rewindTarget, historyMessages, threadTree]);
  const rewindApi = useMemo<SessionRewindApi>(() => ({
    // Rewind needs the engine's own checkpointing (--resume-session-at +
    // rewind_files); engines without it hide the button instead of failing on
    // click. Capability, not a vendor check.
    available: !!sessionId && engineUi.rewind,
    request: (msgId, label) => setRewindTarget({ msgId, ...(label ? { label } : {}) }),
  }), [sessionId, engineUi.rewind]);
  const [messagesOpen, setMessagesOpen] = useState(false);
  // Changed / Files / Terminal all share ONE full-screen split: [ left panel | chat ].
  // null = none open. Opening any view promotes the panel to fullscreen. It is kept
  // for this place with the panel's view (usePanelView above).
  const splitOpen = activeView !== null;
  // A host that cannot open a terminal (the cloud box has no SSH) offers no
  // Terminal tab. The host's own capability says so (its status frame), never
  // its alias; a host the server has not described yet keeps the tab.
  const terminalOffered = useHostStatus(session?.host)?.terminal !== false;
  // An open panel asks first: its repos are re-read ahead of the rows', so the Changed
  // chip's tooltip has the session's git state without the tab.
  useEffect(() => { if (sessionId) void sessionGitStore.refresh(sessionId); }, [sessionId]);
  const {
    unreadCount: letterUnread, decisionCount: letterDecisions, attentionCount: letterAttention,
  } = useSessionLetters(sessionId);
  // The letter open IN the tab (inboxLetterId, kept with the panel's view). Owned
  // here, not in the pane, so hopping to the Files tab and back returns to the
  // letter instead of the list.
  // ChatInput prefill driver — selecting code in the diff drops a prompt into the
  // existing input (no new chat, no fork; goes to the main agent via normal send).
  const [prefillText, setPrefillText] = useState<string | undefined>(undefined);
  const [prefillNonce, setPrefillNonce] = useState(0);
  const [prefillMode, setPrefillMode] = useState<PrefillMode>('replace');
  const handleSelectCode = useCallback((filePath: string, line: number | undefined, code: string) => {
    // The Changed tab already hands a repo-relative path; the Files tab browses the
    // whole filesystem and hands an absolute one. Shorten against the session cwd so
    // a quote reads the same from either surface (a path outside the cwd stays absolute).
    setPrefillText(buildSelectionPrefill(displayPathForPrefill(filePath, session?.cwd), line, code));
    setPrefillMode('replace');
    setPrefillNonce((n) => n + 1);
    // REVEAL the composer first: while the chat column is collapsed it is
    // `display:none`, so ChatInput's focus() lands on <body> and every keystroke
    // the user then types is LOST (2026-08-13 report: "the cursor doesn't go to
    // the input box"). Asking about a selection means "take me to the chat".
    // Reveal is the USER's choice, so it outlives a tab hop (applyOpenCollapse).
    autoCollapsed.current = false;
    setChatCollapsed(false);
  }, [session?.cwd]);
  // "Inject to chat" from a side thread → the SAME prefill driver as a code
  // selection, with one difference: it KEEPS what the user has already typed and
  // puts the injected block in front of it. The summary variant takes a model turn
  // to arrive and the user is free to keep typing while it runs, so a replace would
  // eat both their sentence and its saved draft. Reveal must happen in this batch —
  // a collapsed chat column is `display:none`, so ChatInput's focus() would land on
  // <body> and eat the user's next keystrokes (same trap as handleSelectCode).
  const handleInjectFromThread = useCallback((text: string) => {
    setPrefillText(text);
    setPrefillMode('keep-draft');
    setPrefillNonce((n) => n + 1);
    autoCollapsed.current = false;
    setChatCollapsed(false);
  }, []);
  // A terminal selection's "Add to chat": the output goes in as a block AFTER what
  // is typed ('attach'), so several blocks read in the order added and nothing is
  // sent. Reveals the chat like a code selection does (same display:none trap).
  const handleTerminalAddToChat = useCallback((text: string, source: string) => {
    setPrefillText(buildTerminalPrefill(text, source));
    setPrefillMode('attach');
    setPrefillNonce((n) => n + 1);
    autoCollapsed.current = false;
    setChatCollapsed(false);
    log.info('session-panel', 'terminal selection added to the composer', { sessionId, source, chars: text.length });
  }, [sessionId]);
  // "Quote in session" from a task row elsewhere on the page: append the pill to
  // whatever is typed (a quote joins the sentence in progress, it does not lead
  // it), reveal, focus. Marking the event handled tells the sender the text has
  // a live home; otherwise it parks the text in the persisted draft instead.
  const threadsForInsert = useRef(threads);
  threadsForInsert.current = threads;
  const engineIsAcp = engineUi.isAcp;
  const engineIsAcpRef = useRef(engineIsAcp);
  engineIsAcpRef.current = engineIsAcp;
  useEffect(() => {
    const onInsert = (e: Event) => {
      const detail = (e as CustomEvent<ComposerInsertDetail>).detail;
      if (!detail || detail.sessionId !== sessionId || detail.handled) return;
      if (detail.within && !(panelRef.current && detail.within.contains(panelRef.current))) return;
      detail.handled = true;
      const rootKey = sessionDraftKey(sessionId);
      // "Snooze until something happens" names its skill as a Claude Code
      // command; an ACP engine gets the plain sentence (utils/wait-until.ts).
      const waitLead = detail.mode === 'lead' && startsWithWaitUntil(detail.text);
      const text = waitLead ? waitUntilPrefix({ acp: engineIsAcpRef.current }) : detail.text;
      const draftLeads = waitLead
        ? startsWithWaitUntil(composerTextRef.current)
        : composerTextRef.current.trimStart().startsWith(text.trimEnd());
      if (detail.mode === 'lead' && threadsForInsert.current.draftKey !== rootKey) {
        // A question page's composer posts into the question. A lead is for the
        // session itself: write it into the session's own draft and go back to
        // it (ChatInput reloads the draft on the key change).
        try { leadStoredDraft(rootKey, text); } catch { /* storage unavailable */ }
        const t = threadsForInsert.current;
        if (t.api.viewMode === 'linear') {
          t.api.clearQuote('insert', { keepDraft: true });
          setComposerFocusNonce((n) => n + 1);
        } else {
          t.stack.api.popTo(ROOT_THREAD_KEY, 'insert');
          // Main may stay a page beside the panel's own (Tree Mode keeps its
          // pages): its composer takes the focus then, never the question's.
          requestAnimationFrame(() => {
            if (threadsForInsert.current.stack.api.currentKey === ROOT_THREAD_KEY) setComposerFocusNonce((n) => n + 1);
            else focusPaneRef.current(ROOT_THREAD_KEY, false);
          });
        }
      } else if (detail.mode === 'lead' && draftLeads) {
        // A lead the draft already starts with (the same row clicked twice) only refocuses.
        setComposerFocusNonce((n) => n + 1);
      } else {
        setPrefillText(text);
        setPrefillMode(detail.mode === 'lead' ? 'keep-draft' : 'append');
        setPrefillNonce((n) => n + 1);
      }
      autoCollapsed.current = false;
      setChatCollapsed(false);
      setActiveSession(sessionId);
    };
    window.addEventListener(COMPOSER_INSERT_EVENT, onInsert);
    return () => window.removeEventListener(COMPOSER_INSERT_EVENT, onInsert);
  }, [sessionId]);
  // A keyboard jump to this column (pages/useHomeKeyboard.ts): the caret goes into its
  // composer, revealed first when the chat is collapsed, and the timeline stays put.
  useEffect(() => {
    const onFocus = (e: Event) => {
      const detail = (e as CustomEvent<ComposerFocusDetail>).detail;
      if (!detail || detail.sessionId !== sessionId || detail.handled) return;
      if (detail.within && !(panelRef.current && detail.within.contains(panelRef.current))) return;
      detail.handled = true;
      requestComposerFocus({ keepTimelinePosition: true });
      setActiveSession(sessionId);
    };
    window.addEventListener(COMPOSER_FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(COMPOSER_FOCUS_EVENT, onFocus);
  }, [sessionId, requestComposerFocus]);
  // The transcript pill's "Quote" and "Comment" (beside "Ask here"): the passage,
  // with the user's comment under it, goes into the MAIN conversation's composer as
  // a quote. Nothing is sent: the user collects as many as they like and sends them
  // as one message, in the order added ('stack', prefill-place.ts). On a question
  // (its page, or the composer's target in Conversation Mode) the panel goes back
  // to the main conversation first; that question keeps its own draft.
  const quoteInChat = useCallback((passage: string, comment?: string) => {
    const t = threadsForInsert.current;
    // Conversation Mode: let go of the quoted question. Tree Mode stays where the
    // reader is (2026-11-04, the user: "even comment stay the same tree mode"):
    // the quote goes into the composer of the page on screen.
    if (t.draftKey !== sessionDraftKey(sessionId) && t.api.viewMode === 'linear') {
      t.api.clearQuote('quote-in-chat', { keepDraft: true });
    }
    setPrefillText(buildPassagePrefill(passage, comment));
    setPrefillMode('stack');
    setPrefillNonce((n) => n + 1);
    autoCollapsed.current = false;
    setChatCollapsed(false);
  }, [sessionId]);
  // The pill's Quote / Comment on a passage with a message id: kept as a comment on
  // its words (listed above the composer), never as text in the box. Same trip back
  // to the main conversation as above, since that is the composer that sends it;
  // the timeline stays where the user is reading.
  const addPassageComment = commentsStore.add;
  // A doc comment's row opens its doc (the Files tab); set once handleFileOpen exists below.
  const openDocRef = useRef<(path: string) => void>(() => {});
  const commentsApi = useMemo<SessionCommentsApi>(() => ({
    comments: commentsStore.comments,
    update: commentsStore.update,
    remove: commentsStore.remove,
    requestJump: (id, opts) => {
      const c = commentsStore.comments.find((x) => x.id === id);
      if (c?.doc) openDocRef.current(c.doc.path);
      commentsStore.requestJump(id, opts);
    },
    jump: commentsStore.jump,
    canComment: commentsStore.canComment,
    add: ({ pageKey, ...input }) => {
      // A doc comment is written beside its passage: the reader stays in the doc.
      if (input.doc) { addPassageComment(input); return; }
      const t = threadsForInsert.current;
      // Tree Mode: the comment stays on the page it was made on, in the view the
      // reader is in (never a trip back to Main, never another page: 2026-11-04,
      // the user: "even comment stay the same tree mode"), and goes with that
      // page's next message. Conversation Mode lets go of the quoted question.
      if (t.api.viewMode === 'stack') {
        const head = pageKey ? t.api.tree.byKey.get(pageKey)?.headId : undefined;
        addPassageComment({ ...input, ...(head ? { thread: head } : {}) });
      } else {
        if (t.draftKey !== sessionDraftKey(sessionId)) t.api.clearQuote('quote-in-chat', { keepDraft: true });
        addPassageComment(input);
      }
      autoCollapsed.current = false;
      setChatCollapsed(false);
      // A phone keeps its keyboard down while the user marks more passages. A
      // comment made on a page left of the panel's own focuses that page's composer.
      if (!phoneLayer) {
        if (t.api.viewMode === 'stack' && pageKey !== undefined && pageKey !== t.stack.api.currentKey) focusPaneRef.current(pageKey, false);
        else setComposerFocusNonce((n) => n + 1);
      }
    },
  }), [commentsStore.comments, commentsStore.update, commentsStore.remove, commentsStore.requestJump, commentsStore.jump, commentsStore.canComment, addPassageComment, sessionId, phoneLayer]);
  // A tray row's Edit: show its passage and open its card with the words in the editor.
  const requestCommentJump = commentsStore.requestJump;
  const editPendingComment = useCallback(
    (id: string, origin: { x: number; y: number }) => requestCommentJump(id, { edit: true, origin }),
    [requestCommentJump],
  );
  // Messages the CLI had queued behind the turn that a Stop dropped: like Esc in
  // Claude Code, their text goes back into the input (ahead of anything typed since)
  // and the "Delivered" bubbles go, since the model never saw them.
  useEvent('session:queued-cancelled', (data) => {
    const d = data as { sessionId?: string; messageIds?: string[]; messages?: string[] };
    if (d.sessionId !== sessionId || !Array.isArray(d.messageIds)) return;
    const texts = d.messageIds.map((id, i) => {
      const bubble = optimisticMsgs.find((m) => m.queueId === id);
      dismissFailed(id);
      return bubble?.text ?? stripSendPrefixes(d.messages?.[i] ?? '');
    }).filter((t) => t.trim() !== '');
    log.info('session-panel', 'stop returned queued messages to the composer', { sessionId, messageIds: d.messageIds });
    if (texts.length === 0) return;
    setPrefillText(texts.join('\n\n'));
    setPrefillMode('keep-draft');
    setPrefillNonce((n) => n + 1);
  });
  // A line comment from the diff → send straight to this session's main agent.
  const handleDiffComment = useCallback((message: string) => {
    void send(sessionId, message);
    return true;
  }, [send, sessionId]);
  // The Board tab's "Ask for a board" goes out through the composer's own send
  // path (optimistic bubble, queueing, retry), like a diff comment.
  const handleBoardSend = useCallback((text: string) => send(sessionId, text), [send, sessionId]);
  // Chat column in the split: resizable width (% of viewport) + collapse.
  // Fresh storage key (v3): re-baseline everyone at the new default. The middle
  // content pane (file preview / diff) is the priority — chat is a side column.
  const chatPanel = useResizablePanel('open-walnut-split-chat-w3', 30, 'right');
  // The chat column: the resizable width measures it while a view sits beside it,
  // Tree Mode's split measures it always (useTreeSplit).
  const chatPanelRef = chatPanel.panelRef as MutableRefObject<HTMLDivElement | null>;
  const chatColCallbackRef = useCallback((el: HTMLDivElement | null) => {
    chatColRef.current = el;
    if (splitOpen) chatPanelRef.current = el;
  }, [splitOpen, chatPanelRef]);
  // A chat the user hid comes back hidden (panelView.chatHidden); one the window hid does not.
  const [chatCollapsed, setChatCollapsed] = useState(() => panelView.chatHidden);
  // Was the collapse the WINDOW's decision (too narrow for both columns) or the
  // user's? An automatic collapse belongs to the view that asked for it, so
  // switching tabs drops it; a hand-hidden chat sticks until the user says
  // otherwise. Every user-driven toggle goes through collapseChat.
  const autoCollapsed = useRef(false);
  const collapseChat = useCallback((collapsed: boolean) => {
    autoCollapsed.current = false;
    setChatCollapsed(collapsed);
  }, []);
  // A task chip on the Board, or a task clicked in the chat while the panel is full
  // screen, opens that task in the chat column as a tab, in place of this chat (which
  // stays mounted under it). This panel's OWN task is the "Chat" tab, not the board's:
  // a worker's Board shows its leader's. The tabs are remembered per task: leaving the
  // full screen hides them, coming back shows the same tab.
  const revealChat = useCallback(() => collapseChat(false), [collapseChat]);
  const peek = usePeekTabs({ ownTaskId: session?.taskId, sessionId, enabled: !inset && isFullscreen, onReveal: revealChat });
  const peekShownId = session?.taskId ? peek.shownId : null;
  // The chat stays mounted under a peek (visibility: hidden): its marks must not paint on the peek.
  useHidesHighlights(!!peekShownId);
  const { open: peekOpen, close: peekClose, active: peekActive } = peek;
  const closeShownPeek = useCallback(() => { if (peekActive) peekClose(peekActive, 'close'); }, [peekActive, peekClose]);
  // Stable (the hook's callbacks are), so the memoized chat history does not re-render for it.
  const openPeekFromChat = useCallback((taskId: string) => peekOpen(taskId, 'chat'), [peekOpen]);
  // A task clicked in the chat: full screen keeps it here, as a tab; a column opens its own.
  const chatTaskClick = !inset && isFullscreen && session?.taskId ? openPeekFromChat : onTaskClick;
  // Full screen with no split view has no chat bar of its own: the tabs bring one.
  const peekBarAlone = !inset && isFullscreen && !splitOpen && peek.tabs.length > 0;
  // Opening a view decides the chat column's fate: below the split floor the Inbox
  // tab opens on the letter alone (the chat column has a 280px floor, and half a
  // letter is worse than one click on "show chat"); any other view clears a
  // collapse that was automatic so a tab hop can't silently lose the chat.
  // The Board opens on the board alone when the chat would leave it under 480px
  // (the kanban's floor): the same automatic collapse, undone by the board's own
  // `Show chat` button, after which this panel never collapses the chat for the
  // Board again (the user's choice wins).
  // The Changed view follows the same rule below CHANGED_COLLAPSE_CHAT_BELOW (a
  // tree and a diff squeezed beside the chat wrap every code line), with its own
  // "the user showed the chat" memory.
  const boardChatRevealed = useRef(false);
  const changedChatRevealed = useRef(false);
  /** The Changed view's width beside the chat: measured from the split when it shows, else estimated from the window. */
  const changedPaneWidthWithChat = useCallback((): number => {
    const split = panelRef.current?.querySelector<HTMLElement>('.session-panel-split');
    const chat = chatColRef.current;
    if (split && split.clientWidth > 0) {
      const chatW = chat && chat.clientWidth > 0 ? chat.clientWidth : Math.max(280, (split.clientWidth * chatPanel.pct) / 100);
      return split.clientWidth - chatW;
    }
    return boardPaneWidthWithChat(window.innerWidth, chatPanel.pct);
  }, [chatPanel.pct]);
  const applyOpenCollapse = useCallback((view: SessionSplitView) => {
    // A phone shows the view OR the chat (the view's `Chat` toggle), never both.
    if (isPhoneLayout() || (view === 'inbox' && window.innerWidth < SPLIT_MIN_WIDTH)) {
      autoCollapsed.current = true;
      setChatCollapsed(true);
      return;
    }
    if (view === 'board' && !boardChatRevealed.current && boardPaneWidthWithChat(window.innerWidth, chatPanel.pct) < KANBAN_COLLAPSE_CHAT_BELOW) {
      autoCollapsed.current = true;
      setChatCollapsed(true);
      log.info('session-panel', 'board opened with the chat collapsed', { sessionId, windowWidth: window.innerWidth });
      return;
    }
    if (view === 'changed' && !changedChatRevealed.current && changedPaneWidthWithChat() < CHANGED_COLLAPSE_CHAT_BELOW) {
      autoCollapsed.current = true;
      setChatCollapsed(true);
      log.info('session-panel', 'changed opened with the chat collapsed', { sessionId, windowWidth: window.innerWidth });
      return;
    }
    if (autoCollapsed.current) { autoCollapsed.current = false; setChatCollapsed(false); }
  }, [chatPanel.pct, sessionId, changedPaneWidthWithChat]);
  const revealChatForBoard = useCallback(() => {
    boardChatRevealed.current = true;
    collapseChat(false);
  }, [collapseChat]);
  // File-path click target for the Files split view. When set, the explorer roots
  // at the clicked file (backend lists its parent + preselects it, VS Code style)
  // instead of the session cwd. Cleared when the split closes / view switches.
  // `onHost`: the file lives on another host than the session's (absent = the session's).
  // `missing`: no host has it; the tree shows the session's cwd with that one line.
  // Toggle a split view: same view → close (exit fullscreen); other/none → open it.
  //
  // Exception kept: Files opened via a file-path click (fileViewTarget set) — the
  // chip's first click re-roots the explorer to the session cwd so you can browse
  // the whole tree, the second closes. The re-root no longer loses your place: the
  // explorer's memory is scope-keyed, so the same file stays open and the tree
  // expands to it under the new root (that loss WAS the reported bug).
  const toggleView = useCallback((view: SessionSplitView) => {
    if (inset) {
      // A nested column has no split: a view (the kebab's Inbox / Code / Web) opens
      // with the task in its own column, the Locate path.
      const taskId = session?.taskId;
      log.info('session-panel', 'inset view request opens the task', { sessionId, view, taskId: taskId ?? '' });
      if (!taskId) return;
      const locate = onLocateTask ?? onTaskClick;
      if (locate) locate(taskId); else locateTaskOnHome(taskId, navigate, { sessionId });
      return;
    }
    const rerooting = view === 'files' && fileViewTarget !== null && activeView === 'files';
    setFileViewTarget(null);
    if (rerooting) return; // stay open, explorer re-roots to the session cwd
    // `next` is computed from this render's activeView (already a dependency)
    // rather than inside the updater: the side effects below are not pure, and
    // StrictMode double-invokes an updater.
    const next = activeView === view ? null : view;
    traceInteraction(next ? `view-open:${next}` : `view-close:${view}`, { sessionId });
    setActiveView(next);
    // Phone: the view is a layer under the top bar (its Back closes it), never a
    // full-screen promotion over that bar.
    // A second click on the open view's tab closes that view and stays full
    // screen, back on the chat (2026-10-27, the user: "it should make this file
    // panel disappear but not exit the full screen"); X, Esc and the backdrop
    // still leave full screen.
    if (next) { if (!isPhoneLayout()) enterFullscreen(); applyOpenCollapse(next); } else { collapseChat(false); }
  }, [enterFullscreen, fileViewTarget, activeView, applyOpenCollapse, collapseChat, inset, session?.taskId, sessionId, onLocateTask, onTaskClick, navigate]);

  // A project script from the Scripts chip: open the terminal (once) and type it there.
  // The run's id lets its result say whether it was typed (running) or never was (not run).
  type TerminalInput = { id: number; text: string; raw?: boolean; runId?: string };
  const [terminalInput, setTerminalInputState] = useState<TerminalInput | null>(null);
  const terminalInputRef = useRef<TerminalInput | null>(null);
  const setTerminalInput = useCallback((next: TerminalInput | null) => {
    const cur = terminalInputRef.current;
    if (cur?.runId && cur !== next) noteScriptDropped(sessionId, cur.runId);
    terminalInputRef.current = next;
    setTerminalInputState(next);
  }, [sessionId]);
  // The panel goes (another column took its place): a line it never typed did not run.
  useEffect(() => () => {
    const cur = terminalInputRef.current;
    if (cur?.runId) noteScriptDropped(sessionId, cur.runId);
    terminalInputRef.current = null;
  }, [sessionId]);
  const terminalInputSeq = useRef(0);
  // The phone's top-bar kebab opens the Scripts menu through this (the header is not drawn there).
  const scriptsOpenRef = useRef<((at?: { x: number; y: number }) => void) | null>(null);
  const runInTerminal = useCallback((line: string, _script?: unknown, runId?: string) => {
    setTerminalInput({ id: ++terminalInputSeq.current, text: line, ...(runId ? { runId } : {}) });
    // A terminal docked under another view already shows: it takes the script there.
    if (!terminalShownRef.current) toggleView('terminal');
  }, [toggleView, setTerminalInput]);
  // Ctrl-C into the terminal: the Scripts menu stops a script still running before it runs another.
  const interruptTerminal = useCallback(() => {
    const id = ++terminalInputSeq.current;
    setTerminalInput({ id, text: '\x03', raw: true });
    if (!terminalShownRef.current) toggleView('terminal');
    return () => { if (terminalInputRef.current?.id === id) setTerminalInput(null); };
  }, [toggleView, setTerminalInput]);
  const terminalInputSent = useCallback((id: number) => {
    const cur = terminalInputRef.current;
    if (cur?.id !== id) return;
    if (cur.runId) noteScriptTyped(sessionId, cur.runId);
    terminalInputRef.current = null;
    setTerminalInputState(null);
  }, [sessionId]);
  const terminalShownRef = useRef(false);
  // An open Board whose task stops leading (its last open subtask finished and it
  // keeps no Board of its own, or the Board was deleted) closes back to the chat
  // instead of leaving an empty pane behind a tab that is gone.
  useEffect(() => {
    if (activeView !== 'board' || boardTab !== 'hidden' || !session?.taskId) return;
    log.info('session-panel', 'board view closed: the task no longer leads', { sessionId, taskId: session?.taskId ?? '' });
    toggleView('board');
  }, [activeView, boardTab, toggleView, sessionId, session?.taskId]);
  // Keep-alive for the Code view: once opened, it stays MOUNTED (css-hidden)
  // for the panel's lifetime. Unmounting destroys the iframe, and remounting
  // reboots the whole VS Code workbench (seconds, worse over a tunnel) — the
  // "switching back takes forever" report. display:none does not reload an
  // iframe; moving it in the DOM does, so the hidden container never moves.
  const [codeViewMounted, setCodeViewMounted] = useState(false);
  useEffect(() => {
    if (activeView === 'code') setCodeViewMounted(true);
  }, [activeView]);
  // ...but not FOREVER. display:none drops the iframe's renderer, not the VS
  // Code document inside it: its editor/terminal scrollers keep their tiled
  // compositing layers (measured in the system WKWebView at 2500×1400@2x:
  // +180MB of IOSurfaces per hidden workbench that never came back). A day of
  // columns that each once opened Code is how the Mac app's WebContent reached
  // 2.7GB of layer memory and 17s main-thread freezes on a swapping machine.
  // Keep the fast switch-back for a working session; release a workbench
  // nobody has looked at for a while (reopening reboots it, seconds).
  useEffect(() => {
    if (!codeViewMounted || activeView === 'code') return;
    const timer = setTimeout(() => {
      setCodeViewMounted(false);
      log.info('session-panel', 'code view released after idle', { sessionId, idleMs: CODE_VIEW_HIDDEN_TTL_MS });
    }, CODE_VIEW_HIDDEN_TTL_MS);
    return () => clearTimeout(timer);
  }, [codeViewMounted, activeView, sessionId]);
  // Clicking a file path in the chat opens it in the SAME split layout as
  // Changed/Files/Terminal — file explorer + preview on the left, the live chat
  // in the resizable right column (replaces the old full-screen FileViewer modal).
  // EVERY file type goes here, vault notes included: a click must never navigate
  // the app away from the session (that jump was reverted 2026-08-09). Notes get
  // an explicit "Open in Notes" button in the preview toolbar / right-click menu.
  // `endLine`: the last line of a range reference (`x.go:31-34`), flashed with `line`.
  // The path is looked up first (useClickedPathOpener): a session on one host often
  // names a file on another, which then opens from the host that has it.
  const openLocatedFile = useCallback((t: ClickedPathTarget) => {
    traceInteraction('view-open:files-from-path', { sessionId });
    const { path, line, endLine, term } = t;
    // A nested column has no Files split: the file opens in a tab of its own (the
    // preview's own "Open in new tab"), so the Board and this chat stay put.
    if (inset) { openPopout('file', { path, host: t.host, line, endLine }); return; }
    // A new nonce every time: the same path again still lands on it (the explorer
    // resets on it) after the reader browsed to another file in the tree.
    setFileViewTarget((prev) => t.missing
      ? { path: session?.cwd ?? '~', nonce: (prev?.nonce ?? 0) + 1, missing: missingPathLine(path, t.missing.checked) }
      : { path, line, endLine, term, nonce: (prev?.nonce ?? 0) + 1, ...(t.elsewhere ? { onHost: { host: t.host } } : {}) });
    setActiveView('files');
    // Phone: the view is a layer under the top bar (its Back closes it), never a full-screen sheet over that bar.
    if (!isPhoneLayout()) enterFullscreen();
  }, [enterFullscreen, inset, session?.cwd, sessionId, setActiveView, setFileViewTarget]);
  const handleFileOpen = useClickedPathOpener(openLocatedFile, { host: session?.host ?? undefined, cwd: session?.cwd ?? undefined, sessionId });
  openDocRef.current = (path) => handleFileOpen(path);
  // A path clicked in the terminal opens in Files with the terminal docked under
  // it, so the output that named the file stays in view (one frame: no reconnect).
  const terminalOnPhone = usePhoneLayout();
  const terminalDockAllowed = !inset && !terminalOnPhone;
  // A path no host has (a typo, a file the command has not written yet) says so
  // in the terminal and leaves the view as it was.
  const [terminalPathMissing, setTerminalPathMissing] = useState<{ text: string; nonce: number } | null>(null);
  // The height the docked terminals need (stacked panes): the dock grows to it.
  const [terminalWantPx, setTerminalWantPx] = useState(0);
  // The next places to try for a relative path when the one tried is missing
  // (the shell's directory, its repository root, the session's directory).
  const terminalFallback = useRef<string[]>([]);
  // The path as the terminal printed it: the missing note names it (the places tried were several).
  const terminalPrinted = useRef<string | null>(null);
  const openTerminalPathRef = useRef<(path: string, line?: number) => void>(() => {});
  const openTerminalTarget = useCallback((t: ClickedPathTarget) => {
    const next = terminalFallback.current.shift();
    if (t.missing && next) { openTerminalPathRef.current(next, t.line); return; }
    terminalFallback.current = [];
    if (t.missing) {
      const text = missingPathLine(terminalPrinted.current ?? t.path, t.missing.checked);
      setTerminalPathMissing((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }));
      return;
    }
    setTerminalPathMissing(null);
    if (terminalDockAllowed) setTerminalDock((d) => (d.on ? d : { ...d, on: true }));
    openLocatedFile(t);
  }, [openLocatedFile, setTerminalDock, terminalDockAllowed]);
  const openTerminalPath = useClickedPathOpener(openTerminalTarget, { host: session?.host ?? undefined, cwd: session?.cwd ?? undefined, sessionId });
  openTerminalPathRef.current = openTerminalPath;
  const handleTerminalPath = useCallback((link: TerminalPathLink) => {
    traceInteraction('view-open:files-from-terminal', { sessionId });
    terminalFallback.current = [...(link.fallbackPaths ?? [])];
    terminalPrinted.current = link.printed ?? null;
    openTerminalPath(link.path, link.line);
  }, [openTerminalPath, sessionId]);
  // The terminal docked under Changed / Files / Web: the dock remembers the view
  // it was last under, so "Show with Changed" from the Terminal view goes back there.
  const lastDockView = useRef<SessionSplitView>('changed');
  if (activeView && TERMINAL_DOCK_VIEWS.includes(activeView)) lastDockView.current = activeView;
  const dockViewLabel = DOCK_VIEW_LABEL[lastDockView.current] ?? 'Changed';
  const dockTerminal = useCallback(() => {
    const view = lastDockView.current;
    traceInteraction('terminal-dock:on', { sessionId, view });
    setTerminalDock((d) => ({ ...d, on: true }));
    setActiveView(view);
    applyOpenCollapse(view);
  }, [applyOpenCollapse, sessionId, setActiveView, setTerminalDock]);
  const undockTerminal = useCallback(() => {
    traceInteraction('terminal-dock:off', { sessionId });
    setTerminalDock((d) => ({ ...d, on: false }));
  }, [sessionId, setTerminalDock]);
  const maximizeTerminal = useCallback(() => {
    traceInteraction('view-open:terminal', { sessionId });
    setActiveView('terminal');
    applyOpenCollapse('terminal');
  }, [applyOpenCollapse, sessionId, setActiveView]);
  const resizeTerminalDock = useCallback((px: number) => setTerminalDock((d) => ({ ...d, px })), [setTerminalDock]);
  const terminalDocked = terminalOffered && terminalDockAllowed && terminalDock.on && !!activeView && TERMINAL_DOCK_VIEWS.includes(activeView);
  const terminalShown = activeView === 'terminal' || terminalDocked;
  terminalShownRef.current = terminalShown;
  // A script that could not be typed (the terminal closed, or never connected
  // within a minute) is dropped: it must not run by surprise when it opens later.
  // Its result says it did not run; so does one whose page closed first (script-results.ts).
  const terminalWasOpen = useRef(false);
  useEffect(() => {
    const open = terminalShown;
    const closed = terminalWasOpen.current && !open;
    terminalWasOpen.current = open;
    if (!terminalInput) return;
    if (closed) { setTerminalInput(null); return; }
    const id = terminalInput.id;
    const timer = setTimeout(() => { if (terminalInputRef.current?.id === id) setTerminalInput(null); }, 60_000);
    return () => clearTimeout(timer);
  }, [terminalInput, terminalShown, setTerminalInput]);

  // A host:port service the session started (a dev server, a report page) opens
  // in the Web split view instead of a browser tab: remote ports come through an
  // SSH forward the server sets up, so "localhost:8080 on the dev box" just works.
  // The request carries a nonce so clicking the same link again reloads it.
  const openWebView = useCallback((url: string) => {
    traceInteraction('view-open:web-from-link', { sessionId });
    setFileViewTarget(null);
    setWebRequest((prev) => ({ url, nonce: (prev?.nonce ?? 0) + 1 }));
    setActiveView('web');
    applyOpenCollapse('web');
    // Phone: the view is a layer under the top bar (its Back closes it), as toggleView opens one.
    if (!isPhoneLayout()) enterFullscreen();
    log.info('session-web', 'service link opened in panel', { sessionId, url });
  }, [enterFullscreen, applyOpenCollapse, sessionId, setActiveView, setFileViewTarget, setWebRequest]);
  useEffect(() => { primeKnownServiceHosts(); }, []);
  // The servers this session started, listed in the Web view: asked only while it is open.
  // Slowly while the panel shows (the menu's count starts from it), every few seconds in the Web view.
  const webServers = useSessionServers(sessionId, { enabled: !inset, fast: activeView === 'web' });
  // The task's tabs in the person's browser, read once for the header pill and the phone's.
  const browserView = useBrowserView(!inset && !plainChat ? session?.taskId : undefined);
  // The page the Web view shows, by its port: the title row's server card marks it.
  const webShownPort = activeView === 'web' && webRequest?.url ? activeLocalPort(webRequest.url) : null;
  // Click delegation for the whole chat column: any rendered anchor (markdown
  // autolink, model-written HTML, tool output) whose href is a service. A plain
  // web link, a modified click (⌘/Ctrl/Shift/middle = "give me a real tab"), or a
  // click something inside already handled keeps the browser's own behavior.
  const handleServiceLinkClick = useCallback((e: ReactMouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    // An inset panel has no Web split, and a link in a task opened beside the
    // Board is that task's (its host), never this panel's: both keep the browser's own.
    if (inset || (e.target as HTMLElement).closest?.('.board-task-peek')) return;
    const anchor = (e.target as HTMLElement).closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor || anchor.hasAttribute('data-native-link')) return;
    if (!consoleCanEmbedServices()) return;
    const url = classifyServiceHref(anchor.getAttribute('href') ?? '', {
      sessionHost: session?.host,
      sessionHostname: session?.hostname,
    });
    if (!url) return;
    e.preventDefault();
    openWebView(url);
  }, [openWebView, session?.host, session?.hostname, inset]);

  // "Engine settings" row in the composer's "+" menu and the popover it opens;
  // ChatInput only renders the generic action row, this hook owns the feature.
  const engineSettingsEntry = useEngineSettingsEntry({ sessionId, session, engineUi, onOpenPath: handleFileOpen });
  // "Snooze until something happens…" leads the root composer's "+" menu actions:
  // it starts the message, the user says what the task waits for, and this
  // session's AI sets the trigger up (utils/wait-until.ts). Not on a question page, whose composer
  // posts into the question rather than to the session's task.
  const onQuestionPage = !!threads.composerPlaceholder;
  // "Add a trigger…": a plugin's ready-made trigger armed here, or words for this session's AI.
  const prefillLead = useCallback((text: string) => {
    setPrefillText(text);
    setPrefillMode('keep-draft');
    setPrefillNonce((n) => n + 1);
  }, []);
  const triggerPicker = useTriggerPickerEntry({
    sessionId, taskId: session?.taskId, acp: engineIsAcp, enabled: !onQuestionPage, onPrefill: prefillLead,
  });
  // "Latest update": the session's recap (Overall / Latest), on demand instead of
  // a card above the composer. It leads the list: it is about this session, not an action.
  const latestUpdate = useLatestUpdateEntry({ sessionId, session });
  const transferAvailable = useCanOpenTransfer();
  const composerPlusActions = useMemo<PlusMenuAction[] | undefined>(() => {
    const lead = latestUpdate.action ? [latestUpdate.action] : [];
    // "Transfer harness/host…" sits under "Engine settings": both are about where this work runs.
    const transfer = transferAvailable ? transferPlusAction(session?.taskId) : null;
    const rest = [
      ...(triggerPicker.action ? [triggerPicker.action] : []),
      ...(engineSettingsEntry.plusMenuActions ?? []),
      ...(transfer ? [transfer] : []),
    ];
    if (!session?.taskId || onQuestionPage) {
      const own = engineSettingsEntry.plusMenuActions;
      return lead.length || own ? [...lead, ...(own ?? [])] : undefined;
    }
    const waitUntil: PlusMenuAction = {
      id: 'wait-until',
      label: WAIT_UNTIL_LABEL,
      title: WAIT_UNTIL_TITLE,
      icon: WAIT_UNTIL_ICON,
      onSelect: () => {
        if (startsWithWaitUntil(composerTextRef.current)) {
          setComposerFocusNonce((n) => n + 1);
          return;
        }
        setPrefillText(waitUntilPrefix({ acp: engineIsAcp }));
        setPrefillMode('keep-draft');
        setPrefillNonce((n) => n + 1);
      },
    };
    return [...lead, waitUntil, ...rest];
  }, [engineSettingsEntry.plusMenuActions, triggerPicker.action, latestUpdate.action, session?.taskId, onQuestionPage, engineIsAcp, transferAvailable]);

  // Open the Inbox tab (optionally on one letter) — the arrival half of the
  // `/sessions?id=…&tab=inbox&letter=…` deep link.
  //
  // The split engages only when there is room for both columns: a letter needs
  // real width to read, and the chat column has a 280px floor, so a narrow
  // window lands on the letter alone (its show-chat toggle sits in the bar).
  const openInboxTab = useCallback((letterId?: string) => {
    setFileViewTarget(null);
    setInboxLetterId(letterId ?? null);
    setActiveView('inbox');
    applyOpenCollapse('inbox');
    enterFullscreen();
    log.info('inbox', 'session inbox tab opened', { sessionId, letterId: letterId ?? '' });
  }, [enterFullscreen, sessionId, applyOpenCollapse]);

  // A path inside a letter opens where every other path in a session opens: the
  // panel's Files split. A letter must not be the one surface that pops a modal.
  const letterFileSeq = useRef(0);
  useLayoutEffect(() => () => { letterFileSeq.current++; }, [sessionId, session?.host, inboxLetterId, activeView]);
  const handleLetterFileOpen = useCallback((target: { path: string; line?: number; endLine?: number; host?: string; sourceOnly?: boolean }) => {
    const mine = ++letterFileSeq.current;
    void locateClickedPath(target.path, { host: target.host, sourceOnly: target.sourceOnly }, target).then((located) => {
      if (mine !== letterFileSeq.current) return;
      const panelHost = session?.host && !['local', '__local__'].includes(session.host) ? session.host : undefined;
      openLocatedFile({ ...located, elsewhere: located.host !== panelHost });
    });
  }, [session?.host, openLocatedFile]);
  // planPopoverRef removed — modal uses backdrop click

  // Auto-refresh plan content when modal opens
  useEffect(() => {
    if (planPopoverOpen && shouldFetchPlan) {
      planRefresh();
    }
  }, [planPopoverOpen, shouldFetchPlan, planRefresh]);

  // Close plan modal on Escape
  useEffect(() => {
    if (!planPopoverOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPlanPopoverOpen(false);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [planPopoverOpen]);

  // Listen for PlanCard expand → open the same plan modal
  useEffect(() => {
    const handler = () => setPlanPopoverOpen(true);
    window.addEventListener('open-plan-modal', handler);
    return () => window.removeEventListener('open-plan-modal', handler);
  }, []);

  // Reset execute state when session changes. The split view, its file, service
  // and letter, and full screen are kept per place, and the place names the
  // session: the next session shows its own (a service URL belongs to the session
  // that printed it, whose host decides where the tunnel goes).
  // Full screen and the view are the place's: a panel that moves on to another
  // session (or remounts on one, as the hosts keyed by session do) shows that
  // session's, and the one it left is there again on the way back, until the user
  // leaves full screen, enters it elsewhere or opens a column on Home.
  useEffect(() => {
    setExecuting(false);
    setExecuteError(null);
    setExecuteStarted(false);
    setPlanPopoverOpen(false);
    setNotesOpen(false);
    setMessagesOpen(false);
  }, [sessionId]);
  // The place this panel shows changed (another session, another page of a
  // plugin): the chat comes back as the user left it there, and a view kept
  // there decides the chat's fate the way opening it did. Also on mount.
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (restoredFor.current === sheetAt) return;
    const first = restoredFor.current === null;
    restoredFor.current = sheetAt;
    if (!first) { autoCollapsed.current = false; setChatCollapsed(chatHiddenRef.current); }
    if (activeView && !chatHiddenRef.current) applyOpenCollapse(activeView);
  }, [sheetAt, activeView, applyOpenCollapse]);
  // The Changed view's panel can settle at its size after the view opened (full screen
  // lands a frame later, the window is resized): it gets the same rule as it opens.
  // Read as state, so a window crossing into or out of the phone layout runs it again.
  const changedOnPhone = usePhoneLayout();
  useEffect(() => {
    if (activeView !== 'changed' || chatCollapsed || changedOnPhone) return;
    const split = panelRef.current?.querySelector<HTMLElement>('.session-panel-split');
    if (!split || typeof ResizeObserver === 'undefined') return;
    const check = () => {
      if (changedChatRevealed.current || chatHiddenRef.current) return;
      if (changedPaneWidthWithChat() >= CHANGED_COLLAPSE_CHAT_BELOW) return;
      autoCollapsed.current = true;
      setChatCollapsed(true);
      log.info('session-panel', 'changed collapsed the chat (too narrow)', { sessionId, width: split.clientWidth });
    };
    // Collapsed on the next frame, never inside the observer's own callback: a layout change
    // there leaves its notifications undelivered (WebKit reports that as a page error).
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(check);
    });
    ro.observe(split);
    return () => { ro.disconnect(); cancelAnimationFrame(frame); };
  }, [activeView, chatCollapsed, changedOnPhone, changedPaneWidthWithChat, sessionId]);
  // The chat the user hid is kept with the view; one the window hid is not.
  // Written only when it moved while the same place showed: a move to another
  // place restores that place's, it never writes this one's onto it.
  const { setChatHidden } = panelView;
  const lastChat = useRef({ at: sheetAt, collapsed: chatCollapsed });
  useEffect(() => {
    const last = lastChat.current;
    lastChat.current = { at: sheetAt, collapsed: chatCollapsed };
    if (last.at !== sheetAt || last.collapsed === chatCollapsed) return;
    setChatHidden(chatCollapsed && !autoCollapsed.current);
  }, [chatCollapsed, sheetAt, setChatHidden]);

  // ── Inbox deep link (`/sessions?id=…&tab=inbox&letter=…`) ──
  // Two arrival paths, because the panel that must react usually does not exist
  // yet when the link is followed: a MOUNTED panel hears the event, a freshly
  // mounted one claims the parked request (session-inbox-link.ts). Declared AFTER
  // the reset effect above deliberately — effects run in declaration order, so a
  // link claimed before the reset would be wiped by it on the same commit.
  //
  // The claim is REMEMBERED per session id, not applied once. Claiming empties the
  // mailbox, but the reset effect above runs AGAIN on any effect replay — React
  // StrictMode double-invokes a newly mounted subtree's effects in dev, and a
  // remount does the same in any build — and its second pass set activeView back
  // to null with the park already gone, so the deep link landed on a plain session
  // column with no tab and no fullscreen. Re-applying from the ref makes the
  // arrival idempotent instead of order-critical.
  const claimedInboxLink = useRef<{ sid: string; letterId?: string; at: number } | null>(null);
  useEffect(() => {
    // An inset panel has no Inbox tab: the link is the session's own column's to claim.
    if (inset) return;
    const remembered = claimedInboxLink.current?.sid === sessionId
      ? claimedInboxLink.current : null;
    const claimed = consumeSessionInboxLink(sessionId) ?? remembered;
    if (claimed) {
      claimedInboxLink.current = {
        sid: sessionId, at: Date.now(), ...(claimed.letterId ? { letterId: claimed.letterId } : {}),
      };
      openInboxTab(claimed.letterId);
    }
    const onLink = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string; letterId?: string }>).detail;
      if (!detail || detail.sessionId !== sessionId) return;
      consumeSessionInboxLink(sessionId); // claim it so a later mount can't re-pop
      claimedInboxLink.current = {
        sid: sessionId, at: Date.now(), ...(detail.letterId ? { letterId: detail.letterId } : {}),
      };
      openInboxTab(detail.letterId);
    };
    window.addEventListener(SESSION_INBOX_LINK_EVENT, onLink);
    return () => window.removeEventListener(SESSION_INBOX_LINK_EVENT, onLink);
  }, [sessionId, openInboxTab, inset]);
  // The host's own request: applied on each new value, and again on an effect replay (StrictMode,
  // a remount), which has just run the reset above. openInboxTab is read from a ref because it
  // changes with the chat's width, and a resize is no request.
  const openInboxTabRef = useRef(openInboxTab);
  openInboxTabRef.current = openInboxTab;
  useEffect(() => {
    if (!inboxRequest || inset) return;
    openInboxTabRef.current();
  }, [inboxRequest, inset]);

  // If the user exits fullscreen (ESC / backdrop, or the `fullscreen:yield` that
  // opening another column fires — useFullscreen.tsx) while a split view is open,
  // close it too so the body returns to the normal single-column chat. The yield
  // and an Inbox deep link for THIS panel can arrive in one tick; open-session.ts
  // orders them so the batch never commits with fullscreen off and the tab open,
  // which is the only way this guard would eat a view a link just asked for.
  //
  // A link followed from another page no longer needs a re-assert here: this
  // panel's full screen survives a route change (useFullscreen keepAcrossRoutes),
  // so the router catching up with the URL is not an exit any more.
  useEffect(() => {
    // A phone never promotes a view to fullscreen: there the view is a layer,
    // and its Back is what closes it. A second panel of the same place (the one
    // full screen holds is the other) leaves the view they share alone.
    if (isFullscreen || !splitOpen || isPhoneLayout() || fullscreenPlace() === sheetAt) return;
    setActiveView(null);
    setFileViewTarget(null);
  }, [isFullscreen, splitOpen, sheetAt, setActiveView, setFileViewTarget]);

  // planCompleted=true means the plan is definitively done — show Execute even if session is still running
  // (SSH FIFO sessions stay alive after plan completion; execution creates a new session anyway).
  // For exec sessions without planCompleted, require the session to be stopped.
  const showExecuteButtons =
    (session?.planCompleted === true || (plan && !planLoading && session?.process_status !== 'running'))
    && session?.process_status !== 'error'
    && !executeStarted;

  const handleExecuteContinue = useCallback(async () => {
    setExecuting(true);
    setExecuteError(null);
    try {
      await executePlanContinue(sessionId);
      setExecuteStarted(true);
    } catch (err) {
      setExecuteError(err instanceof Error ? err.message : String(err));
    } finally {
      setExecuting(false);
    }
  }, [sessionId]);

  const handleClearContextExecute = useCallback(async () => {
    const clickedSessionId = sessionIdRef.current; // snapshot at click time
    setExecuting(true);
    setExecuteError(null);
    try {
      const result = await executePlanSession(sessionId);
      setExecuteStarted(true);
      // Only navigate if user is still viewing the same session
      if (result.sessionId && sessionIdRef.current === clickedSessionId) {
        onSessionReplaced?.(sessionId, result.sessionId);
      }
    } catch (err) {
      setExecuteError(err instanceof Error ? err.message : String(err));
    } finally {
      setExecuting(false);
    }
  }, [sessionId, onSessionReplaced]);

  // Retry — resume path: session auto-recovers via WS status events, nothing to do.
  // Retry — fallback path: listen for task:updated to detect new session linked after retry.
  const retryTaskIdRef = useRef<string | null>(null);
  const handleResuming = useCallback(() => {
    // processNext() emits SESSION_STATUS_CHANGED which updates session state.
    // Error banner clears automatically when errorMessage is cleared.
  }, []);
  const handleRetried = useCallback((taskId: string) => {
    retryTaskIdRef.current = taskId;
  }, []);
  const reloadRecord = useCallback(() => {
    fetchSession(sessionId).then((s) => { if (s) setSession(s); }).catch(() => {});
  }, [sessionId]);
  // Its folder was gone and it moved (FolderGoneBanner): the same session reads its new
  // record; a new conversation for the task takes over the way a retry's fresh start does.
  const handleFolderMoved = useCallback((result: ContinueInNewFolderResult) => {
    if (result.status === 'started') handleRetried(result.taskId);
    fetchSession(sessionId).then((s) => { if (s) setSession(s); }).catch(() => {});
  }, [sessionId, handleRetried]);

  // Opening a session that sits in 'error' re-checks its host immediately.
  // A record can stay frozen on a stale "unable to reach remote host" for hours
  // after the tunnel came back (2026-09-03: two hours, while that same host's
  // files opened fine in the Files tab). The server-side recheck sends nothing to
  // the session and converges the record from the daemon's own snapshot, so the
  // normal session:status-changed event is what updates this UI — there is no
  // parallel status path here. Non-blocking: no spinner over the panel, the
  // content stays interactive, only the banner sentence changes.
  // `for` stamps which session the answer belongs to: this panel can be handed a
  // different sessionId without remounting (prefix adoption, fork replacement),
  // and a previous session's verdict must never label the new one's banner.
  const [recheck, setRecheck] = useState<{
    for: string;
    phase: 'idle' | 'checking' | 'done';
    reachable?: boolean;
    infraClaim?: boolean;
  }>({ for: sessionId, phase: 'idle' });
  const inErrorState = session?.process_status === 'error';
  useEffect(() => {
    if (!inErrorState) return;
    if (!claimRecheckSlot(sessionId)) return;
    let cancelled = false;
    setRecheck({ for: sessionId, phase: 'checking' });
    log.info('session-panel', 'session opened in error — rechecking host connectivity', { sessionId });
    recheckSession(sessionId).then((r) => {
      if (cancelled) return;
      setRecheck({ for: sessionId, phase: 'done', reachable: r.reachable, infraClaim: r.infraClaim });
      log.info('session-panel', 'session recheck answered', {
        sessionId,
        checked: r.checked,
        reachable: r.reachable,
        alive: r.alive ?? null,
        processStatus: r.processStatus,
        reason: r.reason ?? null,
      });
    }).catch((err) => {
      if (cancelled) return;
      setRecheck({ for: sessionId, phase: 'idle' });
      log.warn('session-panel', 'session recheck failed', {
        sessionId, error: err instanceof Error ? err.message : String(err),
      });
    });
    return () => { cancelled = true; };
  }, [sessionId, inErrorState]);
  const [restartBusy, setRestartBusy] = useState(false);
  const handleRestart = useCallback(async () => {
    log.info('session-panel', 'restart button clicked', { sessionId });
    setRestartBusy(true);
    try {
      const result = await restartSession(sessionId);
      log.info('session-panel', 'restart API returned', { sessionId, result });
    } catch (err) {
      log.error('session-panel', 'restart API failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    setRestartBusy(false);
  }, [sessionId]);

  const handleOpenVscodeError = useCallback((error: unknown) => {
    notify({
      kind: 'operation-error',
      severity: 'error',
      title: 'Could not open VS Code',
      body: error instanceof Error ? error.message : String(error),
      persistent: false,
      dedupKey: `session-vscode:${sessionId}:${Date.now()}`,
      sessionId,
    });
  }, [notify, sessionId]);

  const supervisionSnapshot = useSessionSupervision(sessionId);
  const [cronDetailOpen, setCronDetailOpen] = useState(false);
  useEffect(() => { setCronDetailOpen(false); }, [sessionId]);
  const terminateBusy = supervisionSnapshot.writing;
  const handleTerminate = useCallback(async () => {
    log.info('session-panel', 'terminate button clicked', { sessionId });
    try {
      await stopSupervisedSession(sessionId);
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 409) {
        const proceed = await confirmDialog({
          title: 'Stop session and automatic recovery?',
          message: 'This stops the CLI and disables automatic recovery. Session-only crons stop with it. Directory-shared durable crons may still run in another session; stopping this session does not delete those jobs.',
          confirmLabel: 'Stop session',
          cancelLabel: 'Keep running',
          danger: true,
        });
        if (proceed) {
          try {
            await stopSupervisedSession(sessionId, true);
          } catch (err2) {
            log.error('session-panel', 'forced terminate API failed', {
              sessionId,
              error: err2 instanceof Error ? err2.message : String(err2),
            });
          }
        }
      } else {
        log.error('session-panel', 'terminate API failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }, [sessionId, confirmDialog]);

  // Investigate — freeze an evidence bundle + open a manual incident, then copy
  // every id (session/task/incident/bundle/host) to the clipboard so the human
  // can paste them into a debug session. The chip confirms inline; the timer is
  // cleaned up on unmount / session change.
  const [investigating, setInvestigating] = useState(false);
  const [investigateResult, setInvestigateResult] = useState<{ kind: 'ok'; id: string } | { kind: 'error' } | null>(null);
  const investigateTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => { clearTimeout(investigateTimerRef.current); }, []);
  const handleInvestigate = useCallback(async () => {
    if (investigating) return;
    log.info('session-panel', 'investigate button clicked', { sessionId, taskId: session?.taskId });
    setInvestigating(true);
    setInvestigateResult(null);
    // Kick off capture, then hand the PENDING text promise to the clipboard
    // synchronously — Safari/WKWebView reject a write issued after the await
    // (user-gesture expired), which silently dropped the copy there.
    const capture = investigateSession(sessionId, session?.taskId);
    const clipPromise = capture.then(({ incident }) => buildInvestigationClip({
      sessionId,
      taskId: session?.taskId,
      incidentId: incident.id,
      bundlePath: incident.bundlePath,
      host: session?.host,
    }));
    const copyDone = copyTextDeferred(clipPromise).catch(() => 'failed' as const);
    try {
      const { incident } = await capture;
      log.info('session-panel', 'investigate captured evidence', { sessionId, incidentId: incident.id, bundlePath: incident.bundlePath });
      const copyResult = await copyDone;
      if (copyResult === 'failed') log.warn('session-panel', 'investigate clipboard copy failed', { sessionId, incidentId: incident.id });
      setInvestigateResult({ kind: 'ok', id: incident.id });
      clearTimeout(investigateTimerRef.current);
      investigateTimerRef.current = setTimeout(() => setInvestigateResult(null), 6000);
    } catch (err) {
      log.error('session-panel', 'investigate failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      setInvestigateResult({ kind: 'error' });
      clearTimeout(investigateTimerRef.current);
      investigateTimerRef.current = setTimeout(() => setInvestigateResult(null), 4000);
    } finally {
      setInvestigating(false);
    }
  }, [investigating, sessionId, session?.taskId, session?.host]);
  useEvent('task:updated', (data: unknown) => {
    const d = data as { task?: { id?: string; exec_session_id?: string; plan_session_id?: string } };
    const t = d.task;
    if (!t?.id || !retryTaskIdRef.current || t.id !== retryTaskIdRef.current) return;
    const newSessionId = t.exec_session_id ?? t.plan_session_id;
    if (newSessionId) {
      retryTaskIdRef.current = null;
      onSessionReplaced?.(sessionId, newSessionId);
    }
  });

  /** One send path for the composer. The question wiring (pre-assigned uuid,
   *  anchor + meta in ONE PATCH, the orientation line) is usePanelThreads'. */
  const threadSend = threads.sendAnchored;
  const sendAnchored = useCallback(async (
    message: string, images: ImageAttachment[] | undefined, interrupt: boolean, targetKey?: string,
  ): Promise<boolean> => {
    // A passage the quote pill held through dictation has served its purpose once
    // the user sends.
    releaseSelectionHold(panelRef.current);
    return threadSend(message, images, interrupt, targetKey);
  }, [threadSend]);

  // Every send goes to THIS session. An "@" reference in the text is a pill the
  // agent receives (plus a server-appended reference card); the composer never
  // routes a message to another session — that is the agent's call.
  // ONE send for a composer, the panel's or the split's left half (`targetKey`,
  // its question): an engine picked for this message starts the task's new
  // session on it, else the question wiring (usePanelThreads' sendAnchored).
  const sendFor = useCallback(async (message: string, images: ImageAttachment[] | undefined, targetKey?: string) => {
    const switchOpts = engineSwitch.sendOptions;
    if (switchOpts) {
      const ok = await send(sessionId, message, images, switchOpts);
      if (ok) { engineSwitch.markSent(); engineSwitch.clear(); }
      return ok;
    }
    return sendAnchored(message, images, false, targetKey);
  }, [sendAnchored, send, sessionId, engineSwitch.sendOptions, engineSwitch.clear, engineSwitch.markSent]);
  // Main's quick actions ride its own composer's "+" (the user, 2026-10-26: not a bar of their own).
  // Waiting = deriveDisplayStatus's rule (a live process holds the prompt); a stopped
  // Main with a stale prompt on its record takes a typed message, so it takes these too.
  const promptOpen = (session?.process_status === 'running' || session?.process_status === 'idle') && !!pendingPermission;
  // A person's message answers a Claude prompt with Deny (the server's closesPrompt rule).
  const promptWarning = promptOpen && (session?.engine ?? 'claude') === 'claude'
    ? (pendingPermission?.toolName === 'AskUserQuestion' ? 'Sending a message dismisses the open question' : 'Sending a message denies the open prompt')
    : null;
  const deniedPromptId = promptWarning ? (pendingPermission && 'requestId' in pendingPermission ? pendingPermission.requestId : undefined) : undefined;
  const handleSend = useCallback((message: string, images?: ImageAttachment[]) => {
    // The message denies the open prompt: its card will say so, not "Denied".
    if (deniedPromptId) markDeniedByMessage(deniedPromptId);
    return sendFor(message, images);
  }, [sendFor, deniedPromptId]);

  const mainQuickActions = useMainQuickPlusActions(
    onQuestionPage ? null : sessionTask,
    promptOpen,
    handleSend,
    macSessionAway ? 'Your Mac is away: sending waits until it is back.' : undefined,
  );
  // Compact without typing /compact: a "+" row. Not on a question page or with an engine switch
  // picked: there the next message goes elsewhere.
  const compactHistoryFacts = useMemo(
    () => (historyLoading ? undefined : factsFromHistory(historyMessages)),
    [historyLoading, historyMessages],
  );
  // Walnut's own idle compaction is quiet: the composer stays as it was (a send, never a Stop), and a
  // message typed meanwhile goes out after it (the CLI runs it as its own turn).
  const idleCompacting = useIdleCompacting(sessionId);
  const composerStreaming = isStreaming && !idleCompacting;
  const compactContext = useCompactContext({
    sessionId: onQuestionPage || engineSwitch.pick ? undefined : sessionId,
    session,
    acp: engineIsAcp,
    running: isStreaming || session?.process_status === 'running',
    idleCompacting,
    send: handleSend,
    historyFacts: compactHistoryFacts,
  });
  const plusActions = useMemo(() => {
    const base = mainQuickActions.length ? [...(composerPlusActions ?? []), ...mainQuickActions] : composerPlusActions;
    const compactRow = compactContext.plusAction;
    return compactRow && !onQuestionPage && !engineSwitch.pick ? [...(base ?? []), compactRow] : base;
  }, [composerPlusActions, mainQuickActions, compactContext.plusAction, onQuestionPage, engineSwitch.pick]);

  // An html-app island's "Send to AI" (island-host.ts): the session's own send, never
  // anchored to a side thread the composer may have open.
  const islandHost = useMemo<IslandHost>(() => ({
    sessionId,
    sendResult: (text: string) => send(sessionId, text),
  }), [sessionId, send]);

  const handleInterruptSendRaw = useCallback((message: string, images?: ImageAttachment[]) => {
    return sendAnchored(message, images, true);
  }, [sendAnchored]);

  // The main composer's sends carry the pending quotes and comments: each quote with
  // its comment, in the order added, ahead of the typed words. Only an ACCEPTED send
  // turns them into marks; a refused one leaves them pending for the next try.
  // The send CLAIMS them at once, so a second send before this one is accepted
  // cannot carry them again. A slash command is a command, not a message: it goes
  // as typed and the comments wait.
  // Tree Mode: each page's composer carries only the comments made on that page
  // (`pageOf` names it at send time; null outside Tree Mode: all of them).
  const claimComments = commentsStore.claim;
  const settleComments = commentsStore.settle;
  const commentPageOfRef = useRef(commentPageOf);
  commentPageOfRef.current = commentPageOf;
  const withComments = useCallback((
    sendFn: (message: string, images?: ImageAttachment[]) => Promise<boolean>,
    pageOf: () => string | null,
  ) => async (message: string, images?: ImageAttachment[]): Promise<boolean> => {
    if (message.trimStart().startsWith('/')) return sendFn(message, images);
    const page = pageOf();
    const carried = claimComments(page === null ? undefined : (c) => commentPageOfRef.current(c) === page);
    if (carried.length === 0) return sendFn(message, images);
    const ids = carried.map((c) => c.id);
    log.info('session-panel', 'sending with passage comments', { sessionId, count: carried.length, page: page === null ? null : page === ROOT_THREAD_KEY ? 'main' : 'question' });
    let ok = false;
    try {
      ok = await sendFn(composeWithComments(carried, message), images);
    } finally {
      settleComments(ids, ok);
    }
    return ok;
  }, [sessionId, claimComments, settleComments]);
  const ownCommentPage = useCallback(() => (treeModeRef.current ? threadsForInsert.current.stack.api.currentKey : null), []);
  const handleComposerSend = useMemo(() => withComments(handleSend, ownCommentPage), [withComments, handleSend, ownCommentPage]);
  const handleInterruptSend = useMemo(() => withComments(handleInterruptSendRaw, ownCommentPage), [withComments, handleInterruptSendRaw, ownCommentPage]);
  // A page left of the panel's own: the same rules into ITS question.
  const sideSend = useCallback((key: string, message: string, images?: ImageAttachment[]) => (
    withComments((m, im) => sendFor(m, im, key), () => key)(message, images)
  ), [withComments, sendFor]);
  const sideInterruptSend = useCallback((key: string, message: string, images?: ImageAttachment[]) => (
    withComments((m, im) => sendAnchored(m, im, true, key), () => key)(message, images)
  ), [withComments, sendAnchored]);

  const handleStopTurn = useCallback(() => {
    void stopTurn(sessionId);
  }, [sessionId, stopTurn]);

  const handleEdit = useCallback((queueId: string, newText: string) => {
    handleEditQueued(sessionId, queueId, newText);
  }, [sessionId, handleEditQueued]);

  const handleDelete = useCallback((queueId: string) => {
    handleDeleteQueued(sessionId, queueId);
  }, [sessionId, handleDeleteQueued]);

  const handleRetry = useCallback((queueId: string) => {
    retryFailed(queueId, sessionId);
  }, [sessionId, retryFailed]);

  // The chat column's box: its width beside a view, and Tree Mode's page count
  // (tree-split.css lays the pages out by it).
  const chatColWidth = splitOpen && !chatCollapsed ? chatPanel.width : undefined;
  const treePanes = treeLeftShown ? treeSplit.paneKeys.length : treeGrid ? 1 : 0;
  const siblingTop = treeSibling ? siblingRows(treeSplit.siblingShare).top : undefined;
  const chatColStyle = useMemo<CSSProperties | undefined>(() => {
    if (chatColWidth === undefined && !treePanes) return undefined;
    return {
      ...(chatColWidth !== undefined ? { width: chatColWidth, flex: `0 0 ${chatColWidth}` } : {}),
      ...(treePanes ? { ['--tree-panes' as string]: String(treePanes), ['--tree-cols' as string]: paneColumns(treePanes, treeSplit.leftShare) } : {}),
      ...(siblingTop ? { ['--tree-sibling-top' as string]: siblingTop } : {}),
    } as CSSProperties;
  }, [chatColWidth, treePanes, siblingTop, treeSplit.leftShare]);
  // A move to the panel's own page while pages sit side by side: it flashes.
  useEffect(() => {
    if (!paneFocus?.flash || paneFocus.key !== threads.stack.api.currentKey || !treeGrid) return;
    bodyRef.current?.animate?.(
      [{ boxShadow: 'inset 0 0 0 2px var(--accent)' }, { boxShadow: 'inset 0 0 0 2px transparent' }],
      { duration: 700, easing: 'ease-out' },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per move
  }, [paneFocus?.n]);
  const ps = session?.process_status;
  // A continue after the usage limit just went in: its turn is starting, not ended.
  const continuingAfterLimit = useContinuingAfterLimit(session?.usageLimitContinued, ps, session?.errorMessage);
  // Phase is forwarded to SessionChatHistory for resume detection logic,
  // not for UI display in this panel.
  const taskPhase = (sessionTask?.phase ?? 'TODO') as TaskPhase;

  // The split's left half's timeline props: one object while they hold (TreeSplitLeft is memo).
  const leftHistory = useMemo(() => ({
    sessionId,
    engine: session?.engine,
    phase: taskPhase,
    initialPrompt: initialPromptText,
    sessionCwd: session?.cwd,
    sessionHost: session?.host,
    chatLane: !!session?.lane?.startsWith('chat:'),
    optimisticMessages: optimisticMsgs,
    queueSync: queueSyncProp,
    onEditQueued: handleEdit,
    onDeleteQueued: handleDelete,
    onRetryFailed: handleRetry,
    folderGoneHistory: session?.cwdGone?.history,
    onDismissFailed: dismissFailed,
    onTaskClick: chatTaskClick,
    onSessionClick,
    onFileOpen: handleFileOpen,
    onQuoteInChat: quoteInChat,
    readTimeline: timelineShare,
  }), [sessionId, session?.engine, taskPhase, initialPromptText, session?.cwd, session?.host, session?.lane, optimisticMsgs, queueSyncProp,
    handleEdit, handleDelete, handleRetry, session?.cwdGone?.history, dismissFailed, chatTaskClick, onSessionClick,
    handleFileOpen, quoteInChat, timelineShare]);

  // Shift+Tab in a composer: the session's next mode.
  const toggleSessionMode = session ? () => {
    if (engineUi.configModes) {
      const control = sessionControls.find((candidate) => candidate.id === 'mode');
      const next = nextSessionControlValue(control);
      if (control && next) void setSessionControl(control.id, next);
      return;
    }
    const cur = session.mode || 'default';
    setModeOptimistic(
      enabledModes[(enabledModes.indexOf(cur) + 1) % enabledModes.length]!,
    );
  } : undefined;
  // Tree Mode: only the main conversation's composer carries the "+" menu, the
  // mode and the model (2026-11-05, the user: "only main chat have the + the
  // bypass the model selection, other just voice and send"). On a question's page
  // the panel's own composer is the light one, and Main's page beside it, when
  // it is on screen, gets the full one.
  const ownComposerLight = treeMode && threads.stack.api.currentKey !== ROOT_THREAD_KEY;
  // Tree Mode's pages side by side: only the page a turn answers offers Stop;
  // every other page's composer sends (its message waits for the turn).
  const streamPages = useMemo(
    () => (treeGrid ? answeringPages(composerStreaming, threadsApi.derived.live) : null),
    [treeGrid, composerStreaming, threadsApi.derived.live],
  );
  const pageStreaming = (key: string): boolean => (treeGrid ? !!streamPages?.has(key) : composerStreaming);

  // Header content — prefer the linked task title; fall back to session metadata.
  const sessionFallbackTitle = session?.title || session?.description || session?.slug || null;
  const headerTitle = (session?.taskId ? taskTitle : null) || sessionFallbackTitle;
  const activityAge = isFullscreen && session?.lastActiveAt ? timeAgo(session.lastActiveAt).replace(/ ago$/, '') : '';
  const activityTimeTitle = activityAge ? `Last active: ${new Date(session!.lastActiveAt!).toLocaleString()}` : '';

  // With its writer: a from-plan session shows another session's plan.
  const planContentValue = useMemo(
    () => (plan?.content ? { content: plan.content, writerSessionId: plan.sourceSessionId || sessionId } : null),
    [plan?.content, plan?.sourceSessionId, sessionId],
  );

  // A session whose record is gone (404) still opened from a task row: the bar
  // names that task, not "Untitled session" (N29).
  const fallbackTaskTitle = useHomeTaskTitleForSession(sessionId, !!phoneLayer && !headerTitle);
  // The replaced session's title, until this session's own record names its task.
  const carriedTitle = headerTitle ? null : carriedTitles.get(sessionId) ?? null;
  shownTitle.current = headerTitle || carriedTitle;
  // The bar and the timeline agree: a card waiting in the timeline names the bar (N2-10).
  const phoneCardTool = usePendingCardTool(sessionId, !!phoneLayer);
  // The home row's task, while the record that names it is still on its way.
  const phoneEarlyTask = useStoreTask(phoneLayer && !session ? liveStatus?.taskId : null);
  // Ask Walnut embeds this panel without a phone layer; on a phone its composer
  // takes the same one-line placeholder (N2-32).
  const phoneWidth = usePhoneLayout();
  const minimize = minimizeHandler({ onMinimize, onClose, phone: phoneWidth || !!phoneLayer, viewPlace, inset: !!inset });
  // An open view is laid out by the layout it is in now, not only by the one it opened
  // in: crossing into or out of the phone layout re-decides what opening decided
  // (onViewClick): full screen on a wide window, and the chat's fate. A Board opened at
  // 1280px kept its chat beside it at 520px, covering the kanban (board-kanban-round4
  // screens, 2026-10-31). Every isPhoneLayout() read here is listed in
  // tests/web/session-panel-phone-layout-ratchet.test.ts.
  const wasPhoneWidth = useRef(phoneWidth);
  useEffect(() => {
    if (wasPhoneWidth.current === phoneWidth) return;
    wasPhoneWidth.current = phoneWidth;
    if (!activeView) return;
    if (!phoneWidth && !isFullscreen) {
      // Full screen is one state of the tab (fullscreen-owner.ts): a panel the
      // user is not on never takes it from the one that holds it; its view closes.
      if (fullscreenPlace() !== null) { setActiveView(null); setFileViewTarget(null); return; }
      enterFullscreen();
    }
    applyOpenCollapse(activeView);
  }, [phoneWidth, activeView, applyOpenCollapse, isFullscreen, enterFullscreen]);
  // Phone: the open column is a layer whose bar is the top bar (one bar, C64).
  const phoneBar = usePhoneLayerWithBar({
    id: `session:${sessionId}`,
    kind: 'session',
    active: !!phoneLayer,
    title: headerTitle || carriedTitle || fallbackTaskTitle || 'Untitled session',
    subtitle: phoneSessionLabel({
      // Before the record loads, the status the home row read (N2-10), never a default Stopped.
      process_status: ps ?? liveStatus?.process_status ?? null,
      pendingPermissionTool: pendingPermission?.toolName ?? null,
      cardTool: phoneCardTool.tool,
      missing: missing || phoneCardTool.gone,
      taskNeedsYou: (() => { const t = session ? sessionTask : phoneEarlyTask; return !!t && taskNeedsAction(t); })(),
      loading: loading && !session,
    }),
    onClose: () => closePanel(sessionId),
    onTitleTap: () => scrollToLatestTurnStart(
      document.querySelector<HTMLElement>(`.session-panel[data-session-id="${CSS.escape(sessionId)}"]`),
    ),
    deepLinkBaseUrl: phoneDeepLinkBaseUrl,
  });
  const phoneClose = phoneBar.close;
  const hostSlot = usePhoneBarSlot(phoneHostSlot ?? '');
  // An open view (Board, Files, Changed...) is a layer over the session's chat.
  usePhoneLayerWithBar({
    id: activeView === 'board' ? `board:${session?.taskId ?? sessionId}` : `viewer:${activeView ?? 'none'}:${sessionId}`,
    kind: activeView === 'board' ? 'board' : 'viewer',
    active: !!(phoneLayer || phoneHostSlot) && !!activeView,
    title: activeView ? activeView.charAt(0).toUpperCase() + activeView.slice(1) : '',
    withAction: false,
    // A window that stops being a phone shows the view as the desktop split: only a back closes it.
    onClose: (info) => { if (info.breakpoint) return; setActiveView(null); collapseChat(false); },
  });
  // Where the kebab goes on a phone: this panel's own bar, or its host's.
  const kebabSlot = phoneLayer ? phoneBar.slot : (phoneHostSlot && phoneBar.phone ? hostSlot : null);
  // A host that draws the header (headerSlot): the badge and the kebab go there, the full desktop menu.
  // Not in fullscreen: the panel is an overlay then, over the host too, and needs its own header to come back.
  const hostHeader = !kebabSlot && !(phoneLayer || phoneHostSlot) && !!headerSlot && !isFullscreen;
  // The session's link tags (threads, docs, CRs), folded behind one control
  // (SessionHeaderLabels.tsx) and counted there.
  const headerTags = sessionTask
    ? <TaskTagPills task={sessionTask} className="session-panel-tag-pills" linksFirst max={Number.MAX_SAFE_INTEGER} onOpenPath={handleFileOpen} pathHost={session?.host ?? undefined} />
    : null;
  // Every other label stays on the row, seen at a glance (2026-11-03, the user: "only tag
  // go there, other should still outside, like trigger ... leader ... worker"): the wait,
  // Embedded, Cron, Trigger, then the team pills. A narrow header draws each as its letter.
  const headerPills = (
    <>
      <WaitingChip task={sessionTask} />
      {/* What the session holds live (its servers, its browser tabs) is a pill here and only here,
          its details in the pill's popover; never a card in the chat
          (tests/web/live-resources-header-only-guard.test.ts). */}
      {!inset && <SessionServersChip servers={webServers} activePort={webShownPort} onOpen={(s) => openWebView(s.url)} />}
      {!inset && !plainChat && session?.taskId && <SessionBrowserChip taskId={session.taskId} view={browserView} />}
      {session?.provider === 'embedded' && (
        <span className="session-panel-badge session-panel-embedded-badge" data-header-pill="embedded" data-short="E">
          {ICON_ROBOT}<span className="task-pill-long"> Embedded</span>
        </span>
      )}
      <CronPill sessionId={sessionId} expanded={cronDetailOpen} onClick={() => setCronDetailOpen((open) => !open)} />
      <TriggerPill taskId={session?.taskId} />
      {sessionTask && <PrPill task={sessionTask} />}
      {/* The team, as on the task rows: Worker lists this task's leader and its fellow
          workers, Leader lists its subtasks. A Personal AI ask is never a board row, so its
          session header is the one place an ask that split work off shows it. */}
      {sessionTask && <SubtaskPill task={sessionTask} />}
      {sessionTask && <LeaderPill task={sessionTask} />}
    </>
  );

  // The id resolved to nothing after the full retry window. Say so explicitly:
  // the previous behaviour rendered an ordinary empty panel, indistinguishable
  // from a slow load, and the column stayed in sessionStorage so every reload
  // replayed the retry loop — which reads as "sessions are broken".
  if (missing) {
    return (
      <div className="session-panel" data-session-id={sessionId} data-session-missing="true">
        <div className="session-panel-missing">
          <p className="session-panel-missing-title">Session not found</p>
          <p className="session-panel-missing-body">
            No session matches <code>{sessionId}</code>. It may have been deleted, or the
            link used a partial id that no longer resolves.
          </p>
          {/* Only where the host gave the panel a close (a column closes itself;
              the embedded slot hides itself). */}
          {onClose && (
            <button className="btn btn-sm btn-primary" onClick={() => closePanel(sessionId)}>
              Close panel
            </button>
          )}
        </div>
      </div>
    );
  }

  /**
   * The composer's controls, as ONE list both composers render (the panel's own
   * and the plan popover's). Priority is what leaves the row first when the
   * column is narrow — the user's call on 2026-09-19: mode last, then model,
   * then reply style, then the side-thread drawer, then the note pill. The two
   * that open a surface anchored to themselves are flagged `anchored`, so a menu
   * row pins them onto the row before clicking (see ComposerControlsBar).
   */
  const composerControls = (opts: { openNonce?: number } = {}): ComposerControl[] => {
    if (!session) return [];
    // An engine picked for the next message: the pill shows and edits that pick.
    const switchPick = engineSwitch.pick;
    const switchPending = switchPick ? {
      model: switchPick.model,
      effort: switchPick.effort as SessionEffort | undefined,
      onPick: (model: string | undefined) => engineSwitch.setPick((p) => (p ? { ...p, model } : p)),
      onPickEffort: (effort: SessionEffort) => engineSwitch.setPick((p) => (p ? { ...p, effort } : p)),
      host: session.host,
      cwd: session.cwd,
    } : undefined;
    // Labels come from the ONE mode registry (core/types.ts) so a mode added
    // there shows a real label instead of its raw id ('dontAsk'). planCompleted
    // is a separate flag meaning "plan was produced" and must not lock the toggle.
    const MODE_LABELS: Record<string, string> = SESSION_MODE_LABELS;
    const currentMode = session.mode || 'default';
    const isPlan = currentMode === 'plan';
    const currentIdx = enabledModes.indexOf(currentMode);
    const nextMode = enabledModes[(currentIdx + 1) % enabledModes.length]!;
    const label = MODE_LABELS[currentMode] ?? currentMode;
    return [
      {
        id: 'mode',
        name: 'Mode',
        priority: 1,
        node: engineUi.configModes ? (
          <SessionControlPills
            controls={sessionControls}
            setControl={setSessionControl}
            engineName={engineUi.displayName}
            showModeShortcut
            showThoughtLevel={false}
          />
        ) : (
          <button
            className={`mode-toggle-pill${isPlan ? ' plan-active' : ''}`}
            onClick={() => setModeOptimistic(nextMode)}
            title={`Mode: ${currentMode}. Click or Shift+Tab to cycle → ${nextMode}`}
          >
            <span className="mode-toggle-pill-label">{label}</span>
            <span className="mode-toggle-pill-shortcut">{'\u21E7'}Tab</span>
          </button>
        ),
      },
      {
        id: 'model',
        name: 'Model',
        priority: 2,
        anchored: true,
        node: (
          <ComposerModelPill
            sessionId={switchPick ? undefined : sessionId}
            session={session}
            engineUi={switchPick ? engineCaps(switchPick.engine, engineCatalog) : engineUi}
            onOptimistic={applyModelPillPatch}
            fallbackAssistant={switchPick ? undefined : lastAssistant}
            openNonce={opts.openNonce}
            openServedRef={opts.openNonce !== undefined ? modelPickerServed : undefined}
            controls={!switchPick && engineUi.isAcp ? sessionControls : undefined}
            onControl={!switchPick && engineUi.isAcp ? setSessionControl : undefined}
            pending={switchPending}
            title={switchPick ? 'Switches this task when you close the picker.' : undefined}
            onProviderSwitch={engineSwitch.enabled ? engineSwitch.onProviderSwitch : undefined}
            providerLockReason={engineSwitch.enabled ? engineSwitch.providerLockReason : undefined}
            onPickerClose={engineSwitch.enabled ? engineSwitch.commit : undefined}
            onPickerCancel={engineSwitch.enabled ? engineSwitch.clear : undefined}
            pickerNote={switchPick ? `Closing the picker switches this task to ${engineCaps(switchPick.engine, engineCatalog).displayName} with this conversation${session?.process_status === 'running' ? ', and stops the running turn' : ''}.` : undefined}
            sourceNote={switchPick ? undefined : launchSourceNote}
          />
        ),
      },
      {
        id: 'output',
        name: 'Reply style',
        priority: 3,
        inAddMenu: true,
        node: (
          <OutputModePill
            sessionId={session.claudeSessionId}
            mode={session.output_mode}
            onOptimistic={(output_mode) => applySessionSettings(settingsSessionId, { output_mode })}
          />
        ),
      },
      {
        id: 'btw',
        name: 'Side thread',
        priority: 4,
        inAddMenu: true,
        node: (
          <SideQuestionDrawer
            sessionId={session.claudeSessionId}
            engine={session.engine}
            cwd={session.cwd}
            host={session.host}
            parentMode={session.mode}
            parentModel={session.model}
            parentEffort={session.effectiveEffort ?? session.effort}
            parentOutputMode={session.output_mode}
            onInjectToComposer={handleInjectFromThread}
            sheetAt={sheetAt}
          />
        ),
      },
      {
        id: 'note',
        name: 'Note',
        priority: 5,
        inAddMenu: true,
        node: (
          <SessionNotesPill
            noteState={noteState}
            expanded={notesOpen}
            onToggleExpanded={() => setNotesOpen(o => !o)}
          />
        ),
      },
    ];
  };
  const planComposerControls = session ? composerControls() : [];
  fullComposerShownRef.current = !ownComposerLight || sidePaneKeys.includes(ROOT_THREAD_KEY);
  // Main's page beside a question's: the panel's full composer controls (see ownComposerLight).
  const mainFullComposer = session && !plainChat && ownComposerLight ? {
    controlsSlot: <ComposerControlsBar className="session-mode-bar" controls={composerControls({ openNonce: modelPickerRequest })} handleRef={composerControlsRef} />,
    addMenuControls: { handleRef: composerControlsRef, ids: ['output', 'btw', ...(noteState.hasNote ? [] : ['note'])] },
    plusMenuActions: plusActions,
    ...(toggleSessionMode ? { onToggleMode: toggleSessionMode } : {}),
  } : undefined;

  // The agent handed this back (turn ended, errored, or waits on a decision).
  const needsAction = !!sessionTask && taskNeedsAction(sessionTask);
  // The session's kebab. On a phone it lives in the top bar's right slot (a portal,
  // so it keeps this tree), led by the header's own row-1 actions (C64).
  // What opens beside the chat and what moves the panel: the menu's Open and Window rows
  // (SessionMenuOpen), the same on a Home column, an Org node and a pop-out.
  // Built only while the menu is open: the Msgs count is a pass over every user turn.
  const renderMenuOpen = (close: () => void) => {
    const menuViews: SessionViewItemsProps = {
      sessionId,
      activeView,
      onToggleView: toggleView,
      unreadCount: letterUnread,
      decisionCount: letterDecisions,
      attentionCount: letterAttention,
      notesOpen,
      onToggleNotes: () => setNotesOpen(o => !o),
      messagesOpen,
      onToggleMessages: () => setMessagesOpen(o => !o),
      // typedUserText: a turn that was only a machine block Walnut prepended is not one of
      // "my messages", so it must not be counted here either — the list below drops it.
      msgCount: historyMessages.filter(m => m.role === 'user' && typedUserText(m.text).trim()).length,
      onOpenUsage: openUsageDialog,
    };
    return (
    <SessionMenuOpen
      close={close}
      views={menuViews}
      inset={inset}
      board={onHostBoard ? 'live' : boardChipLive ? (boardWaitReason ? 'waiting' : 'live') : 'none'}
      onBoard={onHostBoard}
      terminal={terminalOffered && !inset}
      onPlan={hasPlanContent || showExecuteButtons ? () => setPlanPopoverOpen(true) : undefined}
      // Drawn, disabled with the reason, while the record that names the task is on its way, so
      // the row is there from the first opening of the menu (as the header button was).
      locate={taskSlot === 'live' ? {
        label: onLocateTask ?? onTaskClick ? 'Locate task' : 'Find on Home',
        waiting: locateWaitReason ?? (session?.taskId ? null : 'Locate becomes available once the session has loaded'),
        onClick: () => {
          const taskId = session?.taskId;
          if (!taskId) return;
          const locate = onLocateTask ?? onTaskClick;
          if (locate) locate(taskId); else locateTaskOnHome(taskId, navigate, { sessionId });
        },
      } : undefined}
      onPopout={inset ? undefined : () => openPopout('session', { id: sessionId, host: session?.host, cwd: session?.cwd })}
      onFullscreen={inset ? undefined : (isFullscreen ? exitFullscreen : enterFullscreen)}
      fullscreenLabel={isFullscreen ? 'Exit full screen' : 'Full screen'}
    />
    );
  };
  const renderSessionKebab = (phoneRows?: (close: () => void) => ReactNode) => (
    <TaskQuickActions
      taskId={session?.taskId}
      task={session?.taskId ? sessionTask : null}
      isPinned={pinned}
      pinnedTier={pinnedTier}
      onPinTask={handlePinTask}
      onUnpinTask={handleUnpinTask}
      onSetTier={handleSetTier}
      onOpenTaskDetail={onOpenTaskDetail}
      onCompleted={completedInColumn}
      slot="kebab"
      // Right-clicking the panel header opens this same menu at the
      // cursor: the header is the session's object, so its actions
      // belong to the gesture people already try there.
      contextMenuScope=".session-panel-header"
      // Open, Window and the Panels switch lead the menu (SessionMenuOpen).
      // A phone gets the short list (N12): its own rows, Task detail and status.
      // Panel columns, new tabs, editors and directory copies mean nothing there.
      phoneMenu={!!phoneRows}
      leadingSection={(close) => phoneRows ? phoneRows(close) : renderMenuOpen(close)}
      extraSection={phoneRows ? undefined : (close) => (
        <SessionKebabSection
          sessionId={sessionId}
          taskId={session?.taskId}
          cwd={session?.cwd}
          host={session?.host}
          hostname={session?.hostname}
          archived={session?.archived}
          startedAt={session?.startedAt}
          lastActiveAt={session?.lastActiveAt}
          onRestart={handleRestart}
          restartBusy={restartBusy}
          onTerminate={handleTerminate}
          terminateBusy={terminateBusy}
          onInvestigate={handleInvestigate}
          investigating={investigating}
          investigateResult={investigateResult}
          onOpenVscodeError={handleOpenVscodeError}
          onAfterAction={close}
        />
      )}
    />
  );
  // Agent output the user has not looked at yet: task.unread, the same red dot
  // the task list shows. Here it is a dot before the title and a red composer,
  // so a finished column reads as ready at a glance (2026-09-29: a full red
  // frame did that but was too loud). The user's first click or keystroke in
  // this window marks it read, as opening the task row does. Focus alone never
  // does: a window coming back to the front refocuses the composer by itself.
  const unread = !!sessionTask?.unread && sessionTask.status !== 'done' && sessionTask.phase !== 'COMPLETE';
  const markRead = () => {
    const taskId = sessionTask?.id;
    if (!unread || !taskId) return;
    if (taskStore?.tasks.some((t) => t.id === taskId)) {
      taskStore.update(taskId, { unread: false });
      return;
    }
    if (readRequestRef.current === taskId) return;
    readRequestRef.current = taskId;
    updateTask(taskId, { unread: false })
      .then((task) => setFetchedTask(task))
      .catch((err) => log.warn('session-panel', 'mark read failed', { sessionId, taskId, error: String(err) }))
      .finally(() => { readRequestRef.current = null; });
  };

  return (
    <SessionUsageOpenContext.Provider value={openUsageFor}>
    <PlanContentContext.Provider value={planContentValue}>
    <SessionPinsContext.Provider value={pinsApi}>
    <SessionCommentsContext.Provider value={commentsApi}>
    <SessionThreadsContext.Provider value={threadsApi}>
    <SessionRewindContext.Provider value={rewindApi}>
    <SessionPanelErrorBoundary sessionId={sessionId} clearsColumnLayout={!embedded} {...(onClose ? { onClose: closePanel } : {})}>
      {FullscreenBackdrop}
      {usageDialogVisible && (
        <SessionUsageDialog key={sessionId} sessionId={sessionId} title={headerTitle} usage={budgetUsage} onClose={closeUsageDialog} />
      )}
      {rewindTarget && (
        <SessionRewindDialog
          sessionId={sessionId}
          msgId={rewindTarget.msgId}
          {...(rewindTarget.label ? { label: rewindTarget.label } : {})}
          {...(rewindOtherThreads > 0 ? { otherThreadsDropped: rewindOtherThreads } : {})}
          onClose={() => setRewindTarget(null)}
          onRewound={(result) => {
            setRewindTarget(null);
            // In-place (default): same session id, truncated transcript. Drop
            // the client caches (memory + IDB history, streaming blocks) so the
            // remounted timeline rebuilds from the shorter server history with
            // no stale flash, then bump the key to remount.
            if (result.mode !== 'fork' && result.sessionId === sessionId) {
              log.info('session-panel', 'session rewound in place — remounting timeline', {
                sessionId, filesRestored: !!result.files?.canRewind,
                restoredChars: result.restoredPrompt?.length ?? 0,
              });
              clearSessionCaches(sessionId);
              setRewindEpoch((e) => e + 1);
              // The rewound message comes BACK to the composer to edit and
              // resend — the whole point of a rewind, and what the CLI's own
              // /rewind does. rewindEpoch only remounts the timeline, so the
              // composer is alive to receive this.
              if (result.restoredPrompt) {
                setPrefillText(result.restoredPrompt);
                setPrefillMode('replace');
                setPrefillNonce((n) => n + 1);
                autoCollapsed.current = false;
                setChatCollapsed(false);
              }
              return;
            }
            // Fork: the new session's composer has not mounted yet, so hand the
            // message over through the draft key it reads on mount.
            if (result.restoredPrompt) {
              try {
                localStorage.setItem(sessionDraftKey(result.sessionId), result.restoredPrompt);
              } catch { /* private browsing — the copy just opens with an empty box */ }
            }
            // Fork: the rewound session is a NEW id continuing the same task, so
            // the column swaps onto it (no second panel for the same work). The
            // shorter transcript + restored code is the receipt; no toast.
            log.info('session-panel', 'rewound session replaces this column', {
              sessionId, rewoundId: result.sessionId, filesRestored: !!result.files?.canRewind,
            });
            onSessionReplaced?.(sessionId, result.sessionId);
          }}
        />
      )}
      {/* is-changed-open must sit on the SAME element as open-walnut-fullscreen
          (the .session-panel root) so the `.open-walnut-fullscreen.is-changed-open`
          rule that drops the 1400px cap actually matches — otherwise the split
          view stays guttered at 1400px in this slide-out. */}
      <ThreadToastProvider panelRef={panelRef} composerRef={composerWrapRef}>
      <div
        className={`session-panel${fullscreenClass}${splitOpen ? ' is-changed-open' : ''}${unread && !plainChat ? ' session-panel-unread' : ''}${inset ? ' session-panel-inset' : ''}${plainChat ? ' is-plain-chat' : ''}${(phoneLayer || phoneHostSlot) && phoneBar.phone ? ' is-phone-layer' : ''}${hostHeader ? ' has-host-header' : ''}`}
        data-session-id={sessionId}
        ref={panelRef}
        // The panel the user last pointed into is "the current session" for
        // actions taken outside any panel (a task row's "Quote in session").
        onPointerDownCapture={() => { setActiveSession(sessionId); markRead(); }}
        onFocusCapture={() => setActiveSession(sessionId)}
        // Typing counts as reading; a bare modifier or a shortcut chord does not.
        onKeyDownCapture={(e) => { if (!e.metaKey && !e.ctrlKey && !MODIFIER_KEYS.has(e.key)) markRead(); }}
      >
        {/* needs-action: same red tint + same rule (taskNeedsAction) as the pin
            area's cards, so "the agent handed this back" reads identically on
            both surfaces. Independent of the walnut amber TITLE — background is
            the state highlight, text color is the origin marker. */}
        <div
          className={`session-panel-header${needsAction ? ' session-panel-header-needs-action' : ''}`}
          ref={glassHeaderRef}
        >
          {/* Two-row header, and the split is deliberate (2026-07-27):
              ROW 1 = tool chips (Fork / Changed / Files / Board / Terminal / Plan) + time
                      + EVERY icon button (minimize / lock / popout / expand / close).
                      The row holds still while the session record loads: the chips that
                      need the session's task (Fork, Board) exist or not from the
                      first frame, by what the page already knows of the task
                      (headerTaskPresence), and wait disabled for the record only while it
                      loads. A session known to have no task never shows them; once
                      drawn, a later "no task" keeps their places as spacers. A chip only
                      some sessions have (Plan) goes after the ones all have, and is the
                      first host chip to fold into "..." (useSessionHeaderFit.ts).
                      2026-10-11: Fork appeared 60-130 ms after Files was painted, pushed
                      Changed onto Files' spot, and a click aimed at Files opened Changed
                      (tests/e2e/browser/session-header-chips-hold-place.spec.ts).
              ROW 2 = the TITLE on its own full-width line. Only two things may
                      share it: the folded labels control and the ⋮ kebab.
              Before this the title shared one row with 5 icon buttons and the
              status pill, so in a normal 3-column layout it collapsed to ~105px
              ("Fork of ek…"). Anything new belongs in row 1 or the kebab — never
              next to the title. Open-in-VS-Code lives in the kebab only. */}
          {/* ROW 1 — tool chips + time on the left, window controls pinned right.
              Session id / SSH host / Open-in-VS-Code all live in the ⋮ kebab. */}
          <SessionHeaderToolRow rowRef={toolRowRef}>{({ hid, inMore }) => <>
            <div className="session-meta-row-2-chips">
            <span className="session-header-item" data-header-id="fork" data-hidden={hid('fork')}>
              <SessionForkButton
                sessionId={sessionId}
                session={session}
                loading={loading}
                slot={taskSlot}
                sourceTitle={headerTitle}
                onOpenForkDraft={onOpenForkDraft}
              />
            </span>
            {/* The split views need the whole panel: an inset column has none. */}
            {!inset && (
              <>
                <ChangedChip sessionId={sessionId} active={activeView === 'changed'} hidden={hid('changed')} onToggle={toggleView} />
                <button
                  className={`session-action-chip${activeView === 'files' ? ' session-action-chip-active' : ''}`}
                  onClick={() => toggleView('files')}
                  title="Browse the session working directory, full-screen alongside the chat"
                  data-header-id="files"
                  data-hidden={hid('files')}
                >
                  Files
                </button>
                {terminalOffered && (
                  <button
                    className={`session-action-chip${activeView === 'terminal' ? ' session-action-chip-active' : ''}`}
                    onClick={() => toggleView('terminal')}
                    title="Open a terminal in the session working directory, full-screen alongside the chat"
                    data-header-id="terminal"
                    data-hidden={hid('terminal')}
                  >
                    Terminal
                  </button>
                )}
                {terminalOffered && (
                  <SessionScriptsChip
                    sessionId={sessionId}
                    taskId={session?.taskId}
                    hidden={hid('scripts')}
                    rowRef={toolRowRef}
                    onRun={runInTerminal}
                    onInterrupt={interruptTerminal}
                    openRef={scriptsOpenRef}
                  />
                )}
                {/* Board needs the task, like Fork, and only a lead's task has one
                    worth opening (useBoardTab): absent otherwise. It comes AFTER the
                    chips every session has, like Plan below: whether a task leads may
                    be known only once the task list or the owner read lands, and a chip
                    that appears late in front of Terminal pushes it under a click.
                    Drawn, it is disabled until the record lands; a spacer once drawn
                    if the task goes. */}
                {taskSlot === 'spacer' && boardDrawn.current.drawn && (
                  <button type="button" className="session-action-chip" data-header-id="board" data-hidden={hid('board')} {...TASK_SLOT_SPACER}>
                    Board
                  </button>
                )}
                {boardChipLive && (
                  <button
                    className={`session-action-chip${activeView === 'board' ? ' session-action-chip-active' : ''}`}
                    onClick={() => { if (!boardWaitReason) toggleView('board'); }}
                    disabled={!!boardWaitReason}
                    title={boardWaitReason ?? "The task's Board: the page its leader keeps, with a thread and a mark per section, beside the chat"}
                    data-testid="session-board-chip"
                    data-header-id="board"
                    data-hidden={hid('board')}
                  >
                    Board
                  </button>
                )}
              </>
            )}
            {/* Plan & Execute: shown whenever a plan actually exists (regardless of
                mode), or there's something executable. It comes AFTER the chips every
                session has: whether there is a plan is known only once the record (and
                then the plan) has loaded, and a chip that appears late in front of Fork,
                Changed and Files pushes them right under a click on its way to them. */}
            {(hasPlanContent || showExecuteButtons) && (
              <>
                <button
                  className={`session-action-chip${planPopoverOpen ? ' session-action-chip-active' : ''}`}
                  onClick={() => setPlanPopoverOpen(o => !o)}
                  title="Plan & Execute"
                  data-header-id="plan"
                  data-hidden={hid('plan')}
                >
                  Plan {planPopoverOpen ? '\u25B4' : '\u25BE'}
                </button>
                {planPopoverOpen && (
                  <div className="plan-popup-overlay" onClick={() => setPlanPopoverOpen(false)}>
                    <div className="plan-popup-container" onClick={e => e.stopPropagation()}>
                      <div className="plan-popup-header">
                        <span className="plan-popup-title">
                          {plan?.planFile?.split('/').pop() ?? 'Plan'}
                          {isFromPlan && plan?.sourceSessionId && (
                            <span style={{ marginLeft: '8px', fontSize: '11px', fontWeight: 400, color: 'var(--fg-muted)' }}>
                              from{' '}
                              <a
                                href={`/sessions?id=${plan.sourceSessionId}`}
                                style={{ color: 'var(--accent)' }}
                                onClick={(e) => { e.preventDefault(); navigate(`/sessions?id=${plan.sourceSessionId}`); setPlanPopoverOpen(false); }}
                              >
                                {plan.sourceSessionId.slice(0, 12)}...
                              </a>
                            </span>
                          )}
                        </span>
                        <div className="plan-popup-header-actions">
                          {showExecuteButtons && (
                            <>
                              <button className="execute-plan-btn" onClick={handleExecuteContinue} disabled={executing}>
                                {executing ? 'Starting\u2026' : <><PlayGlyphIcon size={10} /> Execute</>}
                              </button>
                              <button className="execute-plan-btn-secondary" onClick={handleClearContextExecute} disabled={executing}>
                                Clear Context & Execute
                              </button>
                            </>
                          )}
                          {executeStarted && <span style={{ fontSize: '11px', color: '#0d9488' }}>Started</span>}
                          {executeError && <span style={{ fontSize: '11px', color: 'var(--error)' }}>{executeError}</span>}
                          <button
                            className="plan-preview-refresh"
                            onClick={async (e) => { e.stopPropagation(); await planRefresh(); }}
                            title="Refresh plan content"
                          >
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                              <path d="M1.5 8a6.5 6.5 0 0111.3-4.4"/><polyline points="13 1 13 4.5 9.5 4.5"/>
                              <path d="M14.5 8a6.5 6.5 0 01-11.3 4.4"/><polyline points="3 15 3 11.5 6.5 11.5"/>
                            </svg>
                            {' '}Refresh
                          </button>
                        </div>
                        <button className="plan-popup-close" onClick={() => setPlanPopoverOpen(false)} aria-label="Close">&times;</button>
                      </div>
                      <div className="plan-popup-body">
                        {planLoading && !plan && (
                          <div style={{ fontSize: '12px', color: 'var(--fg-muted)', padding: '20px 0', textAlign: 'center' }}>Loading plan...</div>
                        )}
                        {plan?.content && (
                          <PlanPopoverContent content={plan.content} writerSessionId={plan.sourceSessionId || sessionId} cwd={session?.cwd} sessionId={sessionId} sessionHost={session?.host} onTaskClick={chatTaskClick} onSessionClick={onSessionClick} onFileOpen={handleFileOpen} />
                        )}
                      </div>
                      <div className="plan-popup-input">
          <ChatInput
            // Any file goes to this session's host (api/file-upload.ts).
            fileTarget={{ sessionId }}
            // Same rule in the plan popup's composer: dictation keeps the passage.
            onDictationInsert={holdDictationSelection}
            // The session's own draft: the words follow between this box and the panel's composer.
            draftKey={threads.draftKey}
            promptRecallKey={sessionId}
            sendBlocked={macSessionAway}
            plusMenuActions={engineSettingsEntry.plusMenuActions}
            addMenuControls={{ handleRef: planComposerControlsRef, ids: ['output', 'btw', ...(noteState.hasNote ? [] : ['note'])] }}
            controlsSlot={session ? (
              <ComposerControlsBar className="session-mode-bar" controls={planComposerControls} handleRef={planComposerControlsRef} />
            ) : undefined}
                          onSend={handleSend}
                          onInterruptSend={handleInterruptSendRaw}
                          onStop={handleStopTurn}
                          isStreaming={composerStreaming}
                          placeholder="Send a message while viewing plan..."
                          showCommands={false}
                          onToggleMode={session ? () => {
                            if (engineUi.configModes) {
                              const control = sessionControls.find((candidate) => candidate.id === 'mode');
                              const next = nextSessionControlValue(control);
                              if (control && next) void setSessionControl(control.id, next);
                              return;
                            }
                            const cur = session.mode || 'default';
                            setModeOptimistic(
                              enabledModes[(enabledModes.indexOf(cur) + 1) % enabledModes.length]!,
                            );
                          } : undefined}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
            {/* This row's width is very precious: it holds only the host's own tools, and
                every new chip pushes them into "...". Do not add more here. Plugins
                (walnut.ui.slot 'session.meta') and any other fact about the session go
                in the ⋮ menu (SessionMetaFacts.tsx). The one exception is a fact the USER
                pinned from its row in that menu ("Header", off by default): it shows here
                as a chip and is the first to move into "...". 2026-10-06: a time chip put
                here by default was taken out at the user's request, then came back as this
                opt-in. */}
            <PinnedSessionFacts sessionId={sessionId} taskId={session?.taskId} hid={hid}
              webOpen={activeView === 'web'} onOpenWeb={inset ? undefined : () => toggleView('web')} />
            {/* The chips the row had no room for, as a menu; renders nothing while all fit. */}
            <SessionHeaderMoreMenu rowRef={toolRowRef} ids={inMore} spacerIds={taskSlot === 'spacer' ? TASK_SLOT_IDS : undefined} />
            {activityAge && (
              <time className="session-panel-time" dateTime={session?.lastActiveAt} title={activityTimeTitle} data-header-id="time" data-hidden={hid('time')}>
                {activityAge}
              </time>
            )}
            </div>{/* .session-meta-row-2-chips */}
            <div className="session-panel-window-controls">
              {/* Watch and Locate are rows of the kebab, by their names (2026-11-09, the user of
                  the eye and the crosshair here: "this 2 put iot in the drop down"). */}
              {/* The three that matter most sit together at the right end, always in this
                  order: Lock, Expand, Close. Minimize and Open in new tab come before them,
                  so a narrow column drops those two first and the three never move. */}
              {/* Inset (a task opened from a Board): no popout or fullscreen of its own. */}
              {!inset && (
                <button
                  className="task-action-btn session-panel-popout"
                  data-header-id="popout"
                  data-hidden={hid('popout')}
                  onClick={() => openPopout('session', { id: sessionId, host: session?.host, cwd: session?.cwd })}
                  title="Open in new tab"
                  aria-label="Open session in new tab"
                >
                  {ICON_NEW_TAB}
                </button>
              )}
              {minimize && !isFullscreen && (
                <button
                  className="task-action-btn session-panel-minimize"
                  data-header-id="minimize"
                  data-hidden={hid('minimize')}
                  onClick={() => minimize(sessionId)}
                  title="Minimize to the taskbar (it keeps running)"
                  aria-label="Minimize session to the taskbar"
                >
                  {ICON_MINIMIZE}
                </button>
              )}
              {/* Lock shows wherever the host keeps a strip to pin within (Home's
                  columns, the Org page's side panels, a plugin that asked). The Ask
                  Walnut slot has no strip and passes no onToggleLock. */}
              {onToggleLock && (
                <button
                  className={`task-action-btn session-panel-lock${locked ? ' is-locked' : ''}`}
                  data-header-id="lock"
                  data-hidden={hid('lock')}
                  onClick={() => onToggleLock(sessionId)}
                  title={locked ? 'Unlock — panel will rejoin the rotation' : 'Lock to the right — panel stays when new sessions open'}
                  aria-label={locked ? 'Unlock session panel' : 'Lock session panel to the right'}
                  aria-pressed={locked}
                >
                  {locked ? ICON_LOCK : ICON_UNLOCK}
                </button>
              )}
              {!inset && (
                <button
                  className="task-action-btn session-panel-expand"
                  data-header-id="expand"
                  data-hidden={hid('expand')}
                  onClick={isFullscreen ? exitFullscreen : enterFullscreen}
                  title={isFullscreen ? 'Collapse back' : 'Expand to full screen'}
                  aria-label={isFullscreen ? 'Collapse session' : 'Expand session to full screen'}
                >
                  {isFullscreen ? ICON_COLLAPSE : ICON_EXPAND}
                </button>
              )}
              {/* In fullscreen the panel reads as an overlay, so its X dismisses the
                  overlay (same path as Escape / backdrop click) and never destroys
                  the column underneath. Closing the column needs the normal view. */}
              {(onClose || isFullscreen) && (
                <button
                  className="task-action-btn session-panel-close"
                  data-header-id="close"
                  onClick={isFullscreen ? exitFullscreen : () => closePanel(sessionId)}
                  title={isFullscreen ? 'Exit full screen' : inset ? 'Close this tab (the task keeps running)' : 'Close session panel'}
                  aria-label={isFullscreen ? 'Exit full screen' : inset ? 'Close this tab' : 'Close session panel'}
                >
                  {ICON_CLOSE}
                </button>
              )}
            </div>
          </>}</SessionHeaderToolRow>

          {/* ROW 2 — the title gets the whole line; only the folded labels and the
              kebab sit beside it (plus the host's one leading control, when
              embedded). Every window/tool icon button lives on row 1. */}
          <div className="session-panel-header-top" ref={titleRowRef} data-header-fit={titleRowTight ? 'tight' : undefined}>
            {headerLeading && !isFullscreen && (
              <div className="session-panel-header-leading">{headerLeading}</div>
            )}
            <div className="session-panel-title-area">
              {/* Same two states as the task list: a solid dot while the output is
                  unread, a hollow ring once it is read but the task still needs
                  the user (cleared by a reply or by completing the task). */}
              {(unread || needsAction) && (
                <span
                  className={`task-unread-dot session-panel-unread-dot${unread ? '' : ' session-panel-attention-dot'}`}
                  role="img"
                  aria-label={unread ? "Unread: agent output you haven't seen" : 'Needs your action'}
                  title={unread ? 'Unread: click this window to mark it read' : 'Needs your action'}
                />
              )}
              {!loading && session?.taskId && (
                <TaskQuickActions
                  taskId={session.taskId}
                  task={sessionTask}
                  slot="phase"
                  compact
                  onCompleted={completedInColumn}
                />
              )}
              {headerTitle
                ? <EditableSessionTitle
                    sessionId={sessionId}
                    taskId={session?.taskId}
                    title={headerTitle}
                    // Same amber as the task lists — one marker, every surface.
                    className={`session-panel-title${sessionTask?.walnut_agent ? ' walnut-task-title' : ''}`}
                  />
                : carriedTitle
                  ? <span className="session-panel-title">{carriedTitle}</span>
                  : <span className="session-panel-title text-muted">{loading ? 'Opening the session…' : 'Untitled session'}</span>
              }
            </div>
            {/* The one question control up here: the mode pill (Tree Mode /
                Conversation Mode). Counts and the list live in the sidebar. */}
            {threads.hasQuestions && (
              <div className="thread-mode-pill-slot">
                <ThreadModePill
                  viewMode={threadsApi.viewMode}
                  narrow={threads.stack.panelWidth > 0 && threads.stack.panelWidth < 560}
                  onToggle={() => threadsApi.setViewMode(threadsApi.viewMode === 'linear' ? 'stack' : 'linear')}
                />
              </div>
            )}
            <div className="session-panel-title-meta">
              {/* Beside the title: the state pills (headerPills), the link tags folded into one
                  control (2026-11-02, the user: "the tag still noisy, all collapse"), and the kebab.
                  The run status (Running, Idle) is in the task detail, never here. Nothing else
                  joins this row: tests/web/session-header-labels-guard.test.ts. */}
              {!loading && !hostHeader && headerPills}
              {!loading && !hostHeader && <SessionHeaderLabels>{headerTags}</SessionHeaderLabels>}
              {loading && <span className="session-panel-badge" style={{ color: 'var(--fg-muted)' }}>Loading...</span>}
              {!loading && sessionId && !kebabSlot && !hostHeader && renderSessionKebab()}
              {/* The host's header (headerSlot): the same pills, the folded link tags and the
                  kebab, the kebab led by the view rows the hidden header held. */}
              {!loading && hostHeader && headerSlot && createPortal(
                <>
                  {threads.hasQuestions && (
                    <ThreadModePill
                      viewMode={threadsApi.viewMode}
                      narrow
                      onToggle={() => threadsApi.setViewMode(threadsApi.viewMode === 'linear' ? 'stack' : 'linear')}
                    />
                  )}
                  {headerPills}
                  <SessionHeaderLabels>{headerTags}</SessionHeaderLabels>
                  {/* This panel's own header, and its Minimize, are hidden under the host's. */}
                  {minimize && (
                    <button
                      type="button"
                      className="task-action-btn session-panel-minimize"
                      onClick={() => minimize(sessionId)}
                      title="Minimize to the taskbar: its chip opens this chat again (the chat stays here, it keeps running)"
                      aria-label="Minimize session to the taskbar"
                    >
                      {ICON_MINIMIZE}
                    </button>
                  )}
                  {sessionId && renderSessionKebab()}
                </>,
                headerSlot,
                'host-header',
              )}
              {/* A phone draws its own top bar (no title row): the wait rides in its
                  action slot, before the kebab, and a tap shows its details. */}
              {!loading && kebabSlot && createPortal(<WaitingChip task={sessionTask} compact />, kebabSlot, 'waiting-chip')}
              {/* And a linked pull request's state, the one way a phone opens its card (a row's
                  pills are labels there). */}
              {!loading && kebabSlot && sessionTask && createPortal(<PrPill task={sessionTask} compact />, kebabSlot, 'pr-pill')}
              {!loading && kebabSlot && !inset && createPortal(
                <SessionServersChip servers={webServers} activePort={webShownPort} onOpen={(s) => openWebView(s.url)} compact />,
                kebabSlot, 'web-chip')}
              {!loading && kebabSlot && !inset && !plainChat && session?.taskId && createPortal(
                <SessionBrowserChip taskId={session.taskId} view={browserView} compact />,
                kebabSlot, 'browser-chip')}
              {!loading && sessionId && kebabSlot && createPortal(renderSessionKebab((close) => (
                <PhoneSessionHeaderRows
                  sessionId={sessionId}
                  close={close}
                  activeView={activeView}
                  onToggleView={toggleView}
                  board={boardChipLive ? (boardWaitReason ? 'waiting' : 'live') : 'none'}
                  terminal={terminalOffered && !inset}
                  onScripts={terminalOffered && !inset ? () => {
                    const r = kebabSlot?.getBoundingClientRect();
                    scriptsOpenRef.current?.(r ? { x: Math.max(8, r.right - 300), y: r.bottom + 4 } : { x: 8, y: 56 });
                  } : undefined}
                  plan={!!(hasPlanContent || showExecuteButtons)}
                  onPlan={() => setPlanPopoverOpen(true)}
                  onCloseSession={onClose ? phoneClose : undefined}
                />
              )), kebabSlot)}
            </div>
          </div>
        </div>

        {messagesOpen && (
          <div className="session-action-panel">
            <UserMessagesSummary
              messages={historyMessages}
              loading={historyLoading}
              onMessageClick={handleMessageClick}
            />
          </div>
        )}
        {session?.cwdGone && !session.archived && (
          <FolderGoneBanner sessionId={sessionId} cwdGone={session.cwdGone} onDone={handleFolderMoved} />
        )}
        {sessionTask?.engine_fallback && fallbackGone !== sessionTask.engine_fallback.at && session?.taskId === sessionTask.id
          && !session.lane && !session.archive_reason?.startsWith('engine_switched:')
          && showsEngineFallback(sessionTask.engine_fallback, session.engine, session.archived) && (
          <EngineFallbackBanner taskId={sessionTask.id} sessionId={sessionId} note={sessionTask.engine_fallback}
            runsOn={{ id: session.acpModel, name: session.acpModelName }}
            onGone={() => setFallbackGone(sessionTask.engine_fallback?.at ?? null)} />
        )}
        {(ps === 'error' || ps === 'stopped') && !session?.cwdGone && session && needsContextRecovery({ ...session, process_status: ps }) && (
          <ContextFullBanner sessionId={sessionId} session={session} onResuming={handleResuming} />
        )}
        {session?.usageLimit && !session.archived && !session.cwdGone && ps !== 'running'
          && !(session.usageLimit.state === 'resumed' && ps !== 'error') && (
          <UsageLimitBanner sessionId={sessionId} usageLimit={session.usageLimit}
            onChange={(next) => setSession(prev => prev ? { ...prev, usageLimit: next ?? undefined } : prev)} />
        )}
        {session?.usageLimitContinued && !session.usageLimit && !session.archived && !session.cwdGone && (
          <UsageLimitContinuedNote sessionId={sessionId} note={session.usageLimitContinued}
            onDismiss={() => setSession(prev => prev ? { ...prev, usageLimitContinued: undefined } : prev)} />
        )}
        {ps === 'error' && !session?.cwdGone && !session?.usageLimit && !continuingAfterLimit && !(session && needsContextRecovery({ ...session, process_status: ps })) && (() => {
          // Render even with NO errorMessage. An error the backend couldn't label
          // used to render nothing at all \u2014 the user got a red "Error" pill and
          // zero explanation, with the Retry button (which lives in this banner)
          // also hidden, so the session looked permanently bricked
          // (inc-1787439819342). A blank diagnosis is still worth a sentence and
          // a Retry.
          // Host-neutral on purpose: this same sentence shows for a session on
          // THIS machine, where "re-checks the host" is meaningless and made a
          // routine local auto-stop read as a network fault (2026-09-03).
          const errorText = session?.errorMessage
            || 'Session ended and no cause was recorded. The button below re-checks whether it is still running; your conversation is kept.';
          // Coupling: 'Connection lost' is set by session-health-monitor when daemon unreachable.
          // 'Reconnecting' activity is set by the same monitor's recovery loop.
          const isReconnecting = !!session?.errorMessage?.includes('Connection lost')
            && !!session.activity?.includes('Reconnecting');
          // Honesty rule: the recorded cause blames the substrate ("unable to
          // reach remote host") but the recheck just talked to that host, so the
          // sentence on screen is no longer true. Say what IS true \u2014 the process
          // is not running and typing resumes it. `infraClaim` is the server's
          // structural classification (session-error-kind), never a prose match.
          const mine = recheck.for === sessionId;
          const checking = mine && recheck.phase === 'checking';
          const provedReachable = mine && recheck.phase === 'done'
            && recheck.reachable === true && recheck.infraClaim === true;
          // Spinning amber = work in flight; neutral grey = a settled, non-alarming
          // fact. A proved-reachable host is the second kind, so it must NOT reuse
          // the spinner variant.
          const spinning = isReconnecting || checking;
          const calm = spinning || provedReachable;
          // A local session's reachability is trivially true, so saying "X is
          // reachable" about this machine is noise. Local gets only the half of
          // the sentence that carries information.
          const isRemote = !!session?.host;
          const hostLabel = session?.hostname || session?.host || '';
          const bannerText = checking
            ? 'Checking connection\u2026'
            : isReconnecting ? 'Reconnecting to remote host...' : errorText;
          // Reachable and stopped: the way on is the composer under this notice, so the
          // notice says that and offers no button that would say something else
          // (2026-11-04, the user's screenshot: a Reconnect button beside "Send a
          // message to resume it", two different answers to one fact).
          // A plain chat (the browser side panel's Ask) shows no notice of the process being
          // stopped or of the check itself: its composer resumes it, and the words are Walnut's
          // internals there (review 2026-11-06). A real error still shows, with Retry.
          if (plainChat && (checking || provedReachable)) return null;
          const reachableText = (
            <>
              {isRemote && <><NoticeToken text={hostLabel} /> is reachable, and </>}
              {isRemote ? "this session's" : "This session's"} process is not running. Send a message to resume it.
            </>
          );
          return (
            <PanelNotice
              className={`session-error-banner${spinning ? ' session-error-banner--reconnecting' : provedReachable ? ' session-error-banner--idle' : ''}`}
              icon={spinning ? '\u21BB' : provedReachable ? '\u2139\uFE0E' : <WarningTriangleIcon size={14} />}
              actions={provedReachable ? null : <SessionRetryButton sessionId={sessionId} host={session?.host} onRetried={handleRetried} onResuming={handleResuming} onFolderGone={reloadRecord} />}
            >
              {isRemote && session?.host && !checking && !provedReachable
                ? <SessionHostErrorText host={session.host} label={hostLabel} reconnecting={isReconnecting} fallback={bannerText} />
                : <span className="session-error-banner-text">{provedReachable ? reachableText : bannerText}</span>}
              {!calm && session?.errorMessage && (() => {
                const sug = getErrorSuggestion(session.errorMessage, { host: session.host, provider: session.provider, hostProblem: hostHasProblem });
                return sug ? <ErrorSuggestionLink {...sug} /> : null;
              })()}
            </PanelNotice>
          );
        })()}
        {ps !== 'error' && session?.host && !session.archived && !session.cwdGone && (
          <SessionHostDownBanner host={session.host} label={session.hostname || session.host} />
        )}
        {ps === 'stopped' && session?.errorMessage && (() => {
          // Idle-timeout reclaim is routine housekeeping, not a failure — the health
          // monitor stops CLI processes after N idle minutes to free memory, and the
          // conversation resumes losslessly via --resume. Showing it as a red Error
          // banner scared users into thinking the session broke (2026-08-10).
          const idle = session.errorMessage.match(/^No output for (\d+) min$/i);
          if (!idle) return null;
          // Routine, and the way on is the composer: no button beside it to say otherwise.
          return (
            <PanelNotice className="session-error-banner session-error-banner--idle" icon={<PauseGlyphIcon size={14} />}>
              <span className="session-error-banner-text">
                Auto-stopped after {idle[1]} min idle. The conversation is kept: send a message to resume it.
              </span>
              {(() => {
                const sug = getErrorSuggestion(session.errorMessage!, { host: session.host, provider: session.provider });
                return sug ? <ErrorSuggestionLink {...sug} /> : null;
              })()}
            </PanelNotice>
          );
        })()}
        {!historyLoading && (ps === 'stopped' || ps === 'error') && !session?.archived
          && historyMessages.filter(m => m.role === 'assistant').length === 0
          && historyMessages.some(m => m.role === 'user')
          // A turn whose only output is an error row (a failed native command) is not
          // empty: its error is already on screen, and a restart would not fix it.
          && !historyMessages.some(m => m.role === 'system' && m.systemVariant === 'error') && (
          <PanelNotice
            className="session-error-banner session-error-banner--warning"
            icon={<WarningTriangleIcon size={14} />}
            actions={(
              <button className="session-retry-btn" onClick={handleRestart} disabled={restartBusy}>
                {restartBusy ? 'Restarting...' : 'Restart'}
              </button>
            )}
          >
            <span className="session-error-banner-text panel-notice-prose">Session returned empty: Claude may have run into a problem.</span>
          </PanelNotice>
        )}
        {session?.mode === 'auto' && session.autoPermissionDenial && (
          <PanelNotice className="session-error-banner session-error-banner--warning" icon={<WarningTriangleIcon size={14} />}
            actions={<button className="session-retry-btn" onClick={() => void askAfterAutoDenial()} disabled={modeSwitchBusy}>
              {modeSwitchBusy ? 'Switching...' : 'Switch to asking'}
            </button>}>
            <span className="session-error-banner-text panel-notice-prose" data-testid="auto-permission-denial">
              Tool calls were refused in Auto mode: {session.autoPermissionDenial.tools.join(', ')}. Claude Code did not provide a reason.
              Switch to asking, then retry the action.
              {modeSwitchError && <span role="alert"> {modeSwitchError}</span>}
            </span>
          </PanelNotice>
        )}
        {/* Split container: when a view (Changed/Files/Terminal) is open, becomes
            [ left panel | chat ] as a flex row; when closed it's display:contents so
            the chat lays out exactly as before. The chat subtree below NEVER changes
            shape — same JSX, same position — so SessionChatHistory's WS/stream stays
            mounted (no remount). */}
        <div className={`session-panel-split${splitOpen ? ' is-changed-open' : ''}${splitOpen && chatCollapsed ? ' is-chat-collapsed' : ''}`}>
          {(() => {
            // Chat toggle while the chat is COLLAPSED: parks at the far right
            // of the left view's toolbar, so the (now full-width) bar keeps
            // both layout controls at its two corners. While the chat is open
            // the toggle lives in the chat column's own bar segment below.
            const chatBarSlot = chatCollapsed && activeView === 'board' ? (
              <button
                type="button"
                className="sfe-btn session-chat-collapse-btn kanban-show-chat"
                data-testid="kanban-show-chat"
                onClick={revealChatForBoard}
                title="Show the chat beside the board"
                aria-expanded={false}
              >{phoneBar.phone ? 'Chat' : 'Show chat'}</button>
            ) : chatCollapsed && activeView === 'changed' && autoCollapsed.current && !phoneBar.phone ? (
              <button
                type="button"
                className="sfe-btn session-chat-collapse-btn session-diff-show-chat"
                onClick={() => { changedChatRevealed.current = true; collapseChat(false); }}
                title="Show the chat beside the changes"
                aria-expanded={false}
              >Show chat</button>
            ) : chatCollapsed ? (
              <button
                type="button"
                className="sfe-btn sfe-tree-toggle session-chat-collapse-btn"
                onClick={() => collapseChat(false)}
                title="Show chat"
                aria-label="Show chat"
                aria-expanded={false}
              >{ICON_PANEL_RIGHT}</button>
            ) : null;
            // Changed / Files / Web: a Terminal toggle beside the chat toggle
            // docks the terminal under the view (tests next to the diff).
            const dockToggle = terminalOffered && terminalDockAllowed && activeView && TERMINAL_DOCK_VIEWS.includes(activeView) ? (
              <button
                type="button"
                className={`sfe-btn session-terminal-dock-toggle${terminalDocked ? ' is-on' : ''}`}
                onClick={terminalDocked ? undockTerminal : () => setTerminalDock((d) => ({ ...d, on: true }))}
                aria-pressed={terminalDocked}
                // Its name stays when a narrow file bar draws it as the icon alone (file-doc-bar.css).
                aria-label="Terminal"
                // At the file bar's last step it folds into ⋯ as a Terminal row (FileContentView BAR_STEPS).
                data-bar-foldable=""
                title={terminalDocked ? 'Hide the terminal (it keeps running)' : `Show the terminal under ${DOCK_VIEW_LABEL[activeView] ?? 'this view'}`}
                data-testid="terminal-dock-toggle"
              >{ICON_TERMINAL}<span className="sfe-btn-label">Terminal</span></button>
            ) : null;
            const dockBarSlot = dockToggle ? <>{dockToggle}{chatBarSlot}</> : chatBarSlot;
            return (
              <>
                {splitOpen && sessionId && activeView !== 'code' && (
                  // data-time-view: which part of the panel had the input (time tracking).
                  <div className={`session-panel-diff-col${terminalDocked ? ' has-terminal-dock' : ''}`} data-time-view={activeView ?? undefined}>
                    <Suspense fallback={null}>
                    {activeView === 'changed' && (
                      <SessionChangedTab sessionId={sessionId} sessionCwd={session?.cwd} sessionHost={session?.host} onSelectCode={handleSelectCode} onComment={handleDiffComment} barRightSlot={dockBarSlot} onOpenFile={handleFileOpen} />
                    )}
                    {activeView === 'files' && (
                      <SessionFileExplorer
                        cwd={fileViewTarget?.path ?? session?.cwd}
                        host={fileViewTarget?.onHost ? fileViewTarget.onHost.host : session?.host}
                        // The session's transcript and its changed repos are on its own host.
                        sessionId={fileViewTarget?.onHost ? undefined : sessionId}
                        onHostNote={fileViewTarget?.onHost ? { host: fileViewTarget.onHost.host, sessionHost: session?.host ?? undefined } : undefined}
                        missingNote={fileViewTarget?.missing}
                        initialLine={fileViewTarget?.line}
                        initialEndLine={fileViewTarget?.endLine}
                        initialTerm={fileViewTarget?.term}
                        openNonce={fileViewTarget?.nonce}
                        // ONE memory key for both ways in, and one PER SESSION. `cwd`
                        // above differs per entry (chat file click → the file's parent
                        // dir; Files chip → session cwd), so a root-keyed "last file
                        // read" never matched across them. Keyed on the session id, not
                        // the cwd: sessions are fully isolated, and two sessions in the
                        // same repo share a cwd — that leaked one's open file into the
                        // other. The session id is unique by construction.
                        memoryScope={sessionScope(sessionId)}
                        // Same sink the Changed tab uses — a quote from a whole file and
                        // a quote from a diff compose the identical prefill.
                        onSelectCode={handleSelectCode}
                        barRightSlot={dockBarSlot}
                      />
                    )}
                    {/* Inbox: this session's letters, reader in place. Same split
                        as its peers, so chat-left + letter-right is free. */}
                    {activeView === 'web' && (
                      <SessionWebView
                        sessionId={sessionId}
                        host={session?.host}
                        request={webRequest}
                        onNavigate={openWebView}
                        barRightSlot={dockBarSlot}
                        servers={webServers}
                      />
                    )}
                    {activeView === 'inbox' && (
                      <SessionInboxPane
                        sessionId={sessionId}
                        openLetterId={inboxLetterId}
                        onOpenLetter={setInboxLetterId}
                        onNavigate={(to) => navigateToTarget(to, navigate)}
                        onOpenFile={handleLetterFileOpen}
                        barRightSlot={chatBarSlot}
                      />
                    )}
                    {/* Board: the page the task's leader keeps. A task chip on it
                        opens that task in the chat column (BoardTaskPeek below); the
                        old jump (onTaskClick, then Locate) is the peek's "Open task". */}
                    {activeView === 'board' && session?.taskId && (
                      <TaskBoardPane
                        taskId={session.taskId}
                        sessionId={sessionId}
                        barRightSlot={chatBarSlot}
                        onOpenTask={peek.open}
                        onLocateTask={onTaskClick ?? onLocateTask}
                        onSendToSession={handleBoardSend}
                        renderSession={(cardSessionId, opts) => (
                          <InsetSessionPanel
                            key={cardSessionId}
                            sessionId={cardSessionId}
                            viewPlace={`${viewPlace}:board`}
                            embedded
                            inset
                            onClose={opts.onClose}
                            onLocateTask={onTaskClick ?? onLocateTask}
                            onTaskClick={openPeekFromChat}
                            onSessionClick={onSessionClick}
                            onOpenTaskDetail={onOpenTaskDetail}
                            onOpenForkDraft={onOpenForkDraft}
                          />
                        )}
                      />
                    )}
                    </Suspense>
                    {/* The terminals: the whole column (Terminal), or docked under
                        Changed / Files / Web. One element at one place for both, so a
                        switch between them keeps every terminal mounted; in a Suspense
                        of its own, so a view above loading its code (a lazy Files)
                        never hides the terminals and drops their screens. */}
                    {terminalShown && (
                      <Suspense fallback={null}>
                      <TerminalDock docked={terminalDocked} px={terminalDock.px} wantPx={terminalWantPx} onResized={resizeTerminalDock}>
                        <SessionTerminal
                          // Its layout belongs to one session: a panel that moves to
                          // another (an engine switch) starts from that one's layout.
                          key={sessionId}
                          sessionId={sessionId}
                          label={session?.cwd ?? session?.host ?? 'Terminal'}
                          host={session?.host}
                          onClose={terminalDocked ? undockTerminal : () => toggleView('terminal')}
                          embedded
                          barRightSlot={terminalDocked ? undefined : chatBarSlot}
                          compact={terminalOnPhone}
                          dock={terminalDockAllowed ? {
                            docked: terminalDocked,
                            viewLabel: terminalDocked ? (DOCK_VIEW_LABEL[activeView!] ?? dockViewLabel) : dockViewLabel,
                            onDock: dockTerminal,
                            onUndock: undockTerminal,
                            onMaximize: maximizeTerminal,
                          } : undefined}
                          onAddToChat={handleTerminalAddToChat}
                          onOpenPath={handleTerminalPath}
                          pathNotice={terminalPathMissing}
                          onDismissPathNotice={() => setTerminalPathMissing(null)}
                          onDockWant={setTerminalWantPx}
                          pendingInput={terminalInput}
                          onPendingInputSent={terminalInputSent}
                          folderGone={terminalFolderGone}
                        />
                      </TerminalDock>
                      </Suspense>
                    )}
                  </div>
                )}
                {/* Code view keep-alive: once opened it stays MOUNTED for the
                    panel's lifetime, css-hidden when another view (or none) is
                    active. Unmounting kills the iframe and remounting reboots
                    the whole VS Code workbench — seconds each switch-back.
                    display:none does not reload an iframe; REPARENTING does,
                    which is why this is its own stable sibling rather than a
                    child of the conditional diff-col above. */}
                {codeViewMounted && sessionId && (
                  <div className={`session-panel-diff-col session-panel-code-col${activeView === 'code' ? '' : ' session-panel-code-col-hidden'}`} data-time-view="code">
                    <SessionCodeView
                      sessionId={sessionId}
                      host={session?.host}
                      barRightSlot={chatBarSlot}
                    />
                  </div>
                )}
              </>
            );
          })()}
          {splitOpen && !chatCollapsed && (
            <div className="session-panel-chat-resize" {...chatPanel.handleProps} title="Drag to resize chat" />
          )}
          <div
            className={`session-panel-chat-col${peekShownId ? ' is-board-peek' : ''}${peekBarAlone ? ' has-peek-bar' : ''}${treeSplit.barShown ? ' has-tree-bar' : ''}${treeGrid ? ' is-tree-split' : ''}${treeSibling ? ' has-tree-sibling' : ''}`}
            data-time-view="chat"
            onClick={handleServiceLinkClick}
            ref={chatColCallbackRef}
            style={chatColStyle}
          >
            {/* The chat's own segment of the full-width bar: the left view's
                toolbar + this strip read as ONE bar split by the column divider,
                with the two layout toggles at the bar's two corners. */}
            {splitOpen && !chatCollapsed && (() => {
              const hideChat = (
                <button
                  type="button"
                  className="sfe-btn sfe-tree-toggle session-chat-collapse-btn"
                  onClick={() => collapseChat(true)}
                  title="Hide chat"
                  aria-label="Hide chat"
                  aria-expanded
                >{ICON_PANEL_RIGHT_FILLED}</button>
              );
              return !inset && isFullscreen && peek.tabs.length > 0 ? <PeekTabBar peek={peek} rightSlot={hideChat} /> : (
                <div className="session-chat-bar">
                  <span className="session-chat-bar-title">Chat</span>
                  {hideChat}
                </div>
              );
            })()}
            {peekBarAlone && <PeekTabBar peek={peek} />}
            {treeSplit.barShown && (
              <ThreadPathBar
                segments={pathSegments}
                split={treeLeftShown}
                narrow={treeSplit.narrowBar}
                onSegment={treeSplit.goToSegment}
                levelItems={pathLevelItems}
                levelHeading={pathHeading}
                onPick={treeSplit.pickAtLevel}
              />
            )}
            {sidePaneKeys.length > 0 && (
              <IslandHostContext.Provider value={islandHost}>
              <MessageAboutContext.Provider value={sessionTask?.org_role === 'main' || sessionTask?.org_role === 'lead'}>
              {sidePaneKeys.map((key, i) => (
                <TreeSplitLeft
                  // By place, not by question: a slide of the pages keeps each
                  // timeline and lands it on its new page (as Cmd+[ always did).
                  key={`side-${i}`}
                  column={i + 1}
                  side={i === 0 ? 'L' : 'M'}
                  historyKey={`${sessionId}:${rewindEpoch}:side-${i}`}
                  history={leftHistory}
                  leftKey={key}
                  rightKey={treeSplit.paneKeys[i + 1]}
                  {...(treeSplit.labels.get(key) ? { number: treeSplit.labels.get(key) } : {})}
                  onClose={closeTreePane}
                  mentionCwd={session?.cwd}
                  mentionHost={session?.host}
                  onSendFor={sideSend}
                  onInterruptSendFor={sideInterruptSend}
                  onStop={handleStopTurn}
                  isStreaming={pageStreaming(key)}
                  sendBlocked={macSessionAway}
                  pendingComments={sidePending.get(key) ?? NO_COMMENTS}
                  onJumpComment={commentsStore.requestJump}
                  onRemoveComment={commentsStore.remove}
                  focusSeq={paneFocus?.key === key ? paneFocus.n : 0}
                  flash={paneFocus?.key === key && paneFocus.flash}
                  landSeq={paneFocus?.key === key && paneFocus.land ? paneFocus.n : 0}
                  {...(key === ROOT_THREAD_KEY && mainFullComposer ? { fullComposer: mainFullComposer } : {})}
                />
              ))}
              </MessageAboutContext.Provider>
              </IslandHostContext.Provider>
            )}
            {treePanes >= 2 && (
              <TreeSplitDivider share={treeSplit.leftShare} onShare={treeSplit.setLeftShare} />
            )}
            {treeSibling && (
              <IslandHostContext.Provider value={islandHost}>
              <MessageAboutContext.Provider value={sessionTask?.org_role === 'main' || sessionTask?.org_role === 'lead'}>
                <TreeSplitLeft
                  key="sibling"
                  column={treePanes}
                  side="S"
                  historyKey={`${sessionId}:${rewindEpoch}:sibling`}
                  history={leftHistory}
                  leftKey={treeSibling.key}
                  rightKey={treeSplit.rightKey}
                  {...(treeSplit.labels.get(treeSibling.key) ? { number: treeSplit.labels.get(treeSibling.key) } : {})}
                  where={`${treeSibling.before ? 'Previous' : 'Next'} \u00b7 ${treeSibling.position} of ${treeSibling.count}`}
                  onSwap={treeSplit.swapSibling}
                  onClose={treeSplit.closeSibling}
                  divider={(
                    <TreeSiblingDivider
                      share={treeSplit.siblingShare}
                      onShare={treeSplit.setSiblingShare}
                      onSwap={treeSplit.swapSibling}
                      pageRef={bodyRef}
                    />
                  )}
                  mentionCwd={session?.cwd}
                  mentionHost={session?.host}
                  onSendFor={sideSend}
                  onInterruptSendFor={sideInterruptSend}
                  onStop={handleStopTurn}
                  isStreaming={pageStreaming(treeSibling.key)}
                  sendBlocked={macSessionAway}
                  pendingComments={sidePending.get(treeSibling.key) ?? NO_COMMENTS}
                  onJumpComment={commentsStore.requestJump}
                  onRemoveComment={commentsStore.remove}
                  focusSeq={paneFocus?.key === treeSibling.key ? paneFocus.n : 0}
                  flash={paneFocus?.key === treeSibling.key && paneFocus.flash}
                  landSeq={0}
                />
              </MessageAboutContext.Provider>
              </IslandHostContext.Provider>
            )}
        <div className="session-panel-body" ref={bodyRef}>
          {/* A transferred task names the other end in one quiet line (the header row is precious). */}
          <TransferLinks task={sessionTask} onOpenTask={chatTaskClick} className="xfer-links-panel" testId="session-transfer-links" />
          {/* A phone says one plain sentence for a session that is gone (N29). */}
          {!(phoneLayer && !loading && !session) && (
            <SessionSupervisionBar sid={sessionId} snapshot={supervisionSnapshot} onRetryStop={handleTerminate} archived={session?.archived} />
          )}
          <CronJobsCard sid={sessionId} snapshot={supervisionSnapshot} open={cronDetailOpen} onClose={() => setCronDetailOpen(false)} archived={session?.archived} />
          <IslandHostContext.Provider value={islandHost}>
          <MessageAboutContext.Provider value={sessionTask?.org_role === 'main' || sessionTask?.org_role === 'lead'}>
          <TreeHalfContext.Provider value={rightHalf}>
          <SessionChatHistory
            key={`${sessionId}:${rewindEpoch}`}
            sessionId={sessionId}
            emptyHistory={emptyHistory}
            publishTimeline={treeGrid ? timelineShare : undefined}
            engine={session?.engine}
            phase={taskPhase}
            initialPrompt={initialPromptText}
            sessionCwd={session?.cwd}
            sessionHost={session?.host}
            chatLane={!!session?.lane?.startsWith('chat:')}
            earlierSessionsTaskId={(session?.engineSwitch || session?.resumedBySwitch) && session.taskId ? session.taskId : undefined}
            onOpenEarlierSession={onSessionClick}
            optimisticMessages={optimisticMsgs}
            queueSync={queueSyncProp}
            onMessagesDelivered={handleMessagesDelivered}
            onBatchCompleted={handleBatchCompleted}
            onBatchFailed={handleBatchFailed}
            onDeliveryWaiting={handleDeliveryWaiting}
            onEditQueued={handleEdit}
            onDeleteQueued={handleDelete}
            onAgentQueued={addExternalQueued}
            onRetryFailed={handleRetry}
            onFolderMoved={handleFolderMoved}
            folderGoneHistory={session?.cwdGone?.history}
            onDismissFailed={dismissFailed}
            onTaskClick={chatTaskClick}
            onSessionClick={onSessionClick}
            onFileOpen={handleFileOpen}
            onStreamingChange={setIsStreaming}
            // Same nonce that drives the prefill: asking about a selection must
            // also SHOW the end of the conversation, or the composer fills in
            // while the timeline still sits wherever the user last scrolled.
            // The thread-anchor path (focus, no prefill) is the same intent, so
            // both counters feed it — their sum still only ever moves forward. An
            // outline row's focus is deliberately NOT in this sum (see
            // requestComposerFocus): it just jumped somewhere.
            scrollToBottomNonce={prefillNonce + composerScrollNonce}
            onRequestComposerFocus={requestComposerFocus}
            onQuoteInChat={quoteInChat}
            {...(plainChat ? { workingText: 'Walnut is thinking…' } : {})}
          />
          </TreeHalfContext.Provider>
          </MessageAboutContext.Provider>
          </IslandHostContext.Provider>
        </div>

        <div className="session-panel-input" ref={composerWrapRef}>
          {/* Sticky-note bar — always visible once a note exists (also hosts the
              editor when opened from the pill/kebab while empty). Docked in the
              composer block, above the input card. */}
          <SessionNotesBar
            noteState={noteState}
            expanded={notesOpen}
            onToggleExpanded={() => setNotesOpen(o => !o)}
            onCollapse={() => setNotesOpen(false)}
          />
          {sendError && !isFolderGoneReason(sendError) && (
            <div className="text-xs" style={{ color: 'var(--error)', padding: '4px 12px' }}>
              {sendError}
            </div>
          )}
          {/* The recap (Overall / Latest) is no longer drawn here: it opens from
              the "+" menu's "Latest update" (useLatestUpdateEntry), 2026-10-26. */}
          <EngineSwitchLine
            pick={engineSwitch.pick}
            server={engineSwitch.server}
            refused={engineSwitch.refused}
            sending={engineSwitch.sending}
            catalog={engineCatalog}
            taskId={session?.taskId}
            onUndo={engineSwitch.clear}
          />
          <SessionBudgetStatus data={budgetUsage.data} onOpen={openUsageDialog} />
          {/* A host replica's console with the Mac away: a session the Mac runs gets
              the line, and its composer stays mounted with the send controls hidden,
              so a presence flip never takes what is being typed. */}
          {/* Said while typing too, not only in the empty box's placeholder: sending answers the open prompt. */}
          {promptWarning && !(phoneLayer || phoneWidth) && (
            <div className="composer-prompt-warning" data-testid="composer-prompt-warning">{promptWarning}</div>
          )}
          {macSessionAway && <MacAwayComposer />}
          <PendingCommentsTray
            pending={ownPendingComments}
            onJump={commentsStore.requestJump}
            onEdit={editPendingComment}
            onRemove={commentsStore.remove}
          />
          <ChatInput
            sendBlocked={macSessionAway}
            // Any file goes to this session's host (api/file-upload.ts).
            fileTarget={{ sessionId }}
            focusNonce={composerFocusNonce}
            promptRecallKey={plainChat ? undefined : sessionId}
            // Dictating into this box takes focus and so collapses the page's
            // selection: let the quote pill hold the passage first (holdDictationSelection).
            onDictationInsert={holdDictationSelection}
            controlsSlot={session && !plainChat ? (
              <ComposerControlsBar className="session-mode-bar" controls={composerControls({ openNonce: modelPickerRequest })} handleRef={composerControlsRef} />
            ) : plainChat ? (
              // The browser side panel's chat: its own chips, then the same mode and model (with its
              // effort) pills as every session's composer (2026-11-09, the user: "why can't i choose
              // model, and mode etc"); the rest (reply style, side thread, note) stays out of it.
              <>
                {composerBar}
                {session && (
                  <ComposerControlsBar
                    className="session-mode-bar is-plain-chat-pickers"
                    controls={composerControls({ openNonce: modelPickerRequest }).filter((c) => PLAIN_CHAT_CONTROLS.has(c.id))}
                    handleRef={composerControlsRef}
                  />
                )}
              </>
            ) : undefined}
            addMenuControls={plainChat ? undefined : { handleRef: composerControlsRef, ids: ['output', 'btw', ...(noteState.hasNote ? [] : ['note'])] }}
            contextPill={threads.composerTarget ? (
              <ComposerThreadPill target={threads.composerTarget} onOpen={openComposerTarget} onClear={clearComposerTarget} />
            ) : composerPill}
            onSend={handleComposerSend}
            onInterruptSend={handleInterruptSend}
            // Pending quotes and comments are a message by themselves.
            allowEmptySend={ownPendingComments.length > 0}
            onStop={handleStopTurn}
            isStreaming={pageStreaming(threads.stack.api.currentKey)}
            // Phone: the Waiting line folds away with the keyboard up (N2-06), so its words ride here.
            placeholder={plainChat ? 'Ask a follow-up…' : threads.composerPlaceholder ?? (phoneLayer || phoneWidth
              ? (sessionTask?.phase === 'WAITING' ? 'Message: moves it to Working' : 'Message')
              // A desktop says it in the line above the box (composer-prompt-warning), once.
              : 'Send a message to this session... (/ for commands)')}
            onValueChange={handleComposerValue}
            showCommands={false}
            {...(plainChat ? {} : {
              sessionCommands: slashCommands,
              searchSessionCommands: searchSlashCommands,
              onRefreshSessionCommands: refreshSlashCommands,
              onSessionCommandsPaletteOpen: onSlashPaletteOpen,
              sessionCommandsStatus: slashCommandsStatus,
              onControlCommand: handleControlCommand,
              mentionCwd: session?.cwd,
              mentionHost: session?.host,
              plusMenuActions: plusActions,
              enableEntityMention: true,
            })}
            sessionMentionSelfId={sessionId}
            // Per page: the root keeps `draft:session:<id>` (old drafts survive),
            // a question page and a pending Ask each have their own.
            draftKey={threads.draftKey}
            draftKeptOnReload={threads.draftKeptOnReload}
            prefillText={prefillText}
            prefillNonce={prefillNonce}
            prefillMode={prefillMode}
            onToggleMode={toggleSessionMode}
            // Tree Mode, a question's page: the text box, the mic and send only;
            // the "+" menu, Bypass and the model are the main conversation's.
            light={ownComposerLight}
          />
        </div>
            {/* The active tab's task (a Board chip, or a task clicked in the chat in full
                screen): a trailing child over the chat above, below the tab bar, which
                keeps its shape and stays mounted (task-board.css). */}
            {peekShownId && session?.taskId && (
              <BoardTaskPeek
                key={peekShownId}
                ownTaskId={session.taskId}
                targetTaskId={peekShownId}
                onEscape={() => peek.activate(null, 'escape')}
                onJump={onTaskClick ?? onLocateTask}
                renderSession={(peekSessionId, jump) => (
                  <InsetSessionPanel
                    key={peekSessionId}
                    sessionId={peekSessionId}
                    viewPlace={`${viewPlace}:peek`}
                    embedded
                    inset
                    onClose={closeShownPeek}
                    onLocateTask={jump}
                    onTaskClick={openPeekFromChat}
                    onSessionClick={onSessionClick}
                    onOpenTaskDetail={onOpenTaskDetail}
                    onOpenForkDraft={onOpenForkDraft}
                  />
                )}
              />
            )}
          </div>{/* .session-panel-chat-col */}
        </div>{/* .session-panel-split */}
        {engineSettingsEntry.popover}
        {triggerPicker.popover}
        {latestUpdate.popover}
        {/* The questions drawer: an overlay inside this panel (never widens or
            pads the transcript), for a session with questions. */}
        {threads.hasQuestions && threadsApi.actions && (
          <ThreadTreeDrawer
            sessionId={sessionId}
            panelRef={panelRef}
            tree={threadTree}
            index={threadsApi.metaIndex}
            meta={threads.meta}
            pins={pinsApi.pins}
            pinsApi={pinsApi}
            live={threadsApi.derived.live}
            drafts={threads.stack.api.drafts}
            {...(threads.stack.api.pending ? { pending: threads.stack.api.pending } : {})}
            currentKey={threadsApi.currentThreadKey}
            unreadKeys={threadsApi.unreadKeys}
            answeredAt={threadsApi.derived.answeredAt}
            mode={threads.stack.drawer.mode}
            setMode={threads.stack.drawer.setMode}
            revealNonce={threads.stack.drawer.revealNonce}
            showHidden={threads.stack.drawer.showHidden}
            setShowHidden={threads.stack.drawer.setShowHidden}
            hiddenCount={threads.hiddenCount}
            actions={threadsApi.actions}
            onNavigate={(key, via) => {
              // Conversation Mode: the row is the composer's target and the
              // timeline goes to its first turn, the view stays. Tree Mode: its page.
              if (threadsApi.viewMode === 'linear') { threadsApi.requestHeadJump(key); return; }
              threads.stack.api.pushTo(key, via);
            }}
            onJumpPin={(pinKey, threadKey) => threadsApi.requestPinJump(pinKey, threadKey)}
            {...(threads.stack.drawer.filter ? { initialFilter: threads.stack.drawer.filter } : {})}
          />
        )}
        <ThreadToastBridge apiRef={threads.toastRef} />
      </div>
      </ThreadToastProvider>
    </SessionPanelErrorBoundary>
    </SessionRewindContext.Provider>
    </SessionThreadsContext.Provider>
    </SessionCommentsContext.Provider>
    </SessionPinsContext.Provider>
    </PlanContentContext.Provider>
    </SessionUsageOpenContext.Provider>
  );
});

/** The memoized panel, for the one place a panel renders a panel (a task opened
 *  beside a Board): inside SessionPanel's body its name is the bare function. */
function InsetSessionPanel(props: SessionPanelProps) {
  return <SessionPanel {...props} />;
}

/**
 * The Changed chip with its git tooltip, and no count on it (2026-11-05, the user of the
 * "611" beside it: "don't show"). Its own component: a git reading re-renders the chip, not
 * the panel (whose header refits its row on every render).
 */
const ChangedChip = memo(function ChangedChip({ sessionId, active, hidden, onToggle }: {
  sessionId: string;
  active: boolean;
  hidden: string;
  onToggle: (view: 'changed') => void;
}) {
  const gitGlance = useSessionGitGlance(sessionId);
  return (
    <button
      className={`session-action-chip${active ? ' session-action-chip-active' : ''}`}
      onClick={() => onToggle('changed')}
      title={changedChipTitle(gitGlance)}
      data-header-id="changed"
      data-hidden={hidden}
      data-testid="session-changed-chip"
    >
      Changed
    </button>
  );
});
