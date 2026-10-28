/**
 * The words beside a node's instructions (OrgNodeEditor): who wrote the stored ones and when, the
 * user or an agent (2026-10-27, the user: "all human action can be done by agent also", so the
 * page says which), or "yours" once the box holds words not saved yet. Empty: nothing to say.
 */
import { orgInstructionsAuthor } from '@open-walnut/org-tree';
import { timeAgo } from '@/utils/time';

export function instructionsSource(opts: {
  /** The box holds words other than the stored ones. */
  edited: boolean;
  stored?: { text?: string; at?: string; by?: string; by_name?: string } | null;
  typed: string;
  now?: number;
}): string {
  if (opts.edited) return opts.typed.trim() ? 'yours' : '';
  const stored = opts.stored;
  if (!stored?.text?.trim()) return '';
  const { who } = orgInstructionsAuthor(stored);
  const when = stored.at ? timeAgo(stored.at, { long: true, now: opts.now }) : '';
  return `by ${who}${when ? `, ${when}` : ''}`;
}
