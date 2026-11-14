/**
 * Settings > Mail rules, as plain functions: the file error sentence, each rule's provenance line,
 * moves in a list, and the rule editor's condition rows (to and from a rule's `when`).
 *
 * No React and no network, so every sentence is graded in the node tier
 * (`tests/web/mail-rules-model.test.ts`). The words the server owns (a rule's summary, a validation
 * message) are passed through untouched; a subject pattern is checked with the server's own module.
 */
import { folderNameProblem } from '@open-walnut/mail-folder-name';
import { compileSubjectPattern, heldPatternLine, ruleOffReason, type PatternHint } from '@open-walnut/mail-subject-pattern';
import type { MailPreviewResponse, MailRule, MailRuleView, MailRuleWhen, MailRulesError } from '@/api/mail-groups';
import { movesPhrase } from '@/utils/mail-preview-moves';

export const COPY = {
  crossLink: 'Inbox Triage reads only Important when grouping is on.',
  openTriage: 'Open Inbox Triage',
  triageUndo: 'Mail that Inbox Triage marks read is not part of group Undo.',
  noFile: 'No rules file yet. Walnut creates it the first time you save a rule.',
  commentsNote: "Saving from here rewrites the file. Comments outside a rule's note are not kept; the previous version is kept as sort-rules.yaml.bak.",
  fixFirst: 'Fix the file first, or reload it after fixing.',
  empty: 'No rules yet. Use "Important…" or "Not important…" on a mail in Mail to teach Walnut, or add one here.',
  changedOnDisk: 'The rules file changed on disk.',
  changedOnSave: 'The rules file changed on disk. Reload to see the new version.',
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

/**
 * The line under a rule: `Learned Sep 28 · note` for one Walnut learned, the note alone for one of
 * the user's (every rule there is theirs unless it says otherwise), '' for one of theirs with none.
 */
export function provenanceLine(rule: Pick<MailRule, 'source' | 'created' | 'note'>): string {
  const day = rule.source === 'learned' ? shortDay(rule.created) : null;
  const head = rule.source === 'learned' ? (day ? `Learned ${day}` : 'Learned') : '';
  return [head, rule.note?.trim() ?? ''].filter(Boolean).join(' \u00b7 ');
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

/** What goes back to the server: the view-only `summary` and `offReason` dropped. */
export function storedRule(rule: MailRuleView | MailRule): MailRule {
  const { summary: _summary, offReason: _offReason, ...rest } = rule as MailRuleView;
  return rest;
}

/** A row shows this much of a subject pattern; the rest is in its tooltip and in the editor. */
export const PATTERN_SHOWN_CHARS = 60;

/**
 * A rule's summary in parts: its subject pattern (`/.../` as sort-rule-summary.ts writes it) as code
 * without the slashes, so a long pattern stays in its own box instead of breaking mid-word in the
 * sentence, and the ` \u2192 target` tail on one line (`nowrap`). A pattern over `PATTERN_SHOWN_CHARS`
 * shows its head and an ellipsis, the whole pattern in `full` (2026-11-05: a 241-character one took
 * six lines of the list).
 */
export interface SummaryPart { text: string; code?: true; full?: string; nowrap?: true }

export function summaryParts(rule: Pick<MailRuleView, 'summary' | 'when'>): SummaryPart[] {
  const { summary } = rule;
  // `→ Build results` stays on one line: a target is never split from its arrow or across lines.
  const target = (rest: string): SummaryPart[] => {
    const arrow = rest.lastIndexOf(' \u2192 ');
    return arrow < 0 ? (rest ? [{ text: rest }] : []) : [
      ...(arrow > 0 ? [{ text: rest.slice(0, arrow) }] : []), { text: ' ' }, { text: rest.slice(arrow + 1), nowrap: true as const },
    ];
  };
  const subject = rule.when.subject;
  if (!subject || typeof subject !== 'object') return target(summary);
  // `Subject matches /x/` leads a rule with no sender; `... with a subject matching /x/` follows
  // one (and is what an older server writes for every rule).
  const word = [`matches /${subject.re}/`, `matching /${subject.re}/`].map((marker) => ({ marker, at: summary.indexOf(marker) })).find((one) => one.at >= 0);
  if (!word) return target(summary);
  const { marker, at } = word;
  // The pattern as code, without the slashes the editor asks people to leave out.
  const { re } = subject;
  let cut = PATTERN_SHOWN_CHARS - 1;
  // Never cut between the two halves of a surrogate pair.
  if (/[\uD800-\uDBFF]/.test(re[cut - 1] ?? '')) cut -= 1;
  const code: SummaryPart = re.length > PATTERN_SHOWN_CHARS
    ? { text: `${re.slice(0, cut)}\u2026`, code: true, full: re }
    : { text: re, code: true };
  return [{ text: summary.slice(0, at + marker.indexOf('/')) }, code, ...target(summary.slice(at + marker.length))];
}

/** The preview line; for a rule the user switched off, what it would match once on. */
export function previewSentence(answer: Pick<MailPreviewResponse, 'matches' | 'moves' | 'partial'>, off = false): string {
  const n = answer.matches;
  const count = `${answer.partial ? 'at least ' : ''}${n.toLocaleString('en-US')} ${n === 1 ? 'mail' : 'mails'}`;
  if (off) return `This rule is switched off; saving keeps it off. Switched on, it would match ${count}`;
  const moves = movesPhrase(answer.matches, answer.moves);
  return moves ? `Matches ${count} \u00b7 ${moves}` : `Matches ${count}`;
}

/** `A group named Build results already exists; …` for a new group typed with an existing name. */
export function existingGroupLine(name: string): string {
  return `A group named ${name} already exists; this rule sends mail to it.`;
}

/** `r-` + 6 hex. */
export function newRuleId(random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < 6; i += 1) out += Math.floor(random() * 16).toString(16);
  return `r-${out}`;
}

// ── the editor's condition rows ──

export type ConditionField =
  | 'from' | 'fromContains' | 'subject' | 'subjectRe' | 'listId' | 'addressedToMe' | 'cc' | 'sender' | 'group' | 'account' | 'message';

export interface ConditionRow { key: number; field: ConditionField; value: string }

export const FIELD_LABELS: Record<ConditionField, string> = {
  from: 'From',
  fromContains: 'From contains',
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

export const FIELD_ORDER: ConditionField[] = ['from', 'fromContains', 'subject', 'subjectRe', 'listId', 'addressedToMe', 'cc', 'sender', 'group', 'account', 'message'];

export const SENDER_KINDS = ['person', 'bulk', 'transactional', 'automated', 'unknown'] as const;

/** The value a freshly chosen field starts with (a fixed-choice field never starts empty). */
export function defaultValueOf(field: ConditionField): string {
  if (field === 'addressedToMe') return 'true';
  if (field === 'cc') return 'true';
  if (field === 'sender') return 'automated';
  return '';
}

/**
 * The field a server error names (`when.from`, `from`, `when.subject.re`) mapped to a row field, or
 * to the editor's own `then`, `note` and folder (`moveTo`) fields.
 */
export function fieldOfError(field: string): ConditionField | 'then' | 'note' | 'moveTo' | null {
  const bare = field.replace(/^rules\[\d+\]\./, '').replace(/^when\./, '');
  if (bare === 'then' || bare === 'note' || bare === 'moveTo') return bare;
  if (bare === 'subject.re') return 'subjectRe';
  return (FIELD_ORDER as string[]).includes(bare) ? bare as ConditionField : null;
}

export function rowsOfWhen(when: MailRuleWhen, nextKey: () => number): ConditionRow[] {
  const rows: ConditionRow[] = [];
  const add = (field: ConditionField, value: string) => rows.push({ key: nextKey(), field, value });
  if (when.from !== undefined) add('from', Array.isArray(when.from) ? when.from.join(', ') : when.from);
  if (when.fromContains !== undefined) add('fromContains', when.fromContains);
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

/**
 * The subject pattern a rule keeps although Walnut will not run it (too big, as an older Walnut
 * accepted, or invalid, too long or with a back-reference, as a hand edit may write): that rule is
 * off, and its own pattern, unchanged, is no problem on a save (the server keeps it too,
 * sort-rules-schema.ts). Undefined for any other rule.
 */
export function heldPatternOf(rule: MailRule | null | undefined): string | undefined {
  const subject = rule?.when.subject;
  if (!subject || typeof subject !== 'object' || !ruleOffReason(rule!.when)) return undefined;
  return subject.re;
}

/** The fields typed into a text box; switching between two of them keeps what was typed. */
export const TEXT_FIELDS: ReadonlySet<ConditionField> = new Set(['from', 'fromContains', 'subject', 'subjectRe', 'listId', 'group', 'message']);

export interface RowsJudged {
  when: MailRuleWhen;
  /** What keeps the rule from saving, per row key (-1: the rule as a whole). */
  problems: Map<number, string>;
  /** A row holding the rule's own pattern that keeps it off: the calm line under it. */
  off: Map<number, string>;
  /** A pattern that runs but will not match as it seems meant to: a line under it that blocks nothing. */
  hints: Map<number, PatternHint>;
  /** A row that replaced the rule's own held pattern with one Walnut runs: saving turns the rule on. */
  turnsOn: Set<number>;
}

/**
 * The rows as a rule `when`, with any problem Walnut can see before asking the server, per row.
 * An empty `when` would match every mail, so it is a problem too (key -1). Text is kept as typed
 * where the matcher compares it as written (a subject's text or pattern, a list id, a message id):
 * a space there is part of what matches, so `^re: ` stays `^re: ` and a stored rule round-trips
 * byte for byte. Only a sender's entries and a group name are trimmed, which their matchers ignore
 * anyway, and a "from contains" text, which is never meant to match on its edge spaces. A value of only spaces is empty. `held` is the rule's own pattern that keeps it off
 * (`heldPatternOf`): a row holding exactly it is kept as written and listed in `off` with
 * `heldPatternLine`, never as a problem; a changed one is judged like any typed pattern.
 */
export function whenOfRows(rows: readonly ConditionRow[], held?: string): RowsJudged {
  const when: MailRuleWhen = {};
  const problems = new Map<number, string>();
  const off = new Map<number, string>();
  const hints = new Map<number, PatternHint>();
  const turnsOn = new Set<number>();
  for (const row of rows) {
    const value = row.value;
    if (!value.trim() && row.field !== 'cc') { problems.set(row.key, 'Type a value.'); continue; }
    switch (row.field) {
      case 'from': {
        const list = value.split(',').map((one) => one.trim()).filter(Boolean);
        when.from = list.length === 1 ? list[0]! : list;
        break;
      }
      // Matched as a case-insensitive substring of the address or display name: edge spaces are noise.
      case 'fromContains': when.fromContains = value.trim(); break;
      case 'subject': when.subject = value; break;
      case 'subjectRe': {
        if (held !== undefined && value === held) {
          when.subject = { re: held };
          off.set(row.key, heldPatternLine(held) ?? '');
          break;
        }
        // The server's own check (linear matcher, same refusals and sentences), before any preview.
        // The server checks again on save; only a cause the shared scan does not know reads differently here.
        const compiled = compileSubjectPattern(value);
        if (!compiled.ok) { problems.set(row.key, compiled.message); break; }
        if (compiled.hint) hints.set(row.key, compiled.hint);
        if (held !== undefined) turnsOn.add(row.key);
        when.subject = { re: value };
        break;
      }
      case 'listId': when.listId = value; break;
      case 'addressedToMe': when.addressedToMe = value === 'true'; break;
      case 'cc': when.cc = true; break;
      case 'sender': when.sender = value as NonNullable<MailRuleWhen['sender']>; break;
      case 'group': when.group = value.trim(); break;
      case 'account': when.account = value; break;
      case 'message': when.message = value; break;
    }
  }
  if (rows.length === 0) problems.set(-1, 'Add at least one condition, or the rule would match every mail.');
  return { when, problems, off, hints, turnsOn };
}

// ── where a rule kept out of the Inbox goes ──

/** The longest folder name a filter may use (the server's MAX_FOLDER_NAME, sort-rules-schema.ts). */
export const MAX_FOLDER_CHARS = 200;

/**
 * Why a typed folder name cannot be used, or null. Empty is fine: the mail goes to Archive. The same
 * rules as the server's `moveToProblem` (sort-rules-schema.ts), in words for the person typing.
 */
export function folderProblem(folder: string): string | null {
  const name = folder.trim();
  if (!name) return null;
  return folderNameProblem(name);
}

/**
 * The rule fields for "Keep out of the Inbox": nothing when it is off or the target is Important or
 * Not important (the server refuses either field there), `skipInbox` for Archive (no folder typed),
 * `moveTo` alone for a named folder. A rule saved from these fields replaces the stored one, so
 * switching a filter back to Archive drops its `moveTo`.
 */
export function destinationOf(keepOut: boolean, folder: string, reserved: boolean): { skipInbox?: true; moveTo?: string } {
  if (!keepOut || reserved) return {};
  const name = folder.trim();
  return name ? { moveTo: name } : { skipInbox: true };
}
