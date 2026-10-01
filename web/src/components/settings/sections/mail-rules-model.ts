/**
 * Settings > Mail rules, as plain functions: the file error sentence, each rule's provenance line,
 * moves in a list, and the rule editor's condition rows (to and from a rule's `when`).
 *
 * No React and no network, so every sentence is graded in the node tier
 * (`tests/web/mail-rules-model.test.ts`). The words the server owns (a rule's summary, a validation
 * message) are passed through untouched.
 */
import type { MailRule, MailRuleView, MailRuleWhen, MailRulesError } from '@/api/mail-groups';

export const COPY = {
  crossLink: 'Inbox Triage reads only Important when grouping is on.',
  openTriage: 'Open Inbox Triage',
  triageUndo: 'Mail that Inbox Triage marks read is not part of group Undo.',
  noFile: 'No rules file yet. Walnut creates it the first time you save a rule.',
  commentsNote: "Saving from here rewrites the file. Comments outside a rule's note are not kept; the previous version is kept as sort-rules.yaml.bak.",
  fixFirst: 'Fix the file first, or reload it after fixing.',
  empty: 'No rules yet. Use "Important…" or "Not important…" on a mail in Mail to teach Walnut, or add one here.',
  builtinNote: 'Your rules above run first.',
  changedOnDisk: 'The rules file changed on disk.',
  changedOnSave: 'The rules file changed on disk. Reload to see the new version.',
  addedByYou: 'Added by you',
  pluginOff: 'This panel is from Mail, which is off.',
} as const;

// ── the file error strip ──

function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function isMissingFileError(error: MailRulesError | undefined): boolean {
  return !!error && /^The rules file is missing/.test(error.message);
}

/**
 * `Line 7: <message> Walnut is still using the rules from 10:42.`, or `Rule 3 (r-7f3a2c): …` when the
 * server could not place the problem on a line. A message that already says what is still in use
 * (the missing-file one) is not told twice.
 */
export function fileErrorSentence(error: MailRulesError): string {
  const message = error.message.trim();
  const where = error.line !== undefined
    ? `Line ${error.line}: `
    : error.rule && !/^Rule \d+/.test(message)
      ? `Rule ${error.rule.index + 1}${error.rule.id ? ` (${error.rule.id})` : ''}: `
      : '';
  const said = /still using the rules/.test(message);
  const body = /[.?!]$/.test(message) ? message : `${message}.`;
  return said ? `${where}${body}` : `${where}${body} Walnut is still using the rules from ${clock(error.since)}.`;
}

// ── rule rows ──

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-09-28` as `Sep 28` (the day, never shifted by time zones). */
export function shortDay(created: string | undefined): string | null {
  const match = created ? /^(\d{4})-(\d{2})-(\d{2})/.exec(created) : null;
  if (!match) return null;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}` : null;
}

/** `Learned Sep 28 · "note"`, or `Added by you`. */
export function provenanceLine(rule: Pick<MailRule, 'source' | 'created' | 'note'>): string {
  if (rule.source !== 'learned') return COPY.addedByYou;
  const day = shortDay(rule.created);
  const head = day ? `Learned ${day}` : 'Learned';
  return rule.note ? `${head} · "${rule.note}"` : head;
}

/** The list with one item moved by `delta`; the same list when the move would leave the ends. */
export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item!);
  return next;
}

/** What goes back to the server: the view-only `summary` dropped. */
export function storedRule(rule: MailRuleView | MailRule): MailRule {
  const { summary: _summary, ...rest } = rule as MailRuleView;
  return rest;
}

/** `r-` + 6 hex. */
export function newRuleId(random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < 6; i += 1) out += Math.floor(random() * 16).toString(16);
  return `r-${out}`;
}

// ── the editor's condition rows ──

export type ConditionField =
  | 'from' | 'subject' | 'subjectRe' | 'listId' | 'addressedToMe' | 'cc' | 'sender' | 'group' | 'account' | 'message';

export interface ConditionRow { key: number; field: ConditionField; value: string }

export const FIELD_LABELS: Record<ConditionField, string> = {
  from: 'From',
  subject: 'Subject contains',
  subjectRe: 'Subject pattern',
  listId: 'Mailing list',
  addressedToMe: 'Sent to me',
  cc: 'I am only on Cc',
  sender: 'Sender kind',
  group: 'Walnut groups it as',
  account: 'Account',
  message: 'One mail',
};

export const FIELD_ORDER: ConditionField[] = ['from', 'subject', 'subjectRe', 'listId', 'addressedToMe', 'cc', 'sender', 'group', 'account', 'message'];

export const SENDER_KINDS = ['person', 'bulk', 'transactional', 'automated', 'unknown'] as const;

/** The value a freshly chosen field starts with (a fixed-choice field never starts empty). */
export function defaultValueOf(field: ConditionField): string {
  if (field === 'addressedToMe') return 'true';
  if (field === 'cc') return 'true';
  if (field === 'sender') return 'automated';
  return '';
}

/** The field a server error names (`when.from`, `from`, `when.subject.re`) mapped to a row field. */
export function fieldOfError(field: string): ConditionField | 'then' | 'note' | null {
  const bare = field.replace(/^rules\[\d+\]\./, '').replace(/^when\./, '');
  if (bare === 'then' || bare === 'note') return bare;
  if (bare === 'subject.re') return 'subjectRe';
  return (FIELD_ORDER as string[]).includes(bare) ? bare as ConditionField : null;
}

export function rowsOfWhen(when: MailRuleWhen, nextKey: () => number): ConditionRow[] {
  const rows: ConditionRow[] = [];
  const add = (field: ConditionField, value: string) => rows.push({ key: nextKey(), field, value });
  if (when.from !== undefined) add('from', Array.isArray(when.from) ? when.from.join(', ') : when.from);
  if (typeof when.subject === 'string') add('subject', when.subject);
  else if (when.subject && typeof when.subject === 'object') add('subjectRe', when.subject.re);
  if (when.listId !== undefined) add('listId', when.listId);
  if (when.addressedToMe !== undefined) add('addressedToMe', String(when.addressedToMe));
  if (when.cc) add('cc', 'true');
  if (when.sender !== undefined) add('sender', when.sender);
  if (when.group !== undefined) add('group', when.group);
  if (when.account !== undefined) add('account', when.account);
  if (when.message !== undefined) add('message', when.message);
  return rows;
}

/** A pattern that can backtrack for ever (a quantified group holding a quantifier, or a back-reference). */
export function riskyPattern(source: string): boolean {
  if (/\\[1-9]|\\k</.test(source)) return true;
  return /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,?\d*\})(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/.test(source)
    || /\(([^()|]+)\|\1\)[+*]/.test(source);
}

export const RISKY_PATTERN = 'This pattern could take too long to run. Remove the repeated group.';

/**
 * The rows as a rule `when`, with any problem Walnut can see before asking the server, per row.
 * An empty `when` would match every mail, so it is a problem too (key -1).
 */
export function whenOfRows(rows: readonly ConditionRow[]): { when: MailRuleWhen; problems: Map<number, string> } {
  const when: MailRuleWhen = {};
  const problems = new Map<number, string>();
  for (const row of rows) {
    const value = row.value.trim();
    if (!value && row.field !== 'cc') { problems.set(row.key, 'Type a value.'); continue; }
    switch (row.field) {
      case 'from': {
        const list = value.split(',').map((one) => one.trim()).filter(Boolean);
        when.from = list.length === 1 ? list[0]! : list;
        break;
      }
      case 'subject': when.subject = value; break;
      case 'subjectRe': {
        if (value.length > 200) { problems.set(row.key, 'A pattern is at most 200 characters.'); break; }
        if (riskyPattern(value)) { problems.set(row.key, RISKY_PATTERN); break; }
        try { new RegExp(value, 'i'); } catch { problems.set(row.key, 'This pattern does not work as a regular expression.'); break; }
        when.subject = { re: value };
        break;
      }
      case 'listId': when.listId = value; break;
      case 'addressedToMe': when.addressedToMe = value === 'true'; break;
      case 'cc': when.cc = true; break;
      case 'sender': when.sender = value as NonNullable<MailRuleWhen['sender']>; break;
      case 'group': when.group = value; break;
      case 'account': when.account = value; break;
      case 'message': when.message = value; break;
    }
  }
  if (rows.length === 0) problems.set(-1, 'Add at least one condition, or the rule would match every mail.');
  return { when, problems };
}
