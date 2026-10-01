/**
 * The rule a group's `Keep out of Inbox…` writes, and the save itself.
 *
 * - A group the model named (`u:<slug>`): `when: { group: <name> }`, so every mail the model sorts
 *   into it from now on is moved, whoever sent it. `then` is the same name, so a move that fails
 *   leaves the mail in this group.
 * - A sender's own group (`s:<key>`): `when: { from: <address> }` (the display name when the sender
 *   has no address), and `then` the sender's label, which becomes a named group.
 * - `s:unknown` (no sender at all) has nothing to match on: no rule, and the menu leaves the item out.
 *
 * The move itself is the server's (mail-filter-moves.ts). "Also move the N unread now" asks it to
 * move the unread the person is looking at, inside the group's watermark, under the rule just saved.
 */
import { archiveMailGroup, getMailRules, putMailRules, type MailRuleWhen } from '@/api/mail-groups';
import { log } from '@/utils/log';
import type { MailGroupCardRequest } from './mail-groups-bus';
import { filterSavedText } from './mail-groups-copy';
import { docOf, newRuleId, saveRefusalOf, todayIso, withLearnedRule } from './mail-correct-model';
import { pushLearnedUndo } from './MailCorrectPopover';

export interface FilterRule {
  when: MailRuleWhen;
  then: string;
  /** A sender's group becomes a named group: listed in the file's `groups`. */
  newGroup?: string;
}

/** The rule for this group, or null when there is nothing to match on. Pure. */
export function filterRuleFor(groupId: string, label: string): FilterRule | null {
  const name = label.trim();
  if (!name) return null;
  if (groupId.startsWith('u:')) return { when: { group: name }, then: name };
  if (!groupId.startsWith('s:')) return null;
  const key = groupId.slice(2);
  if (!key || key === 'unknown') return null;
  return { when: { from: key.startsWith('name:') ? name : key }, then: name, newGroup: name };
}

function messageOf(error: unknown): string {
  const body = (error as { body?: { message?: unknown } })?.body;
  if (body && typeof body.message === 'string') return body.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Save the rule (first in the file; re-read and retried once if the file moved), then, when asked,
 * queue the group's unread for the archive. The status strip says what happened, with Undo for the
 * rule (a mail already moved stays in Archive).
 */
export async function saveGroupFilter(request: MailGroupCardRequest, moveNow: boolean): Promise<void> {
  const rule = filterRuleFor(request.groupId, request.label);
  if (!rule) throw new Error('This group has no sender to match on.');
  const id = newRuleId();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await getMailRules();
    const doc = withLearnedRule(docOf(current), {
      rule: { when: rule.when, then: rule.then }, note: '', id, created: todayIso(), skipInbox: true,
      ...(rule.newGroup ? { newGroup: rule.newGroup } : {}),
    });
    let saved: { fileRev: string };
    try {
      saved = await putMailRules({ ...doc, baseRev: current.fileRev });
    } catch (error) {
      if (attempt === 0 && saveRefusalOf(error).kind === 'changed') continue;
      throw error;
    }
    let text = filterSavedText(request.label, 0);
    if (moveNow && request.unread > 0 && request.watermark) {
      try {
        const answer = await archiveMailGroup({ scope: request.scope, group: request.groupId, watermark: request.watermark, ruleId: id });
        text = filterSavedText(request.label, answer.queued);
      } catch (error) {
        const reason = messageOf(error).replace(/[.\s]+$/, '');
        log.warn('mail', 'group archive failed', { groupId: request.groupId, ruleId: id, error: reason });
        text = `${filterSavedText(request.label, 0)} Walnut couldn't move the unread now: ${reason}.`;
      }
    }
    pushLearnedUndo({
      statusId: `rule-saved:${id}`, viewKey: request.viewKey, text, doc, fileRev: saved.fileRev, ruleIds: [id],
      ...(rule.newGroup ? { createdGroup: rule.newGroup } : {}),
    });
    return;
  }
}
