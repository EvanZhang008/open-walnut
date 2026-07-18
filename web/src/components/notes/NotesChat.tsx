import { type ReactNode } from 'react';
import { useChat } from '@/hooks/useChat';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { ChatMessage } from '@/components/chat/ChatMessage';
import { ChatInput } from '@/components/chat/ChatInput';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import type { ImageAttachment } from '@/api/chat';

export const NOTE_AGENT_ID = 'note-agent';

/**
 * NotesChat — the AI assistant column on the /notes page. Talks to OUR OWN
 * `note-agent` (a builtin embedded agent with the notes file tools) via the same
 * `useChat` + ChatPanel/ChatMessage/ChatInput stack the home page uses, so the
 * agent can actually read / search / edit / create notes in the vault.
 *
 * The conversation to display is OWNED BY THE PAGE (NotesPage resolves it via
 * useConversations — main chat or a named side chat started from the tree's
 * context menu). `activeNotePath` (the note currently open in the editor) is
 * surfaced to the agent as a one-line context hint on each send.
 */
export function NotesChat({ activeNotePath, headerLeft, conversationId }: {
  activeNotePath: string | null;
  /** Replaces the "Note Assistant" title — the pane's mode tabs live here when
   *  the chat column can also host a Claude Code session. */
  headerLeft?: ReactNode;
  /** Which note-agent conversation this pane talks to (null while the list loads). */
  conversationId: string | null;
}) {
  const chat = useChat(NOTE_AGENT_ID, conversationId);

  const handleSend = (text: string, images?: ImageAttachment[]) => {
    // Surface the currently-open note so the agent knows what "this note" means
    // without the user having to name it.
    const hint = activeNotePath
      ? `\n\n[The user is currently viewing the note: ${activeNotePath.replace(/\.md$/, '')}]`
      : '';
    chat.sendMessage(text + hint, undefined, images);
  };

  return (
    <div className="notes-chat">
      <div className="notes-chat-header">
        {headerLeft ?? <span className="notes-chat-title">Note Agent</span>}
        {chat.messages.length > 0 && (
          <button
            className="notes-chat-clear"
            onClick={chat.clearMessages}
            title="Clear conversation"
          >
            Clear
          </button>
        )}
      </div>

      {!conversationId ? (
        <div className="notes-chat-loading"><LoadingSpinner /></div>
      ) : (
        <>
          <ChatPanel messageCount={chat.messages.length} prependedRef={chat.prependedRef}>
            {chat.messages.length === 0 && !chat.isStreaming && (
              <div className="notes-chat-empty">
                <p>Ask about your notes, or have the assistant create and edit them.</p>
                <ul>
                  <li>“What did I write about X?”</li>
                  <li>“Summarize my reading-list note.”</li>
                  <li>“Add a todo to today's note.”</li>
                </ul>
              </div>
            )}
            {chat.messages.map((msg) => (
              <ChatMessage
                key={msg.key}
                role={msg.role}
                content={msg.content}
                blocks={'blocks' in msg ? msg.blocks : undefined}
                images={'images' in msg ? msg.images : undefined}
                timestamp={'timestamp' in msg ? msg.timestamp : undefined}
                source={'source' in msg ? msg.source : undefined}
                notification={'notification' in msg ? msg.notification : undefined}
                queued={'queued' in msg ? msg.queued : undefined}
                onCancel={msg.queued && msg.queueId != null ? () => chat.cancelQueuedMessage(msg.queueId!) : undefined}
              />
            ))}
            {chat.toolActivity && (
              <div className="chat-tool-activity text-sm text-muted">
                <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2, display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }} />
                {chat.toolActivity.name}...
              </div>
            )}
            {chat.error && (
              <div className="chat-message chat-message-notification chat-message-notification-error">
                <div className="chat-message-content"><div className="markdown-body"><p>{chat.error}</p></div></div>
              </div>
            )}
          </ChatPanel>

          <div className="notes-chat-input">
            <ChatInput
              onSend={handleSend}
              onStop={chat.stopGeneration}
              isStreaming={chat.isStreaming}
              queueCount={chat.queueCount}
              showCommands={false}
              placeholder="Ask the note assistant…"
              draftKey={`draft:note-agent:${conversationId}`}
            />
          </div>
        </>
      )}
    </div>
  );
}
