/**
 * The report the user asks Main or a lead for ("give me a report tomorrow morning", 2026-10-31):
 * what needs him, with the one-tap way to answer each, what finished and what moved since a time,
 * and the node's own Brief. Built from Walnut's record (user_status, phases, the inbox), so it
 * needs no turn of the node's session and is never stale at the hour it goes out.
 *
 * `org_report` (src/ops/org.ts, POST /api/v1/org/report) shows it now, sends it now, or schedules
 * it (`at`). A scheduled report is kept on disk (`org/report-schedule.json`) and sent by the
 * primary's minute clock as the node's letter. It starts the node's away thread when the user is
 * away (human-inbox/away-thread.ts), so the updates after it join it.
 */
import path from 'node:path';
import { IS_EPHEMERAL, WALNUT_HOME } from '../../constants.js';
import { readJsonFile, updateJsonFile } from '../../utils/fs.js';
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import type { LetterRecord } from '../human-inbox/types.js';
import { briefTeam } from '../user-status.js';
import { ORG_REPORT } from '../human-inbox/walnut-letters/org-report.js';
import type { LetterLang } from '../human-inbox/walnut-letters/languages.js';
import { briefSectionOf } from '../sessions/brief-structure.js';

const SCHEDULE_FILE = path.join(WALNUT_HOME, 'org', 'report-schedule.json');
/** A report the clock could not send this long after its time is dropped, with a log line. */
const LATE_DROP_MS = 12 * 60 * 60_000;
const LIST_MAX = 20;

export interface MorningReport { subject: string; markdown: string; text: string; taskRefs: string[]; counts: { needs: number; done: number; moved: number } }

const flat = (v: string, max = 240): string => {
  const s = v.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const atOf = (t: Pick<Task, 'phase_changed_at' | 'completed_at'>): number => {
  const v = Date.parse(t.completed_at ?? t.phase_changed_at ?? '');
  return Number.isFinite(v) ? v : 0;
};
/** A time as the report says it: the server's own clock (the one `at: "08:00"` reads), with its offset. */
export function reportTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const zone = off === 0 ? 'UTC' : `UTC${off > 0 ? '+' : '-'}${Math.floor(Math.abs(off) / 60)}${Math.abs(off) % 60 ? `:${p(Math.abs(off) % 60)}` : ''}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${zone}`;
}
const hhmm = reportTime;

/** Pure: the report for `owner` (Main: the whole org; a lead: its team), since `since`. */
export function buildMorningReport(owner: Task, tasks: readonly Task[], letters: readonly LetterRecord[], since: number, now = Date.now(), lang: LetterLang = 'en'): MorningReport {
  const scope = owner.org_role === 'main' ? tasks.filter((t) => !t.plugin_only && t.id !== owner.id) : briefTeam(owner, tasks);
  const decisions = letters.filter((l) => l.type === 'action_required' && !l.answered && !l.archived && !l.settled);
  const refs = new Set<string>();
  const needs = scope.filter((t) => briefSectionOf(t) === 'needs').sort((a, b) => atOf(b) - atOf(a));
  const done = scope.filter((t) => t.phase === 'COMPLETE' && atOf(t) >= since).sort((a, b) => atOf(b) - atOf(a));
  const moved = scope.filter((t) => t.phase !== 'COMPLETE' && atOf(t) >= since && briefSectionOf(t) !== 'needs').sort((a, b) => atOf(b) - atOf(a));
  const shown = <T>(rows: readonly T[]): readonly T[] => rows.slice(0, LIST_MAX);
  for (const t of [...shown(needs), ...shown(done), ...shown(moved)]) refs.add(t.id);
  const orphan = decisions.filter((l) => !needs.some((t) => l.sender.taskId === t.id || l.taskRefs?.includes(t.id))
    && (owner.org_role === 'main' || (!!l.sender.taskId && scope.some((t) => t.id === l.sender.taskId)) || l.sender.taskId === owner.id));
  // The words are the letter registry's (human-inbox/walnut-letters/org-report.ts); the rows are the tasks' own.
  const report = ORG_REPORT.render(lang, {
    owner: owner.org_role === 'main' ? null : flat(owner.title, 60),
    since: hhmm(since),
    listMax: LIST_MAX,
    needsPreview: needs.map((t) => flat(t.title, 60)),
    needs: needs.map((t) => {
      const s = t.user_status;
      const letter = decisions.find((l) => l.sender.taskId === t.id || l.taskRefs?.includes(t.id));
      const form = s?.askForm;
      return {
        title: flat(t.title, 120),
        ...(s?.ask ? { ask: flat(form?.summary ?? s.ask) } : {}),
        ...(s?.checkedAt ? { checked: hhmm(Date.parse(s.checkedAt)), unverified: !!s.unverified } : {}),
        ...(form?.kind === 'yes_no' ? { yesNo: true } : form?.options?.length ? { options: form.options.map((o) => o.label) } : {}),
        ...(letter ? { letter: flat(letter.subject, 120) } : {}),
      };
    }),
    decisions: orphan.map((l) => ({ subject: flat(l.subject, 160), ...(l.sender.taskTitle ? { from: flat(l.sender.taskTitle, 80) } : {}) })),
    done: done.map((t) => ({ title: flat(t.title, 120), ...(t.result_report?.result ? { result: flat(t.result_report.result) } : {}) })),
    moved: moved.map((t) => {
      const s = t.user_status;
      // A snoozed task (snooze.ts) is listed as such: the report never asks about it before its date.
      return {
        title: flat(t.title, 120),
        ...(s?.snoozed ? { snoozedUntil: hhmm(Date.parse(s.snoozed.until)) }
          : s?.state === 'waiting' ? (s.waitingOn ? { waitingOn: flat(s.waitingOn, 160) } : { waiting: true })
            : s?.now ? { now: flat(s.now, 160) } : {}),
      };
    }),
    ...(owner.brief?.text?.trim() ? { brief: { text: owner.brief.text.trim(), ...(owner.brief.at ? { at: hhmm(Date.parse(owner.brief.at)) } : {}) } } : {}),
  });
  const counts = { needs: needs.length, done: done.length, moved: moved.length };
  void now;
  return { subject: report.subject, markdown: report.markdown, text: report.text ?? '', taskRefs: [...refs].slice(0, 30), counts };
}

/** "08:00" (the next time the server's clock reads it), an ISO time, or a duration ("8h"). */
export function parseReportAt(raw: string, now = Date.now()): number {
  const text = raw.trim();
  const hm = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (hm) {
    const d = new Date(now);
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (Number(hm[1]) > 23 || Number(hm[2]) > 59) throw new Error(`at "${text}" is not a time of day`);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const duration = /^(\d+(?:\.\d+)?)\s*(m|h|d)$/i.exec(text);
  const at = duration ? now + Number(duration[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[duration[2]!.toLowerCase() as 'm' | 'h' | 'd'] : Date.parse(text);
  if (!Number.isFinite(at)) throw new Error(`at "${text}" is not "HH:MM", an ISO time or a duration like "8h"`);
  if (at <= now) throw new Error(`at "${text}" is not in the future`);
  return at;
}

export interface ReportSchedule { taskId: string; at: number; since: number; by?: string }
interface ScheduleFile { schedules: ReportSchedule[] }

export async function scheduledReports(): Promise<ReportSchedule[]> {
  return (await readJsonFile<ScheduleFile>(SCHEDULE_FILE, { schedules: [] })).schedules ?? [];
}

/** One report per node: a new time replaces the one it had. */
export async function scheduleReport(s: ReportSchedule): Promise<void> {
  await updateJsonFile<ScheduleFile>(SCHEDULE_FILE, { schedules: [] }, (f) => ({
    schedules: [...(f.schedules ?? []).filter((x) => x.taskId !== s.taskId), s],
  }));
}

async function dropSchedule(taskId: string, at: number): Promise<void> {
  await updateJsonFile<ScheduleFile>(SCHEDULE_FILE, { schedules: [] }, (f) => ({
    schedules: (f.schedules ?? []).filter((x) => !(x.taskId === taskId && x.at === at)),
  }));
}

/** Build the node's report and send it as its letter. */
export async function sendReport(task: Task, since: number, now = Date.now()): Promise<LetterRecord> {
  const { listTasks } = await import('../task-manager.js');
  const { listLetters, sendLetterOnce } = await import('../human-inbox/store.js');
  const { walnutLetterLanguage } = await import('../human-inbox/walnut-letters/languages.js');
  const report = buildMorningReport(task, await listTasks(), (await listLetters()).letters, since, now, await walnutLetterLanguage());
  const { getSessionsForTask } = await import('../session-tracker.js');
  const sid = (await getSessionsForTask(task.id).catch(() => []))
    .sort((a, b) => Date.parse(b.lastActiveAt ?? '') - Date.parse(a.lastActiveAt ?? ''))[0]?.claudeSessionId;
  const { resolveLetterSender } = await import('../human-inbox/letter-ops.js');
  const sender = sid ? await resolveLetterSender(sid) : { sessionId: 'external', host: 'local', taskId: task.id, taskTitle: task.title };
  const { userAwayFrom } = await import('./user-away.js');
  const away = await userAwayFrom(task, now);
  const { letter } = await sendLetterOnce(
    { subject: report.subject, type: 'info', markdown: report.markdown, text: report.text, task_refs: report.taskRefs, sender },
    // The report opens the absence's thread: the node's later updates join it.
    away?.away ? { awayThread: { taskId: task.id, since: away.lastSeenAt } } : {},
  );
  log.notif.info('org report sent', { taskId: task.id, letterId: letter.id, ...report.counts });
  return letter;
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/** Primary only: send each scheduled report when its time comes. Never on an ephemeral copy. */
export function startReportClock(everyMs = 60_000): void {
  if (timer || IS_EPHEMERAL) return;
  timer = setInterval(() => { void tickReports(); }, everyMs);
  timer.unref?.();
}

export function stopReportClock(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * Send the reports that are due. One tick at a time (a slow send must not let the next minute send it
 * again), and a report is taken off the schedule before it is sent, put back when the send fails: a
 * crash between the two loses a report rather than sending it twice.
 */
export async function tickReports(now = Date.now()): Promise<number> {
  if (ticking) return 0;
  ticking = true;
  let sent = 0;
  try {
    for (const s of await scheduledReports().catch(() => [])) {
      if (s.at > now) continue;
      await dropSchedule(s.taskId, s.at);
      if (now - s.at > LATE_DROP_MS) {
        log.notif.warn('org report dropped: its time passed long ago', { taskId: s.taskId, at: new Date(s.at).toISOString() });
        continue;
      }
      try {
        const { listTasksByIds } = await import('../task-manager.js');
        const [task] = await listTasksByIds([s.taskId]);
        if (!task || (task.org_role !== 'main' && task.org_role !== 'lead')) continue;
        await sendReport(task, s.since, now);
        sent++;
      } catch (err) {
        log.notif.warn('org report not sent, kept for the next minute', { taskId: s.taskId, error: err instanceof Error ? err.message : String(err) });
        // Put back unless a newer time replaced it meanwhile.
        await updateJsonFile<ScheduleFile>(SCHEDULE_FILE, { schedules: [] }, (f) => (
          (f.schedules ?? []).some((x) => x.taskId === s.taskId) ? undefined : { schedules: [...(f.schedules ?? []), s] }
        )).catch(() => {});
      }
    }
  } finally {
    ticking = false;
  }
  return sent;
}
