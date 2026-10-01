/**
 * The batch unsubscribe checklist as data (spec 10): which items can be ticked at all, what each
 * method is called, and every sentence around the list.
 *
 * Nothing is ticked when the dialog opens. The groups are the model's own names, so no group is
 * known to be "promotions", and a click must never silently leave a list somebody needs: the person
 * ticks each list. Pure, so those rules (never a mailto the account cannot send, never a list already
 * left or in flight) are pinned by a unit test rather than by a screenshot.
 */
import type {
  MailUnsubscribeBatchItemState,
  MailUnsubscribePlan,
  MailUnsubscribePlanItem,
} from '@/api/mail-groups';
import { formatCount } from './mail-format';

/** A plan item; a mailto the account cannot send carries its address (`mailto`), for the copy button. */
export type PlanItem = MailUnsubscribePlanItem;

export type PlanItemKind = 'checkable' | 'cannot-send' | 'done' | 'in-flight';

export function planItemKind(item: PlanItem): PlanItemKind {
  if (item.done) return 'done';
  if (item.attempt?.status === 'in-flight') return 'in-flight';
  if (item.method === 'mailto' && !item.canSend) return 'cannot-send';
  return 'checkable';
}

/** The words for a method, as the row prints them. */
export function methodText(item: PlanItem): string {
  if (item.method === 'one-click') return 'one-click';
  if (item.method === 'link') return 'web page · Walnut visits the page';
  return item.canSend ? 'email' : "email · can't send from this account";
}

/** The small print under a mailto that WILL send: it goes out in the person's name. */
export function mailtoFromText(address: string): string {
  return `sends an email from ${address}`;
}

export const PICK_SENTENCE = 'Tick the lists you want to leave. Nothing is sent until you press Unsubscribe.';

export function checkingSentence(unchecked: number): string {
  return `Checking ${formatCount(unchecked)} senders for unsubscribe options…`;
}

export function partialSentence(checked: number, of: number): string {
  return `Checked ${formatCount(checked)} of ${formatCount(of)} senders. Open the group again to check the rest.`;
}

export function withoutOptionSentence(count: number): string | null {
  if (count <= 0) return null;
  return `${formatCount(count)} ${count === 1 ? 'sender here has' : 'senders here have'} no unsubscribe option Walnut knows of.`;
}

export function headerUnknownSentence(count: number): string | null {
  if (count <= 0) return null;
  return `Walnut can't read list headers for ${formatCount(count)} mails in this account, so some lists may be missing.`;
}

export function dialogTitle(groupLabel: string): string {
  return `Unsubscribe from lists in ${groupLabel}`;
}

export function submitLabel(ticked: number): string {
  return ticked > 0 ? `Unsubscribe from ${formatCount(ticked)}` : 'Unsubscribe';
}

function shortDate(at: number): string {
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** `Already unsubscribed: Tide Tables (Sep 12), Harbour Notes (Sep 3)`, or null. */
export function alreadyLine(items: PlanItem[]): string | null {
  const done = items.filter((one) => one.done);
  if (done.length === 0) return null;
  return `Already unsubscribed: ${done.map((one) => `${one.label} (${shortDate(one.done!.at)})`).join(', ')}`;
}

/**
 * A `check=1` answer folded in: new items go BELOW the ones already listed (never above, so no row
 * moves under the pointer), and an item already listed keeps its place and takes the fresh data.
 */
export function appendChecked(current: PlanItem[], checked: PlanItem[]): PlanItem[] {
  const fresh = new Map(checked.map((one) => [one.listKey, one]));
  const kept = current.map((one) => fresh.get(one.listKey) ?? one);
  const have = new Set(current.map((one) => one.listKey));
  return [...kept, ...checked.filter((one) => !have.has(one.listKey))];
}

/** The rows that are listed at all (done ones go in the `Already unsubscribed` line). */
export function listedItems(items: PlanItem[]): PlanItem[] {
  return items.filter((one) => !one.done);
}

export type RunStatus = MailUnsubscribeBatchItemState['status'] | 'already';

/** The words on a row while a batch runs. `failed` prints the server's own sentence instead. */
export function runStatusText(status: RunStatus): string {
  switch (status) {
    case 'queued': return 'Waiting';
    case 'running': return 'Unsubscribing…';
    case 'done': return 'Done';
    case 'already': return 'Already done';
    case 'needs-human': return 'Finish on the page';
    case 'skipped': return 'Waiting';
    default: return '';
  }
}

/** `Done 5 · Needs you 1 · Failed 1`, only the parts that are not zero (`Done 0` when nothing ran). */
export function runSummary(statuses: RunStatus[]): string {
  const done = statuses.filter((one) => one === 'done' || one === 'already').length;
  const needs = statuses.filter((one) => one === 'needs-human').length;
  const failed = statuses.filter((one) => one === 'failed').length;
  const parts = [`Done ${formatCount(done)}`];
  if (needs > 0) parts.push(`Needs you ${formatCount(needs)}`);
  if (failed > 0) parts.push(`Failed ${formatCount(failed)}`);
  return parts.join(' · ');
}

/** The strip line while the dialog is closed and the batch still runs, and when it ends. */
export function batchStripText(statuses: RunStatus[], running: boolean): string {
  const left = statuses.filter((one) => one === 'queued' || one === 'running').length;
  if (running) return `Unsubscribing from ${formatCount(left)} more ${left === 1 ? 'list' : 'lists'}…`;
  const done = statuses.filter((one) => one === 'done' || one === 'already').length;
  const needs = statuses.filter((one) => one === 'needs-human').length;
  const head = `Unsubscribed from ${formatCount(done)} ${done === 1 ? 'list' : 'lists'}.`;
  return needs > 0 ? `${head} ${formatCount(needs)} ${needs === 1 ? 'needs' : 'need'} you.` : head;
}

/** A plan with nothing to tick: the dialog shows its sentences and a Close button. */
export function nothingToDo(plan: Pick<MailUnsubscribePlan, 'items'>): boolean {
  return plan.items.every((one) => planItemKind(one) !== 'checkable' && planItemKind(one) !== 'cannot-send');
}

/** The mailto address with its `mailto:` scheme and query removed, for the copy button. */
export function mailtoAddress(raw: string | undefined): string | null {
  if (!raw) return null;
  const bare = raw.replace(/^mailto:/i, '').split('?')[0]!.trim();
  try { return decodeURIComponent(bare) || null; } catch { return bare || null; }
}
