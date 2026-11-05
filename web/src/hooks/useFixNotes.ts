/**
 * The fix notes a host's status carries (utils/host-readiness.ts `hostReadinessNotes`), kept
 * current on this browser's clock: a finished fix's note goes away when its FIX_NOTE_MS run
 * out, even when no new host:status push arrives. A note's age is the server's `ageMs` plus
 * how long this page has held the snapshot, so no clock comparison is needed.
 *
 * Shared by the host's row (useLinkedHostRow, which says what a finished fix did) and its
 * Details (RemoteHostReadiness, which shows a fix still running).
 */
import { useEffect, useMemo, useState } from 'react';
import type { HostStatus } from '@/api/hosts';
import { hostReadinessNotes, type HostReadinessNote } from '@/utils/host-readiness';

export function useFixNotes(status: HostStatus | null | undefined): HostReadinessNote[] {
  const receivedAt = useMemo(() => Date.now(), [status]);
  const [, setTick] = useState(0);
  const notes = hostReadinessNotes(status, Date.now() - receivedAt);
  const nextExpiry = notes.reduce<number | null>(
    (min, n) => (n.expiresInMs === undefined ? min : min === null ? n.expiresInMs : Math.min(min, n.expiresInMs)), null);
  useEffect(() => {
    if (nextExpiry === null) return;
    const t = setTimeout(() => setTick((n) => n + 1), nextExpiry + 50);
    return () => clearTimeout(t);
  }, [nextExpiry, receivedAt]);
  return notes;
}
