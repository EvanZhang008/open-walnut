/**
 * The first message of one triage run, as a pure function.
 *
 * Everything a run needs to start is assembled here: what arrived, since when,
 * what the last run left in State.md, what the last run wrote in the journal,
 * and the checklist it must satisfy before it finishes. No disk, no clock, no
 * bus — the action reads the files and hands the strings in, so every cap and
 * every count in this file is gradable against plain values.
 *
 * TWO SHAPES IN ONE MESSAGE, and the boundary is deliberate:
 *
 *   WALNUT_TRIAGE_COUNT: <n>          ← bookkeeping, consumed by the executor
 *   <walnut-message kind="trigger">   ← the BATCH: somebody else's words
 *     …
 *   </walnut-message>
 *                                     ← then the engine appends the routine's
 *                                       own instructions, OUTSIDE the fence
 *
 * The fence holds mail subjects and Slack text, which are attacker-controlled;
 * `buildWalnutMessage` escapes a body that tries to close it. Walnut's own
 * instructions stay outside it on purpose — the fence means "this came from
 * elsewhere", and the run's orders did not. The engine's concatenation order is
 * `initOutput + "\n\n" + instructions` (cron/timer.ts), which is why the batch
 * comes first and why S12's instructions say "Read the batch above".
 *
 * MAIL IS COUNTS, SLACK IS DATA. Mail's own ops can answer "what arrived since
 * T", so the envelope carries `since`, the per-account counts and the headlines
 * the event already had, and tells the session to call `mail_list`. Core never
 * reads the mail plugin's SQLite. Slack's cursors are not queryable from core at
 * all, so the items ARE the data and they ride in full.
 */

import { boundedItemsJson, ITEMS_JSON_CAP } from '../routines/trigger-envelope.js';
import { buildWalnutMessage } from '../peers/walnut-message-tag.js';
import type { TriagePendingMail, TriagePendingSlack } from './state.js';
import { TRIAGE_AGENT_NAME, type TriageSource } from './types.js';

/** The shared 32 KB whole-item-drop budget, re-exported for the action's tests. */
export { ITEMS_JSON_CAP };

/**
 * How much of State.md rides the envelope.
 *
 * State.md is the run's own working memory and it grows: `## Recently handled`
 * alone holds ~200 message ids. 8 KB is roughly 2K tokens, which is worth paying
 * every run; beyond that the run can `note_read` the rest itself.
 */
export const STATE_DOC_CAP = 8 * 1024;

/** Where the working state lives, vault-relative (NOTES_DIR is the vault root). */
export const TRIAGE_STATE_NOTE = 'Walnut/Triage/State.md';

/** Where the run journal lives; `<YYYY-MM>` is filled per month. */
export const TRIAGE_RUNS_NOTE_DIR = 'Walnut/Triage/Runs';

/** The line the executor consumes and strips (claude-code.ts COUNT_HINT_RE). */
export function triageCountHintLine(count: number): string {
  return `WALNUT_TRIAGE_COUNT: ${Math.max(0, Math.floor(count))}`;
}

export interface TriageBatchInput {
  /** The claimed mail ticks, oldest first. */
  mail: readonly TriagePendingMail[];
  /** The claimed Slack items, oldest first. */
  slack: readonly TriagePendingSlack[];
  droppedMail: number;
  droppedSlack: number;
  /** Everything newer than this is "new" — the last acknowledged run's start. */
  sinceMs: number;
  /** This run's start (the claim). */
  nowMs: number;
  /** Which inboxes the config says feed a batch. */
  sources: readonly TriageSource[];
  /** State.md's raw bytes, or undefined when the note does not exist yet. */
  stateDoc?: string;
  /** The previous run's journal line, when there was one. */
  previousJournalLine?: string;
  /** The previous run never rewrote State.md — say so FIRST. */
  stateStale?: boolean;
  /** True when this exact batch was already handed to a run that never started. */
  redelivered?: boolean;
}

export interface TriageBatchCounts {
  mailAccounts: number;
  mailMessages: number;
  slackItems: number;
  droppedMail: number;
  droppedSlack: number;
  /** What `{count}` in the run's task title means: mail messages + Slack items. */
  total: number;
}

export interface TriageBatch {
  /** The action's whole `summary`: the count hint line, then ONE envelope. */
  message: string;
  /** The envelope body, for tests and for the audit preview. */
  body: string;
  /** The envelope's `note` attribute — the human-readable count. */
  note: string;
  counts: TriageBatchCounts;
}

function iso(ms: number): string {
  return new Date(Number.isFinite(ms) && ms > 0 ? ms : Date.now()).toISOString();
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Cut an over-long State.md at a SECTION boundary, never mid-sentence.
 *
 * A markdown heading is where the document itself says one thought ended, so a
 * cut there leaves every kept section complete and the note says plainly what is
 * missing. Falls back to a line boundary when there is no heading to cut at (a
 * single enormous section), and to a hard slice when there is not even a line
 * break — a pathological note must still produce a bounded envelope.
 */
export function cutStateDoc(text: string, cap = STATE_DOC_CAP): { text: string; cut: boolean } {
  if (text.length <= cap) return { text, cut: false };
  const head = text.slice(0, cap);
  const lastHeading = head.lastIndexOf('\n## ');
  const boundary = lastHeading > 0 ? lastHeading : head.lastIndexOf('\n');
  const kept = boundary > 0 ? head.slice(0, boundary) : head;
  const omitted = text.length - kept.length;
  return {
    text: `${kept}\n\n[State.md is longer than ${cap} characters — ${omitted} more cut here at a section boundary. note_read it in full if you need the rest.]`,
    cut: true,
  };
}

/** One mail account's row as the envelope carries it (counts + headlines). */
function mailRow(row: TriagePendingMail): Record<string, unknown> {
  return {
    accountId: row.accountId,
    newMessages: row.count,
    at: iso(row.atMs),
    headlines: row.headlines.map((h) => ({ from: h.from, subject: h.subject })),
  };
}

function slackRow(row: TriagePendingSlack): Record<string, unknown> {
  return {
    conversation: row.conversation,
    isDm: row.isDm,
    isMention: row.isMention,
    from: row.alias,
    ts: row.ts,
    ...(row.permalink ? { permalink: row.permalink } : {}),
    text: row.text,
  };
}

/** The checklist the automatic-learning contract rests on. */
export const TRIAGE_FINISH_CHECKLIST = [
  'Before you finish:',
  `- rewrite ${TRIAGE_STATE_NOTE} (Awaiting / Watching / Recently handled / Notes for next run),`,
  '  with a frontmatter `updated` stamp of the moment you wrote it',
  `- append one line to ${TRIAGE_RUNS_NOTE_DIR}/<YYYY-MM>.md saying what this run did`,
  '- memory_write anything durable you learned (a sender, a routing rule, a preference)',
  '- confirm every project tracking note you touched is true',
].join('\n');

/**
 * Build one run's first message.
 *
 * Order inside the body is fixed and meaningful: the warning (if any) first
 * because it changes what the run should do; then what is new and since when;
 * then the items; then the carried state; then the checklist last, where a
 * reader ends up.
 */
export function buildTriageBatch(input: TriageBatchInput): TriageBatch {
  const mailMessages = input.mail.reduce((sum, row) => sum + Math.max(0, row.count), 0);
  const counts: TriageBatchCounts = {
    mailAccounts: input.mail.length,
    mailMessages,
    slackItems: input.slack.length,
    droppedMail: Math.max(0, Math.floor(input.droppedMail)),
    droppedSlack: Math.max(0, Math.floor(input.droppedSlack)),
    total: mailMessages + input.slack.length,
  };

  const wantsMail = input.sources.includes('mail');
  const wantsSlack = input.sources.includes('slack');

  const parts: string[] = [];

  if (input.stateStale) {
    parts.push(
      `The previous run did not update ${TRIAGE_STATE_NOTE}. Treat the state below as `
      + 'possibly one run out of date, and make sure you rewrite it this time.',
    );
  }
  if (input.redelivered) {
    parts.push(
      'This batch was already handed to a run that never started, so you may have seen '
      + 'these items before. Re-read the real state before acting — do not assume the '
      + 'earlier run did anything.',
    );
  }

  parts.push([
    `Inbox Triage batch ${iso(input.nowMs)}.`,
    `Everything newer than ${iso(input.sinceMs)} is new.`,
  ].join('\n'));

  if (wantsMail) {
    if (counts.mailAccounts > 0) {
      const dropped = counts.droppedMail > 0
        ? ` ${counts.droppedMail} older account tick(s) were dropped from the buffer.`
        : '';
      const cap = ITEMS_JSON_CAP;
      parts.push(
        `Mail — ${plural(counts.mailMessages, 'new message')} across `
        + `${plural(counts.mailAccounts, 'account')}. The headlines below are a sample; read the `
        + `messages with mail_list on each account and take everything newer than the \`since\` `
        + `above.${dropped}\n\`\`\`json\n${boundedItemsJson(input.mail.map(mailRow), cap)}\n\`\`\``,
      );
    } else {
      parts.push('Mail — nothing new was reported since the last run.');
    }
  }

  if (wantsSlack) {
    if (counts.slackItems > 0) {
      const dropped = counts.droppedSlack > 0
        ? ` ${counts.droppedSlack} older item(s) did not fit the buffer and are only in Slack.`
        : '';
      // Slack shares the SAME 32 KB budget as mail and goes second, so a fat mail
      // block cannot be pushed out by Slack items and the total stays bounded.
      const mailJsonCost = wantsMail && counts.mailAccounts > 0
        ? boundedItemsJson(input.mail.map(mailRow)).length
        : 0;
      const cap = Math.max(1_024, ITEMS_JSON_CAP - mailJsonCost);
      parts.push(
        `Slack — ${plural(counts.slackItems, 'item')}.${dropped}\n`
        + `\`\`\`json\n${boundedItemsJson(input.slack.map(slackRow), cap)}\n\`\`\``,
      );
    } else {
      parts.push('Slack — nothing new was reported since the last run.');
    }
  }

  const stateDoc = (input.stateDoc ?? '').trim();
  if (stateDoc) {
    const { text } = cutStateDoc(stateDoc);
    parts.push(`${TRIAGE_STATE_NOTE} (your working state, as the last run left it):\n${text}`);
  } else {
    parts.push(
      `${TRIAGE_STATE_NOTE} does not exist yet. Write it at the end of this run: `
      + 'Awaiting / Watching / Recently handled / Notes for next run.',
    );
  }

  if (input.previousJournalLine) {
    parts.push(`The previous run's journal line:\n${input.previousJournalLine}`);
  }

  parts.push(TRIAGE_FINISH_CHECKLIST);

  const body = parts.join('\n\n');
  const note = triageBatchNote(counts);
  const message = [
    triageCountHintLine(counts.total),
    buildWalnutMessage({
      kind: 'trigger',
      attrs: { from: TRIAGE_AGENT_NAME, note },
      body,
    }),
  ].join('\n');

  return { message, body, note, counts };
}

/**
 * The envelope's `note` — what the session card shows before it is opened.
 *
 * Counts here MUST equal the rows in the JSON below them: a card claiming 22
 * items over a body holding 8 is the audit trail lying, which is worse than no
 * card. `dropped` is how the two are reconciled when the caps bit.
 */
export function triageBatchNote(counts: TriageBatchCounts): string {
  const bits: string[] = [];
  bits.push(`${plural(counts.mailMessages, 'new mail')} in ${plural(counts.mailAccounts, 'account')}`);
  bits.push(plural(counts.slackItems, 'Slack item'));
  const dropped = counts.droppedMail + counts.droppedSlack;
  if (dropped > 0) bits.push(`${dropped} dropped`);
  return `batch · ${bits.join(' · ')}`;
}
