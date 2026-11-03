/**
 * What the user hears about tasks Walnut kept out of a service: one line a day, to Main
 * (2026-11-02, from the user's 12-hour review: three decision letters in four hours, all unread,
 * though the safe choice was applied and nothing waited on him).
 *
 * A task the rules keep local is already safe: it stays in Walnut with all of its content, and its
 * Sync row (the task menu) sends it whenever the user wants. So nothing asks the user. Each kept
 * task is noted here (on disk, so a restart keeps it), and the day's notes ride Main's next
 * message as one line (never a wake): the first burst 90 s after it goes quiet, later ones at most
 * once every 24 hours. Main puts it in its Brief, in the user's language, when it matters.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';

export type TellKind = 'created' | 'edited' | 'unjudged' | 'edit-unjudged';

interface Entry { taskId: string; kind: TellKind; at: string }
interface DigestState { lastToldAt?: string; pending: Entry[] }

const FILE = () => path.join(WALNUT_HOME, 'private-tasks', 'kept-digest.json');
const DAY_MS = 24 * 3600_000;
/** A first burst is told once it has been quiet this long, and at most this long after its start. */
const QUIET_MS = 90_000;
const MAX_FIRST_WAIT_MS = 10 * 60_000;
/** A line Main could not take is tried again after this. */
const RETRY_MS = 3600_000;
/** Titles named in the line; the rest are counted. */
const MAX_NAMED = 8;

let state: DigestState | null = null;
let chain: Promise<unknown> = Promise.resolve();
let timer: NodeJS.Timeout | null = null;
/** Tests: who takes the line instead of Main (true = taken). */
let tellHook: ((line: string) => Promise<boolean>) | null = null;

async function load(): Promise<DigestState> {
  if (state) return state;
  try {
    const raw = JSON.parse(await fs.readFile(FILE(), 'utf8')) as DigestState;
    state = { ...(typeof raw?.lastToldAt === 'string' ? { lastToldAt: raw.lastToldAt } : {}), pending: Array.isArray(raw?.pending) ? raw.pending : [] };
  } catch {
    state = { pending: [] };
  }
  return state;
}

async function save(s: DigestState): Promise<void> {
  try {
    await fs.mkdir(path.dirname(FILE()), { recursive: true });
    const tmp = `${FILE()}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(s), 'utf8');
    await fs.rename(tmp, FILE());
  } catch (err) {
    log.task.warn('private tasks: the day\'s note was not saved', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** One at a time: notes and the day's line never interleave. */
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.catch(() => undefined);
  return next;
}

/** Note a task kept local for the day's line. Never throws. */
export function noteKeptLocal(taskId: string, kind: TellKind): Promise<void> {
  return serial(async () => {
    const s = await load();
    s.pending = [...s.pending.filter((e) => e.taskId !== taskId), { taskId, kind, at: new Date().toISOString() }];
    await save(s);
    schedule(s);
  }).catch((err) => log.task.warn('private tasks: not noted', { taskId, error: err instanceof Error ? err.message : String(err) }));
}

function schedule(s: DigestState): void {
  if (!s.pending.length) return;
  const now = Date.now();
  const last = Date.parse(s.lastToldAt ?? '');
  const told = Number.isFinite(last);
  // A day's line keeps its hour once set; the very first burst is told once it has been quiet,
  // and at most MAX_FIRST_WAIT_MS after its first note (a slow stream of edits never holds it).
  if (timer && told) return;
  if (timer) clearTimeout(timer);
  const first = Math.min(...s.pending.map((e) => Date.parse(e.at)).filter(Number.isFinite), now);
  const due = told ? Math.max(last + DAY_MS, now + QUIET_MS) : Math.min(now + QUIET_MS, first + MAX_FIRST_WAIT_MS);
  timer = setTimeout(() => { timer = null; void tellKeptDigestNow(); }, Math.max(0, due - now));
  timer.unref?.();
}

/** At boot: a day's notes a restart left wait for their hour. */
export async function resumeKeptDigest(): Promise<void> {
  await serial(async () => schedule(await load()));
}

/** Retry a line Main could not take yet (no Main, no session). */
function retryLater(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void tellKeptDigestNow(); }, RETRY_MS);
  timer.unref?.();
}

/**
 * Tell Main the line of every task noted since the last one, now (the timer, tests). The notes
 * are cleared only once the line rides Main's next message: with no Main to tell, they wait and
 * the line is tried again. Returns the line, or null when nothing is left to tell or Main could
 * not take it.
 */
export function tellKeptDigestNow(): Promise<string | null> {
  return serial(async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    const s = await load();
    if (!s.pending.length) return null;
    const tm = await import('../task-manager.js');
    const { serviceName } = await import('./sync-gate.js');
    const main = (await tm.listTasks()).find((t) => t.org_role === 'main' && t.phase !== 'COMPLETE');
    // Only what is still kept: a task released or decided meanwhile is not news, nor Main itself.
    const byService = new Map<string, string[]>();
    for (const e of s.pending) {
      const t = await tm.getTask(e.taskId).catch(() => null);
      const h = t?.sync_hold;
      if (!t || t.id === main?.id || t.source !== 'local' || !h || h.by === 'user' || (h.state !== 'private' && h.state !== 'unjudged')) continue;
      const service = await serviceName(h.target);
      const edited = e.kind === 'edited' || e.kind === 'edit-unjudged' || h.outside?.state === 'kept';
      const name = `"${t.title.replace(/\s+/g, ' ').slice(0, 80)}" (${t.id})${edited ? ', its copy there keeps the text from before the edit' : ''}`;
      byService.set(service, [...(byService.get(service) ?? []), name]);
    }
    if (!byService.size) {
      // Nothing left to say: the notes go, and the day is not used up.
      s.pending = [];
      await save(s);
      return null;
    }
    const since = new Date(Math.min(...s.pending.map((e) => Date.parse(e.at)).filter(Number.isFinite))).toISOString().slice(0, 16).replace('T', ' ');
    const parts = [...byService].map(([service, tasks]) => {
      const named = tasks.slice(0, MAX_NAMED).join('; ');
      const more = tasks.length > MAX_NAMED ? `; and ${tasks.length - MAX_NAMED} more` : '';
      return `${tasks.length} out of ${service} (${named}${more})`;
    });
    const line = `Since ${since} UTC Walnut kept ${parts.join(', and ')}: they failed that service's sync rules, so each stays a local task with all of its content. `
      + 'Nothing waits on the user: Sync in a task\'s menu sends it (or archives or neutralizes an old copy), and Settings > Tasks > Task providers holds the rules. Mention it in your Brief only if it matters to them.';
    if (!(tellHook ? await tellHook(line) : !!main && await tellMain(main.id, line))) {
      log.task.info('private tasks: the day\'s line waits for Main', { pending: s.pending.length });
      retryLater();
      return null;
    }
    s.pending = [];
    s.lastToldAt = new Date().toISOString();
    await save(s);
    log.task.info('private tasks: the day\'s line went to Main', { services: [...byService.keys()], count: [...byService.values()].reduce((n, l) => n + l.length, 0) });
    return line;
  });
}

/** One line riding Main's next message. True when Main took it (told now, or riding). */
async function tellMain(mainId: string, line: string): Promise<boolean> {
  try {
    // The org is off (org/org-enabled.ts): Main hears nothing; the notes wait for it to be on again.
    const { isOrgEnabled } = await import('../org/org-enabled.js');
    if (!(await isOrgEnabled())) return false;
    const { followerSession, tellOrRide } = await import('../sessions/status-push.js');
    const rec = await followerSession(mainId);
    if (!rec?.claudeSessionId) return false;
    // A key per line: a line still riding is never replaced by the next one.
    return (await tellOrRide(rec.claudeSessionId, `private-task-digest:${Date.now()}`, line)) !== 'none';
  } catch (err) {
    log.task.warn('private tasks: Main was not told', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Wait for every note being written (tests, settle). */
export async function settleKeptDigest(): Promise<void> {
  await chain;
}

/** Tests: forget the state in memory and any timer; `tell` takes the line instead of Main. */
export function resetKeptDigestForTest(tell: ((line: string) => Promise<boolean>) | null = null): void {
  state = null;
  tellHook = tell;
  if (timer) { clearTimeout(timer); timer = null; }
}

/** Tests: the ids waiting for the day's line. */
export async function pendingKeptForTest(): Promise<string[]> {
  await chain;
  return (await load()).pending.map((e) => e.taskId);
}
