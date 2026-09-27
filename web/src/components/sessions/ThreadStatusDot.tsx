/**
 * The 8px status dot of a question (spec 6.4). Pure CSS shapes, never a glyph:
 *   open = hue solid · answering = hue ring breathing (static under reduced
 *   motion) · resolved = faint success solid · suggested = amber solid ·
 *   queued = hue dashed ring · failed = hue ring + small error dot ·
 *   older = neutral hollow · pending / draft = faint hue ring / neutral dashed.
 * `unread` renders the separate 6px accent dot instead.
 */
import type { CSSProperties } from 'react';
import type { ThreadViewStatus } from '@/utils/thread-meta';
import '@/styles/thread-stack.css';

export interface ThreadStatusDotProps {
  status: ThreadViewStatus;
  /** hsl hue of the question's branch (ThreadNode.hue). */
  hue: number;
  /** 1..n; picks the per-depth lightness. */
  depth?: number;
  unread?: boolean;
  /** Tooltip (e.g. `Answered 12 min ago` on the unread dot). */
  title?: string;
  className?: string;
}

export function ThreadStatusDot({ status, hue, depth, unread, title, className }: ThreadStatusDotProps) {
  const style = { '--thread-hue': String(hue) } as CSSProperties;
  const cls = ['thread-status-dot', unread ? 'thread-status-dot--unread' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <span
      className={cls}
      data-status={unread ? 'unread' : status}
      data-depth={depth !== undefined ? String(Math.min(Math.max(depth, 1), 4)) : undefined}
      style={style}
      title={title}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
    >
      {!unread && status === 'failed' && <span className="thread-status-dot-error" />}
    </span>
  );
}
