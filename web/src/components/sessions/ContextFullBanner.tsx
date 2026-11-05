/**
 * The error banner of a session whose conversation no longer fits the model's
 * context window ("Prompt is too long", 2026-11-05: the generic banner offered
 * Reconnect, which cannot help). Walnut compacts such a session by itself
 * (src/core/sessions/context-full-recovery.ts); this says where that stands and
 * offers the one action that works: compact, then resend what got no answer
 * (the same Retry route, which compacts for this error).
 */
import { useCallback, useEffect, useState } from 'react';
import type { SessionRecord } from '@/types/session';
import { useEvent } from '@/hooks/useWebSocket';
import { SessionRetryButton } from './SessionRetryButton';
import { WarningTriangleIcon } from '@/components/common/PhoneIcons';

interface ContextFullBannerProps {
  sessionId: string;
  session: SessionRecord;
  onResuming: () => void;
}

const HEAD = 'This conversation no longer fits the model’s context window, so every message gets “Prompt is too long”.';

/** The banner's sentence for the recovery's state. Exported for tests. */
export function contextFullBannerText(recovery: SessionRecord['contextRecovery'], errorAt?: string): { text: string; busy: boolean } {
  // A recovery older than this error belongs to an earlier episode.
  const current = recovery && (!errorAt || Date.parse(recovery.at) >= Date.parse(errorAt) - 1_000) ? recovery : undefined;
  if (current?.state === 'compacting') {
    return { text: `${HEAD} Walnut is compacting it, then resends the messages that got no answer.`, busy: true };
  }
  if (current?.state === 'failed' && current.reason) {
    return { text: `${HEAD} ${current.reason}`, busy: false };
  }
  return { text: `${HEAD} Compact it to go on: the conversation is summarized and the messages that got no answer are sent again.`, busy: false };
}

type Recovery = SessionRecord['contextRecovery'];

/** The newer of two readings of the recovery's state (the record, the live event). */
function newer(a: Recovery, b: Recovery): Recovery {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b.at) > Date.parse(a.at) ? b : a;
}

export function ContextFullBanner({ sessionId, session, onResuming }: ContextFullBannerProps) {
  // The recovery's state moves without a record refetch (src/core/sessions/context-full-recovery.ts announceState).
  const [live, setLive] = useState<Recovery>(undefined);
  useEffect(() => { setLive(undefined); }, [sessionId]);
  useEvent('session:context-recovery', useCallback((data: unknown) => {
    const d = data as { sessionId?: string; contextRecovery?: Recovery };
    if (d.sessionId === sessionId && d.contextRecovery) setLive(d.contextRecovery);
  }, [sessionId]));
  const { text, busy } = contextFullBannerText(newer(session.contextRecovery, live), session.last_status_change);
  return (
    <div className={`session-error-banner${busy ? ' session-error-banner--reconnecting' : ''}`} data-context-full>
      <span className="session-error-banner-icon">{busy ? '↻' : <WarningTriangleIcon size={14} />}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span className="session-error-banner-text">{text}</span>
      </div>
      {!busy && (
        <SessionRetryButton
          sessionId={sessionId}
          host={session.host}
          onResuming={onResuming}
          words={{
            label: 'Compact and resend',
            busy: 'Compacting…',
            title: 'Summarize this conversation so it fits again, then send the messages that got no answer once more.',
          }}
        />
      )}
    </div>
  );
}
