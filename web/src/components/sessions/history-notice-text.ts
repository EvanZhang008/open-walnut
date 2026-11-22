/**
 * The words SessionChatHistory puts where history could not be read. Pure, so
 * the two notices are tested without mounting the timeline.
 */
import { isLeaderWords, leaderReasonText } from '@/api/leader-presence';

/**
 * The words under "Couldn't load this conversation": a host replica's "Needs your Mac. ..." is
 * already plain words (api/leader-presence.ts); anything else is a raw error, folded as the detail
 * under a plain hint.
 */
export function historyErrorWords(error: unknown): { hint: string; detail?: string } {
  const text = String(error);
  if (isLeaderWords(text)) return { hint: text };
  return { hint: 'Its machine did not answer. Retry in a moment.', detail: text.replace(/^Error:\s*/, '') };
}

/** The older part cannot be paged: a host replica's reason (its pages are built on the Mac), else the size note. */
export function olderUnavailableText(why: string | null | undefined): string {
  return leaderReasonText(why) ?? 'Earlier messages of this session are too large to load here.';
}
