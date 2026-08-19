import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from './client';

// Mirrors src/core/types.ts ConversationMeta (backend owns the source type).
export interface ConversationMeta {
  id: string;                          // 'conv-<uuid>'
  agentId: string;
  title: string;                       // auto from 1st user msg (≤60 chars), renameable
  createdAt: string;                   // ISO
  lastMessageAt: string;               // ISO — sort key (desc)
  messageCount: number;                // logical message count (approx, for display)
  pinned?: boolean;
  isMain?: boolean;                    // exactly ONE true per agent — receives notifications & cron, can't be deleted
  lastDistilledAt: string | null;      // null = never distilled
  lastDistilledMessageCount: number;   // messageCount at last distill (dedup key)
}

export interface ConversationIndex {
  version: 1;
  activeConversationId: string | null;
  conversations: ConversationMeta[];
}

export async function listConversations(
  agentId: string,
): Promise<{ conversations: ConversationMeta[]; activeConversationId: string }> {
  return apiGet<{ conversations: ConversationMeta[]; activeConversationId: string }>(
    `/api/agents/${agentId}/conversations`,
  );
}

export async function createConversation(
  agentId: string,
  title?: string,
): Promise<ConversationMeta> {
  const res = await apiPost<{ conversation: ConversationMeta }>(
    `/api/agents/${agentId}/conversations`,
    title ? { title } : {},
  );
  return res.conversation;
}

export async function setActiveConversation(
  agentId: string,
  conversationId: string,
): Promise<void> {
  await apiPut<{ activeConversationId: string }>(
    `/api/agents/${agentId}/conversations/active`,
    { conversationId },
  );
}

export async function renameConversation(
  agentId: string,
  conversationId: string,
  title: string,
): Promise<ConversationMeta> {
  const res = await apiPatch<{ conversation: ConversationMeta }>(
    `/api/agents/${agentId}/conversations/${conversationId}`,
    { title },
  );
  return res.conversation;
}

export async function setConversationPinned(
  agentId: string,
  conversationId: string,
  pinned: boolean,
): Promise<ConversationMeta> {
  const res = await apiPatch<{ conversation: ConversationMeta }>(
    `/api/agents/${agentId}/conversations/${conversationId}`,
    { pinned },
  );
  return res.conversation;
}

export async function deleteConversation(
  agentId: string,
  conversationId: string,
): Promise<void> {
  await apiDelete(`/api/agents/${agentId}/conversations/${conversationId}`);
}

/** Turn the WHOLE conversation into a task: creates the task and links the lane
 *  session to it. The conversation stays in Main Chat; the task's session circle
 *  routes back to the same transcript. 409 when the lane has no session yet. */
export async function promoteConversationToTask(
  agentId: string,
  conversationId: string,
  input: { title?: string; project?: string },
): Promise<{ task: import('@open-walnut/core').Task; sessionId: string }> {
  return apiPost<{ task: import('@open-walnut/core').Task; sessionId: string }>(
    `/api/agents/${agentId}/conversations/${conversationId}/promote-task`,
    input,
  );
}

/** Fork a conversation: new conversation + a forked lane session carrying the
 *  full history (CLI --resume --fork-session). Lane engine only (409 otherwise). */
export async function forkConversation(
  agentId: string,
  conversationId: string,
): Promise<{ conversation: ConversationMeta; sessionId: string }> {
  return apiPost<{ conversation: ConversationMeta; sessionId: string }>(
    `/api/agents/${agentId}/conversations/${conversationId}/fork`,
    {},
  );
}
