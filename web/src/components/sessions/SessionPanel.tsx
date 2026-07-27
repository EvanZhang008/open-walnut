import { useState, useEffect, useCallback, useRef, useMemo, Component, type ReactNode, type ErrorInfo, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { SessionChatHistory } from './SessionChatHistory';
import { SessionNotesPill, SessionNotesBar, useSessionNote } from './SessionNotes';
import { SessionFileExplorer } from './SessionFileExplorer';
import { SessionTerminal } from './SessionTerminal';
import { SessionDiffView } from './SessionDiffView';
import { buildSelectionPrefill } from './diffPrefill';
import type { SessionSplitView } from './sessionSplitView';
import { ICON_ROBOT, ICON_EXPAND, ICON_COLLAPSE, ICON_CLOSE, ICON_LOCK, ICON_UNLOCK, ICON_LOCATE, ICON_NEW_TAB, ICON_VSCODE } from '../common/Icons';
import { openPopout } from '@/popout/openPopout';
import { UserMessagesSummary } from './UserMessagesSummary';
// PlanPreviewSection replaced by inline plan popover in meta bar
import { ChatInput } from '@/components/chat/ChatInput';
import { SideQuestionDrawer } from '@/components/sessions/SideQuestionDrawer';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { useSessionSend } from '@/hooks/useSessionSend';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { useSessionHistory } from '@/hooks/useSessionHistory';
import { useNotesAwareFileOpen } from '@/hooks/useNotesAwareFileOpen';
import type { ImageAttachment } from '@/api/chat';
import { useEvent } from '@/hooks/useWebSocket';
import { fetchSession, executePlanContinue, executePlanSession, updateSession, restartSession, terminateSession, investigateSession, setSessionEffort, setSessionModel } from '@/api/sessions';
import { terminalPrewarm } from '@/api/terminal';
import { log } from '@/utils/log';
import { buildInvestigationClip } from '@/utils/investigation-clipboard';
import { fetchTask } from '@/api/tasks';
import { EditableSessionTitle } from './EditableSessionTitle';
import { useFocusBarContext } from '@/contexts/FocusBarContext';
import type { FocusTier } from '@/api/focus';
import { timeAgo } from '@/utils/time';
import { ProcessStatusBadge } from './WorkStatusPicker';
import { SessionForkButton } from './SessionForkButton';
import { SessionKebabSection } from './SessionKebabSection';
import { ModelPicker } from './ModelPicker';
import { CodexModelPicker } from './CodexModelPicker';
import { modelSupportsEffort, DEFAULT_SESSION_EFFORT } from '@open-walnut/core';
import { TaskQuickActions } from './TaskQuickActions';
import { useFullscreen } from '@/hooks/useFullscreen';
import { useResizablePanel } from '@/hooks/useResizablePanel';
import { useSessionUsage, formatModelName, getContextWindowSize } from '@/hooks/useSessionUsage';
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
import { nextSessionControlValue, SessionControlPills } from './SessionControlPills';
import { openSessionInVscode } from './openSessionInVscode';
import { useNotifications } from '@/contexts/notifications';

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
  const html = useMemo(() => renderMarkdownWithRefs(content, cwd), [content, cwd]);
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
  /** Called immediately when Fork is clicked — parent can show a pending panel. */
  onForkPending?: (cwd: string, host?: string) => void;
  /** Called when fork API returns — parent stores taskId for WS-based session resolution. */
  onForkResolved?: (taskId: string, sessionId?: string) => void;
  /** Called when fork API fails — parent should show error on the pending panel. */
  onForkFailed?: (errorMessage?: string) => void;
}

export const SessionPanel = memo(function SessionPanel({ sessionId, onClose, locked, onToggleLock, onTaskClick, onOpenTaskDetail, onSessionClick, onSessionReplaced, onForkPending, onForkResolved, onForkFailed }: SessionPanelProps) {
  const navigate = useNavigate();
  const { notify } = useNotifications();
  const enabledModes = useEnabledModes();
  const [sessionRecord, setSession] = useState<SessionRecord | null>(null);
  const session = useResolvedSessionRecord(sessionRecord);
  const { controls: sessionControls, setControl: setSessionControl } = useSessionControls(
    sessionId,
    session?.engine,
  );
  const [loading, setLoading] = useState(true);
  const { optimisticMsgs, sendError, send, interruptSend, retryFailed, dismissFailed, handleMessagesDelivered, handleBatchCompleted, handleBatchFailed, handleEditQueued, handleDeleteQueued, addExternalQueued } = useSessionSend(sessionId);
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
  // CSS-promotion fullscreen (same instance, no remount)
  const { isFullscreen, enterFullscreen, exitFullscreen, fullscreenClass, FullscreenBackdrop } = useFullscreen();

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
  const { messages: historyMessages, loading: historyLoading } = useSessionHistory(sessionId);

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
  const displayModel = formatModelName(rawModel);
  let contextPercent = liveUsage.contextPercent;
  if (contextPercent == null && lastAssistant?.usage) {
    const u = lastAssistant.usage as Record<string, number>;
    const totalInput = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    if (totalInput > 0) {
      const ctxSize = getContextWindowSize(rawModel, totalInput);
      contextPercent = Math.round(totalInput / ctxSize * 100);
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

  // Task title for the breadcrumb link
  const [taskTitle, setTaskTitle] = useState<string | null>(null);
  // Full task object — passed to TaskQuickActions to avoid a duplicate fetch
  const [sessionTask, setSessionTask] = useState<import('@open-walnut/core').Task | null>(null);

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
    setTaskTitle(null);
    setSessionTask(null);
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
              if (!cancelled) {
                setTaskTitle(t.title);
                setSessionTask(t);
              }
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
        setSessionTask(prev => prev ? { ...prev, phase: d.phase as import('@open-walnut/core').Task['phase'] } : prev);
      }
    }
  });

  // Keep sessionTask in sync with real-time task events (phase changes, completions)
  useEvent('task:updated', (data) => {
    const d = data as { task?: import('@open-walnut/core').Task };
    if (d.task && session?.taskId && d.task.id === session.taskId) {
      setSessionTask(d.task);
      setTaskTitle(d.task.title);
    }
  });
  useEvent('task:completed', (data) => {
    const d = data as { task?: import('@open-walnut/core').Task };
    if (d.task && session?.taskId && d.task.id === session.taskId) {
      setSessionTask(d.task);
      setTaskTitle(d.task.title);
    }
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

  // Re-fetch session state on WebSocket reconnect.
  // Events during disconnect (e.g. session:status-changed, session:result) are lost;
  // without this, the UI can show stale "Resuming session..." indefinitely.
  // Typical trigger: a `dev:prod` server restart drops the WS connection briefly.
  useEvent('_ws:reconnected', () => {
    if (sessionId) {
      fetchSession(sessionId).then((s) => { if (s) setSession(s); }).catch(() => {});
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
  const [messagesOpen, setMessagesOpen] = useState(false);
  // Changed / Files / Terminal all share ONE full-screen split: [ left panel | chat ].
  // null = none open. Opening any view promotes the panel to fullscreen.
  const [activeView, setActiveView] = useState<SessionSplitView | null>(null);
  const splitOpen = activeView !== null;
  // ChatInput prefill driver — selecting code in the diff drops a prompt into the
  // existing input (no new chat, no fork; goes to the main agent via normal send).
  const [prefillText, setPrefillText] = useState<string | undefined>(undefined);
  const [prefillNonce, setPrefillNonce] = useState(0);
  const handleSelectCode = useCallback((filePath: string, line: number | undefined, code: string) => {
    setPrefillText(buildSelectionPrefill(filePath, line, code));
    setPrefillNonce((n) => n + 1);
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
  // File-path click target for the Files split view. When set, the explorer roots
  // at the clicked file (backend lists its parent + preselects it, VS Code style)
  // instead of the session cwd. Cleared when the split closes / view switches.
  const [fileViewTarget, setFileViewTarget] = useState<{ path: string; line?: number } | null>(null);
  // Toggle a split view: same view → close (exit fullscreen); other/none → open it.
  // Exception: Files opened via a file-path click (fileViewTarget set) — the chip
  // first re-roots the explorer back to the session cwd, second click closes.
  const toggleView = useCallback((view: SessionSplitView) => {
    const rerooting = view === 'files' && fileViewTarget !== null && activeView === 'files';
    setFileViewTarget(null);
    if (rerooting) return; // stay open, explorer re-roots to the session cwd
    setActiveView((cur) => {
      const next = cur === view ? null : view;
      if (next) enterFullscreen(); else { exitFullscreen(); setChatCollapsed(false); }
      return next;
    });
  }, [enterFullscreen, exitFullscreen, fileViewTarget, activeView]);
  // Clicking a file path in the chat opens it in the SAME split layout as
  // Changed/Files/Terminal — file explorer + preview on the left, the live chat
  // in the resizable right column (replaces the old full-screen FileViewer modal).
  const openFileViewer = useCallback((path: string, line?: number) => {
    setFileViewTarget({ path, line });
    setActiveView('files');
    enterFullscreen();
  }, [enterFullscreen]);
  const handleFileOpen = useNotesAwareFileOpen(openFileViewer, session?.host);
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
    exitFullscreen();
  }, [sessionId, exitFullscreen]);

  // If the user exits fullscreen (ESC / backdrop) while a split view is open, close
  // it too so the body returns to the normal single-column chat.
  useEffect(() => {
    if (!isFullscreen && splitOpen) { setActiveView(null); setFileViewTarget(null); }
  }, [isFullscreen, splitOpen]);

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
      log.error('session-panel', 'terminate API failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    setTerminateBusy(false);
  }, [sessionId]);

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
    try {
      const { incident } = await investigateSession(sessionId, session?.taskId);
      log.info('session-panel', 'investigate captured evidence', { sessionId, incidentId: incident.id, bundlePath: incident.bundlePath });
      const clip = buildInvestigationClip({
        sessionId,
        taskId: session?.taskId,
        incidentId: incident.id,
        bundlePath: incident.bundlePath,
        host: session?.host,
      });
      await navigator.clipboard.writeText(clip).catch(() => {});
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

  const handleSend = useCallback((message: string, images?: ImageAttachment[]) => {
    return send(sessionId, message, images);
  }, [sessionId, send]);

  const handleInterruptSend = useCallback((message: string, images?: ImageAttachment[]) => {
    return interruptSend(sessionId, message, images);
  }, [sessionId, interruptSend]);

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
  // Codex sessions get the CodexModelPicker; its menu is re-anchored to open
  // UPWARD when inside the mode bar (see .session-mode-bar .codex-model-menu).
  const modelInfoPill = session?.engine === 'codex' ? (
    <CodexModelPicker
      sessionId={sessionId}
      currentModelId={session.acpModel}
      contextPercent={contextPercent}
      onModelChange={(acpModel) => {
        setSession((previous) => previous ? { ...previous, acpModel } : previous);
      }}
    />
  ) : displayModel ? (
    <button
      type="button"
      className="session-detail-model-pill session-detail-model-pill-clickable composer-model-pill"
      title={`${rawModel || ''} — click to switch model / effort`}
      onClick={() => setModelPickerOpen((v) => !v)}
    >
      {displayModel}
      {contextPercent != null && (
        <span
          className="session-detail-context-pct"
          style={{
            color: contextPercent > 80 ? 'var(--danger, #ff3b30)'
              : contextPercent > 50 ? 'var(--warning, #ff9500)'
              : 'var(--fg-muted)',
          }}
          title={`Context: ${contextPercent}%${liveUsage.inputTokens ? ` (${Math.round(liveUsage.inputTokens / 1000)}K)` : ''}`}
        >
          {' '}{contextPercent}%
        </span>
      )}
      {modelSupportsEffort(rawModel) && (() => {
        // Badge shows the CLI's TRUE effort (effectiveEffort, read back via
        // get_settings) — falling back to the requested level, then the API
        // default. When the CLI overrode the request (env / downgrade), flag it.
        const shown = session?.effectiveEffort ?? session?.effort ?? DEFAULT_SESSION_EFFORT;
        const overridden = session?.effectiveEffort != null && session?.effort != null
          && session.effectiveEffort !== session.effort;
        const title = overridden
          ? `Reasoning effort: ${session!.effectiveEffort} (requested ${session!.effort}, overridden by env/model)`
          : session?.effectiveEffort
          ? `Reasoning effort: ${session.effectiveEffort} (confirmed by CLI)`
          : session?.effort
          ? `Reasoning effort: ${session.effort} (requested)`
          : `Reasoning effort: ${DEFAULT_SESSION_EFFORT} (default)`;
        return (
          <span className="session-detail-effort-badge" title={title}>
            {' · '}{shown}{overridden ? ' ⚠' : ''}
          </span>
        );
      })()}
    </button>
  ) : null;

  return (
    <PlanContentContext.Provider value={planContentValue}>
    <SessionPanelErrorBoundary sessionId={sessionId} onClose={onClose}>
      {FullscreenBackdrop}
      {/* is-changed-open must sit on the SAME element as open-walnut-fullscreen
          (the .session-panel root) so the `.open-walnut-fullscreen.is-changed-open`
          rule that drops the 1400px cap actually matches — otherwise the split
          view stays guttered at 1400px in this slide-out. */}
      <div
        className={`session-panel${fullscreenClass}${splitOpen ? ' is-changed-open' : ''}`}
        data-session-id={sessionId}
        ref={panelRef}
      >
        <div className="session-panel-header" ref={glassHeaderRef}>
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
                    className="session-panel-title"
                  />
                : <span className="session-panel-title text-muted">Untitled session</span>
              }
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
                />
              )}
              {loading && <span className="session-panel-badge" style={{ color: 'var(--fg-muted)' }}>Loading...</span>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '3px', flexShrink: 0 }}>
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
                className="task-action-btn session-panel-vscode"
                onClick={() => { void openSessionInVscode(sessionId).catch(handleOpenVscodeError); }}
                title="Open in VS Code"
                aria-label="Open in VS Code"
              >
                {ICON_VSCODE}
              </button>
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
          </div>
          {/* Meta row 1 removed — session id + SSH host both moved into the ⋮ kebab
              Session section; open-in-Sessions-page is the title-bar ↗ popout. */}
          {/* Meta row 2: the kept-visible actions (Plan / Fork / Changed / Files /
              Terminal) + model + time. Everything else lives in the \u22EE kebab. */}
          <div className="session-meta-row-2">
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
              const MODE_LABELS: Record<string, string> = {
                default: 'Default', bypass: 'Bypass', plan: 'Plan', accept: 'Accept',
              };
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
                  {session.engine === 'codex' ? (
                    <SessionControlPills
                      controls={sessionControls}
                      setControl={setSessionControl}
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
                  <SideQuestionDrawer sessionId={session?.claudeSessionId} />
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
                          isStreaming={isStreaming}
                          placeholder="Send a message while viewing plan..."
                          showCommands={false}
                          onToggleMode={session ? () => {
                            if (session.engine === 'codex') {
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
              cwd={session?.cwd}
              taskId={session?.taskId}
              engine={session?.engine}
              onForkStarted={(cwd, host) => { onForkPending?.(cwd, host); }}
              onForkComplete={(newTaskId, newSessionId) => { onForkResolved?.(newTaskId, newSessionId); onTaskClick?.(newTaskId); }}
              onForkFailed={(errMsg) => onForkFailed?.(errMsg)}
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
            {/* Model pill + turn count moved out of the header (2026-07-25):
                the pill now lives in the composer controls row (modelInfoPill,
                rendered in both ChatInput controlsSlot mode bars); the turn
                count was removed entirely. Time-ago stays. */}
            {session?.lastActiveAt && <span className="session-panel-time">{timeAgo(session.lastActiveAt)}</span>}
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
        {ps === 'error' && session?.errorMessage && (() => {
          // Coupling: 'Connection lost' is set by session-health-monitor when daemon unreachable.
          // 'Reconnecting' activity is set by the same monitor's recoverConnectionLostSessions().
          const isReconnecting = session.errorMessage.includes('Connection lost')
            && session.activity?.includes('Reconnecting');
          return (
            <div className={`session-error-banner${isReconnecting ? ' session-error-banner--reconnecting' : ''}`}>
              <span className="session-error-banner-icon">{isReconnecting ? '\u21BB' : '\u26A0\uFE0F'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="session-error-banner-text">
                  {isReconnecting ? 'Reconnecting to remote host...' : session.errorMessage}
                </span>
                {!isReconnecting && (() => {
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
          {splitOpen && sessionId && (
            <div className="session-panel-diff-col">
              {activeView === 'changed' && (
                <SessionDiffView sessionId={sessionId} sessionCwd={session?.cwd} sessionHost={session?.host} onSelectCode={handleSelectCode} onComment={handleDiffComment} />
              )}
              {activeView === 'files' && (
                <SessionFileExplorer
                  cwd={fileViewTarget?.path ?? session?.cwd}
                  host={session?.host}
                  sessionId={sessionId}
                  initialLine={fileViewTarget?.line}
                />
              )}
              {activeView === 'terminal' && (
                <SessionTerminal
                  sessionId={sessionId}
                  label={session?.cwd ?? session?.host ?? 'Terminal'}
                  host={session?.host}
                  onClose={() => toggleView('terminal')}
                  embedded
                />
              )}
            </div>
          )}
          {splitOpen && (
            chatCollapsed ? (
              <button
                className="session-chat-collapsed-rail"
                onClick={() => setChatCollapsed(false)}
                title="Show chat"
              >💬</button>
            ) : (
              <div className="session-panel-chat-resize" onMouseDown={chatPanel.handleResizeStart} title="Drag to resize chat" />
            )
          )}
          <div
            className="session-panel-chat-col"
            ref={splitOpen ? chatPanel.panelRef : undefined}
            style={splitOpen && !chatCollapsed ? { width: chatPanel.width, flex: `0 0 ${chatPanel.width}` } : undefined}
          >
            {splitOpen && !chatCollapsed && (
              <button
                className="session-chat-collapse-btn"
                onClick={() => setChatCollapsed(true)}
                title="Collapse chat"
              >⟩</button>
            )}
        <div className="session-panel-body" ref={bodyRef}>
          <SessionChatHistory
            key={sessionId}
            sessionId={sessionId}
            engine={session?.engine}
            phase={taskPhase}
            initialPrompt={historyMessages.find(m => m.role === 'user')?.text}
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
          <ChatInput
            controlsSlot={session ? (() => {
              // Mode toggle uses session.mode only (not planCompleted) — planCompleted
              // is a separate flag meaning "plan was produced", it shouldn't lock the toggle.
              // Rendered INSIDE the composer card's controls row (D6), between the
              // "+" and the mic/send cluster.
              const MODE_LABELS: Record<string, string> = {
                default: 'Default', bypass: 'Bypass', plan: 'Plan', accept: 'Accept',
              };
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
                  {session.engine === 'codex' ? (
                    <SessionControlPills
                      controls={sessionControls}
                      setControl={setSessionControl}
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
                  <SideQuestionDrawer sessionId={session?.claudeSessionId} />
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
            isStreaming={isStreaming}
            placeholder="Send a message to this session... (/ for commands)"
            showCommands={false}
            sessionCommands={slashCommands}
            searchSessionCommands={searchSlashCommands}
            onRefreshSessionCommands={refreshSlashCommands}
            onControlCommand={handleControlCommand}
            mentionCwd={session?.cwd}
            mentionHost={session?.host}
            draftKey={`draft:session:${sessionId}`}
            prefillText={prefillText}
            prefillNonce={prefillNonce}
            onToggleMode={session ? () => {
              if (session.engine === 'codex') {
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
            />
          )}
        </div>
          </div>{/* .session-panel-chat-col */}
        </div>{/* .session-panel-split */}
      </div>
    </SessionPanelErrorBoundary>
    </PlanContentContext.Provider>
  );
});
