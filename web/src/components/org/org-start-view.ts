/**
 * What an Org node with no session shows (OrgNodeStart.tsx), from its task and the server's last
 * answer to a start (src/core/org/org-autostart.ts). Pure, so the states are tested apart.
 */
import type { Task } from '@open-walnut/core';
import type { ChannelRow } from './org-channels-model';

/** The server's answers that mean a start is on its way or done: the chat follows. */
const ON_ITS_WAY = new Set(['has_session', 'starting']);

export type OrgStartView =
  | { kind: 'off' }
  | { kind: 'failed'; error: string }
  | { kind: 'idle' }
  | { kind: 'no-vp' }
  | { kind: 'starting' }
  /** The page's tasks are not read yet: whether it has a session is not known. */
  | { kind: 'loading' }
  /** A replica (the cloud companion): Main and the VPs start on the primary, the Mac. */
  | { kind: 'elsewhere' };

/** What the view shows, from the node's task and the server's last answer. Pure. */
export function orgStartView(input: {
  enabled: boolean; row: Pick<ChannelRow, 'kind' | 'contactId'>; contact: Pick<Task, 'org_start'> | undefined;
  answer: { skipped?: string; error?: string; status?: number } | null;
  loading?: boolean; starting?: boolean;
}): OrgStartView {
  if (!input.enabled) return { kind: 'off' };
  if (input.starting) return { kind: 'starting' };
  // Before the tasks are read a node that has a session looks like one with none.
  if (input.loading && !input.contact) return { kind: 'loading' };
  if (input.answer?.status === 501) return { kind: 'elsewhere' };
  const failed = input.contact?.org_start?.state === 'failed' ? input.contact.org_start.error || 'it did not start' : input.answer?.error;
  if (failed) return { kind: 'failed', error: failed };
  if (input.contact?.org_start?.state === 'starting') return { kind: 'starting' };
  // Any other answer (a test window, a start that failed before, a node now closed) waits for a click.
  if (input.answer?.skipped && !ON_ITS_WAY.has(input.answer.skipped)) return { kind: 'idle' };
  if (!input.row.contactId) return input.row.kind === 'main' ? { kind: 'idle' } : { kind: 'no-vp' };
  return { kind: 'starting' };
}
