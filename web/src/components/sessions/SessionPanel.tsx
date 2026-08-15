import { useState, useEffect, useCallback, useRef, useMemo, Component, type ReactNode, type ErrorInfo, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { copyTextDeferred } from '@/utils/clipboard';
import { SessionChatHistory } from './SessionChatHistory';
import { SessionNotesPill, SessionNotesBar, useSessionNote } from './SessionNotes';
import { SessionFileExplorer } from './SessionFileExplorer';
import { sessionScope } from '@/utils/file-view-state';
import { SessionTerminal } from './SessionTerminal';
import { SessionDiffView } from './SessionDiffView';
import { buildSelectionPrefill, displayPathForPrefill } from './diffPrefill';
import type { SessionSplitView } from './sessionSplitView';
import { ICON_ROBOT, ICON_EXPAND, ICON_COLLAPSE, ICON_CLOSE, ICON_LOCK, ICON_UNLOCK, ICON_LOCATE, ICON_NEW_TAB, ICON_CHEVRON_LEFT, ICON_CHEVRON_RIGHT } from '../common/Icons';
import { openPopout } from '@/popout/openPopout';
import { UserMessagesSummary } from './UserMessagesSummary';
// PlanPreviewSection replaced by inline plan popover in meta bar
import { ChatInput } from '@/components/chat/ChatInput';
import { SideQuestionDrawer } from '@/components/sessions/SideQuestionDrawer';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { useSessionSend } from '@/hooks/useSessionSend';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { useSessionHistory } from '@/hooks/useSessionHistory';
import type { ImageAttachment } from '@/api/chat';
import { useEvent } from '@/hooks/useWebSocket';
import { fetchSession, executePlanContinue, executePlanSession, updateSession, restartSession, terminateSession, investigateSession, setSessionEffort, setSessionModel } from '@/api/sessions';
import { terminalPrewarm } from '@/api/terminal';
import { log } from '@/utils/log';
import { runWhenVisible } from '@/utils/page-visibility';
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
import { modelSupportsEffort, SESSION_EFFORTS, SESSION_MODE_LABELS } from '@open-walnut/core';
import { TaskQuickActions } from './TaskQuickActions';
import { useFullscreen } from '@/hooks/useFullscreen';
import { useResizablePanel } from '@/hooks/useResizablePanel';
import { useSessionUsage, formatModelName, getContextWindowSize } from '@/hooks/useSessionUsage';
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
import { nextSessionControlValue, SessionControlPills } from './SessionControlPills';
import { useNotifications } from '@/contexts/notifications';
import { useConfirm } from '@/hooks/useConfirm';

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
    setMissing(false);
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
      // Model backfill for idle launches (todo-launcher quick start): quick-start
      // pre-seeds the record model-less (Auto) and returns before the CLI's init
      // event writes the real model onto it. The status snapshot doesn't carry
      // model, and an idle session (empty first message) never produces the
      // assistant turn whose usage-update would deliver it — so without this
      // refetch the record's model stays invisible until the first real turn.
      // status-changed fires right after the init-model write; refetch while the
      // record is still model-less (self-limiting: stops once model is present).
      if (session && !session.model && session.engine !== 'codex') {
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
    // The Changed tab already hands a repo-relative path; the Files tab browses the
    // whole filesystem and hands an absolute one. Shorten against the session cwd so
    // a quote reads the same from either surface (a path outside the cwd stays absolute).
    setPrefillText(buildSelectionPrefill(displayPathForPrefill(filePath, session?.cwd), line, code));
    setPrefillNonce((n) => n + 1);
    // REVEAL the composer first: while the chat column is collapsed it is
    // `display:none`, so ChatInput's focus() lands on <body> and every keystroke
    // the user then types is LOST (2026-08-13 report: "the cursor doesn't go to
    // the input box"). Asking about a selection means "take me to the chat".
    setChatCollapsed(false);
  }, [session?.cwd]);
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
    setActiveView((cur) => {
      const next = cur === view ? null : view;
      if (next) enterFullscreen(); else { exitFullscreen(); setChatCollapsed(false); }
      return next;
    });
  }, [enterFullscreen, exitFullscreen, fileViewTarget, activeView]);
  // Clicking a file path in the chat opens it in the SAME split layout as
  // Changed/Files/Terminal — file explorer + preview on the left, the live chat
  // in the resizable right column (replaces the old full-screen FileViewer modal).
  // EVERY file type goes here, vault notes included: a click must never navigate
  // the app away from the session (that jump was reverted 2026-08-09). Notes get
  // an explicit "Open in Notes" button in the preview toolbar / right-click menu.
  const handleFileOpen = useCallback((path: string, line?: number) => {
    setFileViewTarget({ path, line });
    setActiveView('files');
    enterFullscreen();
  }, [enterFullscreen]);
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

  const handleSend = useCallback((message: string, images?: ImageAttachment[]) => {
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
  ) : (
    // No rawModel yet ≠ no pill: a todo-launcher quick start (empty first
    // message) idles with a model-less record until its first real turn, and
    // hiding the pill hides the ONLY model/effort entry point ("model option
    // doesn't show"). Render "Auto" — the picker itself live-pulls the truth.
    <button
      type="button"
      className="session-detail-model-pill session-detail-model-pill-clickable composer-model-pill"
      title={`${rawModel || (autoResolved ? `Auto — CLI default resolves to ${autoResolved} on this host` : 'Model not reported yet (Auto)')} — click to switch model / effort`}
      onClick={() => setModelPickerOpen((v) => !v)}
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
          title={`Context: ${contextPercent}%${liveUsage.inputTokens ? ` (${Math.round(liveUsage.inputTokens / 1000)}K)` : ''}`}
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
                          onStop={handleStopTurn}
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
                    className="session-panel-title"
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
                  Auto-stopped after {idle[1]} min idle. The conversation is preserved — send a message or Retry to resume.
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
                className="pane-collapsed-rail pane-rail-right session-chat-collapsed-rail"
                onClick={() => setChatCollapsed(false)}
                title="Show chat"
                aria-label="Show chat"
                aria-expanded={false}
              >{ICON_CHEVRON_LEFT}<span className="pane-rail-label">Chat</span></button>
            ) : (
              <div className="session-panel-chat-resize" {...chatPanel.handleProps} title="Drag to resize chat" />
            )
          )}
          <div
            className="session-panel-chat-col"
            ref={splitOpen ? chatPanel.panelRef : undefined}
            style={splitOpen && !chatCollapsed ? { width: chatPanel.width, flex: `0 0 ${chatPanel.width}` } : undefined}
          >
            {splitOpen && !chatCollapsed && (
              <button
                className="pane-collapse-btn pane-collapse-btn-right session-chat-collapse-btn"
                onClick={() => setChatCollapsed(true)}
                title="Collapse chat"
                aria-label="Collapse chat"
                aria-expanded
              >{ICON_CHEVRON_RIGHT}</button>
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
