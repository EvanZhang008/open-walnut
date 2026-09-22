import { useEffect, useRef } from 'react'
import type { ImageAttachment } from '@/api/chat'
import { ChatInput } from '@/components/chat/ChatInput'
import { ChatMessage } from '@/components/chat/ChatMessage'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { useChat } from '@/hooks/useChat'
import type { ChatViewProps } from '@/plugins/types'

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
  /** Called after `autoSend` actually went out, so the caller can latch it. */
  onAutoSent?: (text: string) => void
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
  focusNonce,
}: PluginChatViewProps) {
  const chat = useChat(agentId, conversationId)

  const handleSend = (text: string, images?: ImageAttachment[]) => {
    const message = transformMessage ? transformMessage(text) : text
    chat.sendMessage(message, undefined, images)
  }

  // A ref, not state: StrictMode runs effects twice on mount and the conversation id lands a moment
  // after it, so the guard has to survive both without the user seeing the preset twice. Refs are
  // preserved across StrictMode's simulated remount, which is exactly the property needed.
  const autoSentRef = useRef(false)
  useEffect(() => {
    if (!autoSend || autoSentRef.current || !conversationId || chat.isLoading) return
    autoSentRef.current = true
    handleSend(autoSend)
    onAutoSent?.(autoSend)
    // handleSend/onAutoSent are re-created every render; the ref is what makes this run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSend, conversationId, chat.isLoading])

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
              onSend={handleSend}
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
