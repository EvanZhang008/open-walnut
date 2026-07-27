import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChat } from '@/hooks/useChat';
import { usePlanMode } from '@/hooks/usePlanMode';
import { useWebSocket } from '@/hooks/useWebSocket';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { ChatMessage } from '@/components/chat/ChatMessage';
import { ChatInput } from '@/components/chat/ChatInput';
import { QuickAccessBar } from '@/components/chat/QuickAccessBar';
import { useOverlayHeightVar } from '@/hooks/useHeightVar';
import type { SlashCommand, CommandContext } from '@/commands/types';
import { shouldHideUiOnlyMessage, useUiOnlySettings } from '@/hooks/useDeveloperSettings';

export function ChatPage() {
  const navigate = useNavigate();
  const { messages, isStreaming, toolActivity, isLoading, queueCount, hasMore, isLoadingOlder, prependedRef, sendMessage, clearMessages, addLocalMessage, stopGeneration, cancelQueuedMessage, clearQueue, loadOlderMessages } = useChat();
  const { mode: chatMode, toggleMode, getPlanPayload } = usePlanMode();
  const { connectionState } = useWebSocket();
  // Force re-render when UI Only settings change
  useUiOnlySettings();
  // G4 glass composer overlay height → --chat-composer-h on .chat-page
  const chatComposerRef = useOverlayHeightVar('--chat-composer-h', '.chat-panel');

  const handleSend = useCallback((text: string, images?: Parameters<typeof sendMessage>[2]) => {
    const plan = getPlanPayload();
    sendMessage(text, undefined, images, undefined, plan.mode, plan.planModeFirst, plan.planModeOff);
  }, [sendMessage, getPlanPayload]);

  const handleCommand = useCallback((cmd: SlashCommand, args?: string) => {
    const ctx: CommandContext = {
      sendMessage,
      clearMessages,
      addLocalMessage,
      navigate,
      args,
    };
    cmd.execute(ctx);
  }, [sendMessage, clearMessages, addLocalMessage, navigate]);

  return (
    <div className="chat-page">
      <div className="page-header flex justify-between items-center">
        <div>
          <h1 className="page-title">Chat</h1>
          <p className="page-subtitle">
            Chat with Walnut
            {connectionState !== 'connected' && (
              <span className="text-xs" style={{ color: 'var(--warning)', marginLeft: 8 }}>
                ({connectionState})
              </span>
            )}
          </p>
        </div>
        {messages.length > 0 && (
          <button className="btn" onClick={clearMessages}>Clear</button>
        )}
      </div>

      <ChatPanel messageCount={messages.length} prependedRef={prependedRef}>
        {hasMore && (
          <div className="chat-load-more">
            <button
              className="btn btn-sm"
              onClick={loadOlderMessages}
              disabled={isLoadingOlder}
            >
              {isLoadingOlder ? 'Loading…' : 'Load older messages'}
            </button>
          </div>
        )}
        {messages.length === 0 && !isLoading && (
          <div className="empty-state">
            <p>Start a conversation with Walnut. Ask about your tasks, get help with planning, or just chat.</p>
          </div>
        )}
        {messages
          .filter((msg) => !shouldHideUiOnlyMessage(msg.source, msg.notification))
          .map((msg) => (
          <ChatMessage
                key={msg.key}
                role={msg.role}
                content={msg.content}
                blocks={msg.blocks}
                timestamp={msg.timestamp}
                source={msg.source}
                cronJobName={msg.cronJobName}
                notification={msg.notification}
                queued={msg.queued}
                onCancel={msg.queued && msg.queueId != null ? () => cancelQueuedMessage(msg.queueId!) : undefined}
              />
        ))}
        {toolActivity && (
          <div className="chat-tool-activity text-sm text-muted">
            <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2, display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }} />
            {toolActivity.name}...
          </div>
        )}
      </ChatPanel>

      {/* G4 glass composer overlay — pills + input on one glass surface;
          .chat-panel pads by the tracked --chat-composer-h. */}
      <div className="chat-composer-overlay" ref={chatComposerRef}>
        <QuickAccessBar onSessionClick={() => {}} mode={chatMode} onModeToggle={toggleMode} />

        <ChatInput
          onSend={handleSend}
          onCommand={handleCommand}
          onStop={stopGeneration}
          onClearQueue={clearQueue}
          disabled={connectionState !== 'connected'}
          isStreaming={isStreaming}
          queueCount={queueCount}
          draftKey="draft:chat-page"
          onToggleMode={toggleMode}
        />
      </div>
    </div>
  );
}
