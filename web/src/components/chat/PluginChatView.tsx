import { useEffect, useRef } from 'react'
import type { ImageAttachment } from '@/api/chat'
import { ChatInput } from '@/components/chat/ChatInput'
import { ChatMessage } from '@/components/chat/ChatMessage'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { useChat } from '@/hooks/useChat'
import type { ChatViewProps } from '@/plugins/types'
// The verdict lives next to the latch it decides (and is graded without a DOM there): `autoSend`
// exists for the Ask-object drawer, whose latch is the thing a wrong verdict destroys.
import { autoSendOutcome, type AutoSendWatch } from '@/components/chat/ask-object-conversation'

interface PluginChatViewProps extends Omit<ChatViewProps, 'draftKey'> {
  draftStorageKey: string
  /**
   * Send this text once, as soon as the conversation exists, as a normal user turn (so it goes
   * through `transformMessage` and shows up in the transcript). The Ask-object drawer's
   * `Summarize…` / `Draft a reply…` entries are "open AND ask" in one click; only the caller knows
   * whether this object was already asked, which is why the once-ness is a prop and not a guess
   * here. Plugins never see it: `ChatViewProps` is unchanged.
   */
  autoSend?: string
  /**
   * Called once `autoSend` has been handed to the transport, so the caller can latch it. Paired with
   * `onAutoSendFailed`: this is a claim, not a receipt — see the effect below for why the hook cannot
   * offer a receipt, and what corrects it.
   */
  onAutoSent?: (text: string) => void
  /**
   * Called when that send is afterwards known to have gone nowhere (an offline socket, a 500), so the
   * caller can give the latch back. Without it the question was unaskable forever: the latch is in
   * localStorage and nothing sent was ever shown.
   */
  onAutoSendFailed?: (text: string) => void
  /** Forwarded to the composer: a truthy nonce focuses the box WITHOUT touching the draft. */
  focusNonce?: number
}

export function PluginChatView({
  agentId,
  conversationId,
  draftStorageKey,
  title = 'Chat',
  placeholder = 'Message this agent…',
  emptyText = 'Start a conversation.',
  transformMessage,
  autoSend,
  onAutoSent,
  onAutoSendFailed,
  focusNonce,
}: PluginChatViewProps) {
  const chat = useChat(agentId, conversationId)

  const handleSend = (text: string, images?: ImageAttachment[]) => {
    const message = transformMessage ? transformMessage(text) : text
    return chat.sendMessage(message, undefined, images)
  }

  /**
   * The composer's own contract: `false` keeps the draft. So a send that never went out leaves the text
   * in the box for the user to retry, which is what the hook's outcome is now able to say. `queued`
   * counts as sent: the message is on screen and goes out when the running turn ends.
   */
  const sendFromComposer = (text: string, images?: ImageAttachment[]): Promise<boolean> => (
    handleSend(text, images).then((outcome) => outcome !== 'failed' && outcome !== 'dropped')
  )

  /** Assistant turns on screen — the one signal that says the server took the send. */
  const replies = chat.messages.reduce((count, message) => (
    message.role === 'assistant' ? count + 1 : count
  ), 0)

  // A ref, not state: StrictMode runs effects twice on mount and the conversation id lands a moment
  // after it, so the guard has to survive both without the user seeing the preset twice. Refs are
  // preserved across StrictMode's simulated remount, which is exactly the property needed.
  const autoSentRef = useRef(false)
  const watchRef = useRef<{ text: string; watch: AutoSendWatch } | null>(null)
  useEffect(() => {
    if (!autoSend || autoSentRef.current || !conversationId || chat.isLoading) return
    autoSentRef.current = true
    // The latch is CLAIMED here, for a send merely handed to the transport: that is the earliest point
    // at which a reopen could send the question twice, and a double send is the worse of the two
    // failures. Two things can take it back. `sendMessage` now answers what became of the send, which
    // is the DEFINITE signal, and the watcher below is the backstop for the case the promise cannot
    // speak for: a message parked behind a running turn, whose real delivery happens later.
    watchRef.current = { text: autoSend, watch: { repliesAtDispatch: replies, started: false } }
    const sending = handleSend(autoSend)
    onAutoSent?.(autoSend)
    void sending.then((outcome) => {
      if (outcome !== 'failed' && outcome !== 'dropped') return
      // Nothing was sent, so there is nothing for the watcher to conclude about.
      watchRef.current = null
      onAutoSendFailed?.(autoSend)
    })
    // handleSend/onAutoSent are re-created every render; the ref is what makes this run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSend, conversationId, chat.isLoading])

  // The other half of that contract. It deliberately does NOT retry: the hook has already put its own
  // error notification on screen, and the recovery the released latch buys is the next open.
  useEffect(() => {
    const pending = watchRef.current
    if (!pending) return
    const { watch, verdict } = autoSendOutcome(pending.watch, {
      replies,
      streaming: chat.isStreaming,
      queued: chat.queueCount,
    })
    pending.watch = watch
    if (verdict === 'pending') return
    watchRef.current = null
    if (verdict === 'failed') onAutoSendFailed?.(pending.text)
    // onAutoSendFailed is re-created every render; watchRef is what makes this fire at most once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replies, chat.isStreaming, chat.queueCount])

  return (
    <div className="plugin-chat-view" data-testid="plugin-chat-view" data-agent-id={agentId}>
      <div className="plugin-chat-view-header">
        <span>{title}</span>
        {chat.messages.length > 0 && (
          <button type="button" onClick={chat.clearMessages}>Clear</button>
        )}
      </div>
      {!conversationId || chat.isLoading ? (
        <div className="plugin-chat-view-loading"><LoadingSpinner /></div>
      ) : (
        <>
          <ChatPanel messageCount={chat.messages.length} prependedRef={chat.prependedRef}>
            {chat.messages.length === 0 && !chat.isStreaming && (
              <div className="plugin-chat-view-empty">{emptyText}</div>
            )}
            {chat.messages.map((message) => (
              <ChatMessage
                key={message.key}
                role={message.role}
                content={message.content}
                blocks={'blocks' in message ? message.blocks : undefined}
                images={'images' in message ? message.images : undefined}
                timestamp={'timestamp' in message ? message.timestamp : undefined}
                source={'source' in message ? message.source : undefined}
                notification={'notification' in message ? message.notification : undefined}
                queued={'queued' in message ? message.queued : undefined}
                onCancel={message.queued && message.queueId != null
                  ? () => chat.cancelQueuedMessage(message.queueId!)
                  : undefined}
              />
            ))}
            {chat.toolActivity && (
              <div className="chat-tool-activity text-sm text-muted">
                <span className="spinner plugin-chat-view-spinner" />
                {chat.toolActivity.name}...
              </div>
            )}
          </ChatPanel>
          <div className="plugin-chat-view-input">
            <ChatInput
              onSend={sendFromComposer}
              onStop={chat.stopGeneration}
              isStreaming={chat.isStreaming}
              queueCount={chat.queueCount}
              showCommands={false}
              placeholder={placeholder}
              draftKey={draftStorageKey}
              focusNonce={focusNonce}
            />
          </div>
        </>
      )}
    </div>
  )
}
