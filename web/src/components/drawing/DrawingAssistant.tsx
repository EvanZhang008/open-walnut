/**
 * The Drawing app's assistant: a chat beside the canvas that changes THIS drawing. The person asks
 * ("align these boxes", "add a cache between the API and the database"); Walnut's own agent edits the
 * file with the drawing tools, and each saved edit reaches the canvas at once (`drawings:updated`).
 *
 * A thin host of `AskObjectDrawer` (one remembered conversation per drawing, the context sent ahead
 * of the first question) in its plain chat mode, as the browser side panel and Mail use it. Its asks
 * are conversations, not work for the board, so their task is not pinned.
 */
import { useCallback, useRef } from 'react';
import { AskObjectDrawer } from '@/components/chat/AskObjectDrawer';
import type { AskSessionLaunch } from '@/components/chat/ask-object-session';
import { drawingAssistantContext, drawingAssistantKey } from './drawing-assistant-context';

/** The console's own Walnut, the same one Ask Walnut and Mail's questions talk to. */
export const DRAWING_ASSISTANT_AGENT = 'general';

export interface DrawingAssistantProps {
  /** The drawing file the chat is about. */
  path: string;
  title: string;
  onClose(): void;
}

export function DrawingAssistant({ path, title, onClose }: DrawingAssistantProps) {
  const latest = useRef({ path, title });
  latest.current = { path, title };
  // The first question carries the drawing as it is named then (a rename since opening included).
  const prepareContext = useCallback(async () => drawingAssistantContext(latest.current.path, latest.current.title), []);
  const adjustLaunch = useCallback((body: AskSessionLaunch): AskSessionLaunch => ({ ...body, taskMeta: { ...body.taskMeta, pinTier: null } }), []);
  const objectKey = drawingAssistantKey(path);
  return (
    <aside className="drawing-assistant" aria-label="Drawing assistant">
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
          adjustLaunch={adjustLaunch}
          // Escape leaves the composer; the panel closes only from its own button.
          onClose={() => { (document.activeElement as HTMLElement | null)?.blur(); }}
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
