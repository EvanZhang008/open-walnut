/**
 * "Syncs when your Mac is back": the mark on a task row (or a Board) a host
 * replica holds a write for while the Mac is away (docs/plan/walnut-replica-servers-impl.md,
 * WP10; src/replica/away-reads.ts). The replica's answers carry `replica_sync`
 * (`pending`: in this host's journal; `awaiting`: the Mac took it, its copy has
 * not come back yet). The Mac's own answers never carry it, so on the Mac this
 * renders nothing and its rows are unchanged.
 */
import '@/styles/away-sync-mark.css';

export const AWAY_SYNC_TEXT = 'Syncs when your Mac is back';

/** The mark a row or a Board answer carries, or null. */
export function awaySyncOf(item: unknown): 'pending' | 'awaiting' | null {
  const v = item && typeof item === 'object' ? (item as { replica_sync?: unknown }).replica_sync : undefined;
  return v === 'pending' || v === 'awaiting' ? v : null;
}

export function AwaySyncMark({ item, className }: { item: unknown; className?: string }) {
  const mark = awaySyncOf(item);
  if (!mark) return null;
  return (
    <span
      className={`away-sync-mark${className ? ` ${className}` : ''}`}
      data-testid="away-sync-mark"
      data-sync={mark}
      title={mark === 'pending'
        ? 'Saved on this host. Your Mac takes it when it is back.'
        : 'Your Mac took it; this view updates with its next copy.'}
    >
      {AWAY_SYNC_TEXT}
    </span>
  );
}
