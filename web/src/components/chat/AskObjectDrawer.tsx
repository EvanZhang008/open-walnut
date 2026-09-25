/**
 * Ask Walnut about ONE object — a mail row, a Slack message, anything a surface can name.
 *
 * The ask is an ordinary Ask Walnut session, drawn with the same panels as every other session: the
 * draft panel (with a quote of the object) until the first question goes out, then `SessionPanel`
 * itself, with its title, tool cards, composer and Locate (which, off Home, finds the task on Home).
 * The object's context rides the first message as a leading block the panel folds into one row, so the
 * first bubble reads as the question (see ask-object-session.ts). A `preset` + `autoSend` pair is the
 * "open AND ask" entries (`Summarize…`, `Draft a reply…`): sent once per session, into the object's
 * existing session when it has one. Ask-mode passes no preset and lands the caret in the composer.
 *
 * It was a lane conversation drawn by `PluginChatView` until 2026-09-25, when the person asked for "the
 * same UI like regular session". The Slack plugin reaches this through `ui.views.AskObjectView`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ImageAttachment } from '@/api/chat';
import { fetchSession, fetchSessionsForTask } from '@/api/sessions';
import { wsClient } from '@/api/ws';
import { ICON_CHEVRON_LEFT, ICON_CLOSE } from '@/components/common/Icons';
import { DraftSessionPanel } from '@/components/sessions/DraftSessionPanel';
import { SessionPanel } from '@/components/sessions/SessionPanel';
import type { DraftColumn } from '@/components/sessions/draft-column';
import { freshLauncherMeta } from '@/components/sessions/task-meta-constants';
import type { QuickStartTaskMeta } from '@/components/sessions/SessionPathSelector';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';
import { visibleInterval } from '@/utils/page-visibility';
import {
  askObjectFirstMessage, askSessionAsked, forgetAskSession, launchAskSession, readAskSession,
  withAsked, writeAskSession, type AskSessionLaunch, type AskSessionRecord, type AskSessionScope,
} from './ask-object-session';
import { GENERAL_AGENT_ID, GENERAL_ASK_AGENT } from './ask-walnut-slot-model';
import '@/styles/ask-object-drawer.css';
import '@/styles/walnut-agent.css';

export interface AskObjectQuote {
  /** Who the object is from. */
  who: string;
  /** When it happened, already formatted for reading. */
  when: string;
  /** Where it lives — a folder, a channel, an account label. */
  where: string;
  /** The first few lines of the object, as plain text. */
  preview: string;
}

export interface AskObjectDrawerProps {
  /** Stable identity of the object — `<surface>:<account>:<id>`. Its session is remembered under it. */
  objectKey: string;
  /** The drawer's name for itself (its landmark label). */
  title: string;
  quote: AskObjectQuote;
  agentId: string;
  /** What Walnut is told about the object, sent ahead of the FIRST question and never again. */
  contextBlock: string;
  /** What the folded context row in the first turn says: `Mail you are asking about`. */
  contextName: string;
  /** The question the menu entry stands for. Sent on open when `autoSend`; otherwise it is not used. */
  preset?: string;
  /** Send `preset` as soon as the drawer opens. Once per session, across reopens. */
  autoSend?: boolean;
  onClose: () => void;
  /** Present when the drawer was opened from somewhere the user wants to return to (a thread). */
  onBack?: () => void;
  /**
   * The thing the keyboard goes back to when this closes, as a CSS selector.
   *
   * Needed because of WHEN this drawer mounts: the click that opens it is a click on a context-menu
   * row, so `document.activeElement` at mount is that row, and the menu unmounts a moment later. The
   * captured element is then disconnected and nothing is focused, which drops a keyboard user at the
   * top of the document instead of on the message they were working through. The opener knows what to
   * come back to; a selector (rather than an element) survives the list re-rendering in between.
   */
  restoreFocusTo?: string;
}

type View =
  | { kind: 'resolving' }
  | { kind: 'compose' }
  /** A launch in flight, or failed (`error`), carrying what Retry replays. */
  | { kind: 'starting'; question: string; preset?: string; images?: ImageAttachment[]; error?: string }
  /** The task exists and its engine has not reported the session id yet. */
  | { kind: 'linking'; taskId: string; error?: string }
  | { kind: 'session'; sessionId: string; sendError?: { preset: string; message: string } };

/** How long a task may take to report its session before the drawer says so (visible time). */
const LINK_TIMEOUT_MS = 60_000;
const LINK_POLL_MS = 400;

/** Overlays that close themselves on Escape: a menu, a list, a dialog, a context menu. */
const OVERLAY = '[role="menu"], [role="listbox"], [role="dialog"], .wn-context-menu';

/**
 * Is this Escape someone else's? The panels inside the drawer have popovers (the model picker, the
 * composer's + and send menus, the control pills, the plan preview, a quote pin) that listen for
 * Escape later than this drawer does, so without this check one Escape closed the menu AND the whole
 * drawer under it. An input being edited (the session title) takes Escape as "cancel the edit".
 */
function escapeBelongsToAnOverlay(e: KeyboardEvent, drawer: HTMLElement | null): boolean {
  const target = e.target instanceof Element ? e.target : null;
  if (target instanceof HTMLInputElement) return true;
  if (target?.closest(OVERLAY)) return true;
  if (drawer?.querySelector(`${OVERLAY}, [aria-haspopup][aria-expanded="true"]`)) return true;
  // Portalled overlays hang off <body>, outside the app root.
  return Array.from(document.querySelectorAll(OVERLAY)).some((one) => !one.closest('#root'));
}

/** The quick-start body for an ask. Same shape the Ask Walnut slot sends, minus a tier: an ask about
 *  one mail should not pin itself to Focus. */
function launchPayload(agentId: string, message: string, meta: QuickStartTaskMeta, images?: ImageAttachment[]): AskSessionLaunch {
  return {
    cwd: '',
    message,
    ...(images?.length ? { images } : {}),
    walnutAgent: true,
    ...(agentId === GENERAL_AGENT_ID ? { project: GENERAL_ASK_AGENT.project } : { agentId }),
    taskMeta: { unread: false, priority: meta.priority, pinTier: null },
    ...(meta.model ? { model: meta.model } : {}),
  };
}

async function sendIntoSession(sessionId: string, message: string): Promise<void> {
  await wsClient.sendRpc<{ messageId: string }>('session:send', { sessionId, message });
}

export function AskObjectDrawer(props: AskObjectDrawerProps) {
  const { objectKey, agentId, quote, contextBlock, contextName, preset, autoSend } = props;
  const scope = useMemo<AskSessionScope>(() => ({ agentId, key: objectKey }), [agentId, objectKey]);
  const [view, setView] = useState<View>({ kind: 'resolving' });
  const [meta, setMeta] = useState<QuickStartTaskMeta>(() => ({ ...freshLauncherMeta(), pinTier: undefined }));
  // The scope a result belongs to: an answer that lands after the drawer moved to another object must
  // not paint that object's session here.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const contextRef = useRef({ contextBlock, contextName, meta });
  contextRef.current = { contextBlock, contextName, meta };
  // A question that joined another launch still in flight, sent once the session is known (adopt).
  const followUpRef = useRef('');
  const drawerRef = useRef<HTMLElement | null>(null);

  /** Open a remembered session, sending `ask` into it first when it has not been asked there yet. */
  const openSession = useCallback(async (record: AskSessionRecord & { sessionId: string }, ask: string) => {
    if (ask && !askSessionAsked(record, ask)) {
      try {
        await sendIntoSession(record.sessionId, ask);
        writeAskSession(scope, withAsked(record, ask, Date.now()));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn('ask-object', 'preset send into an existing session failed', { sessionId: record.sessionId, error: message });
        if (scopeRef.current === scope) setView({ kind: 'session', sessionId: record.sessionId, sendError: { preset: ask, message } });
        return;
      }
    } else {
      writeAskSession(scope, withAsked(record, undefined, Date.now()));
    }
    if (scopeRef.current === scope) setView({ kind: 'session', sessionId: record.sessionId });
  }, [scope]);

  const launch = useCallback(async (question: string, fromPreset?: string, images?: ImageAttachment[]): Promise<boolean> => {
    const { contextBlock: block, contextName: name, meta: launchMeta } = contextRef.current;
    const message = askObjectFirstMessage(name, block, question);
    setView({ kind: 'starting', question, ...(fromPreset ? { preset: fromPreset } : {}), ...(images?.length ? { images } : {}) });
    try {
      const { record, joined } = await launchAskSession(scope, launchPayload(agentId, message, launchMeta, images), fromPreset);
      log.info('ask-object', 'ask session launched', { objectKey: scope.key, taskId: record.taskId, sessionId: record.sessionId ?? null, joined });
      if (scopeRef.current !== scope) return true;
      // Another launch for this object was already out, carrying ITS question: this one goes into the
      // session as a follow-up (`openSession` skips it when it is the same canned question).
      if (joined && question) {
        if (record.sessionId) {
          await openSession({ ...record, sessionId: record.sessionId }, question);
          return true;
        }
        followUpRef.current = question;
      }
      setView(record.sessionId ? { kind: 'session', sessionId: record.sessionId } : { kind: 'linking', taskId: record.taskId });
      return true;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      log.warn('ask-object', 'ask session launch failed', { objectKey: scope.key, error: text });
      if (scopeRef.current === scope) {
        setView({ kind: 'starting', question, ...(fromPreset ? { preset: fromPreset } : {}), ...(images?.length ? { images } : {}), error: text });
      }
      return false;
    }
  }, [agentId, scope, openSession]);

  // Which session is this object's, and what to do on open. Re-runs for a new object or a new canned
  // question; StrictMode's second run is harmless because a launch is single-flight per scope and an
  // existing session's preset is only sent by the run still live when its lookup lands.
  const ask = autoSend && preset ? preset : '';
  useEffect(() => {
    let live = true;
    const record = readAskSession(scope);
    void (async () => {
      if (record?.sessionId) {
        let exists = true;
        try {
          const session = await fetchSession(record.sessionId);
          exists = Boolean(session);
        } catch {
          // A failed read is not "gone": keep the session, the panel has its own retry.
        }
        if (!live) return;
        if (exists) {
          await openSession({ ...record, sessionId: record.sessionId }, ask);
          return;
        }
        log.info('ask-object', 'remembered session is gone, starting over', { objectKey: scope.key, sessionId: record.sessionId });
        forgetAskSession(scope);
      } else if (record?.taskId) {
        setView({ kind: 'linking', taskId: record.taskId });
        return;
      }
      if (!live) return;
      if (ask) void launch(ask, ask);
      else setView({ kind: 'compose' });
    })();
    return () => { live = false; };
  }, [scope, ask, openSession, launch]);

  // An engine that mints its own session id reports it after the task: the task event first, a poll
  // behind it, and a deadline so the drawer never spins forever.
  const linkingTaskId = view.kind === 'linking' && !view.error ? view.taskId : '';
  const adopt = useCallback((sessionId: string) => {
    const record = readAskSession(scope);
    if (!record || record.sessionId) return;
    const linked = { ...record, sessionId };
    writeAskSession(scope, linked);
    const followUp = followUpRef.current;
    followUpRef.current = '';
    void openSession(linked, followUp || ask);
  }, [scope, ask, openSession]);
  useEvent('task:updated', (data: unknown) => {
    if (!linkingTaskId) return;
    const task = (data as { task?: { id?: string; exec_session_id?: string; plan_session_id?: string } }).task;
    if (task?.id !== linkingTaskId) return;
    const sessionId = task.exec_session_id ?? task.plan_session_id;
    if (sessionId) adopt(sessionId);
  });
  useEffect(() => {
    if (!linkingTaskId) return;
    let cancelled = false;
    // Counted in polls, which only run while the page is visible: a tab left in the background does not
    // use up the wait, and the last poll is still a real check before the drawer gives up.
    let polls = 0;
    const cancel = visibleInterval(async () => {
      polls += 1;
      try {
        const sessions = await fetchSessionsForTask(linkingTaskId);
        const active = sessions.find((one) => one.claudeSessionId && !one.archived);
        if (active && !cancelled) {
          cancel();
          adopt(active.claudeSessionId);
          return;
        }
      } catch { /* next tick */ }
      if (!cancelled && polls * LINK_POLL_MS >= LINK_TIMEOUT_MS) {
        cancel();
        setView({ kind: 'linking', taskId: linkingTaskId, error: 'The session has not started yet.' });
      }
    }, LINK_POLL_MS);
    return () => { cancelled = true; cancel(); };
  }, [linkingTaskId, adopt]);

  // Escape closes, and focus goes back to whatever had it (the row the menu opened from). A key the
  // panel inside already answered, or one an open menu will answer, is theirs, not a close. Both
  // callbacks ride refs: an opener that passes a fresh arrow each render must not re-run this effect,
  // whose cleanup is the focus return.
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const restoreFocusRef = useRef(props.restoreFocusTo);
  restoreFocusRef.current = props.restoreFocusTo;
  // Zero-argument on purpose: the panels call `onClose(sessionId)` / `onClose(draftId)`, and an opener's
  // close must not receive an id it never asked for.
  const onClose = useCallback(() => { onCloseRef.current(); }, []);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      if (escapeBelongsToAnOverlay(e, drawerRef.current)) return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      // The opener's answer first, resolved NOW rather than at mount so a list that re-rendered in
      // between is followed. The element captured at mount is the fallback, and it is usually the
      // context-menu row that opened this and is gone by now.
      const selector = restoreFocusRef.current;
      const named = selector ? document.querySelector(selector) : null;
      const back = named instanceof HTMLElement && named.isConnected
        ? named
        : (previous && previous.isConnected && previous !== document.body ? previous : null);
      back?.focus({ preventScroll: true });
    };
  }, []);

  const backButton = props.onBack ? (
    <button
      type="button"
      className="ask-object-icon-btn"
      data-testid="ask-object-back"
      aria-label="Back"
      title="Back"
      onClick={props.onBack}
    >
      {ICON_CHEVRON_LEFT}
    </button>
  ) : null;

  const quoteCard = (
    <blockquote className="ask-object-quote" data-testid="ask-object-quote">
      <span className="ask-object-who">{[quote.who, quote.when, quote.where].filter(Boolean).join(' · ')}</span>
      <span className="ask-object-preview">{quote.preview || '(no text)'}</span>
    </blockquote>
  );

  const draft = useMemo<DraftColumn>(() => ({
    id: `ask-object:${agentId}:${objectKey}`,
    cwd: '',
    host: null,
    walnut: true,
    project: GENERAL_ASK_AGENT.project,
    projectSource: 'seed',
    meta,
  }), [agentId, objectKey, meta]);
  const noop = useCallback(() => { /* an ask has no folder or project to pick */ }, []);
  const known = useCallback(() => true, []);
  const onMetaChange = useCallback((_id: string, updater: (m: QuickStartTaskMeta) => QuickStartTaskMeta) => {
    setMeta((m) => updater(m));
  }, []);
  const onStart = useCallback((_id: string, text: string, images?: ImageAttachment[]) => (
    launch(text.trim(), undefined, images)
  ), [launch]);

  // One retry at a time: a double click on Try again must not send the question twice.
  const [retrying, setRetrying] = useState(false);
  const retrySend = useCallback((question: string) => {
    const record = readAskSession(scope);
    if (!record?.sessionId || retrying) return;
    setRetrying(true);
    void openSession({ ...record, sessionId: record.sessionId }, question).finally(() => setRetrying(false));
  }, [scope, retrying, openSession]);

  let body: ReactNode;
  if (view.kind === 'session') {
    body = (
      <div className="ask-object-session" data-testid="ask-object-session" data-session-id={view.sessionId}>
        {view.sendError ? (
          <p className="ask-object-error" data-testid="ask-object-error">
            Could not ask Walnut. {view.sendError.message}
            <button
              type="button"
              className="ask-object-inline-btn"
              data-testid="ask-object-retry"
              disabled={retrying}
              onClick={() => retrySend(view.sendError!.preset)}
            >
              Try again
            </button>
          </p>
        ) : null}
        <SessionPanel
          key={view.sessionId}
          sessionId={view.sessionId}
          embedded
          // Ask mode (no canned question) is the person about to type: the caret goes to the composer,
          // on a reopened session as much as on a new one.
          focusComposer={!ask}
          {...(backButton ? { headerLeading: backButton } : {})}
          onClose={onClose}
        />
      </div>
    );
  } else if (view.kind === 'compose') {
    body = (
      <div className="ask-object-compose" data-testid="ask-object-compose">
        <DraftSessionPanel
          draft={draft}
          autoFocus
          {...(backButton ? { headerLeading: backButton } : {})}
          intro={quoteCard}
          onStart={onStart}
          onSaveAsTask={noop}
          onClose={onClose}
          onPathChange={noop}
          onProjectChange={noop}
          onMetaChange={onMetaChange}
          isKnownProject={known}
        />
      </div>
    );
  } else {
    const failed = view.kind === 'starting' || view.kind === 'linking' ? view.error : undefined;
    body = (
      <div className="ask-object-pending" data-testid="ask-object-pending">
        <div className="ask-object-head">
          {backButton}
          <h2 className="ask-object-title">{props.title}</h2>
          <button
            type="button"
            className="ask-object-icon-btn"
            data-testid="ask-object-close"
            aria-label="Close"
            title="Close"
            onClick={onClose}
          >
            {ICON_CLOSE}
          </button>
        </div>
        {quoteCard}
        <div className="ask-walnut-pending">
          {failed ? (
            <>
              <p className="ask-walnut-pending-error" data-testid="ask-object-error">
                {view.kind === 'linking' ? failed : <>Walnut couldn&apos;t start: {failed}</>}
              </p>
              <div className="ask-walnut-pending-actions">
                {view.kind === 'starting' ? (
                  <button
                    className="btn btn-sm btn-primary"
                    data-testid="ask-object-retry"
                    onClick={() => { void launch(view.question, view.preset, view.images); }}
                  >
                    Retry
                  </button>
                ) : null}
                {view.kind === 'linking' ? (
                  <>
                    {/* The task exists and may still get its session: waiting on is the safe default,
                        and starting over is named as what it is (the old task stays in the asks). */}
                    <button
                      className="btn btn-sm btn-primary"
                      data-testid="ask-object-keep-waiting"
                      onClick={() => setView({ kind: 'linking', taskId: view.taskId })}
                    >
                      Keep waiting
                    </button>
                    <button
                      className="btn btn-sm"
                      data-testid="ask-object-start-over"
                      onClick={() => {
                        forgetAskSession(scope);
                        setView({ kind: 'compose' });
                      }}
                    >
                      Start over
                    </button>
                  </>
                ) : (
                  <button className="btn btn-sm" onClick={() => setView({ kind: 'compose' })}>
                    Back
                  </button>
                )}
              </div>
            </>
          ) : (
            <p className="ask-walnut-pending-status">
              <span className="spinner ask-walnut-pending-spinner" />
              {view.kind === 'resolving' ? 'Opening…' : 'Starting Walnut…'}
            </p>
          )}
          {view.kind === 'starting' && view.question ? <p className="ask-walnut-pending-echo">{view.question}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <aside
      ref={drawerRef}
      className="ask-object-drawer"
      data-testid="ask-object-drawer"
      data-object-key={objectKey}
      data-view={view.kind}
      aria-label={props.title}
    >
      {body}
    </aside>
  );
}
