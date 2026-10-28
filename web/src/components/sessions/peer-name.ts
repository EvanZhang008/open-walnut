/**
 * Who sent a received message, the way its card names them
 * (SessionProvenanceCard): the sender's task title, else the live session title
 * from the mention index (an exact id, else a unique short-id prefix), else the
 * title the envelope printed. A fold line that named the session while the card
 * under it named the task read as two senders ("Reply from Walnut lead" over a
 * card from "Walnut VP", 2026-10-27). One hook per component; the returned
 * function is cheap per call.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { SessionEnvelopePeer } from '@open-walnut/history-session-envelope';
import { candidateTaskId, resolveRefInIndex } from '@/components/chat/session-mention';
import { ensureSessionMentionIndex, getSessionMentionIndex, subscribeSessionMentionIndex } from '@/stores/session-mention-index';
import { getEntityLabelsVersion, peekTaskLabel, subscribeEntityLabels } from '@/stores/entity-label-store';
import { sessionStatusStore } from '@/stores/session-status-store';

export type PeerNameOf = (peer: SessionEnvelopePeer) => string | undefined;

export function usePeerNameOf(): PeerNameOf {
  const candidates = useSyncExternalStore(subscribeSessionMentionIndex, getSessionMentionIndex, getSessionMentionIndex);
  const labels = useSyncExternalStore(subscribeEntityLabels, getEntityLabelsVersion, getEntityLabelsVersion);
  useEffect(() => { void ensureSessionMentionIndex(); }, []);
  return useCallback((peer: SessionEnvelopePeer) => {
    if (peer.anonymous) return undefined;
    const hit = peer.sessionId ? candidates.find((c) => c.id === peer.sessionId)
      : peer.shortId ? resolveRefInIndex(peer.shortId, candidates) : undefined;
    const sessionId = peer.sessionId ?? hit?.id;
    const taskId = peer.taskId ?? candidateTaskId(hit ?? undefined)
      ?? (sessionId ? sessionStatusStore.getStatus(sessionId)?.taskId ?? undefined : undefined);
    return (taskId ? peekTaskLabel(taskId)?.title : undefined) || hit?.title || peer.title;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- labels invalidates the task title lookups inside
  }, [candidates, labels]);
}
