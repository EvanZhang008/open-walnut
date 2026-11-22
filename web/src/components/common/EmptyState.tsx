/**
 * The one look of "nothing to show here": empty, loading and unavailable.
 * standard.md, "Empty, loading and unavailable states"; guarded by
 * tests/web/empty-state-ratchet.test.ts (a hand-made empty class or a bare "No ..." line fails it).
 *
 * 2026-11-21 UI audit: 124 hand-made empty classes in 11/12/12.5/13/14 px, centred or not, and a
 * session with no history showed one grey "No conversation history found" in a huge white pane
 * (new session, lost record or still loading? it did not say).
 *
 * Every state says what this place is and why it is empty, in one title line, an optional hint,
 * and one next step when there is one (clear the filter, retry, start a message).
 *
 * Sizes:
 *  - pane:    a whole pane or page (a reader with nothing open, a chat with no messages): centred,
 *             icon 32 px, 15 px title.
 *  - section: a list, panel or card body: centred, icon 20 px, 13 px title.
 *  - row:     one line inside a list, a menu or a picker: left, no icon, 12 px.
 */
import type { ReactNode, MouseEvent } from 'react';
import { ICON_EMPTY, ICON_WARNING } from './Icons';
import { readsPlain } from './state-words';
import { useDetailsDisclosure } from '../sessions/row-disclosure';

export { stateWords, readsPlain } from './state-words';
import './empty-state.css';

export type EmptyStateKind = 'empty' | 'loading' | 'unavailable';
export type EmptyStateSize = 'pane' | 'section' | 'row';

export interface EmptyStateAction {
  label: string;
  onClick(e: MouseEvent<HTMLButtonElement>): void;
  /** The page's one main action (a filled button); default is the quiet grey one. */
  primary?: boolean;
  /** Shown greyed while the step is already running ("Trying…"). */
  disabled?: boolean;
  /** Its tooltip, when the label needs one more word. */
  tooltip?: string;
  testId?: string;
}

export interface EmptyStateProps {
  /** What this place is and why it is empty, in plain words ("No messages yet"). */
  title: ReactNode;
  /** One more line: what to do, or what is still usable. */
  hint?: ReactNode;
  /**
   * The raw reason for whoever needs it (an error message, a file name). It stays behind a
   * "Details" toggle, so the hint says in plain words what happened and what still works.
   */
  detail?: string;
  /** The one next step, when there is one. */
  action?: EmptyStateAction;
  /** A second, quieter step beside it (rare: "Show 3 completed" and "Clear search"). */
  secondaryAction?: EmptyStateAction;
  kind?: EmptyStateKind;
  size?: EmptyStateSize;
  /** Replaces the kind's default icon (pane and section sizes); `null` shows none. */
  icon?: ReactNode | null;
  /** Anything the state must keep below its words (a list of choices, a link). Rare. */
  children?: ReactNode;
  /** Layout only (margins, grid placement). Never a font, colour or padding of its own. */
  className?: string;
  testId?: string;
  /** Extra data-* attributes tests or callers read. */
  data?: Record<string, string | undefined>;
  /**
   * The root's role. Default: `alert` for unavailable (a failure is announced), `status` otherwise.
   * Inside a listbox, menu or tree pass `presentation`: those own only their options or items.
   */
  role?: 'status' | 'alert' | 'presentation';
}

export function EmptyState({
  title, hint, detail, action, secondaryAction, kind = 'empty', size = 'section', icon, children, className, testId, data, role,
}: EmptyStateProps) {
  // A row keeps the icons that tell a state apart (the spinner, the failure's warning), not the tray.
  const shownIcon = size === 'row' && kind === 'empty'
    ? null
    : icon !== undefined
      ? icon
      : kind === 'loading'
        ? <span className="empty-state-spinner" aria-hidden="true" />
        : kind === 'unavailable' ? ICON_WARNING : ICON_EMPTY;
  // A reason that already reads as a plain sentence is the hint; a raw one folds behind Details.
  const detailIsHint = !hint && !!detail && readsPlain(detail);
  const shownHint = detailIsHint ? detail : hint;
  const folded = detailIsHint ? undefined : detail;
  const dataAttrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(data ?? {})) if (v !== undefined) dataAttrs[`data-${k}`] = v;
  return (
    <div
      className={className ? `empty-state ${className}` : 'empty-state'}
      data-size={size}
      data-kind={kind}
      data-testid={testId}
      role={role ?? (kind === 'unavailable' ? 'alert' : 'status')}
      aria-busy={kind === 'loading' || undefined}
      {...dataAttrs}
    >
      {shownIcon && <span className="empty-state-icon" aria-hidden="true">{shownIcon}</span>}
      <span className="empty-state-words">
        <span className="empty-state-title">{title}</span>
        {shownHint && <span className="empty-state-hint">{shownHint}</span>}
      </span>
      {(action || secondaryAction) && (
        <span className="empty-state-actions">
          {action && <StateButton action={action} size={size} />}
          {secondaryAction && <StateButton action={{ ...secondaryAction, primary: false }} size={size} />}
        </span>
      )}
      {folded && <StateDetail text={folded} id={testId} />}
      {children && <div className="empty-state-extra">{children}</div>}
    </div>
  );
}

/** A whole pane's next step is a full-size button under its 15 px title; a list's or a row's is small. */
function StateButton({ action, size }: { action: EmptyStateAction; size: EmptyStateSize }) {
  return (
    <button
      type="button"
      className={`btn${size === 'pane' ? '' : ' btn-sm'}${action.primary ? ' btn-primary' : ''}`}
      data-testid={action.testId}
      disabled={action.disabled}
      title={action.tooltip}
      onClick={action.onClick}
    >
      {action.label}
    </button>
  );
}

/** A place whose content is on its way. Say what is loading ("Loading tasks…"). */
export function LoadingState(props: Omit<EmptyStateProps, 'kind' | 'title'> & { title?: ReactNode }) {
  return <EmptyState {...props} kind="loading" title={props.title ?? 'Loading…'} />;
}

/** A place whose content could not be read. Say what still works, and offer Retry when it may help. */
export function UnavailableState({ onRetry, retryLabel = 'Retry', ...props }: Omit<EmptyStateProps, 'kind'> & {
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <EmptyState
      {...props}
      kind="unavailable"
      action={props.action ?? (onRetry ? { label: retryLabel, onClick: () => onRetry() } : undefined)}
    />
  );
}

/** The raw reason, folded; kept open or shut like every other disclosure in the session. */
function StateDetail({ text, id }: { text: string; id?: string }) {
  const disclosure = useDetailsDisclosure(id ? `state-detail:${id}` : undefined);
  return (
    <details className="empty-state-detail" {...disclosure}>
      <summary>Details</summary>
      <span className="empty-state-detail-text">{text}</span>
    </details>
  );
}
