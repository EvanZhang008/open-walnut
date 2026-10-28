/**
 * Who sent a received message, the way its card names them: the live session
 * title from the mention index (an exact id, else a unique short-id prefix), else
 * the title the envelope printed. One hook per component; the returned function
 * is cheap per call.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { SessionEnvelopePeer } from '@open-walnut/history-session-envelope';
import { resolveRefInIndex } from '@/components/chat/session-mention';
import { ensureSessionMentionIndex, getSessionMentionIndex, subscribeSessionMentionIndex } from '@/stores/session-mention-index';

export type PeerNameOf = (peer: SessionEnvelopePeer) => string | undefined;

export function usePeerNameOf(): PeerNameOf {
  const candidates = useSyncExternalStore(subscribeSessionMentionIndex, getSessionMentionIndex, getSessionMentionIndex);
  useEffect(() => { void ensureSessionMentionIndex(); }, []);
  return useCallback((peer: SessionEnvelopePeer) => {
    if (peer.anonymous) return undefined;
    const hit = peer.sessionId ? candidates.find((c) => c.id === peer.sessionId)
      : peer.shortId ? resolveRefInIndex(peer.shortId, candidates) : undefined;
    return hit?.title || peer.title;
  }, [candidates]);
}
