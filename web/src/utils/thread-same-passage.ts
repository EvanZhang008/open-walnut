/**
 * Which pages on the stack show "You already asked about this passage." (spec
 * 5.4). The note belongs to the page an Ask on an already asked passage opened,
 * and it stays on that page while the page is on the stack: a pop back to it
 * must find the page exactly as it was left, or the landing cannot put the
 * sentence back at its y (C4: the note is 24px tall, and on a short page the
 * scroll box has no room to absorb it). A page leaves the set when it leaves
 * the path, or when it is entered again any other way.
 */
import type { NavPlan } from './thread-stack-state';

export function nextSamePassageKeys(
  prev: readonly string[],
  toPath: readonly string[],
  plan: Pick<NavPlan, 'pushed' | 'to'>,
  via: string,
): string[] {
  const kept = prev.filter((k) => toPath.includes(k) && !plan.pushed.includes(k));
  if (via === 'same-passage' && !kept.includes(plan.to)) kept.push(plan.to);
  return kept;
}
