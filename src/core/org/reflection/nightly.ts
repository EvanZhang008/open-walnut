/**
 * Once a night, the day's reflection record goes to the node's own session (2026-11-19, the user's
 * lead, for the user: "event plus nightly"; then: a VP cannot change its own nightly routine, so
 * the duty brings the record itself). After NIGHTLY_AT on the server's local clock, a node whose
 * reflection wrote a record today gets one note naming the file and each finding in a line, so its
 * evening reflection (a routine or its own turn) reads what its team got wrong and keeps the lessons
 * that are its own (MEMORY.md, its instructions). A day with no finding sends nothing.
 */
import fsp from 'node:fs/promises';
import type { Task } from '../../types.js';
import { handedToLine, readDayEntries, reflectionDayFileOf, ruleLine, type DayEntry } from './records.js';
import { localDate, readReflectionState, updateReflectionState } from './state.js';
import crypto from 'node:crypto';
import { painsFileOf, painsNightlyText, painsReport } from './pains.js';
import { readGuardRun, readPainsFile } from './pains-store.js';

/** Minutes after local midnight: before the VPs' 20:00 reflection routines. */
export const NIGHTLY_AT_MIN = 19 * 60 + 45;
/** The note lists every finding of a usual day (2026-11-20: at 1500 a team's 10 showed as 4), each cut to one line. */
const SUMMARY_MAX = 3000;
const LINE_MAX = 240;

export type NightlySend = (node: Task, text: string, title: string) => Promise<boolean>;

const oneLine = (l: string): string => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX - 3).trimEnd()}...` : l);

/** One finding as the note lists it: kind, what went wrong, the rule it became, the task it went to. Pure. */
export function nightlyLine(e: DayEntry): string {
  return oneLine(`- ${e.at.slice(11, 16)} ${e.finding.kind} in ${e.task.title}: ${e.finding.what_went_wrong} Rule: ${ruleLine(e.rule)}. Handed to: ${handedToLine(e)}.`);
}

/** The one-line findings of a day's Markdown (a day, or the part of one, written before its JSON). Pure. */
function markdownLines(record: string): string[] {
  const lines: string[] = [];
  let title = '';
  for (const raw of record.split('\n')) {
    if (raw.startsWith('## ')) title = raw.slice(3).trim();
    else if (raw.startsWith('- What went wrong: ') && title) { lines.push(oneLine(`- ${title}: ${raw.slice(19).trim()}`)); title = ''; }
  }
  return lines;
}

/**
 * The day's findings, one line each. Every finding since the JSON began is in both files; on the
 * day the JSON began, the Markdown's first entries are only there, so they are listed from it. Pure.
 */
export function dayLines(markdown: string, entries: readonly DayEntry[]): string[] {
  const md = markdownLines(markdown);
  return [...md.slice(0, Math.max(0, md.length - entries.length)), ...entries.map(nightlyLine)];
}

/**
 * The note for one day's record: its findings, one line each, and where the whole record is. Pure.
 * `record` is the day's Markdown, its entries (its JSON), or both.
 */
export function nightlyText(nodeName: string, file: string, record: string | readonly DayEntry[] | { markdown: string; entries: readonly DayEntry[] }): string {
  const lines = typeof record === 'string' ? dayLines(record, [])
    : 'markdown' in record ? dayLines(record.markdown, record.entries) : dayLines('', record);
  let body = '';
  for (const [i, l] of lines.entries()) {
    // Every finding is the reader's: the ones the note has no room for are counted, with the file that holds them.
    if (body.length + l.length > SUMMARY_MAX) { body += `- ... and ${lines.length - i} more, not listed here: all ${lines.length} are in ${file}\n`; break; }
    body += `${l}\n`;
  }
  // The pass's own notes (a judge budget spent: moments that wait) are the reader's too.
  const md = typeof record === 'string' ? record : 'markdown' in record ? record.markdown : '';
  const notes = md.split('\n').filter((l) => l.startsWith('> Note: ')).map((l) => `- ${l.slice(8).trim()}`);
  return [
    `${nodeName}'s reflection today found ${lines.length} decision${lines.length === 1 ? '' : 's'} to fix in your team's sessions. `
      + `The whole record (what each session said, the correction it got, the rule it became, the task it went to): ${file}`,
    '',
    body.trimEnd(),
    ...(notes.length ? ['', ...notes.slice(-3)] : []),
    '',
    'Read it in tonight\'s reflection. Keep in your MEMORY.md or instructions what is yours to keep; the team guidance already holds the lines for your team. No reply is needed.',
  ].join('\n');
}

/** The pain registry's lines for tonight: its unowned pains and the guard tests not known to pass ('' for none). */
export async function painsNightly(nodeId: string, nowMs: number): Promise<string> {
  const read = await readPainsFile(nodeId);
  if (read.state === 'missing') return '';
  // A registry that cannot be read is never written over: someone must fix it, so it is said.
  if (read.state === 'bad') {
    const { pendingCount } = await import('./pain-record.js');
    const waiting = await pendingCount(nodeId);
    return `Pain registry (${painsFileOf(nodeId)}): it cannot be read and no complaint is filed until it is fixed: ${read.why}.${waiting ? ` ${waiting} complaint${waiting === 1 ? '' : 's'} wait${waiting === 1 ? 's' : ''} to be filed then.` : ''}`;
  }
  if (!read.entries.length) return '';
  const run = await readGuardRun(nodeId);
  return painsNightlyText(painsFileOf(nodeId), painsReport(read.entries, run, nowMs), run);
}

const hashOf = (t: string) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);

/** The day's note with the registry's part after it; a day with no finding has only the registry's. Pure. */
export function withPains(day: string, pains: string, nodeName: string): string {
  if (!pains) return day;
  return day ? `${day}\n\n${pains}` : `${nodeName}'s reflection found no new decision to fix today, but its pain registry needs you.\n\n${pains}`;
}

/** Send today's record to the node once, after NIGHTLY_AT_MIN. Answers what it did. */
export async function nightlyNote(node: Task, nodeName: string, nowMs: number, send: NightlySend): Promise<'sent' | 'early' | 'done' | 'none' | 'failed'> {
  const d = new Date(nowMs);
  if (d.getHours() * 60 + d.getMinutes() < NIGHTLY_AT_MIN) return 'early';
  const date = localDate(nowMs);
  if ((await readReflectionState(node.id, nowMs)).nightly === date) return 'done';
  const file = reflectionDayFileOf(node.id, date);
  const record = { markdown: await fsp.readFile(file, 'utf-8').catch(() => ''), entries: (await readDayEntries(node.id, date)) ?? [] };
  // Marked first: a send that fails is not sent again tonight (the record stays for tomorrow's reading).
  await updateReflectionState(node.id, (s) => { s.nightly = date; }, nowMs);
  // The registry's part goes out when it changed since the last note that carried it: an unchanged
  // list is never sent again (every note wakes the node's session).
  const painsNow = await painsNightly(node.id, nowMs).catch(() => '');
  const painsHash = painsNow ? hashOf(painsNow) : '';
  const pains = painsNow && painsHash !== (await readReflectionState(node.id, nowMs)).painsNote ? painsNow : '';

  const found = dayLines(record.markdown, record.entries).length > 0;
  if (!found && !pains) return 'none';
  const text = withPains(found ? nightlyText(nodeName, file, record) : '', pains, nodeName);
  const ok = await send(node, text, `${nodeName}'s reflection: today's record`).catch(() => false);
  // Marked only once it went out: a failed send carries the same list again tomorrow.
  if (ok && pains) await updateReflectionState(node.id, (s) => { s.painsNote = painsHash; }, nowMs);
  return ok ? 'sent' : 'failed';
}
