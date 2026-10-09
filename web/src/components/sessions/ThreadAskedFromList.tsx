/**
 * "Asked from this answer" (spec 5.10): after an answer on the page, one row per
 * visible question asked about it, in transcript order. A row says where that
 * question stands (Waiting, Answering, No answer, Looks answered, open below,
 * Done + takeaway) and opens its page on click, Enter or Space. A pending page
 * left with text shows as `New question (draft)`.
 */
import { memo, type KeyboardEvent } from 'react';
import { ThreadStatusDot } from '@/components/sessions/ThreadStatusDot';
import { ThreadChevronIcon } from '@/components/sessions/ThreadIcons';
import { DRAFT_ROW_LABEL, type AskedFromRow } from '@/utils/thread-stack-state';

export type { AskedFromRow };
export const ASKED_FROM_HEADING = 'Asked from this answer';

/** `12 min ago` style, for the unread row's tooltip. */
export function relativeAgo(thenMs: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

interface Props {
  rows: AskedFromRow[];
  onOpen: (key: string) => void;
  onRetry: (key: string) => void;
  onMarkDone: (key: string) => void;
  onNotYet: (key: string) => void;
}

function StatusLabel({ row, onRetry, onMarkDone, onNotYet }: { row: AskedFromRow } & Omit<Props, 'rows' | 'onOpen'>) {
  const stop = (fn: () => void) => (e: { stopPropagation: () => void }) => { e.stopPropagation(); fn(); };
  switch (row.status) {
    case 'queued': return <span className="thread-asked-state">Waiting…</span>;
    case 'answering': return <span className="thread-asked-state">Answering…</span>;
    case 'failed':
      return (
        <span className="thread-asked-state thread-asked-state--failed">
          No answer · <button type="button" className="thread-asked-inline-btn" onClick={stop(() => onRetry(row.key))}>Retry</button>
        </span>
      );
    case 'suggested':
      return (
        <span className="thread-asked-state thread-asked-state--suggested">
          Looks answered
          <button type="button" className="thread-asked-inline-btn" onClick={stop(() => onMarkDone(row.key))}>Archive</button>
          <button type="button" className="thread-asked-inline-btn" onClick={stop(() => onNotYet(row.key))}>Not yet</button>
        </span>
      );
    case 'resolved': return <span className="thread-asked-done">Archived</span>;
    default:
      return row.openBelow > 0 ? <span className="thread-asked-state">{row.openBelow} open below</span> : null;
  }
}

export const ThreadAskedFromList = memo(function ThreadAskedFromList({ rows, onOpen, onRetry, onMarkDone, onNotYet }: Props) {
  if (rows.length === 0) return null;
  const onKey = (key: string) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(key); }
  };
  return (
    <section className="thread-asked-from" aria-label={ASKED_FROM_HEADING}>
      <div className="thread-asked-heading">{ASKED_FROM_HEADING}</div>
      {rows.map((row) => {
        const tip = row.unread && row.answeredAt ? `Answered ${relativeAgo(row.answeredAt)}` : undefined;
        return (
          <div
            key={row.key}
            role="button"
            tabIndex={0}
            className={`thread-asked-row${row.draft ? ' is-draft' : ''}${row.status === 'resolved' ? ' is-resolved' : ''}`}
            data-thread-key={row.key}
            data-status={row.status}
            data-thread-level={Math.min(Math.max(row.level, 1), 4)}
            style={{ ['--thread-hue' as string]: row.hue }}
            title={tip}
            onClick={() => onOpen(row.key)}
            onKeyDown={onKey(row.key)}
          >
            {/* The dot slot: the unread dot, or a failed question's ring + error
                dot (spec 5.10, C68); every other row keeps the slot empty. */}
            {row.unread
              ? <ThreadStatusDot status={row.status} hue={row.hue} depth={row.level} unread {...(tip ? { title: tip } : {})} />
              : row.status === 'failed'
                ? <ThreadStatusDot status="failed" hue={row.hue} depth={row.level} />
                : <span className="thread-asked-unread-slot" aria-hidden="true" />}
            <span className="thread-asked-bar" aria-hidden="true" />
            <span className="thread-asked-text">
              <span className="thread-asked-title-line">
                <span className="thread-asked-title">{row.draft ? DRAFT_ROW_LABEL : row.title}</span>
                {row.naming && !row.draft && <span className="thread-naming">Naming…</span>}
              </span>
              {row.status === 'resolved' && row.takeaway && (
                <span className="thread-asked-takeaway">{row.takeaway}</span>
              )}
            </span>
            {!row.draft && <StatusLabel row={row} onRetry={onRetry} onMarkDone={onMarkDone} onNotYet={onNotYet} />}
            <ThreadChevronIcon size={12} className="thread-asked-chevron" />
          </div>
        );
      })}
    </section>
  );
});
