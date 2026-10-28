/**
 * The words beside "Core instructions" (OrgNodeEditor, AgentMemoryPanel): where the words in the
 * box come from. Walnut's default; who wrote the stored ones and when, the user or an agent
 * (2026-10-27, the user: "all human action can be done by agent also", so the page says which),
 * an agent's own words following Walnut's default in the box (orgInstructionsShown); or "yours"
 * once the box holds words not saved yet.
 */
import { orgInstructionsAuthor, type OrgInstructionsStamp } from '@open-walnut/org-tree';
import { timeAgo } from '@/utils/time';

export function instructionsSource(opts: {
  followsDefault: boolean;
  /** The box holds words other than the stored ones. */
  edited: boolean;
  stored?: Partial<OrgInstructionsStamp> | null;
  now?: number;
}): string {
  if (opts.followsDefault) return 'Walnut\'s default';
  const stored = opts.stored;
  if (opts.edited || !stored?.text?.trim()) return 'yours';
  const { byUser, usersWords, who } = orgInstructionsAuthor(stored);
  const when = stored.at ? timeAgo(stored.at, { long: true, now: opts.now }) : '';
  const by = byUser ? 'by you' : usersWords ? `by ${who} for you` : `Walnut's default and lines by ${who}`;
  return `${by}${when ? `, ${when}` : ''}`;
}
