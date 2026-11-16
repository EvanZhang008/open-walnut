/**
 * The Drawing app's assistant: one task and its session per drawing, shown beside the canvas, that
 * changes THIS drawing. The person asks ("align these boxes", "add a cache between the API and the
 * database"), and the editor's "Make a diagram" and "Text to diagram" arrive here too as messages
 * (`request`), so every change is the same agent's and can be read in its session. Walnut's own
 * agent edits the file with the drawing tools; each saved edit reaches the canvas at once.
 *
 * A thin host of `AskObjectDrawer` (one remembered conversation per drawing, the context sent ahead
 * of the first question) in its plain chat mode, as the browser side panel and Mail use it. The
 * task is named after the drawing ("Drawing: <title>") and opens from the panel's head; it is not
 * pinned to the board, so a drawing's chat never fills Focus.
 */
import { useEffect, useRef, useState } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { useOpenTask } from '@/hooks/useOpenTask';
import { AskObjectDrawer } from '@/components/chat/AskObjectDrawer';
import { readAskSession, type AskSessionLaunch } from '@/components/chat/ask-object-session';
import { sendSessionMessage } from '@/api/session-send';
import { updateTask } from '@/api/tasks';
import { isPopoutPath, openTaskInApp } from '@/popout/openPopout';
import { log } from '@/utils/log';
import { DRAWING_ASSISTANT_AGENT, drawingAssistantContext, drawingAssistantKey, drawingTaskTitle } from './drawing-assistant-context';

/** A message the editor hands the assistant (Make a diagram, Text to diagram); `id` grows per ask. */
export interface DrawingAssistantRequest { id: number; text: string }

export interface DrawingAssistantProps {
  /** The drawing file the chat is about. */
  path: string;
  title: string;
  /** The editor's latest ask for this conversation. */
  request?: DrawingAssistantRequest | null;
  /** The ask went into the conversation (no `error`), or could not (`error` says why). */
  onRequestDone?(id: number, error?: string): void;
  onClose(): void;
  /** Escape in the chat: the keys go back to the drawing. */
  onLeave(): void;
}

/** Its asks are conversations, not work for the board: their task is not pinned. Module level, so
 *  it holds no render (useLeanCallback.ts). */
function unpinned(body: AskSessionLaunch): AskSessionLaunch {
  return { ...body, taskMeta: { ...body.taskMeta, pinTier: null } };
}

const TITLED_PREFIX = 'walnut:drawing-task-titled:';

/** Name a drawing's new task after the drawing, once (the person may rename it after). */
function titleOnce(taskId: string, title: string): void {
  try {
    if (localStorage.getItem(TITLED_PREFIX + taskId)) return;
    localStorage.setItem(TITLED_PREFIX + taskId, '1');
  } catch { /* private mode: it may be named twice, never wrongly */ }
  void updateTask(taskId, { title: drawingTaskTitle(title) }).catch((error: unknown) => {
    log.warn('drawing', 'the drawing task could not be named', { taskId, error: String(error) });
  });
}

export function DrawingAssistant({ path, title, request, onRequestDone, onClose, onLeave }: DrawingAssistantProps) {
  const panel = useRef<HTMLElement>(null);
  const openTask = useOpenTask();
  const objectKey = drawingAssistantKey(path);
  const [taskId, setTaskId] = useState<string | null>(() => readAskSession({ agentId: DRAWING_ASSISTANT_AGENT, key: objectKey })?.taskId ?? null);
  // A request before this drawing has a conversation is its first question (it launches the task).
  const [firstAsk, setFirstAsk] = useState<string | null>(null);
  // The first question carries the drawing as it is named then (a rename since opening included).
  const prepareContext = useLeanCallback(async () => drawingAssistantContext(path, title), [path, title]);
  const onRecord = useLeanCallback((record: { taskId: string }) => {
    setTaskId(record.taskId);
    titleOnce(record.taskId, title);
  }, [title]);
  const doneRef = useRef(onRequestDone);
  doneRef.current = onRequestDone;

  const requestId = request?.id ?? 0;
  useEffect(() => {
    if (!request) return;
    const done = (error?: string) => doneRef.current?.(request.id, error);
    const record = readAskSession({ agentId: DRAWING_ASSISTANT_AGENT, key: objectKey });
    if (record?.sessionId) {
      sendSessionMessage({ sessionId: record.sessionId, message: request.text }).then(() => done(), (error: unknown) => {
        log.warn('drawing', 'a diagram ask could not reach the assistant', { sessionId: record.sessionId, error: String(error) });
        done(`The assistant did not get it: ${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    if (record?.taskId) { done('The assistant is still starting. Try again in a moment.'); return; }
    setFirstAsk(request.text);
    done();
    // One send per request id; the text and key of that request are read with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);

  const openOwnTask = () => {
    if (!taskId) return;
    if (isPopoutPath(window.location.pathname)) openTaskInApp(taskId);
    else openTask(taskId);
  };

  return (
    <aside ref={panel} className="drawing-assistant" aria-label="Drawing assistant">
      <div className="drawing-assistant-head">
        <span>Assistant</span>
        <span className="drawing-assistant-head-gap" />
        {taskId && (
          <button type="button" className="drawing-quiet-button drawing-assistant-open-task" onClick={openOwnTask}
            title="Open this drawing's task and its whole session">Open task</button>
        )}
        <button type="button" className="drawing-icon-button" aria-label="Close assistant" title="Close assistant" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>
      <div className="drawing-assistant-chat">
        <AskObjectDrawer
          // One conversation per drawing: another drawing starts from its own, never this one's draft.
          key={objectKey}
          objectKey={objectKey}
          title={`Assistant for ${title}`}
          quote={{ who: '', when: '', where: 'Drawing', preview: title }}
          agentId={DRAWING_ASSISTANT_AGENT}
          contextBlock={drawingAssistantContext(path, title)}
          contextName="Drawing you are changing"
          prepareContext={prepareContext}
          adjustLaunch={unpinned}
          onRecord={onRecord}
          {...(firstAsk ? { preset: firstAsk, autoSend: true } : {})}
          // Escape in the chat hands the keys back to the drawing; an Escape anywhere else (the drawer
          // hears every one on the page) is the canvas's own. The panel closes only from its button.
          onClose={() => { if (panel.current?.contains(document.activeElement)) onLeave(); }}
          plainChat
          noQuote
          intro={(
            <div className="drawing-assistant-intro">
              <p>Tell Walnut what to change in this drawing. Each edit shows on the canvas as it is made. Make a diagram and Text to diagram run here too.</p>
              <ul>
                <li>Align the boxes and space them evenly</li>
                <li>Add a cache between the API and the database</li>
                <li>Turn my sketch into a clean diagram</li>
              </ul>
            </div>
          )}
          composerPlaceholder="Ask for a change: align the boxes, add a cache between API and DB…"
        />
      </div>
    </aside>
  );
}

export default DrawingAssistant;
