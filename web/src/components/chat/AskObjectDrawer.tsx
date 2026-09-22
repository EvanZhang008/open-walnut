/**
 * Ask Walnut about ONE object — a mail row, a Slack message, anything a surface can name.
 *
 * The drawer is three parts: a header, a quote card showing exactly what Walnut will be told, and the
 * agent's chat (`PluginChatView`) on a conversation scoped to that object. The first message sent from
 * here carries the caller's context block, so the model reads what the user is looking at; every later
 * message goes out as typed. A `preset` + `autoSend` pair is the "open AND ask" entries
 * (`Summarize…`, `Draft a reply…`): one visible user turn, once per object. Ask-mode passes no preset
 * and lands the caret in the composer instead.
 *
 * It is a LANE conversation, not a task session: a summary of one mail should not occupy a board row.
 * The Slack plugin's `ask-drawer.tsx` is the same thing built against the plugin web API; keep the two
 * behaving alike.
 */
import { useEffect, useRef, useState } from 'react';
import { ICON_CHEVRON_LEFT, ICON_CLOSE } from '@/components/common/Icons';
import { PluginChatView } from '@/components/chat/PluginChatView';
import {
  askObjectConversationFor,
  askObjectLatchTaken,
  askObjectTitle,
  claimAskObjectLatch,
  prefixContextOnce,
  presetLatchName,
  releaseAskObjectLatch,
} from '@/components/chat/ask-object-conversation';
import '@/styles/ask-object-drawer.css';

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
  /** Stable identity of the object — `<surface>:<account>:<id>`. The conversation is remembered under it. */
  objectKey: string;
  /** The header's title. */
  title: string;
  quote: AskObjectQuote;
  agentId: string;
  /** Prepended to the FIRST message sent about this object, and to nothing after it. */
  contextBlock: string;
  /** The question the menu entry stands for. Sent on open when `autoSend`; otherwise it is not used. */
  preset?: string;
  /** Send `preset` as soon as the conversation exists. Once per object, across reopens. */
  autoSend?: boolean;
  /** What the ask is filed as in the agent's conversation list. Defaults to `<who>: <preview>`. */
  conversationTitle?: string;
  placeholder?: string;
  emptyText?: string;
  onClose: () => void;
  /** Present when the drawer was opened from somewhere the user wants to return to (a thread). */
  onBack?: () => void;
}

export function AskObjectDrawer(props: AskObjectDrawerProps) {
  const { objectKey, agentId, quote, contextBlock, preset, autoSend } = props;
  const [conversation, setConversation] = useState<{ key: string; id: string; error: string }>(
    { key: '', id: '', error: '' },
  );
  const [attempt, setAttempt] = useState(0);
  const conversationTitle = props.conversationTitle
    ?? askObjectTitle(quote.who || quote.where || props.title, quote.preview);

  useEffect(() => {
    let live = true;
    askObjectConversationFor(objectKey, conversationTitle, { agentId })
      .then((id) => { if (live) setConversation({ key: objectKey, id, error: '' }); })
      .catch((error: unknown) => {
        if (live) {
          setConversation({
            key: objectKey,
            id: '',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => { live = false; };
    // `conversationTitle` deliberately absent: it settles a beat after opening (a display name
    // resolves) and re-running would ask for a second conversation. The single-flight map in
    // ask-object-conversation.ts is the other half of that guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectKey, agentId, attempt]);

  const conversationId = conversation.key === objectKey && conversation.id ? conversation.id : null;
  const conversationError = conversation.key === objectKey ? conversation.error : '';

  // Read ONCE, at mount, and never written here: StrictMode runs a state initializer twice, so a
  // latch taken during render would consume the preset without ever sending it. PluginChatView
  // reports the send back through `onAutoSent`, and THAT is where the latch is taken.
  // Per OBJECT AND PRESET (see presetLatchName): a latch per object would mean that having asked for a
  // summary of this mail, a later "finish unsubscribing" on the same mail opens the drawer and sends
  // nothing.
  // The agent is part of a latch's identity, exactly as it is part of the conversation key: this same
  // object under a second agent is a second chat, which needs its own quote and its own first question.
  const contextScope = { agentId, key: objectKey };
  const presetScope = { agentId, key: preset ? `${objectKey}#${presetLatchName(preset)}` : objectKey };
  const [pendingPreset] = useState(() => (
    autoSend && preset && !askObjectLatchTaken('preset', presetScope) ? preset : ''
  ));

  // Escape closes, and focus goes back to whatever had it (the row the menu opened from).
  // preventDefault before stopPropagation is the repo's Escape-ownership convention.
  const onClose = props.onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      if (previous && previous.isConnected && previous !== document.body) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [onClose]);

  const latched = useRef(false);

  return (
    <aside className="ask-object-drawer" data-testid="ask-object-drawer" data-object-key={objectKey} aria-label={props.title}>
      <header className="ask-object-head">
        {props.onBack ? (
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
        ) : null}
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
      </header>

      <blockquote className="ask-object-quote" data-testid="ask-object-quote">
        <span className="ask-object-who">
          {[quote.who, quote.when, quote.where].filter(Boolean).join(' · ')}
        </span>
        <span className="ask-object-preview">{quote.preview || '(no text)'}</span>
      </blockquote>

      {conversationError ? (
        <p className="ask-object-error" data-testid="ask-object-error">
          Could not open a chat. {conversationError}
          <button
            type="button"
            className="ask-object-inline-btn"
            data-testid="ask-object-retry"
            onClick={() => setAttempt((count) => count + 1)}
          >
            Try again
          </button>
        </p>
      ) : null}

      {/* The wrapper hides PluginChatView's own header (see ask-object-drawer.css): the drawer's
          header above is the one header. Its `Clear` button goes with it — deliberate, because a
          chat scoped to one object is ended by closing the drawer, not by emptying it. */}
      <div className="ask-object-chat" data-testid="ask-object-chat" data-conversation={conversationId ?? ''}>
        <PluginChatView
          agentId={agentId}
          conversationId={conversationId}
          draftStorageKey={`ask-object:${agentId}:${objectKey}`}
          placeholder={props.placeholder ?? 'Ask about this'}
          emptyText={props.emptyText ?? `Ask about this${quote.who ? ` message from ${quote.who}` : ''}.`}
          transformMessage={(input) => prefixContextOnce(contextScope, contextBlock, input)}
          autoSend={pendingPreset || undefined}
          onAutoSent={() => {
            if (latched.current) return;
            latched.current = true;
            claimAskObjectLatch('preset', presetScope);
          }}
          onAutoSendFailed={() => {
            // Nothing reached Walnut, so neither latch may stay taken: the question has to stay
            // askable, and the quote it was carrying has to ride whatever is sent next. Both are on
            // disk, so a burnt one could never be lit again from any window.
            latched.current = false;
            releaseAskObjectLatch('preset', presetScope);
            releaseAskObjectLatch('context', contextScope);
          }}
          focusNonce={pendingPreset ? undefined : 1}
        />
      </div>
    </aside>
  );
}
