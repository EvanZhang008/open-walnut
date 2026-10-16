/**
 * The words SessionChatHistory puts where history could not be read. Pure, so
 * the two notices are tested without mounting the timeline.
 */
import { isLeaderWords, leaderReasonText } from '@/api/leader-presence';

/** A failed load: a host replica's "Needs your Mac. ..." is already the words (api/leader-presence.ts). */
export function historyErrorText(error: unknown): string {
  const text = String(error);
  return isLeaderWords(text) ? text : `Failed to load history: ${text}`;
}

/** The older part cannot be paged: a host replica's reason (its pages are built on the Mac), else the size note. */
export function olderUnavailableText(why: string | null | undefined): string {
  return leaderReasonText(why) ?? 'Earlier messages of this session are too large to load here.';
}
