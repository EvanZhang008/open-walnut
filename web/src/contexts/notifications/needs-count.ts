/**
 * The bell and the Inbox rail with the experiment inbox_needs_threads on: each thing that needs him
 * counted once (core/human-inbox/needs-model.ts inboxNeedsCount). A decision letter waiting on its
 * thread is one thing, counted as the thread, never again as an unread letter. Off, the counts stay
 * attentionBadgeCount and sectionCounts. Pure.
 */
import { inboxNeedsCount, type UrgencyThread } from '@open-walnut/inbox-needs';
import type { Notification } from './types';
import { letterIdOf, sectionCounts, sectionOf } from './notification-model';

/**
 * The letters the feed carries an envelope for, once each: unread while any of its envelopes is.
 * An envelope that names no letter stands for itself.
 */
export function feedLetters(feed: readonly Notification[]): Array<{ id: string; read: boolean }> {
  const out = new Map<string, { id: string; read: boolean }>();
  for (const n of feed) {
    if (sectionOf(n) !== 'inbox') continue;
    const id = letterIdOf(n) ?? `notification:${n.id}`;
    const was = out.get(id);
    out.set(id, { id, read: (was?.read ?? true) && !!n.read });
  }
  return [...out.values()];
}

/** The bell: the live asks, plus every thread that needs him and every unread letter none of them holds. */
export function attentionWithNeeds(feed: Notification[], needs: readonly Pick<UrgencyThread, 'letter'>[]): number {
  return sectionCounts(feed).action + inboxNeedsCount(needs, feedLetters(feed)).total;
}

/**
 * The Inbox rail: every thread that needs him plus the unread letters none of them holds, from the
 * letter store's own list when it has one (authoritative, as sectionCounts reads it), else the feed.
 */
export function inboxRailCount(
  feed: readonly Notification[],
  letters: readonly { id: string; read: boolean; archived?: boolean }[],
  needs: readonly Pick<UrgencyThread, 'letter'>[],
): number {
  return inboxNeedsCount(needs, letters.length ? letters : feedLetters(feed)).total;
}
