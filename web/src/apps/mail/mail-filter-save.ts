/**
 * The rule "Filter mails like these…" writes, and the save itself.
 *
 * `when` is what the person typed: `fromContains` (the sender's address or name contains it) and
 * `subject` (the subject contains it), both case-insensitive, at least one. `then` is a group named
 * after the folder, so a move that fails still shows the mail together in the Inbox, and `moveTo` is
 * the folder: Walnut files the mail there in the account itself (mail-filter-moves.ts), making the
 * folder when the account has none. The person's own rule (`source: user`), first in the file.
 *
 * "Also move the N in the Inbox now" asks the server to apply it to every inbox mail it decides, read
 * or unread (`/rules/apply`); without it only new mail is moved.
 */
import { applyMailRule, getMailRules, putMailRules, type MailRuleWhen } from '@/api/mail-groups';
import { log } from '@/utils/log';
import { docOf, newRuleId, saveRefusalOf, todayIso, withLearnedRule } from './mail-correct-model';
import { folderFilterSavedText, FOLDER_FILTER_NEEDS_MATCH } from './mail-groups-copy';
import { MAX_FOLDER } from './mail-filter-defaults';
import { MAX_FOLDER_NAME, folderNameProblem } from '@open-walnut/mail-folder-name';
import { pushLearnedUndo } from './MailCorrectPopover';

export { MAX_FOLDER_NAME };
const RESERVED = new Set(['important', 'not important']);

export interface FolderFilterInput {
  fromContains: string;
  subject: string;
  folder: string;
  /** Only this account's mail; unset, every account's. */
  accountId?: string;
}

export type FolderFilterRule = { when: MailRuleWhen; then: string; moveTo: string } | { problem: string };

/** Why this folder name cannot be used, or null: the one rule the server, the IMAP provider and Settings read. */
export function folderProblem(folder: string): string | null {
  return folderNameProblem(folder);
}

/** The rule for the card's fields, or what keeps it from saving. Pure. */
export function folderFilterRule(input: FolderFilterInput): FolderFilterRule {
  const fromContains = input.fromContains.trim();
  const subject = input.subject.trim();
  if (!fromContains && !subject) return { problem: FOLDER_FILTER_NEEDS_MATCH };
  const problem = folderProblem(input.folder);
  if (problem) return { problem };
  const moveTo = input.folder.trim();
  // The group it shows in while it waits to move: the folder's last part, as long as a group name may be.
  let then = (moveTo.split('/').pop() ?? moveTo).replace(/\s+/g, ' ').trim().slice(0, MAX_FOLDER).trim() || 'Filtered';
  if (RESERVED.has(then.toLowerCase())) then = `${then} (filed)`;
  const account = input.accountId?.trim();
  return { when: { ...(fromContains ? { fromContains } : {}), ...(subject ? { subject } : {}), ...(account ? { account } : {}) }, then, moveTo };
}

function messageOf(error: unknown): string {
  const body = (error as { body?: { message?: unknown } })?.body;
  if (body && typeof body.message === 'string') return body.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Save the filter (first in the file; re-read and retried once if the file moved), then, when asked,
 * move the mail already in the Inbox. The status strip says what happened, with Undo for the rule (mail
 * already moved stays in the folder).
 */
export async function saveFolderFilter(input: FolderFilterInput & { moveNow: boolean; viewKey: string }): Promise<{ queued: number }> {
  const rule = folderFilterRule(input);
  if ('problem' in rule) throw new Error(rule.problem);
  const id = newRuleId();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await getMailRules();
    // A group the file did not list yet is this save's, so Undo may take it away again.
    const newGroup = current.groups.some((one) => one.toLowerCase() === rule.then.toLowerCase()) ? undefined : rule.then;
    const doc = withLearnedRule(docOf(current), {
      rule: { when: rule.when, then: rule.then }, note: '', id, created: todayIso(), moveTo: rule.moveTo, source: 'user',
      ...(newGroup ? { newGroup } : {}),
    });
    let saved: { fileRev: string };
    try {
      saved = await putMailRules({ ...doc, baseRev: current.fileRev });
    } catch (error) {
      if (attempt === 0 && saveRefusalOf(error).kind === 'changed') continue;
      throw error;
    }
    let queued = 0;
    let text = folderFilterSavedText(rule.moveTo, 0);
    if (input.moveNow) {
      try {
        queued = (await applyMailRule(id)).queued;
        text = folderFilterSavedText(rule.moveTo, queued);
      } catch (error) {
        const reason = messageOf(error).replace(/[.\s]+$/, '');
        log.warn('mail', 'filter apply failed', { ruleId: id, error: reason });
        // A deadline on this side says nothing about the server, which may still be queueing the moves.
        text = (error as { name?: string })?.name === 'TimeoutError'
          ? `${folderFilterSavedText(rule.moveTo, 0)} Walnut is still sorting the mail already there; it moves as it goes.`
          : `${folderFilterSavedText(rule.moveTo, 0)} Walnut couldn't move the mail already there: ${reason}.`;
      }
    }
    pushLearnedUndo({
      statusId: `rule-saved:${id}`, viewKey: input.viewKey, text, doc, fileRev: saved.fileRev, ruleIds: [id],
      ...(newGroup ? { createdGroup: newGroup } : {}),
    });
    return { queued };
  }
  return { queued: 0 };
}
