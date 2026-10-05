/**
 * Parking a task for a session, and the receipt the user gets for it.
 *
 * A task a session parks (WAITING) leaves the user's default task list, so the
 * user has to hear where it went. Every park a session makes sends ONE inbox
 * letter: what is being watched, when the task comes back by itself, and how to
 * take it back now (2026-10-04: "everything put in wait needs a report in the
 * inbox that says clearly: I put this in wait"). The session may write the
 * opening itself (`wait_report`); the facts under it are always stamped here, so
 * a receipt never depends on the model remembering them.
 *
 * Only a SESSION's park gets a receipt. A human who parks a task did it with their
 * own hands and needs no letter about it.
 */

import { log } from '../logging/index.js';

/** The longest opening a session may write into a receipt: one phone screen, generously. */
export const WAIT_REPORT_MAX = 4000;

const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * A wait clock from a caller: an ISO datetime, or a duration from now ("90m",
 * "6h", "3d"). `""` = no clock. `undefined` = the caller named none (the store
 * then applies the default). Throws on anything else, and on a time not in the
 * future, so a bad clock is refused before anything is written.
 */
export function parseWaitUntil(raw: unknown, nowMs: number = Date.now()): string | '' | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new Error('wait_until must be an ISO datetime or a duration like "6h" / "3d"');
  }
  const text = typeof raw === 'string' ? raw.trim() : String(raw);
  if (text === '') return '';
  // A bare number (ms) or a number with a unit is a duration; anything else must be a date.
  const duration = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(text);
  const atMs = duration
    ? nowMs + Math.floor(Number(duration[1]) * UNIT_MS[(duration[2] ?? 'ms').toLowerCase()])
    : Date.parse(text);
  if (!Number.isFinite(atMs)) {
    throw new Error(`wait_until "${text}" is neither an ISO datetime nor a duration like "6h" / "3d"`);
  }
  if (atMs <= nowMs) {
    throw new Error(`wait_until "${text}" is not in the future`);
  }
  return new Date(atMs).toISOString();
}

/** A wait_report from a caller: trimmed text, or undefined. Throws when it is not text or too long. */
export function parseWaitReport(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new Error('wait_report must be text (markdown)');
  const text = raw.trim();
  if (!text) return undefined;
  if (text.length > WAIT_REPORT_MAX) {
    throw new Error(`wait_report is ${text.length} characters; keep it to one phone screen (at most ${WAIT_REPORT_MAX})`);
  }
  return text;
}

/** One armed trigger as the receipt names it. */
export interface ReceiptTrigger {
  description?: string;
  name?: string;
  everyMs?: number;
  host?: string;
}

/** "Wed, Oct 7, 1:57 PM" in the server's time zone (the user's Mac). */
export function receiptTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function everyText(ms: number | undefined): string {
  if (!ms || ms <= 0) return '';
  if (ms % 86_400_000 === 0) return `every ${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `every ${ms / 60_000} min`;
  return `every ${Math.round(ms / 1000)}s`;
}

function hostText(host: string | undefined): string {
  return host && host !== '__local__' ? ` on ${host}` : '';
}

/**
 * The receipt letter, as pure data (unit-tested). The session's own words lead;
 * the facts follow in a fixed shape, so every receipt answers the same three
 * questions: what am I waiting on, when does it come back, how do I take it back.
 */
export function composeWaitReceipt(input: {
  title: string;
  waitUntil?: string;
  report?: string;
  triggers: ReceiptTrigger[];
}): { subject: string; markdown: string; text: string } {
  const watched = input.triggers.map((t) => {
    const what = (t.description || t.name || 'A trigger').replace(/\s+/g, ' ').trim();
    const how = [everyText(t.everyMs), hostText(t.host).trim()].filter(Boolean).join(' ');
    return `- ${what}${how ? ` (${how})` : ''}`;
  });
  const back = input.waitUntil
    ? `**Back by:** ${receiptTime(input.waitUntil)} at the latest, even if nothing happens.`
    : '**Back by:** no time limit. Only a trigger firing or your message brings it back.';
  const facts = [
    'This task is parked: it is off your task list until something happens. Nothing is needed from you.',
    '',
    watched.length > 0 ? '**Watching:**' : '**Watching:** nothing; only the clock brings it back.',
    ...watched,
    '',
    back,
    '**To take it back now:** send a message in its session.',
  ].join('\n');
  const markdown = input.report ? `${input.report}\n\n---\n\n${facts}` : facts;
  const firstLine = (input.report ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  const text = firstLine
    ?? (input.waitUntil ? `Parked until ${receiptTime(input.waitUntil)} at the latest.` : 'Parked until something happens.');
  return { subject: `Waiting: ${input.title}`.slice(0, 200), markdown, text: text.slice(0, 280) };
}

/** True when the caller sid names a session Walnut knows (a human's call carries none). */
export async function isSessionCaller(callerSid: string | undefined): Promise<boolean> {
  const sid = (callerSid ?? '').trim();
  if (!sid) return false;
  const { getSessionByClaudeId } = await import('./session-tracker.js');
  return !!(await getSessionByClaudeId(sid).catch(() => null));
}

/** The enabled triggers that deliver into a task, as the receipt names them. */
async function triggersFor(taskId: string): Promise<ReceiptTrigger[]> {
  const { listRoutines } = await import('./routines/routines-core.js');
  const { jobs } = await listRoutines(false);
  return (jobs as Array<{
    enabled?: boolean; name?: string; description?: string; schedule?: { everyMs?: number }
    check?: { host?: string }; executor?: { type?: string; config?: { target?: unknown } }
  }>)
    .filter((j) => j.enabled !== false && j.check && j.executor?.type === 'session' && j.executor.config?.target === taskId)
    .map((j) => ({
      ...(j.description ? { description: j.description } : {}),
      ...(j.name ? { name: j.name } : {}),
      ...(typeof j.schedule?.everyMs === 'number' ? { everyMs: j.schedule.everyMs } : {}),
      ...(j.check?.host ? { host: j.check.host } : {}),
    }));
}

/**
 * Send the receipt for a park a session made. Never throws: the park itself
 * already happened, so a letter that cannot be written is reported back to the
 * caller (who can tell the user in its reply) instead of failing the call.
 */
export async function sendWaitReceipt(opts: {
  taskId: string;
  callerSid: string | undefined;
  report?: string;
}): Promise<{ letterId?: string; error?: string }> {
  try {
    const { getTask } = await import('./task-manager.js');
    const task = await getTask(opts.taskId);
    const triggers = await triggersFor(task.id).catch(() => []);
    const letter = composeWaitReceipt({
      title: task.title,
      ...(task.wait_until ? { waitUntil: task.wait_until } : {}),
      ...(opts.report ? { report: opts.report } : {}),
      triggers,
    });
    const { sendLetterAsCaller } = await import('./human-inbox/letter-ops.js');
    const sent = await sendLetterAsCaller({
      subject: letter.subject, type: 'info', markdown: letter.markdown, text: letter.text, task_refs: [task.id],
    }, opts.callerSid);
    log.task.info('wait receipt sent', { taskId: task.id, letterId: sent.id, triggers: triggers.length, report: !!opts.report });
    return { letterId: sent.id };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.task.warn('wait receipt could not be sent', { taskId: opts.taskId, error });
    return { error };
  }
}
