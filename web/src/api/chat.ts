import { apiGet, apiPost } from './client';

// Block types for rich chat messages — shared between API layer, hooks, and components
export interface ThinkingBlock {
  type: 'thinking';
  content: string;
}

export interface ToolCallBlock {
  type: 'tool_call';
  name: string;
  toolUseId?: string;
  input?: Record<string, unknown>;
  result?: string;
  status: 'calling' | 'done' | 'error';
}

/** Detect if a tool call result indicates an error */
export function isToolResultError(result: string | undefined): boolean {
  if (!result) return false;
  const trimmed = result.trimStart();
  // Plain-text error prefixes (used by most tools)
  if (trimmed.startsWith('Error:')
    || trimmed.startsWith('Error -')
    || trimmed.startsWith('[Error]')
    || trimmed.startsWith('ToolError:')
    || trimmed.startsWith('[Aborted')) return true;
  // JSON-wrapped errors (exec tool returns {"status":"error",...})
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      return parsed.status === 'error' || parsed.status === 'blocked';
    } catch { /* not JSON, ignore */ }
  }
  return false;
}

export interface TextBlock {
  type: 'text';
  content: string;
}

export interface ImageBlock {
  type: 'image';
  mediaType: string;
  data: string;  // base64 data, '[compacted]', or '' when using url
  url?: string;  // /api/images/{filename} — set for path-based images from history
}

export type MessageBlock = ThinkingBlock | ToolCallBlock | TextBlock | ImageBlock;

export interface ImageAttachment {
  data: string;       // raw base64 (empty string when url is set)
  mediaType: string;  // 'image/png', etc.
  name: string;       // filename or 'pasted-image'
  url?: string;       // /api/images/{filename} — set for persisted images
}

/**
 * Unified chat entry from the server — single source of truth.
 * - tag 'ai': model-facing message with Anthropic ContentBlock[] content
 * - tag 'ui': display-only notification with string content
 */
export interface ChatEntry {
  tag: 'ai' | 'ui';
  role: 'user' | 'assistant';
  content: unknown;  // ContentBlock[] for 'ai', string for 'ui'
  timestamp: string;
  displayText?: string;
  source?: 'cron' | 'triage' | 'session' | 'session-error' | 'agent-error' | 'subagent' | 'compaction' | 'compacting' | 'heartbeat';
  cronJobName?: string;
  notification?: boolean;
  taskId?: string;
  sessionId?: string;  // Linked session ID (e.g. embedded triage run ID)
  compacted?: boolean;
  contextHashes?: Record<string, string>;
}

/** @deprecated Use ChatEntry instead */
export interface DisplayMessage {
  role: 'user' | 'assistant';
  content: string;
  blocks?: MessageBlock[];
  timestamp: string;
  source?: 'cron' | 'triage' | 'session' | 'session-error' | 'agent-error' | 'subagent' | 'compaction' | 'heartbeat';
  cronJobName?: string;
  notification?: boolean;
  taskId?: string;
}

export interface PaginationInfo {
  page: number;
  pageSize: number;
  totalMessages: number;
  totalPages: number;
  hasMore: boolean;
}

export interface ChatHistoryResponse {
  messages: ChatEntry[];
  pagination: PaginationInfo;
}

export async function fetchChatHistory(
  page = 1,
  pageSize = 100,
): Promise<ChatHistoryResponse> {
  const params: Record<string, string> = {
    page: String(page),
    pageSize: String(pageSize),
  };
  return apiGet<ChatHistoryResponse>('/api/chat/history', params);
}

export interface TriageHistoryResponse {
  entries: ChatEntry[];
  total: number;
}

export async function fetchTriageHistory(
  limit = 50,
  taskId?: string,
): Promise<TriageHistoryResponse> {
  const params: Record<string, string> = { limit: String(limit) };
  if (taskId) params.taskId = taskId;
  return apiGet<TriageHistoryResponse>('/api/chat/triage', params);
}

export async function clearChatHistory(): Promise<void> {
  await apiPost('/api/chat/clear');
}

export async function compactChatHistory(): Promise<void> {
  await apiPost('/api/chat/compact');
}

export interface ChatStats {
  apiMessageCount: number;
  estimatedTokens: number;
  systemTokens?: number;
  toolsTokens?: number;
  estimatedTotalTokens?: number;
  compacted: boolean;
  /** Model's context window size (e.g. 200K or 1M). */
  contextWindow?: number;
}

export async function fetchChatStats(): Promise<ChatStats> {
  return apiGet<ChatStats>('/api/chat/stats');
}
