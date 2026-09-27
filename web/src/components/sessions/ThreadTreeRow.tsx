/**
 * One tree drawer row (spec 6.4, 6.5): a `treeitem` with its indent guides
 * (one 1px guide per level), a disclosure only when it has visible children,
 * the status dot (a pin icon for pins), a two-line label (single line for
 * root, pins and `<n> done`), and on the right the `<n> open below` pill, which
 * the hover / cursor actions replace.
 *
 * Action buttons never take focus or trigger the row (mousedown is prevented,
 * click stops); the container ignores a second click within 400ms.
 */
import { memo, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { ThreadStatusDot } from '@/components/sessions/ThreadStatusDot';
import {
  ThreadCheckIcon, ThreadChevronIcon, ThreadNotYetIcon, ThreadPinIcon, ThreadReopenIcon, ThreadTrashIcon,
} from '@/components/sessions/ThreadIcons';
import { ThreadInlineRename } from '@/components/sessions/ThreadInlineRename';
import { openBelowTitle, segmentsOf, type MatchRange, type TreeRow } from '@/utils/thread-tree-rows';
import { TITLE_MAX } from '@/utils/thread-meta';

export type TreeRowAction = 'done' | 'reopen' | 'remove' | 'restore' | 'not-yet' | 'undo-removed';

export interface ThreadTreeRowProps {
  row: TreeRow;
  cursor: boolean;
  pulse: boolean;
  renaming: boolean;
  unreadTitle?: string;
  onActivate: (row: TreeRow) => void;
  onToggle: (row: TreeRow) => void;
  onAction: (row: TreeRow, action: TreeRowAction, el: HTMLElement) => void;
  onRenameSave: (row: TreeRow, text: string) => void;
  onRenameCancel: () => void;
  /** DOM focus reached the row (Tab, a screen reader, a click): it becomes the cursor. */
  onFocusRow: (row: TreeRow) => void;
}

const SINGLE_LINE = new Set(['root', 'pin', 'done-group', 'hidden-header', 'pending', 'draft']);

function Hl({ text, ranges }: { text: string; ranges?: MatchRange[] }) {
  return <>{segmentsOf(text, ranges).map((s, i) => (s.hit ? <mark key={i} className="thread-tree-hit">{s.text}</mark> : <span key={i}>{s.text}</span>))}</>;
}

function ActionButton({ label, onPress, children, danger }: { label: string; onPress: (el: HTMLElement) => void; children: ReactNode; danger?: boolean }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      className={danger ? 'thread-tree-action thread-tree-action--danger' : 'thread-tree-action'}
      title={label}
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e: MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); onPress(e.currentTarget); }}
    >
      {children}
    </button>
  );
}

function TextButton({ label, onPress }: { label: string; onPress: (el: HTMLElement) => void }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      className="thread-tree-text-btn"
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onPress(e.currentTarget); }}
    >
      {label}
    </button>
  );
}

function trailing(p: ThreadTreeRowProps): ReactNode {
  const { row, onAction } = p;
  const act = (a: TreeRowAction) => (el: HTMLElement) => onAction(row, a, el);
  if (row.kind === 'hidden') return <TextButton label="Restore" onPress={act('restore')} />;
  if (row.kind !== 'thread' && row.kind !== 'pin') return null;
  const pill = row.openBelow > 0 ? (
    <span className="thread-tree-pill" data-folded={row.hasChildren && !row.expanded ? 'true' : undefined} title={openBelowTitle(row.openBelow)}>
      {row.openBelow}
    </span>
  ) : null;
  const resolved = row.status === 'resolved';
  // A suggested row's `Mark done` / `Not yet` live HERE, as whole icon buttons
  // (N11): a 300px drawer has no room for two text buttons beside `Looks
  // answered` on a nested row, and a clipped `Mark d…` is not a control.
  const suggested = row.kind === 'thread' && row.status === 'suggested';
  return (
    <>
      {pill}
      <span className="thread-tree-actions">
        {row.kind === 'thread' && !resolved && (
          <ActionButton label="Mark done" onPress={act('done')}><ThreadCheckIcon size={13} /></ActionButton>
        )}
        {suggested && (
          <ActionButton label="Not yet" onPress={act('not-yet')}><ThreadNotYetIcon size={12} /></ActionButton>
        )}
        {row.kind === 'thread' && resolved && (
          <ActionButton label="Reopen" onPress={act('reopen')}><ThreadReopenIcon size={13} /></ActionButton>
        )}
        <ActionButton
          label={row.kind === 'pin' ? 'Remove pin (Undo available)' : 'Remove (Undo available)'}
          onPress={act('remove')}
          danger
        >
          <ThreadTrashIcon size={13} />
        </ActionButton>
      </span>
    </>
  );
}

function secondLine(p: ThreadTreeRowProps): ReactNode {
  const { row } = p;
  if (row.status === 'suggested' && row.kind === 'thread' && !row.hitSnippet) {
    // The verdict only; its two actions are the row's hover / cursor buttons.
    return (
      <span className="thread-tree-secondary thread-tree-secondary--suggested">
        <span className="thread-tree-verdict">Looks answered</span>
      </span>
    );
  }
  if (!row.secondary) return <span className="thread-tree-secondary" />;
  // ONE text box around the pieces, so the line clips once at its end and never
  // cuts each piece on its own (N23: `Poin…  lantern  pass reads the can…`).
  return (
    <span className="thread-tree-secondary">
      <span className="thread-tree-secondary-text"><Hl text={row.secondary} ranges={row.secondaryMatches} /></span>
    </span>
  );
}

function ThreadTreeRowImpl(p: ThreadTreeRowProps) {
  const { row, cursor, pulse, renaming, unreadTitle } = p;
  if (row.kind === 'hidden-header') {
    return <div className="thread-tree-group-label" role="presentation">{row.title}</div>;
  }
  if (row.kind === 'removed') {
    return (
      <div className="thread-tree-row thread-tree-row--removed" role="treeitem" aria-level={row.depth + 1}
        data-row-id={row.id} data-kind="removed" data-of={row.removedOf} style={{ '--depth': row.depth } as CSSProperties}>
        <span className="thread-tree-removed-text">Removed</span>
        <span aria-hidden="true" className="thread-tree-removed-sep">·</span>
        <TextButton label="Undo" onPress={(el) => p.onAction(row, 'undo-removed', el)} />
      </div>
    );
  }
  const single = SINGLE_LINE.has(row.kind);
  const guides = Array.from({ length: row.depth }, (_, l) => <span key={l} className="thread-tree-guide" style={{ '--level': l } as CSSProperties} />);
  const style = { '--depth': row.depth, '--thread-hue': String(row.hue) } as CSSProperties;
  return (
    <div
      id={`thread-tree-row-${encodeURIComponent(row.id)}`}
      className="thread-tree-row"
      role="treeitem"
      tabIndex={cursor ? 0 : -1}
      aria-level={row.depth + 1}
      aria-expanded={row.hasChildren ? row.expanded : undefined}
      aria-selected={row.current}
      aria-label={row.kind === 'pin' ? `Pinned passage: ${row.tooltip ?? row.title}` : undefined}
      title={row.tooltip}
      data-row-id={row.id}
      data-kind={row.kind}
      data-status={row.status}
      data-lines={single ? '1' : '2'}
      data-cursor={cursor ? 'true' : undefined}
      data-ancestor-only={row.ancestorOnly ? 'true' : undefined}
      data-settled={row.settled ? 'true' : undefined}
      data-pulse={pulse ? 'true' : undefined}
      style={style}
      onClick={() => p.onActivate(row)}
      onFocus={(e) => { if (e.target === e.currentTarget) p.onFocusRow(row); }}
    >
      {guides}
      <span
        className="thread-tree-disclosure"
        data-open={row.hasChildren && row.expanded ? 'true' : undefined}
        data-disabled={row.disclosureDisabled ? 'true' : undefined}
        aria-hidden="true"
        onMouseDown={(e) => { if (row.hasChildren) e.preventDefault(); }}
        onClick={(e) => { if (!row.hasChildren) return; e.stopPropagation(); if (!row.disclosureDisabled) p.onToggle(row); }}
      >
        {row.hasChildren && <ThreadChevronIcon size={10} />}
      </span>
      {row.kind === 'pin' ? <ThreadPinIcon size={12} className="thread-tree-pin-icon" />
        : row.kind === 'root' || row.kind === 'done-group' ? null
          : <ThreadStatusDot status={row.status ?? 'older'} hue={row.hue} depth={row.depth} />}
      {unreadTitle && <ThreadStatusDot status="open" hue={row.hue} unread title={unreadTitle} className="thread-tree-unread" />}
      <span className="thread-tree-text">
        {renaming ? (
          <ThreadInlineRename initial={row.title} max={TITLE_MAX} ariaLabel="Rename question"
            onSave={(t) => p.onRenameSave(row, t)} onCancel={p.onRenameCancel} />
        ) : (
          <span className="thread-tree-title-line">
            <span className="thread-tree-title" title={row.titleShown ? row.title : undefined}><Hl text={row.titleShown ?? row.title} ranges={row.titleMatches} /></span>
            {row.naming && <span className="thread-naming">Naming…</span>}
          </span>
        )}
        {!single && secondLine(p)}
      </span>
      <span className="thread-tree-trailing">{trailing(p)}</span>
    </div>
  );
}

const sameRanges = (a?: readonly MatchRange[], b?: readonly MatchRange[]) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((r, i) => r[0] === b[i][0] && r[1] === b[i][1]));

/** Flatten builds fresh row objects on every keystroke: compare their content. */
function sameRow(a: TreeRow, b: TreeRow): boolean {
  for (const k of Object.keys(a) as Array<keyof TreeRow>) {
    if (k === 'titleMatches' || k === 'secondaryMatches') continue;
    if (a[k] !== b[k]) return false;
  }
  return Object.keys(a).length === Object.keys(b).length
    && sameRanges(a.titleMatches, b.titleMatches) && sameRanges(a.secondaryMatches, b.secondaryMatches);
}

export const ThreadTreeRow = memo(ThreadTreeRowImpl, (prev, next) => {
  for (const k of Object.keys(next) as Array<keyof ThreadTreeRowProps>) {
    if (k === 'row') continue;
    if (prev[k] !== next[k]) return false;
  }
  return sameRow(prev.row, next.row);
});
