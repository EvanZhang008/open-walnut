import { useState, useEffect, useCallback, useRef, useMemo, Component, type ReactNode, type ErrorInfo, memo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { copyTextDeferred } from '@/utils/clipboard';
import { SessionChatHistory } from './SessionChatHistory';
import { SessionNotesPill, SessionNotesBar, useSessionNote } from './SessionNotes';
import { OutputModePill } from './OutputModePill';
import { useSessionPins } from '@/hooks/useSessionPins';
import { SessionPinsContext } from '@/contexts/SessionPinsContext';
import { SessionRewindContext, type SessionRewindApi } from '@/contexts/SessionRewindContext';
import { SessionRewindDialog } from './SessionRewindDialog';
import { SessionFileExplorer } from './SessionFileExplorer';
import { sessionScope } from '@/utils/file-view-state';
import { SessionTerminal } from './SessionTerminal';
import { SessionCodeView } from './SessionCodeView';
import { prefetchVscodeEmbed } from './vscodeEmbedPrefetch';
import { SessionDiffView } from './SessionDiffView';
import { SessionInboxPane } from '@/components/inbox/SessionInboxPane';
import { useSessionLetters } from '@/hooks/useSessionLetters';
import { inboxChipTitle } from '@/components/inbox/session-letters';
import {
  consumeSessionInboxLink, deepLinkFullscreenReassert, SESSION_INBOX_LINK_EVENT,
} from '@/components/inbox/session-inbox-link';
import { buildSelectionPrefill, displayPathForPrefill } from './diffPrefill';
import type { SessionSplitView } from './sessionSplitView';
import { ICON_ROBOT, ICON_EXPAND, ICON_COLLAPSE, ICON_CLOSE, ICON_LOCK, ICON_UNLOCK, ICON_LOCATE, ICON_NEW_TAB, ICON_PANEL_RIGHT, ICON_PANEL_RIGHT_FILLED } from '../common/Icons';
import { openPopout } from '@/popout/openPopout';
import { navigateToTarget } from '@/utils/open-session';
import { UserMessagesSummary } from './UserMessagesSummary';
// PlanPreviewSection replaced by inline plan popover in meta bar
import { ChatInput } from '@/components/chat/ChatInput';
import { SideQuestionDrawer } from '@/components/sessions/SideQuestionDrawer';
import { useRenderedMarkdown } from '@/hooks/useEntityLabels';
import { useSessionSend } from '@/hooks/useSessionSend';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { useSessionHistory } from '@/hooks/useSessionHistory';
import type { ImageAttachment } from '@/api/chat';
import { useEvent } from '@/hooks/useWebSocket';
import { fetchSession, executePlanContinue, executePlanSession, updateSession, restartSession, recheckSession, terminateSession, investigateSession, setSessionEffort, setSessionModel, setCodexSessionModel } from '@/api/sessions';
import { parseSessionDirective } from '@/components/chat/session-mention';
import { buildImageRefsPayload } from '@/api/image-upload';
import { terminalPrewarm } from '@/api/terminal';
import { log } from '@/utils/log';
import { traceInteraction } from '@/utils/interaction-timer';
import { clearSessionCaches } from '@/cache/session-cache';
import { runWhenVisible } from '@/utils/page-visibility';
import { buildInvestigationClip } from '@/utils/investigation-clipboard';
import { fetchTask } from '@/api/tasks';
import { EditableSessionTitle } from './EditableSessionTitle';
import { useFocusBarContext } from '@/contexts/FocusBarContext';
import { useStoreTask } from '@/contexts/TasksContext';
import type { FocusTier } from '@/api/focus';
import { timeAgo } from '@/utils/time';
import { ProcessStatusBadge } from './WorkStatusPicker';
import { SessionForkButton } from './SessionForkButton';
import { SessionKebabSection } from './SessionKebabSection';
import { ModelPicker, acpModelDisplayName } from './ModelPicker';
import { modelSupportsEffort, SESSION_EFFORTS, SESSION_MODE_LABELS } from '@open-walnut/core';
import { TaskQuickActions } from './TaskQuickActions';
import { useFullscreen } from '@/hooks/useFullscreen';
import { useResizablePanel } from '@/hooks/useResizablePanel';
import { useSessionUsage, formatModelName, getContextWindowSize, contextBadgeTitle } from '@/hooks/useSessionUsage';
import { useHostModelCatalog } from '@/hooks/useModelCatalog';
import { useHeightVar } from '@/hooks/useHeightVar';
import { useSessionPlan } from '@/hooks/useSessionPlan';
import { PlanContentContext } from '@/contexts/PlanContentContext';
import { SessionRetryButton } from './SessionRetryButton';
import { wsClient } from '@/api/ws';
import type { SessionRecord, TaskPhase } from '@/types/session';
import { useEnabledModes } from '@/hooks/useEnabledModes';
import { getErrorSuggestion } from '@/utils/error-suggestions';
import { ErrorSuggestionLink } from '@/components/common/ErrorSuggestionLink';
import { useResolvedSessionRecord } from '@/hooks/useSessionStatus';
import { useSessionControls } from '@/hooks/useSessionControls';
import { useEngineCatalog } from '@/hooks/useEngineCatalog';
import { engineCaps } from '@/utils/engine-capabilities';
import { taskNeedsAction } from '@/utils/session-status';
import { nextSessionControlValue, SessionControlPills } from './SessionControlPills';
import { useNotifications } from '@/contexts/notifications';
import { useConfirm } from '@/hooks/useConfirm';

/**
 * Below this viewport width a split view opens with the chat column collapsed:
 * the content pane and the 280px-floor chat column don't both fit, and half a
 * letter is worse than one click on "show chat".
 */
const SPLIT_MIN_WIDTH = 900;
/** Pointer dwell on the Code chip before the VS Code ensure is prefetched. */
const CODE_PREFETCH_DWELL_MS = 400;
/** How long a hidden (kept-alive) VS Code view survives before it is unmounted. */
const CODE_VIEW_HIDDEN_TTL_MS = 10 * 60_000;

interface SessionPanelErrorBoundaryProps {
  sessionId: string;
  onClose: (sessionId: string) => void;
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
      return (
        <div className="session-panel" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '24px' }}>
          <p style={{ color: 'var(--fg-muted)', margin: 0 }}>Something went wrong loading this session.</p>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              sessionStorage.removeItem('open-walnut-home-session-columns');
              this.props.onClose(this.props.sessionId);
            }}
          >
            Close panel
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Renders plan markdown content inside the plan popover with scrollable area */
function PlanPopoverContent({ content, cwd }: { content: string; cwd?: string }) {
  const html = useRenderedMarkdown(content, cwd);
  return (
    <div
      className="markdown-body"
      dangerouslySetInnerHTML={{ __html: html }}
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
  /** Stable close handler — receives the sessionId so parent can identify which panel to close. */
  onClose: (sessionId: string) => void;
  /** Whether this panel is locked — pinned to the rightmost region, not evicted by new sessions. */
  locked?: boolean;
  /** Toggle the lock state. Parent re-orders slots so locked panels sit on the right. */
  onToggleLock?: (sessionId: string) => void;
  onTaskClick?: (taskId: string) => void;
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
}

export const SessionPanel = memo(function SessionPanel({ sessionId, onClose, locked, onToggleLock, onTaskClick, onOpenTaskDetail, onSessionClick, onSessionReplaced, onOpenForkDraft }: SessionPanelProps) {
  const navigate = useNavigate();
  const { notify } = useNotifications();
  const confirmDialog = useConfirm();
  const enabledModes = useEnabledModes();
  const [sessionRecord, setSession] = useState<SessionRecord | null>(null);
  const session = useResolvedSessionRecord(sessionRecord);
  // Every engine-shaped decision in this panel (rewind, mode surface, model
  // pane, model backfill) reads this capability view — never the engine id.
  const engineCatalog = useEngineCatalog();
  const engineUi = engineCaps(session?.engine, engineCatalog);
  const { controls: sessionControls, setControl: setSessionControl } = useSessionControls(
    sessionId,
    session?.engine,
  );
  const [loading, setLoading] = useState(true);
  // Set once the ~15s retry window closes on a 404 — the id resolves to nothing.
  const [missing, setMissing] = useState(false);
  const { optimisticMsgs, sendError, send, interruptSend, stopTurn, retryFailed, dismissFailed, handleMessagesDelivered, handleBatchCompleted, handleBatchFailed, handleEditQueued, handleDeleteQueued, addExternalQueued } = useSessionSend(sessionId);
  // isStreaming is bubbled up from the single useSessionStream instance that lives
  // inside SessionChatHistory (via onStreamingChange). We used to mount a second
  // hook instance here, which doubled stream-subscribe RPCs and produced two
  // parallel defensive-clear paths that could wipe live stream blocks.
  const [isStreaming, setIsStreaming] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Track latest sessionId so async callbacks can detect navigation
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // Slash command autocomplete for session input — pass host so REMOTE sessions
  // get the remote host's skills, not the Mac's local ones.
  const { items: slashCommands, search: searchSlashCommands, refresh: refreshSlashCommands } = useSlashCommands(session?.cwd, session?.host);

  // Model picker state
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  // The clicked model pill — the popout picker anchors here (portal to <body>,
  // so a narrow session column can't clip the panel).
  const modelPillRef = useRef<HTMLElement | null>(null);
  // CSS-promotion fullscreen (same instance, no remount)
  const { isFullscreen, enterFullscreen, exitFullscreen, fullscreenClass, FullscreenBackdrop } = useFullscreen();

  // The route, and when it last CHANGED (0 = not since mount). Both live in refs
  // read by the fullscreen guard below, so that effect's deps stay on the
  // fullscreen state (useFullscreen already subscribes this component to the
  // router, so useLocation costs no extra render here). The change is detected
  // against the ref rather than trusting the effect's own mount run: a fresh mount
  // is not a navigation, and StrictMode's double-invoke must stay a no-op.
  const { pathname } = useLocation();
  const routePath = useRef(pathname);
  const routeChangedAt = useRef(0);
  useEffect(() => {
    if (routePath.current === pathname) return;
    routePath.current = pathname;
    routeChangedAt.current = Date.now();
  }, [pathname]);

  // G4 liquid glass: header + composer overlay the chat column (position:
  // absolute) so content scrolls UNDER them; the scroll area pads itself by
  // these measured heights (CSS vars on the panel root). Composer height is
  // dynamic (textarea autogrow, image previews, queue bar) so it MUST be
  // tracked, not hardcoded; header varies with chip-row wrap.
  const panelRef = useRef<HTMLDivElement>(null);
  const glassHeaderRef = useHeightVar(panelRef, '--sp-header-h');
  const glassComposerRef = useHeightVar(panelRef, '--sp-composer-h', '.session-panel-body .session-history');

  const handleControlCommand = useCallback((command: string) => {
    if (command === 'model') {
      setModelPickerOpen(true);
    }
  }, []);

  const handleModelSwitch = useCallback((model: string) => {
    setModelPickerOpen(false);
    // Live switch via apply_flag_settings (no respawn, no message send) — same
    // mechanism as effort. Optimistically reflect it, then reconcile from the
    // get_settings read-back (effectiveModel = the CLI's true runtime model).
    const prevModel = session?.model;
    setSession(prev => prev ? { ...prev, model } : prev);
    setSessionModel(sessionId, model).then((res) => {
      if (res.effectiveModel) {
        setSession(prev => prev ? { ...prev, model: res.effectiveModel } : prev);
      }
    }).catch((err) => {
      console.error('Model switch failed:', err);
      setSession(prev => prev ? { ...prev, model: prevModel } : prev);
    });
  }, [sessionId, session?.model]);

  // ACP model switch — optimistic, revert + notify on failure. Same contract
  // the retired standalone Codex picker had, now driven from the shared
  // two-pane picker's ACP pane for every ACP engine.
  const handleAcpModelSwitch = useCallback((modelId: string) => {
    setModelPickerOpen(false);
    const previous = session?.acpModel;
    const previousName = session?.acpModelName;
    if (modelId === previous) return;
    // Drop the advertised name with the id: it belongs to the OLD model, and the
    // pill prefers it, so keeping it would label the new model with the old name
    // until the server record comes back.
    setSession(prev => prev ? { ...prev, acpModel: modelId, acpModelName: undefined } : prev);
    setCodexSessionModel(sessionId, modelId).catch((error) => {
      setSession(prev => prev ? { ...prev, acpModel: previous, acpModelName: previousName } : prev);
      log.error('session-panel', 'acp model switch failed', {
        sessionId,
        modelId,
        engine: engineUi.id,
        error: error instanceof Error ? error.message : String(error),
      });
      notify({
        kind: 'operation-error',
        severity: 'error',
        title: `${engineUi.displayName} model switch failed`,
        body: error instanceof Error ? error.message : String(error),
        persistent: false,
        dedupKey: `acp-model-switch:${sessionId}:${Date.now()}`,
        sessionId,
      });
    });
  }, [sessionId, session?.acpModel, notify, engineUi.id, engineUi.displayName]);

  const handleEffortSwitch = useCallback((effort: import('@open-walnut/core').SessionEffort) => {
    setModelPickerOpen(false);
    // Optimistically reflect the requested effort so the pill/badge updates immediately.
    // Backend delivers it via apply_flag_settings, then READS BACK the CLI's true effort.
    // Reconcile effectiveEffort from the response so the badge shows what the CLI actually
    // uses (and flags an env/model override). Revert on failure (model rejected the level).
    const prevEffort = session?.effort;
    const prevEffective = session?.effectiveEffort;
    setSession(prev => prev ? { ...prev, effort } : prev);
    setSessionEffort(sessionId, effort).then((res) => {
      // Trust the CLI read-back: effectiveEffort is what actually took (may differ).
      setSession(prev => prev ? { ...prev, effort, effectiveEffort: res.effectiveEffort ?? prev.effectiveEffort } : prev);
    }).catch((err) => {
      console.error('Effort switch failed:', err);
      setSession(prev => prev ? { ...prev, effort: prevEffort, effectiveEffort: prevEffective } : prev);
    });
  }, [sessionId, session?.effort, session?.effectiveEffort]);

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
  const hasPlan = !!session?.planCompleted;
  const isFromPlan = !!session?.fromPlanSessionId;
  // mode === 'plan' covers sessions still actively planning — planCompleted is only set after the plan tool call finishes,
  // so without this the Plan chip would be hidden during active planning.
  const shouldFetchPlan = hasPlan || isFromPlan || session?.mode === 'plan';
  const { plan, loading: planLoading, refresh: planRefresh } = useSessionPlan(sessionId || undefined, shouldFetchPlan);
  // Plan chip visibility is gated on whether a plan actually EXISTS — not on mode.
  // A bypass session that produced a plan (planCompleted / from-plan) still shows it;
  // a plan-mode session that hasn't produced one yet shows it once the content loads.
  const hasPlanContent = hasPlan || isFromPlan || !!plan?.content;

  // Real-time model + context window usage
  const liveUsage = useSessionUsage(sessionId);
  const lastAssistant = !historyLoading && historyMessages.length > 0
    ? [...historyMessages].reverse().find(m => m.role === 'assistant' && m.model)
    : undefined;
  const rawModel = liveUsage.model || session?.model || lastAssistant?.model;
  // Auto launch before the CLI reports its model (idle todo-launcher session):
  // the host catalog's 'default' row already knows what Auto resolves to on
  // this host — show "Auto (Opus 5 1M)" instead of a bare "Auto" so the user
  // knows what they're running from second zero.
  const hostCatalog = useHostModelCatalog(session?.host);
  const autoResolved = !rawModel
    ? formatModelName(hostCatalog?.models.find((m) => m.value === 'default')?.resolvedModel)
    : '';
  const displayModel = formatModelName(rawModel);
  let contextPercent = liveUsage.contextPercent;
  // Fallback for a page loaded with no live usage event yet (server restart, or
  // a session idle since before this mount): derive it from the last assistant
  // message's tokens. Both halves come from the SERVER when available — the
  // model string can't reveal a custom proxy model's window, and guessing 200K
  // for one was 5x wrong (2026-08-23).
  let badgeUsage = liveUsage;
  if (contextPercent == null && lastAssistant?.usage) {
    const u = lastAssistant.usage as Record<string, number>;
    const totalInput = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const ctxSize = session?.modelMaxWindow ?? getContextWindowSize(rawModel, totalInput);
    if (totalInput > 0 && ctxSize != null) {
      contextPercent = Math.round(totalInput / ctxSize * 100);
      badgeUsage = {
        ...liveUsage, inputTokens: totalInput, contextWindow: ctxSize,
        autoCompactAt: liveUsage.autoCompactAt ?? session?.autoCompactAt,
      };
    }
  }


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
  const sessionTask = useMemo(() => {
    if (!storeTask) return fetchedTask;
    if (!fetchedTask || storeTask.ext !== undefined) return storeTask;
    return { ...storeTask, ext: fetchedTask.ext };
  }, [storeTask, fetchedTask]);
  const taskTitle = sessionTask?.title ?? null;

  // Pin state — read from the shared Focus Bar store (single source of truth,
  // same data every other surface renders). Mutations go through the shared
  // optimistic handlers, so a pin/tier/complete here updates the Homepage
  // pinned tiers in the same frame — no private fetch, no config:changed poll.
  const focusBar = useFocusBarContext();
  const pinned = session?.taskId ? focusBar.isPinned(session.taskId) : false;
  const pinnedTier: FocusTier | undefined = pinned && session?.taskId ? focusBar.tierOf(session.taskId) : undefined;

  const handlePinTask = useCallback((id: string) => {
    focusBar.pin(id).catch((err) => console.error('Pin failed:', err));
  }, [focusBar]);

  const handleUnpinTask = useCallback((id: string) => {
    focusBar.unpin(id).catch((err) => console.error('Unpin failed:', err));
  }, [focusBar]);

  const handleSetTier = useCallback((id: string, tier: FocusTier) => {
    focusBar.setTier(id, tier).catch((err) => console.error('Set tier failed:', err));
  }, [focusBar]);

  // Fetch session metadata
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setSession(null);
    setLoading(true);
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

  // Task phase is not part of SessionStatusSnapshot; keep only that sibling
  // record synchronized from the event.
  useEvent('session:status-changed', (data) => {
    const d = data as { sessionId?: string; phase?: string };
    if (d.sessionId === sessionId) {
      if (d.phase) {
        setFetchedTask(prev => prev ? { ...prev, phase: d.phase as import('@open-walnut/core').Task['phase'] } : prev);
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

  // Keep pendingPermission live so the badge flips Running↔Waiting in real time.
  // pendingPermission is a record field (not part of SessionStatusSnapshot), so
  // the status store can't carry it — mirror the two permission events instead.
  // The server also re-emits unanswered requests every 60s, so a missed initial
  // event self-heals into the Waiting display within a minute.
  useEvent('session:permission-request', (data) => {
    const d = data as { sessionId?: string; requestId?: string; toolName?: string; reason?: string };
    if (d.sessionId === sessionId && d.requestId) {
      setSession(prev => prev ? {
        ...prev,
        pendingPermission: {
          requestId: d.requestId!,
          toolName: d.toolName,
          reason: d.reason,
          // Event payload carries no timestamp — "now" is right for a fresh
          // prompt and only slightly under-counts for a 60s re-emit.
          receivedAt: prev.pendingPermission?.requestId === d.requestId
            ? prev.pendingPermission!.receivedAt
            : new Date().toISOString(),
        },
      } : prev);
    }
  });
  useEvent('session:permission-resolved', (data) => {
    const d = data as { sessionId?: string; requestId?: string };
    if (d.sessionId === sessionId) {
      setSession(prev => (prev && prev.pendingPermission
        && (!d.requestId || prev.pendingPermission.requestId === d.requestId))
        ? { ...prev, pendingPermission: undefined }
        : prev);
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
    };
    if (d.sessionId !== sessionId) return;
    setSession(prev => prev ? {
      ...prev,
      // null = "CLI reports no effort set" ⇒ clear the stale value so the badge
      // falls back to the documented API default instead of a dead reading.
      effectiveEffort: d.effectiveEffort ?? undefined,
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
  const [rewindTarget, setRewindTarget] = useState<{ msgId: string; label?: string } | null>(null);
  // Bumped after an IN-PLACE rewind: the transcript was truncated under the
  // same session id, so the timeline (SessionChatHistory) is remounted via its
  // key to rebuild history + streaming state from scratch. Client caches are
  // cleared first (see onRewound) so the remount's initial load can't adopt the
  // pre-rewind copy.
  const [rewindEpoch, setRewindEpoch] = useState(0);
  const rewindApi = useMemo<SessionRewindApi>(() => ({
    // Rewind needs the engine's own checkpointing (--resume-session-at +
    // rewind_files); engines without it hide the button instead of failing on
    // click. Capability, not a vendor check.
    available: !!sessionId && engineUi.rewind,
    request: (msgId, label) => setRewindTarget({ msgId, ...(label ? { label } : {}) }),
  }), [sessionId, engineUi.rewind]);
  const [messagesOpen, setMessagesOpen] = useState(false);
  // Changed / Files / Terminal all share ONE full-screen split: [ left panel | chat ].
  // null = none open. Opening any view promotes the panel to fullscreen.
  const [activeView, setActiveView] = useState<SessionSplitView | null>(null);
  const splitOpen = activeView !== null;
  // Inbox tab: the letters THIS session wrote to the human. The COUNT is read
  // whether or not the tab is open — a badge that only appears once you open the
  // tab can't tell you a letter is waiting. One shared fetch feeds every panel
  // (useSessionLetters), so N columns are still one GET.
  const {
    unreadCount: letterUnread, decisionCount: letterDecisions, attentionCount: letterAttention,
  } = useSessionLetters(sessionId);
  // The letter open IN the tab. Owned here, not in the pane, so hopping to the
  // Files tab and back returns to the letter instead of the list.
  const [inboxLetterId, setInboxLetterId] = useState<string | null>(null);
  // ChatInput prefill driver — selecting code in the diff drops a prompt into the
  // existing input (no new chat, no fork; goes to the main agent via normal send).
  const [prefillText, setPrefillText] = useState<string | undefined>(undefined);
  const [prefillNonce, setPrefillNonce] = useState(0);
  const handleSelectCode = useCallback((filePath: string, line: number | undefined, code: string) => {
    // The Changed tab already hands a repo-relative path; the Files tab browses the
    // whole filesystem and hands an absolute one. Shorten against the session cwd so
    // a quote reads the same from either surface (a path outside the cwd stays absolute).
    setPrefillText(buildSelectionPrefill(displayPathForPrefill(filePath, session?.cwd), line, code));
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
  // selection: replace the draft, reveal the composer, focus it. The thread's
  // Q&A becomes ordinary text the user can edit before sending (nothing is sent
  // for them). Reveal must happen in this batch — a collapsed chat column is
  // `display:none`, so ChatInput's focus() would land on <body> and eat the
  // user's next keystrokes (same trap as handleSelectCode).
  const handleInjectFromThread = useCallback((text: string) => {
    setPrefillText(text);
    setPrefillNonce((n) => n + 1);
    autoCollapsed.current = false;
    setChatCollapsed(false);
  }, []);
  // A line comment from the diff → send straight to this session's main agent.
  const handleDiffComment = useCallback((message: string) => {
    void send(sessionId, message);
    return true;
  }, [send, sessionId]);
  // Chat column in the split: resizable width (% of viewport) + collapse.
  // Fresh storage key (v3): re-baseline everyone at the new default. The middle
  // content pane (file preview / diff) is the priority — chat is a side column.
  const chatPanel = useResizablePanel('open-walnut-split-chat-w3', 30, 'right');
  const [chatCollapsed, setChatCollapsed] = useState(false);
  // Was the collapse the WINDOW's decision (too narrow for both columns) or the
  // user's? An automatic collapse belongs to the view that asked for it, so
  // switching tabs drops it; a hand-hidden chat sticks until the user says
  // otherwise. Every user-driven toggle goes through collapseChat.
  const autoCollapsed = useRef(false);
  const collapseChat = useCallback((collapsed: boolean) => {
    autoCollapsed.current = false;
    setChatCollapsed(collapsed);
  }, []);
  // Opening a view decides the chat column's fate: below the split floor the Inbox
  // tab opens on the letter alone (the chat column has a 280px floor, and half a
  // letter is worse than one click on "show chat"); any other view clears a
  // collapse that was automatic so a tab hop can't silently lose the chat.
  const applyOpenCollapse = useCallback((view: SessionSplitView) => {
    if (view === 'inbox' && window.innerWidth < SPLIT_MIN_WIDTH) {
      autoCollapsed.current = true;
      setChatCollapsed(true);
      return;
    }
    if (autoCollapsed.current) { autoCollapsed.current = false; setChatCollapsed(false); }
  }, []);
  // File-path click target for the Files split view. When set, the explorer roots
  // at the clicked file (backend lists its parent + preselects it, VS Code style)
  // instead of the session cwd. Cleared when the split closes / view switches.
  const [fileViewTarget, setFileViewTarget] = useState<{ path: string; line?: number; term?: string } | null>(null);
  // Toggle a split view: same view → close (exit fullscreen); other/none → open it.
  //
  // Exception kept: Files opened via a file-path click (fileViewTarget set) — the
  // chip's first click re-roots the explorer to the session cwd so you can browse
  // the whole tree, the second closes. The re-root no longer loses your place: the
  // explorer's memory is scope-keyed, so the same file stays open and the tree
  // expands to it under the new root (that loss WAS the reported bug).
  const toggleView = useCallback((view: SessionSplitView) => {
    const rerooting = view === 'files' && fileViewTarget !== null && activeView === 'files';
    setFileViewTarget(null);
    if (rerooting) return; // stay open, explorer re-roots to the session cwd
    // `next` is computed from this render's activeView (already a dependency)
    // rather than inside the updater: the side effects below are not pure, and
    // StrictMode double-invokes an updater.
    const next = activeView === view ? null : view;
    traceInteraction(next ? `view-open:${next}` : `view-close:${view}`, { sessionId });
    setActiveView(next);
    if (next) { enterFullscreen(); applyOpenCollapse(next); } else { exitFullscreen(); collapseChat(false); }
  }, [enterFullscreen, exitFullscreen, fileViewTarget, activeView, applyOpenCollapse, collapseChat]);
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
  const codeHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (codeHoverTimer.current) clearTimeout(codeHoverTimer.current); }, []);
  // Clicking a file path in the chat opens it in the SAME split layout as
  // Changed/Files/Terminal — file explorer + preview on the left, the live chat
  // in the resizable right column (replaces the old full-screen FileViewer modal).
  // EVERY file type goes here, vault notes included: a click must never navigate
  // the app away from the session (that jump was reverted 2026-08-09). Notes get
  // an explicit "Open in Notes" button in the preview toolbar / right-click menu.
  const handleFileOpen = useCallback((path: string, line?: number, term?: string) => {
    traceInteraction('view-open:files-from-path', { sessionId });
    setFileViewTarget({ path, line, term });
    setActiveView('files');
    enterFullscreen();
  }, [enterFullscreen]);

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
  const handleLetterFileOpen = useCallback(
    (target: { path: string; line?: number }) => handleFileOpen(target.path, target.line),
    [handleFileOpen],
  );
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

  // Reset execute + fullscreen state when session changes
  useEffect(() => {
    setExecuting(false);
    setExecuteError(null);
    setExecuteStarted(false);
    setPlanPopoverOpen(false);
    setNotesOpen(false);
    setMessagesOpen(false);
    setActiveView(null);
    setFileViewTarget(null);
    setInboxLetterId(null);
    exitFullscreen();
  }, [sessionId, exitFullscreen]);

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
  }, [sessionId, openInboxTab]);

  // If the user exits fullscreen (ESC / backdrop) while a split view is open, close
  // it too so the body returns to the normal single-column chat.
  //
  // …UNLESS a deep link is still SETTLING. A link followed from another route
  // (`/sessions?id=…&tab=inbox`, or a notification clicked on /tasks) opens the
  // column before React Router's `useLocation()` catches up with the URL, so the
  // panel mounts believing it is on the old route and then sees a pathname change —
  // and a pathname change is useFullscreen's "you navigated away" exit. That
  // dropped fullscreen a few ms after the tab opened, and this guard read it as
  // "the user pressed Escape" and closed the very view the link asked for.
  //
  // Re-asserting fullscreen is a LOADED move (useFullscreen's backdrop is
  // portalled to document.body, so putting it back after a REAL navigation strands
  // a blurred click-blocking sheet over the new page — the 2026-08-09 incident), so
  // the decision is a pure rule with four conditions and lives in
  // `deepLinkFullscreenReassert`, where it is unit-pinned.
  const settledClaim = useRef('');
  useEffect(() => {
    if (isFullscreen || !splitOpen) return;
    const key = deepLinkFullscreenReassert({
      claim: claimedInboxLink.current,
      sessionId,
      settledKey: settledClaim.current,
      routeChangedAt: routeChangedAt.current,
      path: routePath.current,
      now: Date.now(),
    });
    if (key) {
      settledClaim.current = key;
      enterFullscreen();
      return;
    }
    setActiveView(null);
    setFileViewTarget(null);
  }, [isFullscreen, splitOpen, sessionId, enterFullscreen]);

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

  const [terminateBusy, setTerminateBusy] = useState(false);
  const handleTerminate = useCallback(async () => {
    log.info('session-panel', 'terminate button clicked', { sessionId });
    setTerminateBusy(true);
    try {
      await terminateSession(sessionId);
    } catch (err) {
      // 409 cron_owner: this session owns recurring CLI crons — killing it
      // silently migrates them to any other session sharing the project
      // directory. Surface the choice instead of failing quietly.
      const status = (err as { status?: number })?.status;
      if (status === 409) {
        const proceed = await confirmDialog({
          title: 'Session owns scheduled crons',
          message: 'Stopping this session will NOT stop its recurring scheduled tasks — they persist in the project directory and will fire into any other session that shares it, without provenance. Terminate anyway?',
          confirmLabel: 'Terminate anyway',
          cancelLabel: 'Keep running',
          danger: true,
        });
        if (proceed) {
          try {
            await terminateSession(sessionId, { force: true });
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
    setTerminateBusy(false);
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

  // "@<session> message" routing (Claude Code's direct-message convention): a
  // leading @ + id prefix resolved to another session sends THERE, not here.
  // Resolution is server-side (unique-prefix or nothing — 409 on ambiguity), so
  // an unresolvable ref falls through to a normal send and no text is lost.
  const [routedNotice, setRoutedNotice] = useState<{ sessionId: string; shortId: string; title: string } | null>(null);
  const routedNoticeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(routedNoticeTimerRef.current), []);

  const handleSend = useCallback(async (message: string, images?: ImageAttachment[]) => {
    const directive = parseSessionDirective(message);
    if (directive) {
      let target = null;
      try {
        target = await fetchSession(directive.ref);
      } catch { /* ambiguous prefix / transient — treat as unresolved */ }
      if (target && target.claudeSessionId !== sessionId) {
        try {
          const res = await wsClient.sendRpc<{ messageId: string }>('session:send', {
            sessionId: target.claudeSessionId,
            message: directive.body,
            ...(await buildImageRefsPayload(images)),
          });
          if (res?.messageId) {
            setRoutedNotice({
              sessionId: target.claudeSessionId,
              shortId: target.claudeSessionId.slice(0, 8),
              title: target.title || '(untitled)',
            });
            clearTimeout(routedNoticeTimerRef.current);
            routedNoticeTimerRef.current = setTimeout(() => setRoutedNotice(null), 6000);
            return true;
          }
          return false;
        } catch {
          return false; // ChatInput restores the draft on false
        }
      }
    }
    return send(sessionId, message, images);
  }, [sessionId, send]);

  const handleInterruptSend = useCallback((message: string, images?: ImageAttachment[]) => {
    return interruptSend(sessionId, message, images);
  }, [sessionId, interruptSend]);

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

  const ps = session?.process_status;
  // Phase is forwarded to SessionChatHistory for resume detection logic,
  // not for UI display in this panel.
  const taskPhase = (sessionTask?.phase ?? 'TODO') as TaskPhase;

  // Header content — prefer the linked task title; fall back to session metadata.
  const sessionFallbackTitle = session?.title || session?.description || session?.slug || null;
  const headerTitle = (session?.taskId ? taskTitle : null) || sessionFallbackTitle;

  const planContentValue = plan?.content ?? null;

  // Model info pill — moved from the header meta row into the composer's
  // controls row (rendered inside both ChatInput controlsSlot mode bars).
  // EVERY engine opens the SAME two-pane picker (provider rail | models) — an
  // ACP session just opens it on the ACP pane, with the others greyed.
  const modelInfoPill = engineUi.isAcp ? (
    <button
      type="button"
      className="session-detail-model-pill session-detail-model-pill-clickable composer-model-pill"
      title={`Switch ${engineUi.displayName} model`}
      onClick={(e) => { modelPillRef.current = e.currentTarget; setModelPickerOpen((v) => !v); }}
    >
      {/* 3 tiers: the provider's own name (minus its provider prefix — a pill
          reading "Amazon Bedrock/Claude…" is all provider, no model), else
          prettify the id, else the engine. */}
      {acpModelDisplayName(session?.acpModel, session?.acpModelName) ?? engineUi.displayName}
      {contextPercent != null && (
        <span className="session-detail-context-pct"> {contextPercent}%</span>
      )}
    </button>
  ) : (
    // No rawModel yet ≠ no pill: a todo-launcher quick start (empty first
    // message) idles with a model-less record until its first real turn, and
    // hiding the pill hides the ONLY model/effort entry point ("model option
    // doesn't show"). Render "Auto" — the picker itself live-pulls the truth.
    <button
      type="button"
      className="session-detail-model-pill session-detail-model-pill-clickable composer-model-pill"
      title={`${rawModel || (autoResolved ? `Auto — CLI default resolves to ${autoResolved} on this host` : 'Model not reported yet (Auto)')} — click to switch model / effort`}
      onClick={(e) => { modelPillRef.current = e.currentTarget; setModelPickerOpen((v) => !v); }}
    >
      {displayModel || (autoResolved ? `Auto (${autoResolved})` : 'Auto')}
      {contextPercent != null && (
        <span
          className="session-detail-context-pct"
          style={{
            color: contextPercent > 80 ? 'var(--danger, #ff3b30)'
              : contextPercent > 50 ? 'var(--warning, #ff9500)'
              : 'var(--fg-muted)',
          }}
          title={contextBadgeTitle(badgeUsage, contextPercent)}
        >
          {' '}{contextPercent}%
        </span>
      )}
      {modelSupportsEffort(rawModel) && (() => {
        // Badge shows the CLI's TRUE effort (effectiveEffort, read back via
        // get_settings) — falling back to the requested level. When the CLI
        // overrode the request (env / downgrade), flag it.
        //
        // NO fabricated default. This used to fall back to DEFAULT_SESSION_EFFORT
        // ('high') and render it exactly like a confirmed reading — which is how
        // the pill came to say "High" while the picker said "X-High" for the same
        // session: the user's level lives in the CLI's OWN settings.json
        // (effortLevel), which Walnut never requests, so record.effort is
        // undefined and the guess was simply wrong. An honest gap beats a
        // confident wrong number: render nothing until a real value exists (the
        // session-start read-back fills it in ~1.5s via session:settings-applied).
        const shown = session?.effectiveEffort ?? session?.effort;
        if (!shown) return null;
        const overridden = session?.effectiveEffort != null && session?.effort != null
          && session.effectiveEffort !== session.effort;
        const title = overridden
          ? `Reasoning effort: ${session!.effectiveEffort} (requested ${session!.effort}, overridden by env/model)`
          : session?.effectiveEffort
          ? `Reasoning effort: ${session.effectiveEffort} (confirmed by CLI)`
          : `Reasoning effort: ${shown} (requested — not yet confirmed by the CLI)`;
        // Same label table the picker's segments use, so one truth reads the same
        // on both surfaces ("X-High", not the raw id "xhigh").
        const label = SESSION_EFFORTS.find((e) => e.id === shown)?.label ?? shown;
        return (
          <span className="session-detail-effort-badge" title={title}>
            {' · '}{label}{overridden ? ' ⚠' : ''}
          </span>
        );
      })()}
    </button>
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
          <button className="btn btn-sm btn-primary" onClick={() => onClose(sessionId)}>
            Close panel
          </button>
        </div>
      </div>
    );
  }

  return (
    <PlanContentContext.Provider value={planContentValue}>
    <SessionPinsContext.Provider value={pinsApi}>
    <SessionRewindContext.Provider value={rewindApi}>
    <SessionPanelErrorBoundary sessionId={sessionId} onClose={onClose}>
      {FullscreenBackdrop}
      {rewindTarget && (
        <SessionRewindDialog
          sessionId={sessionId}
          msgId={rewindTarget.msgId}
          {...(rewindTarget.label ? { label: rewindTarget.label } : {})}
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
              });
              clearSessionCaches(sessionId);
              setRewindEpoch((e) => e + 1);
              return;
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
      <div
        className={`session-panel${fullscreenClass}${splitOpen ? ' is-changed-open' : ''}`}
        data-session-id={sessionId}
        ref={panelRef}
      >
        {/* needs-action: same red tint + same rule (taskNeedsAction) as the pin
            area's cards, so "the agent handed this back" reads identically on
            both surfaces. Independent of the walnut amber TITLE — background is
            the state highlight, text color is the origin marker. */}
        <div
          className={`session-panel-header${sessionTask && taskNeedsAction(sessionTask) ? ' session-panel-header-needs-action' : ''}`}
          ref={glassHeaderRef}
        >
          {/* Two-row header, and the split is deliberate (2026-07-27):
              ROW 1 = tool chips (Plan / Fork / Changed / Files / Terminal) + time
                      + EVERY icon button (locate / lock / popout / expand / close).
              ROW 2 = the TITLE on its own full-width line. Only two things may
                      share it: the status badge and the ⋮ kebab.
              Before this the title shared one row with 5 icon buttons and the
              status pill, so in a normal 3-column layout it collapsed to ~105px
              ("Fork of ek…"). Anything new belongs in row 1 or the kebab — never
              next to the title. Open-in-VS-Code lives in the kebab only. */}
          {/* ROW 1 — tool chips + time on the left, window controls pinned right.
              Session id / SSH host / Open-in-VS-Code all live in the ⋮ kebab. */}
          <div className="session-meta-row-2">
            <div className="session-meta-row-2-chips">
            {/* Plan & Execute \u2014 shown whenever a plan actually exists (regardless
                of mode), or there's something executable. */}
            {(hasPlanContent || showExecuteButtons) && (
              <>
                <button
                  className={`session-action-chip${planPopoverOpen ? ' session-action-chip-active' : ''}`}
                  onClick={() => setPlanPopoverOpen(o => !o)}
                  title="Plan & Execute"
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
                                {executing ? 'Starting\u2026' : '\u25B6 Execute'}
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
                          <PlanPopoverContent content={plan.content} cwd={session?.cwd} />
                        )}
                      </div>
                      <div className="plan-popup-input">
                        {/* Recap tip — one line "what just happened" (self-report) right above
              the composer, so the user re-orients on a long session without
              re-reading the transcript. Hidden while streaming (live output
              makes it redundant). */}
          {session?.recap && !isStreaming && (
            <div className="session-recap-tip" title={session.recap}>
              <span className="session-recap-tip-icon">💬</span>
              <span className="session-recap-tip-text">{session.recap}</span>
            </div>
          )}
          <ChatInput
            controlsSlot={session ? (() => {
              // Mode toggle uses session.mode only (not planCompleted) — planCompleted
              // is a separate flag meaning "plan was produced", it shouldn't lock the toggle.
              // Rendered INSIDE the composer card's controls row (D6), between the
              // "+" and the mic/send cluster.
              // Labels come from the ONE mode registry (core/types.ts) so a mode
              // added there shows a real label instead of its raw id ('dontAsk').
              const MODE_LABELS: Record<string, string> = SESSION_MODE_LABELS;
              const currentMode = session.mode || 'default';
              const isPlan = currentMode === 'plan';
              const currentIdx = enabledModes.indexOf(currentMode);
              const nextMode = enabledModes[(currentIdx + 1) % enabledModes.length]!;
              const toggleMode = () => {
                setSession({ ...session, mode: nextMode });
                updateSession(session.claudeSessionId, { mode: nextMode }).catch(err => {
                  setSession({ ...session, mode: currentMode }); // revert
                  console.warn('[session-panel] mode toggle failed', session.claudeSessionId, nextMode, err);
                });
              };
              const label = MODE_LABELS[currentMode] ?? currentMode;
              return (
                <div className="session-mode-bar">
                  {engineUi.configModes ? (
                    <SessionControlPills
                      controls={sessionControls}
                      setControl={setSessionControl}
                      engineName={engineUi.displayName}
                      showModeShortcut
                    />
                  ) : (
                    <button
                      className={`mode-toggle-pill${isPlan ? ' plan-active' : ''}`}
                      onClick={toggleMode}
                      title={`Mode: ${currentMode}. Click or Shift+Tab to cycle → ${nextMode}`}
                    >
                      <span className="mode-toggle-pill-label">
                        {label}
                      </span>
                      <span className="mode-toggle-pill-shortcut">{'\u21E7'}Tab</span>
                    </button>
                  )}
                  <OutputModePill
                    sessionId={session.claudeSessionId}
                    mode={session.output_mode}
                    onOptimistic={(output_mode) => setSession(prev => prev ? { ...prev, output_mode } : prev)}
                  />
                  <SideQuestionDrawer
                    sessionId={session?.claudeSessionId}
                    engine={session?.engine}
                    cwd={session?.cwd}
                    host={session?.host}
                    parentMode={session?.mode}
                    onInjectToComposer={handleInjectFromThread}
                  />
                  <SessionNotesPill
                    noteState={noteState}
                    expanded={notesOpen}
                    onToggleExpanded={() => setNotesOpen(o => !o)}
                  />
                  {modelInfoPill}
                </div>
              );
            })() : undefined}
                          onSend={handleSend}
                          onInterruptSend={handleInterruptSend}
                          onStop={handleStopTurn}
                          isStreaming={isStreaming}
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
                            const next = enabledModes[(enabledModes.indexOf(cur) + 1) % enabledModes.length]!;
                            setSession({ ...session, mode: next });
                            updateSession(session.claudeSessionId, { mode: next }).catch(err => {
                              setSession({ ...session, mode: cur }); // revert
                              console.warn('[session-panel] mode toggle failed', session.claudeSessionId, next, err);
                            });
                          } : undefined}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
            <SessionForkButton
              sessionId={sessionId}
              session={session}
              sourceTitle={headerTitle}
              onOpenForkDraft={onOpenForkDraft}
            />
            <button
              className={`session-action-chip${activeView === 'changed' ? ' session-action-chip-active' : ''}`}
              onClick={() => toggleView('changed')}
              title="See the files this session changed — full-screen diff alongside the chat"
            >
              Changed
            </button>
            <button
              className={`session-action-chip${activeView === 'files' ? ' session-action-chip-active' : ''}`}
              onClick={() => toggleView('files')}
              title="Browse the session working directory — full-screen alongside the chat"
            >
              Files
            </button>
            <button
              className={`session-action-chip${activeView === 'terminal' ? ' session-action-chip-active' : ''}`}
              onClick={() => toggleView('terminal')}
              title="Open a terminal in the session working directory — full-screen alongside the chat"
            >
              Terminal
            </button>
            {/* Inbox — peer of the other tabs. The badge counts THIS session's
                letters that still want the human: unread OR waiting on a decision,
                each letter once (a decision read-but-not-answered is the whole
                point of an async ask, and gating on unread alone left the chip
                bare while the agent was still blocked). Any unanswered decision in
                the count turns the badge warning-coloured. */}
            <button
              className={`session-action-chip${activeView === 'inbox' ? ' session-action-chip-active' : ''}`}
              onClick={() => toggleView('inbox')}
              title={inboxChipTitle(letterAttention, letterUnread, letterDecisions)}
            >
              Inbox
              {letterAttention > 0 && (
                <span
                  className={`session-action-chip-count${letterDecisions > 0 ? ' session-action-chip-count-warn' : ''}`}
                >
                  {letterAttention > 99 ? '99+' : letterAttention}
                </span>
              )}
            </button>
            <button
              className={`session-action-chip${activeView === 'code' ? ' session-action-chip-active' : ''}`}
              onClick={() => toggleView('code')}
              // Hover = intent: warm the ensure (spawn/adopt + tunnel) so the
              // click usually finds it already resolved. install=false inside.
              // DWELL first: the chip sits at the end of the tab strip, so the
              // pointer crosses it on the way to Files/Terminal. Each crossing
              // used to fire a POST that the server answered in ~5s (remote
              // host probe) and that, as a write, jumped the browser's 6-slot
              // fetch queue — the Files tree the user actually clicked waited
              // behind it (2026-09-02: "open Files, ~5s until it shows").
              onMouseEnter={() => {
                if (!sessionId) return;
                codeHoverTimer.current = setTimeout(() => prefetchVscodeEmbed(sessionId), CODE_PREFETCH_DWELL_MS);
              }}
              onMouseLeave={() => {
                if (codeHoverTimer.current) { clearTimeout(codeHoverTimer.current); codeHoverTimer.current = null; }
              }}
              title="Embedded VS Code in the session working directory — full-screen alongside the chat"
            >
              Code
            </button>
            {/* Model pill + turn count moved out of the header (2026-07-25):
                the pill now lives in the composer controls row (modelInfoPill,
                rendered in both ChatInput controlsSlot mode bars); the turn
                count was removed entirely. Time-ago stays. */}
            {session?.lastActiveAt && <span className="session-panel-time">{timeAgo(session.lastActiveAt)}</span>}
            </div>{/* .session-meta-row-2-chips */}
            <div className="session-panel-window-controls">
              {!loading && session?.taskId && (
                <button
                  className="task-action-btn session-panel-locate"
                  onClick={() => onTaskClick?.(session.taskId!)}
                  title={taskTitle ? `Go to task: ${taskTitle}` : `Go to task ${session.taskId}`}
                  aria-label="Locate task"
                >
                  {ICON_LOCATE}
                </button>
              )}
              {onToggleLock && (
                <button
                  className={`task-action-btn session-panel-lock${locked ? ' is-locked' : ''}`}
                  onClick={() => onToggleLock(sessionId)}
                  title={locked ? 'Unlock — panel will rejoin the rotation' : 'Pin to right — panel stays when new sessions open'}
                  aria-label={locked ? 'Unlock session panel' : 'Lock session panel to the right'}
                  aria-pressed={locked}
                >
                  {locked ? ICON_LOCK : ICON_UNLOCK}
                </button>
              )}
              <button
                className="task-action-btn session-panel-popout"
                onClick={() => openPopout('session', { id: sessionId, host: session?.host, cwd: session?.cwd })}
                title="Open in new tab"
                aria-label="Open session in new tab"
              >
                {ICON_NEW_TAB}
              </button>
              <button
                className="task-action-btn session-panel-expand"
                onClick={isFullscreen ? exitFullscreen : enterFullscreen}
                title={isFullscreen ? 'Collapse back' : 'Expand to full screen'}
                aria-label={isFullscreen ? 'Collapse session' : 'Expand session to full screen'}
              >
                {isFullscreen ? ICON_COLLAPSE : ICON_EXPAND}
              </button>
              <button
                className="task-action-btn session-panel-close"
                onClick={() => onClose(sessionId)}
                title="Close session panel"
                aria-label="Close session panel"
              >
                {ICON_CLOSE}
              </button>
            </div>
          </div>{/* .session-meta-row-2 */}

          {/* ROW 2 — the title gets the whole line; only the status badge and the
              kebab sit beside it. Every icon button lives on row 1. */}
          <div className="session-panel-header-top">
            <div className="session-panel-title-area">
              {!loading && session?.taskId && (
                <TaskQuickActions
                  taskId={session.taskId}
                  task={sessionTask}
                  slot="phase"
                  compact
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
                : <span className="session-panel-title text-muted">Untitled session</span>
              }
            </div>
            <div className="session-panel-title-meta">
              {!loading && session?.provider === 'embedded' && (
                <span
                  className="session-panel-badge"
                  style={{
                    color: 'var(--accent)',
                    background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
                    fontSize: '10px',
                    fontWeight: 600,
                  }}
                >
                  {ICON_ROBOT} Embedded
                </span>
              )}
              {!loading && ps && (
                <ProcessStatusBadge
                  processStatus={ps}
                  size="sm"
                  errorMessage={session?.errorMessage}
                  pendingPermission={session?.pendingPermission}
                />
              )}
              {loading && <span className="session-panel-badge" style={{ color: 'var(--fg-muted)' }}>Loading...</span>}
              {!loading && sessionId && (
                <TaskQuickActions
                  taskId={session?.taskId}
                  task={session?.taskId ? sessionTask : null}
                  isPinned={pinned}
                  pinnedTier={pinnedTier}
                  onPinTask={handlePinTask}
                  onUnpinTask={handleUnpinTask}
                  onSetTier={handleSetTier}
                  onOpenTaskDetail={onOpenTaskDetail}
                  slot="kebab"
                  // Right-clicking the panel header opens this same menu at the
                  // cursor: the header is the session's object, so its actions
                  // belong to the gesture people already try there.
                  contextMenuScope=".session-panel-header"
                  extraSection={(close) => (
                    <SessionKebabSection
                      sessionId={sessionId}
                      cwd={session?.cwd}
                      host={session?.host}
                      hostname={session?.hostname}
                      archived={session?.archived}
                      notesOpen={notesOpen}
                      onToggleNotes={() => setNotesOpen(o => !o)}
                      messagesOpen={messagesOpen}
                      onToggleMessages={() => setMessagesOpen(o => !o)}
                      msgCount={historyMessages.filter(m => m.role === 'user' && m.text.trim()).length}
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
              )}
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
        {ps === 'error' && (() => {
          // Render even with NO errorMessage. An error the backend couldn't label
          // used to render nothing at all \u2014 the user got a red "Error" pill and
          // zero explanation, with the Retry button (which lives in this banner)
          // also hidden, so the session looked permanently bricked
          // (inc-1787439819342). A blank diagnosis is still worth a sentence and
          // a Retry.
          const errorText = session?.errorMessage
            || 'Session ended unexpectedly and no cause was recorded. Reconnect re-checks the host; your conversation is kept.';
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
          const hostLabel = session?.hostname || session?.host || 'The host';
          const bannerText = checking
            ? 'Checking connection\u2026'
            : provedReachable
              ? `${hostLabel} is reachable \u2014 this session's process is not running. Send a message to resume it.`
              : isReconnecting ? 'Reconnecting to remote host...' : errorText;
          return (
            <div className={`session-error-banner${spinning ? ' session-error-banner--reconnecting' : provedReachable ? ' session-error-banner--idle' : ''}`}>
              <span className="session-error-banner-icon">{spinning ? '\u21BB' : provedReachable ? '\u2139\uFE0F' : '\u26A0\uFE0F'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="session-error-banner-text">{bannerText}</span>
                {!calm && session?.errorMessage && (() => {
                  const sug = getErrorSuggestion(session.errorMessage, { host: session.host, provider: session.provider });
                  return sug ? <ErrorSuggestionLink {...sug} /> : null;
                })()}
              </div>
              <SessionRetryButton sessionId={sessionId} onRetried={handleRetried} onResuming={handleResuming} />
            </div>
          );
        })()}
        {ps === 'stopped' && session?.errorMessage && (() => {
          // Idle-timeout reclaim is routine housekeeping, not a failure — the health
          // monitor stops CLI processes after N idle minutes to free memory, and the
          // conversation resumes losslessly via --resume. Showing it as a red Error
          // banner scared users into thinking the session broke (2026-08-10).
          const idle = session.errorMessage.match(/^No output for (\d+) min$/i);
          if (!idle) return null;
          return (
            <div className="session-error-banner session-error-banner--idle">
              <span className="session-error-banner-icon">{'⏸'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="session-error-banner-text">
                  Auto-stopped after {idle[1]} min idle. The conversation is preserved — send a message to resume it.
                </span>
                {(() => {
                  const sug = getErrorSuggestion(session.errorMessage!, { host: session.host, provider: session.provider });
                  return sug ? <ErrorSuggestionLink {...sug} /> : null;
                })()}
              </div>
              <SessionRetryButton sessionId={sessionId} onRetried={handleRetried} onResuming={handleResuming} />
            </div>
          );
        })()}
        {!historyLoading && (ps === 'stopped' || ps === 'error') && !session?.archived
          && historyMessages.filter(m => m.role === 'assistant').length === 0
          && historyMessages.some(m => m.role === 'user') && (
          <div className="session-error-banner" style={{ background: 'color-mix(in srgb, var(--warning) 8%, transparent)', borderColor: 'color-mix(in srgb, var(--warning) 25%, transparent)' }}>
            <span className="session-error-banner-icon">{'\u26A0\uFE0F'}</span>
            <span className="session-error-banner-text">Session returned empty — Claude may have encountered an issue.</span>
            <button className="session-retry-btn" onClick={handleRestart} disabled={restartBusy}>
              {restartBusy ? 'Restarting...' : 'Restart'}
            </button>
          </div>
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
            const chatBarSlot = chatCollapsed ? (
              <button
                type="button"
                className="sfe-btn sfe-tree-toggle session-chat-collapse-btn"
                onClick={() => collapseChat(false)}
                title="Show chat"
                aria-label="Show chat"
                aria-expanded={false}
              >{ICON_PANEL_RIGHT}</button>
            ) : null;
            return (
              <>
                {splitOpen && sessionId && activeView !== 'code' && (
                  <div className="session-panel-diff-col">
                    {activeView === 'changed' && (
                      <SessionDiffView sessionId={sessionId} sessionCwd={session?.cwd} sessionHost={session?.host} onSelectCode={handleSelectCode} onComment={handleDiffComment} barRightSlot={chatBarSlot} onOpenFile={handleFileOpen} />
                    )}
                    {activeView === 'files' && (
                      <SessionFileExplorer
                        cwd={fileViewTarget?.path ?? session?.cwd}
                        host={session?.host}
                        sessionId={sessionId}
                        initialLine={fileViewTarget?.line}
                        initialTerm={fileViewTarget?.term}
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
                        barRightSlot={chatBarSlot}
                      />
                    )}
                    {activeView === 'terminal' && (
                      <SessionTerminal
                        sessionId={sessionId}
                        label={session?.cwd ?? session?.host ?? 'Terminal'}
                        host={session?.host}
                        onClose={() => toggleView('terminal')}
                        embedded
                        barRightSlot={chatBarSlot}
                      />
                    )}
                    {/* Inbox: this session's letters, reader in place. Same split
                        as its peers, so chat-left + letter-right is free. */}
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
                  <div className={`session-panel-diff-col session-panel-code-col${activeView === 'code' ? '' : ' session-panel-code-col-hidden'}`}>
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
            className="session-panel-chat-col"
            ref={splitOpen ? chatPanel.panelRef : undefined}
            style={splitOpen && !chatCollapsed ? { width: chatPanel.width, flex: `0 0 ${chatPanel.width}` } : undefined}
          >
            {/* The chat's own segment of the full-width bar: the left view's
                toolbar + this strip read as ONE bar split by the column divider,
                with the two layout toggles at the bar's two corners. */}
            {splitOpen && !chatCollapsed && (
              <div className="session-chat-bar">
                <span className="session-chat-bar-title">Chat</span>
                <button
                  type="button"
                  className="sfe-btn sfe-tree-toggle session-chat-collapse-btn"
                  onClick={() => collapseChat(true)}
                  title="Hide chat"
                  aria-label="Hide chat"
                  aria-expanded
                >{ICON_PANEL_RIGHT_FILLED}</button>
              </div>
            )}
        <div className="session-panel-body" ref={bodyRef}>
          <SessionChatHistory
            key={`${sessionId}:${rewindEpoch}`}
            sessionId={sessionId}
            engine={session?.engine}
            phase={taskPhase}
            initialPrompt={initialPromptText}
            sessionCwd={session?.cwd}
            sessionHost={session?.host}
            optimisticMessages={optimisticMsgs}
            onMessagesDelivered={handleMessagesDelivered}
            onBatchCompleted={handleBatchCompleted}
            onBatchFailed={handleBatchFailed}
            onEditQueued={handleEdit}
            onDeleteQueued={handleDelete}
            onAgentQueued={addExternalQueued}
            onRetryFailed={handleRetry}
            onDismissFailed={dismissFailed}
            onTaskClick={onTaskClick}
            onSessionClick={onSessionClick}
            onFileOpen={handleFileOpen}
            onStreamingChange={setIsStreaming}
            // Same nonce that drives the prefill: asking about a selection must
            // also SHOW the end of the conversation, or the composer fills in
            // while the timeline still sits wherever the user last scrolled.
            scrollToBottomNonce={prefillNonce}
          />
        </div>

        <div className="session-panel-input" ref={glassComposerRef}>
          {/* Sticky-note bar — always visible once a note exists (also hosts the
              editor when opened from the pill/kebab while empty). Lives INSIDE
              the composer overlay so the tracked --sp-composer-h includes it
              (the overlay floats over the scroll area; anything outside it
              would be hidden behind the glass). */}
          <SessionNotesBar
            noteState={noteState}
            expanded={notesOpen}
            onToggleExpanded={() => setNotesOpen(o => !o)}
            onCollapse={() => setNotesOpen(false)}
          />
          {sendError && (
            <div className="text-xs" style={{ color: 'var(--error)', padding: '4px 12px' }}>
              {sendError}
            </div>
          )}
          {/* Recap tip — one line "what just happened" (self-report) right above
              the composer, so the user re-orients on a long session without
              re-reading the transcript. Hidden while streaming (live output
              makes it redundant). */}
          {session?.recap && !isStreaming && (
            <div className="session-recap-tip" title={session.recap}>
              <span className="session-recap-tip-icon">💬</span>
              <span className="session-recap-tip-text">{session.recap}</span>
            </div>
          )}
          {routedNotice && (
            <div className="session-routed-notice" role="status">
              <span aria-hidden="true">↗</span>
              {/* This is the ONLY outgoing surface for a session→session message
                  (a routed send leaves no bubble in the sender's timeline), so it
                  carries the same clickable "which session" chip the incoming
                  provenance card does — click it to open that column. */}
              <span>
                Sent to{' '}
                <button
                  type="button"
                  className="provenance-chip provenance-chip-session"
                  title={`Open session ${routedNotice.sessionId}`}
                  onClick={() => onSessionClick?.(routedNotice.sessionId)}
                >{`@${routedNotice.shortId}`}</button>{' '}
                {routedNotice.title}
              </span>
              <button
                type="button"
                className="session-routed-notice-dismiss"
                aria-label="Dismiss"
                onClick={() => setRoutedNotice(null)}
              >
                &times;
              </button>
            </div>
          )}
          <ChatInput
            controlsSlot={session ? (() => {
              // Mode toggle uses session.mode only (not planCompleted) — planCompleted
              // is a separate flag meaning "plan was produced", it shouldn't lock the toggle.
              // Rendered INSIDE the composer card's controls row (D6), between the
              // "+" and the mic/send cluster.
              // Labels come from the ONE mode registry (core/types.ts) so a mode
              // added there shows a real label instead of its raw id ('dontAsk').
              const MODE_LABELS: Record<string, string> = SESSION_MODE_LABELS;
              const currentMode = session.mode || 'default';
              const isPlan = currentMode === 'plan';
              const currentIdx = enabledModes.indexOf(currentMode);
              const nextMode = enabledModes[(currentIdx + 1) % enabledModes.length]!;
              const toggleMode = () => {
                setSession({ ...session, mode: nextMode });
                updateSession(session.claudeSessionId, { mode: nextMode }).catch(err => {
                  setSession({ ...session, mode: currentMode }); // revert
                  console.warn('[session-panel] mode toggle failed', session.claudeSessionId, nextMode, err);
                });
              };
              const label = MODE_LABELS[currentMode] ?? currentMode;
              return (
                <div className="session-mode-bar">
                  {engineUi.configModes ? (
                    <SessionControlPills
                      controls={sessionControls}
                      setControl={setSessionControl}
                      engineName={engineUi.displayName}
                      showModeShortcut
                    />
                  ) : (
                    <button
                      className={`mode-toggle-pill${isPlan ? ' plan-active' : ''}`}
                      onClick={toggleMode}
                      title={`Mode: ${currentMode}. Click or Shift+Tab to cycle → ${nextMode}`}
                    >
                      <span className="mode-toggle-pill-label">
                        {label}
                      </span>
                      <span className="mode-toggle-pill-shortcut">{'\u21E7'}Tab</span>
                    </button>
                  )}
                  <OutputModePill
                    sessionId={session.claudeSessionId}
                    mode={session.output_mode}
                    onOptimistic={(output_mode) => setSession(prev => prev ? { ...prev, output_mode } : prev)}
                  />
                  <SideQuestionDrawer
                    sessionId={session?.claudeSessionId}
                    engine={session?.engine}
                    cwd={session?.cwd}
                    host={session?.host}
                    parentMode={session?.mode}
                    onInjectToComposer={handleInjectFromThread}
                  />
                  <SessionNotesPill
                    noteState={noteState}
                    expanded={notesOpen}
                    onToggleExpanded={() => setNotesOpen(o => !o)}
                  />
                  {modelInfoPill}
                </div>
              );
            })() : undefined}
            onSend={handleSend}
            onInterruptSend={handleInterruptSend}
            onStop={handleStopTurn}
            isStreaming={isStreaming}
            placeholder="Send a message to this session... (/ for commands)"
            showCommands={false}
            sessionCommands={slashCommands}
            searchSessionCommands={searchSlashCommands}
            onRefreshSessionCommands={refreshSlashCommands}
            onControlCommand={handleControlCommand}
            mentionCwd={session?.cwd}
            mentionHost={session?.host}
            enableSessionMention
            sessionMentionSelfId={sessionId}
            draftKey={`draft:session:${sessionId}`}
            prefillText={prefillText}
            prefillNonce={prefillNonce}
            onToggleMode={session ? () => {
              if (engineUi.configModes) {
                const control = sessionControls.find((candidate) => candidate.id === 'mode');
                const next = nextSessionControlValue(control);
                if (control && next) void setSessionControl(control.id, next);
                return;
              }
              const cur = session.mode || 'default';
              const next = enabledModes[(enabledModes.indexOf(cur) + 1) % enabledModes.length]!;
              setSession({ ...session, mode: next });
              updateSession(session.claudeSessionId, { mode: next }).catch(err => {
                setSession({ ...session, mode: cur }); // revert
                console.warn('[session-panel] mode toggle failed', session.claudeSessionId, next, err);
              });
            } : undefined}
          />
          {modelPickerOpen && (
            <ModelPicker
              currentModel={rawModel}
              currentEffort={session?.effectiveEffort ?? session?.effort}
              sessionId={sessionId}
              host={session?.host}
              onSwitch={handleModelSwitch}
              onEffortSwitch={handleEffortSwitch}
              onClose={() => setModelPickerOpen(false)}
              // Live session: engine is a spawn-time fact. The rail shows every
              // registered provider but the others render greyed + locked (no
              // onProviderSwitch) — start a new session to change engines.
              engine={engineUi.id}
              acpCurrentModelId={session?.acpModel}
              onAcpSwitch={engineUi.isAcp ? handleAcpModelSwitch : undefined}
              anchorRef={modelPillRef}
            />
          )}
        </div>
          </div>{/* .session-panel-chat-col */}
        </div>{/* .session-panel-split */}
      </div>
    </SessionPanelErrorBoundary>
    </SessionRewindContext.Provider>
    </SessionPinsContext.Provider>
    </PlanContentContext.Provider>
  );
});
