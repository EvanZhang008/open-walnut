/**
 * A DRAFT row's right-click menu, as data.
 *
 * The Drafts view draws its own rows (`MailDraftsList`) rather than `MailRow`, so they looked exactly
 * like message rows, carried the same `mail-row` class, and answered the BROWSER's menu: in that one
 * folder the gesture the rest of the console had just taught did nothing. These rows are Walnut's own
 * drafts, so the message menu's items do not apply to them (there is no provider message to mark read,
 * no thread to reply to, no deep link, and the task route takes a message id), and the menu says only
 * what a draft can actually do.
 *
 * Two items, both routes that exist today: `openMailDraft` (the row's own click) and the draft DELETE
 * the composer's own Discard already uses. Discard is dropped for the draft the composer is HOLDING:
 * that pane has its own Discard with its own confirm, and deleting the row under an open composer is
 * a second path into the same state with none of its guards.
 */
import type { ContextMenuItem } from '@/utils/context-menu';
import { normalizeContextMenuItems } from '@/utils/context-menu';

export interface DraftRowMenuTarget {
  draftId: string;
  subject: string;
  /** Who it is addressed to, as the row prints it, or '' when nobody has been named yet. */
  recipients: string;
  /** This draft is the one the composer is holding. */
  open: boolean;
}

export interface DraftRowMenuActions {
  onEdit: (draftId: string) => void;
  onDiscard: (draftId: string) => void;
}

/** Said under `Discard draft`: it is a delete, and nothing else on this row is. */
export const DISCARD_DRAFT_TITLE = 'Deletes this draft. Nobody has received it';

/** The heading: what this draft is, which on an unfinished one is whatever it does have. */
export function draftRowHeading(target: DraftRowMenuTarget): string {
  const subject = target.subject.replace(/\s+/g, ' ').trim();
  if (subject) return subject;
  return target.recipients ? `Draft to ${target.recipients}` : 'Unsent draft';
}

export function draftRowMenuItems(
  target: DraftRowMenuTarget,
  actions: DraftRowMenuActions,
): ContextMenuItem[] {
  const heading = draftRowHeading(target);
  return normalizeContextMenuItems([
    { key: 'who', info: true, label: heading, title: heading },
    {
      key: 'edit',
      label: 'Continue editing',
      onSelect: () => { actions.onEdit(target.draftId); },
    },
    { divider: true, when: !target.open },
    {
      key: 'discard',
      when: !target.open,
      label: 'Discard draft',
      title: DISCARD_DRAFT_TITLE,
      danger: true,
      onSelect: () => { actions.onDiscard(target.draftId); },
    },
  ]);
}
