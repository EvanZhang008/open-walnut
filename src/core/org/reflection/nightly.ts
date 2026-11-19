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
import { reflectionDayFileOf } from './records.js';
import { localDate, readReflectionState, updateReflectionState } from './state.js';

/** Minutes after local midnight: before the VPs' 20:00 reflection routines. */
export const NIGHTLY_AT_MIN = 19 * 60 + 45;
const SUMMARY_MAX = 1500;

export type NightlySend = (node: Task, text: string, title: string) => Promise<boolean>;

/** The note for one day's record: its findings, one line each, and where the whole record is. Pure. */
export function nightlyText(nodeName: string, file: string, record: string): string {
  const lines: string[] = [];
  let title = '';
  for (const raw of record.split('\n')) {
    if (raw.startsWith('## ')) title = raw.slice(3).trim();
    else if (raw.startsWith('- What went wrong: ') && title) { lines.push(`- ${title}: ${raw.slice(19).trim()}`); title = ''; }
  }
  let body = '';
  for (const [i, l] of lines.entries()) {
    if (body.length + l.length > SUMMARY_MAX) { body += `- ... ${lines.length - i} more in the record\n`; break; }
    body += `${l}\n`;
  }
  return [
    `${nodeName}'s reflection today found ${lines.length} decision${lines.length === 1 ? '' : 's'} to fix in your team's sessions. `
      + `The whole record (what each session said, the correction it got, the guidance line added): ${file}`,
    '',
    body.trimEnd(),
    '',
    'Read it in tonight\'s reflection. Keep in your MEMORY.md or instructions what is yours to keep; the team guidance already holds the lines for your team. No reply is needed.',
  ].join('\n');
}

/** Send today's record to the node once, after NIGHTLY_AT_MIN. Answers what it did. */
export async function nightlyNote(node: Task, nodeName: string, nowMs: number, send: NightlySend): Promise<'sent' | 'early' | 'done' | 'none' | 'failed'> {
  const d = new Date(nowMs);
  if (d.getHours() * 60 + d.getMinutes() < NIGHTLY_AT_MIN) return 'early';
  const date = localDate(nowMs);
  if ((await readReflectionState(node.id, nowMs)).nightly === date) return 'done';
  const file = reflectionDayFileOf(node.id, date);
  const record = await fsp.readFile(file, 'utf-8').catch(() => '');
  // Marked first: a send that fails is not sent again tonight (the record stays for tomorrow's reading).
  await updateReflectionState(node.id, (s) => { s.nightly = date; }, nowMs);
  if (!record.trim()) return 'none';
  const ok = await send(node, nightlyText(nodeName, file, record), `${nodeName}'s reflection: today's record`).catch(() => false);
  return ok ? 'sent' : 'failed';
}
