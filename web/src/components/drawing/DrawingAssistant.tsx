/**
 * The Drawing app's assistant: a chat beside the canvas that changes THIS drawing. The person asks
 * ("align these boxes", "add a cache between the API and the database"); Walnut's own agent edits the
 * file with the drawing tools, and each saved edit reaches the canvas at once (`drawings:updated`).
 *
 * A thin host of `AskObjectDrawer` (one remembered conversation per drawing, the context sent ahead
 * of the first question) in its plain chat mode, as the browser side panel and Mail use it. Its asks
 * are conversations, not work for the board, so their task is not pinned.
 */
import { useRef } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { AskObjectDrawer } from '@/components/chat/AskObjectDrawer';
import type { AskSessionLaunch } from '@/components/chat/ask-object-session';
import { DRAWING_ASSISTANT_AGENT, drawingAssistantContext, drawingAssistantKey } from './drawing-assistant-context';

export interface DrawingAssistantProps {
  /** The drawing file the chat is about. */
  path: string;
  title: string;
  onClose(): void;
  /** Escape in the chat: the keys go back to the drawing. */
  onLeave(): void;
}

/** Its asks are conversations, not work for the board: their task is not pinned. Module level, so
 *  it holds no render (useLeanCallback.ts). */
function unpinned(body: AskSessionLaunch): AskSessionLaunch {
  return { ...body, taskMeta: { ...body.taskMeta, pinTier: null } };
}

export function DrawingAssistant({ path, title, onClose, onLeave }: DrawingAssistantProps) {
  const panel = useRef<HTMLElement>(null);
  // The first question carries the drawing as it is named then (a rename since opening included).
  const prepareContext = useLeanCallback(async () => drawingAssistantContext(path, title), [path, title]);
  const objectKey = drawingAssistantKey(path);
  return (
    <aside ref={panel} className="drawing-assistant" aria-label="Drawing assistant">
      <div className="drawing-assistant-head">
        <span>Assistant</span>
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
          // Escape in the chat hands the keys back to the drawing; an Escape anywhere else (the drawer
          // hears every one on the page) is the canvas's own. The panel closes only from its button.
          onClose={() => { if (panel.current?.contains(document.activeElement)) onLeave(); }}
          plainChat
          noQuote
          intro={(
            <div className="drawing-assistant-intro">
              <p>Tell Walnut what to change in this drawing. Each edit shows on the canvas as it is made.</p>
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
