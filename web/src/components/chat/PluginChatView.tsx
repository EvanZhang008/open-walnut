import type { ImageAttachment } from '@/api/chat'
import { ChatInput } from '@/components/chat/ChatInput'
import { ChatMessage } from '@/components/chat/ChatMessage'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { useChat } from '@/hooks/useChat'
import type { ChatViewProps } from '@/plugins/types'

interface PluginChatViewProps extends Omit<ChatViewProps, 'draftKey'> {
  draftStorageKey: string
}

export function PluginChatView({
  agentId,
  conversationId,
  draftStorageKey,
  title = 'Chat',
  placeholder = 'Message this agent…',
  emptyText = 'Start a conversation.',
  transformMessage,
}: PluginChatViewProps) {
  const chat = useChat(agentId, conversationId)

  const handleSend = (text: string, images?: ImageAttachment[]) => {
    const message = transformMessage ? transformMessage(text) : text
    chat.sendMessage(message, undefined, images)
  }

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
            />
          </div>
        </>
      )}
    </div>
  )
}
