/**
 * The first message of an Ask Walnut session opened FROM the ✦ AI search card.
 *
 * The one-shot AI lane answers in one claude -p run with a fixed tool budget;
 * "Open as session" hands the same question to a full Personal AI session that
 * can dig through tasks, transcripts, memory and notes, and that the user can
 * keep asking. The message has to carry everything by itself: the button is
 * ONE click, there is no composer step, so the session must know what to do
 * from this text alone.
 *
 * Pure: no DOM, no store — pinned by tests/web/agent-search-session.test.ts.
 */

import type { AgentSearchPayload, AgentSearchRow } from '@/api/agentSearch';

/** Candidates riding along from a finished quick search. Enough to seed the
 *  session, few enough that the message stays a briefing, not a dump. */
const MAX_SEEDED_ROWS = 8;
/** The model's evidence phrase is free text; a long one is noise in a briefing. */
const MAX_EVIDENCE_CHARS = 160;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function seededRowLine(row: AgentSearchRow): string {
  // Every interpolated field goes through clip(), which also flattens whitespace:
  // a project name may legally contain a newline (assertValidProjectName allows
  // it), and an unflattened one would forge a bullet of its own in this list.
  const where = clip([row.project?.trim() || 'Inbox', row.phase?.trim()].filter(Boolean).join(' · '), 120);
  const evidence = row.evidence?.trim() ? `: “${clip(row.evidence, MAX_EVIDENCE_CHARS)}”` : '';
  return `- ${clip(row.title, 120) || row.taskId} (${where}), task ${row.taskId}${evidence}`;
}

/**
 * Build the seed message. `found` is the quick search's payload when it had
 * finished (any state without a payload — still searching, failed, AI lane
 * off — sends the bare briefing, and the session does its own search).
 *
 * The first line doubles as the task's title candidate (the session auto-title
 * hook reads the first user message), so it names the question plainly.
 */
export function buildSearchSessionMessage(query: string, found?: AgentSearchPayload): string {
  const q = query.replace(/\s+/g, ' ').trim();
  const lines: string[] = [
    `Find everything about: ${q}`,
    '',
    'This started as a search on my task board. Search my tasks, sessions (including their transcripts), memory and notes for it, then report:',
    '- the matching tasks and sessions (title, id, status), most relevant first',
    '- a short summary of what they say about it',
    '- whether it looks resolved or still open',
  ];
  const rows = found?.results.slice(0, MAX_SEEDED_ROWS) ?? [];
  if (rows.length === 0) return lines.join('\n');
  lines.push('', 'A quick AI search already found these; start from them and go deeper:');
  for (const row of rows) lines.push(seededRowLine(row));
  if (found && found.results.length > rows.length) {
    lines.push(`- …and ${found.results.length - rows.length} more`);
  }
  // Attributed, and ONLY alongside candidates. A summary from a search that found
  // nothing is a weaker model's negative conclusion; unattributed at the end of
  // this message it reads as the user's own premise, and the one job here is to
  // look harder than that search did.
  const summary = found?.summary?.trim();
  if (summary) lines.push('', `That quick search summed it up as “${clip(summary, 300)}” — verify it.`);
  return lines.join('\n');
}
