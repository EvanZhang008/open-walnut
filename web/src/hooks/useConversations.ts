/**
 * useConversations — manages the conversation list for the active agent.
 *
 * The server is the source of truth for activeConversationId; localStorage only
 * provides a per-agent hint to avoid a flash before the first fetch resolves.
 * Subscribes to conversation:* events so changes made elsewhere (or by other
 * tabs) refresh the list.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useEvent } from './useWebSocket';
import { log } from '@/utils/log';
import {
  listConversations,
  createConversation,
  setActiveConversation,
  renameConversation as apiRename,
  setConversationPinned,
  deleteConversation as apiDelete,
  type ConversationMeta,
} from '@/api/conversations';

export const ACTIVE_CONV_KEY = (agentId: string) => `walnut:activeConv:${agentId}`;

export interface UseConversationsReturn {
  conversations: ConversationMeta[];
  activeConversationId: string | null;
  isLoading: boolean;
  create: (title?: string) => Promise<string>;
  switchTo: (conversationId: string) => void;
  rename: (conversationId: string, title: string) => Promise<void>;
  remove: (conversationId: string) => Promise<void>;
  togglePin: (conversationId: string) => Promise<void>;
  refresh: () => void;
}

export function useConversations(agentId: string): UseConversationsReturn {
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ACTIVE_CONV_KEY(agentId));
    } catch {
      return null;
    }
  });
  const [isLoading, setIsLoading] = useState(true);

  // Keep agentId in a ref for stable callbacks (event handlers + actions).
  const agentIdRef = useRef(agentId);
  agentIdRef.current = agentId;

  const applyActive = useCallback((aid: string, cid: string | null) => {
    setActiveConversationId(cid);
    try {
      if (cid) localStorage.setItem(ACTIVE_CONV_KEY(aid), cid);
    } catch { /* localStorage unavailable */ }
  }, []);

  const load = useCallback((aid: string, signal?: { cancelled: boolean }) => {
    setIsLoading(true);
    listConversations(aid)
      .then((resp) => {
        if (signal?.cancelled) return;
        setConversations(resp.conversations);
        applyActive(aid, resp.activeConversationId);
      })
      .catch((err) => {
        if (signal?.cancelled) return;
        log.warn('frontend', 'useConversations: failed to load conversations', {
          agentId: aid, error: String(err),
        });
      })
      .finally(() => {
        if (!signal?.cancelled) setIsLoading(false);
      });
  }, [applyActive]);

  // Fetch list + active on agentId change. Reset state so a stale agent's
  // conversations don't flash before the new fetch resolves.
  useEffect(() => {
    const signal = { cancelled: false };
    setConversations([]);
    // Seed active from the per-agent hint while the fetch is in flight.
    try {
      setActiveConversationId(localStorage.getItem(ACTIVE_CONV_KEY(agentId)));
    } catch {
      setActiveConversationId(null);
    }
    load(agentId, signal);
    return () => { signal.cancelled = true; };
  }, [agentId, load]);

  const refresh = useCallback(() => {
    load(agentIdRef.current);
  }, [load]);

  // Refresh when conversations change elsewhere (other tabs / server-side timers).
  // Only react to events for the currently-active agent.
  const onConversationEvent = useCallback((data: unknown) => {
    const eventAgentId = (data as Record<string, unknown>)?.agentId as string | undefined;
    if (eventAgentId && eventAgentId !== agentIdRef.current) return;
    refresh();
  }, [refresh]);
  useEvent('conversation:created', onConversationEvent);
  useEvent('conversation:deleted', onConversationEvent);
  useEvent('conversation:updated', onConversationEvent);

  const create = useCallback(async (title?: string): Promise<string> => {
    const aid = agentIdRef.current;
    const meta = await createConversation(aid, title);
    // Server sets the new conversation active; reflect optimistically + refresh.
    setConversations((prev) => [meta, ...prev.filter((c) => c.id !== meta.id)]);
    applyActive(aid, meta.id);
    log.info('frontend', 'useConversations: created conversation', {
      agentId: aid, conversationId: meta.id,
    });
    return meta.id;
  }, [applyActive]);

  const switchTo = useCallback((conversationId: string) => {
    const aid = agentIdRef.current;
    applyActive(aid, conversationId);   // optimistic
    setActiveConversation(aid, conversationId).catch((err) => {
      log.warn('frontend', 'useConversations: failed to set active conversation', {
        agentId: aid, conversationId, error: String(err),
      });
    });
  }, [applyActive]);

  const rename = useCallback(async (conversationId: string, title: string): Promise<void> => {
    const aid = agentIdRef.current;
    const meta = await apiRename(aid, conversationId, title);
    setConversations((prev) => prev.map((c) => (c.id === conversationId ? meta : c)));
  }, []);

  const togglePin = useCallback(async (conversationId: string): Promise<void> => {
    const aid = agentIdRef.current;
    const current = conversations.find((c) => c.id === conversationId);
    const meta = await setConversationPinned(aid, conversationId, !current?.pinned);
    setConversations((prev) => prev.map((c) => (c.id === conversationId ? meta : c)));
    refresh(); // pin changes sort order — re-fetch for the canonical ordering
  }, [conversations, refresh]);

  const remove = useCallback(async (conversationId: string): Promise<void> => {
    const aid = agentIdRef.current;
    await apiDelete(aid, conversationId);
    // The deleted conversation may have been active — re-fetch to learn the new active.
    refresh();
  }, [refresh]);

  return {
    conversations,
    activeConversationId,
    isLoading,
    create,
    switchTo,
    rename,
    remove,
    togglePin,
    refresh,
  };
}
