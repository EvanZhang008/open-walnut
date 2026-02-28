import { useState, useCallback, useRef, useEffect, type MutableRefObject } from 'react';
import { useEvent } from './useWebSocket';
import { wsClient } from '@/api/ws';
import {
  fetchChatHistory, clearChatHistory, fetchChatStats,
  isToolResultError,
  type ChatEntry, type ChatStats,
  type ThinkingBlock, type ToolCallBlock, type TextBlock, type ImageBlock, type MessageBlock,
  type ImageAttachment,
} from '@/api/chat';

const PAGE_SIZE = 100;

// Re-export block types for components that import from this file
export type { ThinkingBlock, ToolCallBlock, TextBlock, ImageBlock, MessageBlock, ImageAttachment };

let messageKeyCounter = 0;
function nextMessageKey(): string {
  return `msg-${++messageKeyCounter}`;
}

export interface ChatMessage {
  /** Stable unique key for React list rendering (survives prepend/append) */
  key: string;
  role: 'user' | 'assistant';
  content: string;
  blocks?: MessageBlock[];
  images?: ImageAttachment[];
  taskContext?: TaskContext;
  timestamp?: string;
  source?: 'cron' | 'triage' | 'triage-notify' | 'session' | 'session-error' | 'agent-error' | 'subagent' | 'compaction' | 'compacting' | 'heartbeat';
  cronJobName?: string;
  notification?: boolean;
  queued?: boolean;
  queueId?: number;
}

export interface TaskContext {
  id: string;
  title: string;
  category: string;
  project: string;
  status: string;
  phase?: string;
  priority?: string;
  starred?: boolean;
  due_date?: string;
  source?: string;
  description: string;
  summary: string;
  note: string;
  conversation_log?: string;
  created_at?: string;
  plan_session_id?: string;
  plan_session_status?: { work_status: string; process_status: string; activity?: string; provider?: string };
  exec_session_id?: string;
  exec_session_status?: { work_status: string; process_status: string; activity?: string; provider?: string };
  subtasks?: { id: string; title: string; done: boolean }[];
}

/** Build a rich task reference: [id|Project / Title] or [id|Title], falling back to [id]. */
function buildTaskRef(id: string, title?: string, project?: string, category?: string): string {
  if (!title) return `[${id}]`;
  const label = project && project !== category ? `${project} / ${title}` : title;
  return `[${id}|${label}]`;
}

/**
 * Parse Anthropic ContentBlock[] from an AI entry into MessageBlock[] for rendering.
 * Pairs tool_use blocks with subsequent tool_result blocks by ID.
 */
function parseContentBlocks(content: unknown): { text: string; blocks: MessageBlock[] } {
  if (typeof content === 'string') {
    return { text: content, blocks: content ? [{ type: 'text', content }] : [] };
  }
  if (!Array.isArray(content)) {
    return { text: '', blocks: [] };
  }

  const blocks: MessageBlock[] = [];
  const toolUseIndex = new Map<string, number>();
  let text = '';

  for (const block of content) {
    if (block.type === 'thinking' && block.thinking) {
      blocks.push({ type: 'thinking', content: block.thinking });
    } else if (block.type === 'text' && block.text) {
      blocks.push({ type: 'text', content: block.text });
      text += block.text;
    } else if (block.type === 'tool_use') {
      const idx = blocks.length;
      blocks.push({
        type: 'tool_call',
        name: block.name,
        input: block.input,
        status: 'done',
      });
      if (block.id) toolUseIndex.set(block.id, idx);
    } else if (block.type === 'tool_result' && block.tool_use_id) {
      const idx = toolUseIndex.get(block.tool_use_id);
      if (idx !== undefined && blocks[idx]?.type === 'tool_call') {
        const raw = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content);
        const tb = blocks[idx] as ToolCallBlock;
        tb.result = raw;
        if (isToolResultError(raw)) tb.status = 'error';
      }
    } else if (block.type === 'image') {
      // Path-based images (new format): { type: 'image', path: '...', media_type: '...' }
      if (block.path) {
        const filename = block.path.split('/').pop() ?? '';
        blocks.push({
          type: 'image',
          mediaType: block.media_type ?? 'image/png',
          data: '',
          url: `/api/images/${filename}`,
        });
      } else {
        // Legacy base64 images: { type: 'image', source: { data, media_type } }
        blocks.push({
          type: 'image',
          mediaType: block.source?.media_type ?? 'image/png',
          data: block.source?.data ?? '',
        });
      }
    }
  }

  return { text, blocks };
}

/**
 * Convert ChatEntry[] from the server into ChatMessage[] for rendering.
 * Groups consecutive AI entries so tool_use (assistant) and tool_result (user)
 * are paired into a single assistant message with rich blocks.
 */
function chatEntriesToMessages(entries: ChatEntry[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let i = 0;

  while (i < entries.length) {
    const entry = entries[i];

    if (entry.tag === 'ui') {
      // UI entries → render as-is
      const content = typeof entry.content === 'string' ? entry.content : '';
      messages.push({
        key: nextMessageKey(),
        role: entry.role,
        content,
        timestamp: entry.timestamp,
        source: entry.source,
        cronJobName: entry.cronJobName,
        notification: entry.notification,
      });
      i++;
      continue;
    }

    // AI user entry → render as user message
    if (entry.role === 'user') {
      // Skip tool_result-only user messages — they're paired with the preceding assistant
      if (Array.isArray(entry.content) && entry.content.every(
        (b: { type: string }) => b.type === 'tool_result',
      )) {
        i++;
        continue;
      }
      // Skip system-initiated user prompts (cron/heartbeat/triage/subagent) —
      // these are the agent prompt entries that duplicate the UI notification.
      // The corresponding tag:'ui' entry already displays in the chat.
      if (entry.source && entry.source !== 'compaction' && entry.source !== 'compacting') {
        i++;
        continue;
      }
      const displayContent = entry.displayText
        ?? (typeof entry.content === 'string' ? entry.content : '');

      // Extract images from content blocks for display
      let entryImages: ImageAttachment[] | undefined;
      if (Array.isArray(entry.content)) {
        const imgBlocks = entry.content.filter(
          (b: { type: string }) => b.type === 'image',
        );
        if (imgBlocks.length > 0) {
          entryImages = imgBlocks.map((b: { source?: { media_type?: string; data?: string }; path?: string; media_type?: string }) => {
            // Path-based images (new format)
            if (b.path) {
              const filename = (b.path as string).split('/').pop() ?? '';
              return {
                data: '',
                mediaType: b.media_type ?? 'image/png',
                name: 'uploaded-image',
                url: `/api/images/${filename}`,
              };
            }
            // Legacy base64 images
            return {
              data: b.source?.data ?? '',
              mediaType: b.source?.media_type ?? 'image/png',
              name: 'uploaded-image',
            };
          });
        }
      }

      messages.push({
        key: nextMessageKey(),
        role: 'user',
        content: displayContent,
        images: entryImages,
        timestamp: entry.timestamp,
        source: entry.source,
      });
      i++;
      continue;
    }

    // AI assistant entry: collect this + any following tool_result user entries
    // to build a complete assistant message with paired tool blocks.
    // IMPORTANT: never merge across source boundaries — a heartbeat turn must
    // not swallow entries from a subsequent user-chat turn (or vice-versa).
    const turnEntries: ChatEntry[] = [entry];
    let j = i + 1;
    while (j < entries.length) {
      const next = entries[j];
      if (next.tag !== 'ai') break;
      if (next.source !== entry.source) break; // don't merge across source boundaries
      // tool_result user messages belong to this turn
      if (next.role === 'user' && Array.isArray(next.content) && next.content.some(
        (b: { type: string }) => b.type === 'tool_result',
      )) {
        turnEntries.push(next);
        j++;
        // After tool_result, there may be another assistant response (multi-round tool use)
        if (j < entries.length && entries[j].tag === 'ai' && entries[j].role === 'assistant'
            && entries[j].source === entry.source) {
          turnEntries.push(entries[j]);
          j++;
        }
        continue;
      }
      break;
    }

    // Parse all turn entries together
    const allBlocks: unknown[] = [];
    for (const te of turnEntries) {
      if (Array.isArray(te.content)) {
        allBlocks.push(...te.content);
      }
    }
    const { text, blocks } = parseContentBlocks(allBlocks);

    messages.push({
      key: nextMessageKey(),
      role: 'assistant',
      content: text,
      blocks: blocks.length > 0 ? blocks : undefined,
      timestamp: entry.timestamp,
      source: entry.source,
      notification: entry.notification,
    });
    i = j;
  }

  return messages;
}

interface ToolActivity {
  name: string;
  status: 'running' | 'done';
}

export const MAX_QUEUE_SIZE = 10;
interface UseChatReturn {
  messages: ChatMessage[];
  isStreaming: boolean;
  isCompacting: boolean;
  toolActivity: ToolActivity | null;
  error: string | null;
  isLoading: boolean;
  stats: ChatStats | null;
  queueCount: number;
  hasMore: boolean;
  isLoadingOlder: boolean;
  /** Ref set to true right before older messages are prepended.
   *  Pass to ChatPanel so it can distinguish prepend from append for scroll preservation. */
  prependedRef: MutableRefObject<boolean>;
  sendMessage: (text: string, taskContext?: TaskContext, images?: ImageAttachment[]) => void;
  clearMessages: () => void;
  addLocalMessage: (content: string) => void;
  stopGeneration: () => void;
  cancelQueuedMessage: (queueId: number) => void;
  clearQueue: () => void;
  loadOlderMessages: () => void;
}

/** Helper: update the last assistant message's blocks, or create one.
 *  When `currentSource` is provided, only appends to the last assistant if its
 *  source matches — otherwise creates a new message. This prevents heartbeat/cron
 *  streaming from merging into a preceding chat message (or vice-versa). */
function upsertLastAssistant(
  prev: ChatMessage[],
  updater: (blocks: MessageBlock[], content: string) => { blocks: MessageBlock[]; content: string },
  currentSource?: ChatMessage['source'],
): ChatMessage[] {
  const last = prev[prev.length - 1];
  // Only append to existing assistant if source matches
  const sourceMatch = currentSource === undefined
    ? !last?.source   // no source given → only match messages without source
    : last?.source === currentSource;
  if (last && last.role === 'assistant' && sourceMatch) {
    const { blocks, content } = updater(last.blocks ?? [], last.content);
    return [...prev.slice(0, -1), { ...last, content, blocks }];
  }
  const { blocks, content } = updater([], '');
  return [...prev, {
    key: nextMessageKey(), role: 'assistant', content, blocks,
    timestamp: new Date().toISOString(),
    ...(currentSource ? { source: currentSource } : {}),
  }];
}

export function useChat(): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [toolActivity, setToolActivity] = useState<ToolActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [stats, setStats] = useState<ChatStats | null>(null);
  const [queueCount, setQueueCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const prependedRef = useRef(false);
  const nextPageRef = useRef(2);
  // Queue for messages sent while AI is streaming
  const queueIdCounter = useRef(0);
  const queueRef = useRef<{ id: number; text: string; taskContext?: TaskContext; images?: ImageAttachment[] }[]>([]);
  // Track whether an RPC is in flight (to know when to drain)
  const rpcInFlightRef = useRef(false);
  // Timer ID for delayed drain after errors (cleared on queue reset / unmount)
  const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // State refs for use in stable callbacks (avoids deps on isStreaming)
  const isStreamingRef = useRef(false);
  // Track the current agent turn's source so streaming handlers can separate heartbeat/cron/chat
  const currentSourceRef = useRef<ChatMessage['source'] | undefined>(undefined);
  // Forward ref for sendRpc to break circular dependency with drainOrStop
  const sendRpcRef = useRef<(text: string, taskContext?: TaskContext, images?: ImageAttachment[]) => void>(undefined);

  // Keep refs in sync with state
  isStreamingRef.current = isStreaming;

  // Fetch real conversation stats from server
  const refreshStats = useCallback(() => {
    fetchChatStats().then(setStats).catch(() => {});
  }, []);

  // Load chat history from server on mount
  useEffect(() => {
    let cancelled = false;
    fetchChatHistory(1, PAGE_SIZE)
      .then((resp) => {
        if (cancelled) return;
        setMessages(chatEntriesToMessages(resp.messages));
        setHasMore(resp.pagination.hasMore);
        nextPageRef.current = 2;
      })
      .catch(() => {
        // Failed to load history — start with empty
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    refreshStats();
    return () => { cancelled = true; };
  }, [refreshStats]);

  // Handle thinking blocks
  useEvent('agent:thinking', (data) => {
    const { text } = data as { text: string };
    const src = currentSourceRef.current;
    setMessages((prev) =>
      upsertLastAssistant(prev, (blocks, content) => ({
        blocks: [...blocks, { type: 'thinking', content: text }],
        content,
      }), src),
    );
  });

  // Handle streaming text deltas — batch via rAF to coalesce ~100 tokens/sec into ~60 renders/sec
  const textDeltaBuffer = useRef('');
  const textDeltaRaf = useRef<number | null>(null);

  // Cancel pending rAF on unmount to avoid setState on unmounted component
  useEffect(() => {
    return () => {
      if (textDeltaRaf.current !== null) {
        cancelAnimationFrame(textDeltaRaf.current);
        textDeltaRaf.current = null;
      }
    };
  }, []);

  useEvent('agent:text-delta', (data) => {
    const { delta, sessionId, source } = data as { delta: string; sessionId?: string; source?: string };
    if (sessionId) return;

    // Track the source of the current agent turn (heartbeat, cron, triage, etc.)
    if (source && !currentSourceRef.current) {
      currentSourceRef.current = source as ChatMessage['source'];
    }

    textDeltaBuffer.current += delta;

    if (textDeltaRaf.current === null) {
      textDeltaRaf.current = requestAnimationFrame(() => {
        textDeltaRaf.current = null;
        const accumulated = textDeltaBuffer.current;
        textDeltaBuffer.current = '';
        if (!accumulated) return;

        const src = currentSourceRef.current;
        setMessages((prev) =>
          upsertLastAssistant(prev, (blocks, content) => {
            const last = blocks[blocks.length - 1];
            if (last && last.type === 'text') {
              return {
                blocks: [...blocks.slice(0, -1), { type: 'text', content: last.content + accumulated }],
                content: content + accumulated,
              };
            }
            return {
              blocks: [...blocks, { type: 'text', content: accumulated }],
              content: content + accumulated,
            };
          }, src),
        );
      });
    }
  });

  // Handle tool call start
  useEvent('agent:tool-call', (data) => {
    const { toolName, input } = data as { toolName: string; input: Record<string, unknown> };
    const src = currentSourceRef.current;
    setMessages((prev) =>
      upsertLastAssistant(prev, (blocks, content) => ({
        blocks: [...blocks, { type: 'tool_call', name: toolName, input, status: 'calling' }],
        content,
      }), src),
    );
  });

  // Handle tool result
  useEvent('agent:tool-result', (data) => {
    const { toolName, result } = data as { toolName: string; result: string };
    const src = currentSourceRef.current;
    setMessages((prev) =>
      upsertLastAssistant(prev, (blocks, content) => {
        // Find the last tool_call block with this name that's still 'calling'
        const updated = [...blocks];
        for (let i = updated.length - 1; i >= 0; i--) {
          const b = updated[i];
          if (b.type === 'tool_call' && b.name === toolName && b.status === 'calling') {
            updated[i] = { ...b, status: isToolResultError(result) ? 'error' : 'done', result };
            break;
          }
        }
        return { blocks: updated, content };
      }, src),
    );
  });

  // Handle tool activity indicators (keep transient spinner, skip session events)
  useEvent('agent:tool-activity', (data) => {
    const activity = data as ToolActivity & { sessionId?: string };
    if (activity.sessionId) return;
    setToolActivity(activity.status === 'done' ? null : activity);
  });

  // Handle final complete response
  useEvent('agent:response', (data) => {
    const { source } = (data ?? {}) as { source?: string };
    setToolActivity(null);
    refreshStats();

    // Retroactively tag the streaming assistant message with its source
    // (heartbeat/cron/triage text-deltas may create the message before source is known)
    if (source) {
      const typedSource = source as ChatMessage['source'];
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant' && !last.source) {
          return [...prev.slice(0, -1), { ...last, source: typedSource }];
        }
        return prev;
      });
    }

    // Clear source ref — this turn is complete
    currentSourceRef.current = undefined;

    // If RPC is in flight, .then() will call drainOrStop when it resolves.
    // If no RPC (cron/triage), drain or stop now.
    if (!rpcInFlightRef.current) {
      drainOrStop();
    }
  });

  // Handle cron chat messages — show scheduled job triggers in chat
  useEvent('cron:chat-message', (data) => {
    const { content, jobName, timestamp, agentWillRespond } = data as {
      content: string; jobName: string; timestamp: string; agentWillRespond?: boolean;
    };
    setMessages((prev) => [
      ...prev,
      {
        key: nextMessageKey(),
        role: 'user',
        content,
        timestamp,
        source: 'cron',
        cronJobName: jobName,
      },
    ]);
    // Only show streaming indicator when agent will actually respond (wakeMode 'now')
    if (agentWillRespond) {
      setIsStreaming(true);
    }
  });

  // Handle heartbeat chat messages — show heartbeat triggers in chat
  // Heartbeat always triggers an agent response, so always set streaming indicator
  useEvent('heartbeat:chat-message', (data) => {
    const { content, timestamp } = data as { content: string; timestamp: string };
    setMessages((prev) => [
      ...prev,
      {
        key: nextMessageKey(),
        role: 'user',
        content,
        timestamp,
        source: 'heartbeat',
        notification: true,
      },
    ]);
    setIsStreaming(true);
  });

  // Handle session results — show completed session output in chat
  useEvent('session:result', (data) => {
    const { result, taskId: eventTaskId, isError,
            taskTitle, taskProject, taskCategory } = data as {
      result?: string; taskId?: string; sessionId?: string; isError?: boolean;
      taskTitle?: string; taskProject?: string; taskCategory?: string;
    };
    if (!result) return;
    const prefix = isError ? '**Session Error**' : '**Session Result**';
    const taskRef = eventTaskId ? buildTaskRef(eventTaskId, taskTitle, taskProject, taskCategory) : null;
    const content = taskRef
      ? `${prefix} (${taskRef}):\n\n${result}`
      : `${prefix}:\n\n${result}`;
    setMessages((prev) => [...prev, {
      key: nextMessageKey(),
      role: 'assistant', content, blocks: [{ type: 'text', content }],
      source: isError ? 'session-error' : 'session',
      notification: true,
    }]);
  });

  // Handle session errors
  useEvent('session:error', (data) => {
    const { error: errMsg, taskId: eventTaskId,
            taskTitle, taskProject, taskCategory } = data as {
      error: string; taskId?: string;
      taskTitle?: string; taskProject?: string; taskCategory?: string;
    };
    const taskRef = eventTaskId ? buildTaskRef(eventTaskId, taskTitle, taskProject, taskCategory) : null;
    const content = `**Session Error**${taskRef ? ` (${taskRef})` : ''}: ${errMsg}`;
    setMessages((prev) => [...prev, {
      key: nextMessageKey(),
      role: 'assistant', content, blocks: [{ type: 'text', content }],
      source: 'session-error',
      notification: true,
    }]);
  });

  // Handle chat:history-updated — server pushes compact notifications (triage, subagent)
  useEvent('chat:history-updated', (data) => {
    const { entry } = data as {
      entry?: { role: 'user' | 'assistant'; content: string; source?: string; notification?: boolean; taskId?: string; timestamp?: string };
    };
    if (!entry || !entry.content) return;
    setMessages((prev) => [...prev, {
      key: nextMessageKey(),
      role: entry.role,
      content: entry.content,
      timestamp: entry.timestamp,
      source: entry.source as ChatMessage['source'],
      notification: entry.notification,
    }]);
  });

  // Handle errors — don't clear queue; after a delay, drain remaining queued messages
  useEvent('agent:error', (data) => {
    const { error: errMsg } = data as { error: string };
    setError(errMsg);
    setToolActivity(null);
    // Let the user see the error, then drain remaining queued messages
    if (queueRef.current.length > 0) {
      drainTimerRef.current = setTimeout(() => { drainTimerRef.current = null; drainOrStop(); }, 1500);
    } else {
      setIsStreaming(false);
    }
  });

  // Handle compaction lifecycle
  useEvent('chat:compacting', () => {
    setIsCompacting(true);
    // Insert a placeholder message at the current position in chat.
    // New messages sent during compaction appear BELOW this spinner.
    setMessages((prev) => [...prev, {
      key: nextMessageKey(),
      role: 'assistant',
      content: 'Compacting conversation history...',
      source: 'compacting' as ChatMessage['source'],
      notification: true,
      timestamp: new Date().toISOString(),
    }]);
  });

  useEvent('chat:compacted', (data) => {
    setIsCompacting(false);
    const { divider } = data as { divider?: string };
    // Only reset pagination when actual compaction occurred (has divider).
    // A no-op compaction (empty payload) should not discard scroll-back state.
    if (divider) {
      refreshStats();
      setHasMore(false);
      nextPageRef.current = 2;
    }
    // Replace the compacting placeholder with the final divider (or remove it)
    setMessages((prev) => {
      const without = prev.filter((m) => m.source !== 'compacting');
      if (divider) {
        // Count non-compacting messages before the placeholder to find the
        // correct insertion index in the filtered array (avoids off-by-one
        // since `without` has one fewer element than `prev`).
        const placeholderIdx = prev.findIndex((m) => m.source === 'compacting');
        const insertIdx = placeholderIdx >= 0
          ? prev.slice(0, placeholderIdx).filter((m) => m.source !== 'compacting').length
          : without.length;
        const dividerMsg: ChatMessage = {
          key: nextMessageKey(),
          role: 'assistant',
          content: divider,
          source: 'compaction' as ChatMessage['source'],
          notification: true,
          timestamp: new Date().toISOString(),
        };
        return [...without.slice(0, insertIdx), dividerMsg, ...without.slice(insertIdx)];
      }
      return without;
    });
  });

  /** Clear all queued messages from state and ref */
  const clearQueue = useCallback(() => {
    if (drainTimerRef.current) { clearTimeout(drainTimerRef.current); drainTimerRef.current = null; }
    queueRef.current = [];
    setQueueCount(0);
    setMessages((prev) => prev.filter((m) => !m.queued));
  }, []);

  /** Cancel a single queued message by its queueId */
  const cancelQueuedMessage = useCallback((queueId: number) => {
    queueRef.current = queueRef.current.filter((item) => item.id !== queueId);
    setQueueCount(queueRef.current.length);
    setMessages((prev) => prev.filter((m) => !(m.queued && m.queueId === queueId)));
  }, []);

  /** Drain the next queued message, or set isStreaming=false if queue is empty */
  const drainOrStop = useCallback(() => {
    if (queueRef.current.length > 0) {
      const next = queueRef.current.shift()!;
      setQueueCount(queueRef.current.length);
      // Remove queued badge from the first matching message (by queueId)
      setMessages((prev) => {
        let found = false;
        return prev.map((m) => {
          if (!found && m.queued && m.queueId === next.id) {
            found = true;
            return { ...m, queued: false };
          }
          return m;
        });
      });
      sendRpcRef.current?.(next.text, next.taskContext, next.images);
    } else {
      setIsStreaming(false);
    }
  }, []);

  /** Send a message via RPC (not queued) */
  const sendRpc = useCallback((text: string, taskContext?: TaskContext, images?: ImageAttachment[]) => {
    setIsStreaming(true);
    setError(null);
    rpcInFlightRef.current = true;
    // User-initiated chat — clear source so streaming goes into an unsourced assistant message
    currentSourceRef.current = undefined;

    const payload: Record<string, unknown> = { message: text };
    if (taskContext) {
      payload.taskContext = taskContext;
    }
    if (images?.length) {
      payload.images = images.map(img => ({ data: img.data, mediaType: img.mediaType }));
    }

    wsClient.sendRpc('chat', payload)
      .then(() => {
        rpcInFlightRef.current = false;
        drainOrStop();
      })
      .catch((e: Error) => {
        rpcInFlightRef.current = false;
        setError(e.message);
        // Don't clear queue on RPC error — drain remaining after delay
        if (queueRef.current.length > 0) {
          drainTimerRef.current = setTimeout(() => { drainTimerRef.current = null; drainOrStop(); }, 1500);
        } else {
          setIsStreaming(false);
        }
      });
  }, [drainOrStop]);
  sendRpcRef.current = sendRpc;

  const sendMessage = useCallback((text: string, taskContext?: TaskContext, images?: ImageAttachment[]) => {
    if (isStreamingRef.current) {
      if (queueRef.current.length >= MAX_QUEUE_SIZE) return;
      const queueId = ++queueIdCounter.current;
      const userMsg: ChatMessage = {
        key: nextMessageKey(),
        role: 'user', content: text, taskContext, images,
        timestamp: new Date().toISOString(), queued: true, queueId,
      };
      setMessages((prev) => [...prev, userMsg]);
      queueRef.current.push({ id: queueId, text, taskContext, images });
      setQueueCount(queueRef.current.length);
      return;
    }

    // Immediate send
    const userMsg: ChatMessage = { key: nextMessageKey(), role: 'user', content: text, taskContext, images, timestamp: new Date().toISOString() };
    setMessages((prev) => [...prev, userMsg]);
    sendRpc(text, taskContext, images);
  }, [sendRpc]);

  const clearMessages = useCallback(() => {
    clearChatHistory().catch(() => {});
    clearQueue();
    setMessages([]);
    setError(null);
    setHasMore(false);
    nextPageRef.current = 2;
  }, [clearQueue]);

  const addLocalMessage = useCallback((content: string) => {
    setMessages((prev) => [...prev, {
      key: nextMessageKey(),
      role: 'assistant',
      content,
      blocks: [{ type: 'text', content }],
      timestamp: new Date().toISOString(),
    }]);
  }, []);

  const stopGeneration = useCallback(() => {
    clearQueue();
    wsClient.sendRpc('chat:stop', {}).catch(() => {});
  }, [clearQueue]);

  const loadOlderMessages = useCallback(() => {
    if (isLoadingOlder || !hasMore) return;
    setIsLoadingOlder(true);
    const page = nextPageRef.current;
    fetchChatHistory(page, PAGE_SIZE)
      .then((resp) => {
        const older = chatEntriesToMessages(resp.messages);
        // Signal ChatPanel that we're prepending so it preserves scroll position
        prependedRef.current = true;
        setMessages((prev) => [...older, ...prev]);
        setHasMore(resp.pagination.hasMore);
        nextPageRef.current = page + 1;
      })
      .catch(() => {})
      .finally(() => setIsLoadingOlder(false));
  }, [isLoadingOlder, hasMore]);

  return { messages, isStreaming, isCompacting, toolActivity, error, isLoading, stats, queueCount, hasMore, isLoadingOlder, prependedRef, sendMessage, clearMessages, addLocalMessage, stopGeneration, cancelQueuedMessage, clearQueue, loadOlderMessages };
}
