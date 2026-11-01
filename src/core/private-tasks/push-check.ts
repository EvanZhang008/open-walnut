/**
 * The check on every push of new text to an outside service (2026-11-01, the user: "1) keyword
 * filter 2) ai post validate"): before a title, description, note, summary or conversation log
 * of a synced task leaves Walnut, the user's private words and the fast model read what is about
 * to be posted. sync-guard.ts calls it for every plugin method that carries text, so every push
 * path, today's and a future one, goes through it.
 *
 *   - Only new text is judged: each task keeps, per field, the hash of the last text that may go
 *     out (`approvals`, on disk, so a restart does not judge every task again): text the model
 *     judged work, text the user sent out themself, and text already outside (pulled from the
 *     service, or synced before this check existed, recorded once at the first start). A task
 *     released at birth was judged on the very text its first push carries.
 *   - A private word the user accepted for a task (they answered "Sync" on its letter) is not
 *     held against that task again.
 *   - The model judging the text private, or not answering, stops the push: the task turns local
 *     in its project (edit-stop.ts), with all of its content, and the user and Main are told.
 *   - No model to ask (the user turned the check off, or no model provider is set up): only the
 *     words are checked.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { compilePrivateWords, ruleMatches } from './private-words.js';
import { judgeTaskPrivacy, type PrivacyVerdict } from './privacy-judge.js';

/** The text fields a push carries, as they will be after it. */
export interface PushText {
  title: string;
  description?: string;
  note?: string;
  summary?: string;
}

type TextField = 'title' | 'description' | 'note' | 'summary';
const TEXT_FIELDS: readonly TextField[] = ['title', 'description', 'note', 'summary'];

interface Approval {
  /** Per field, the hash of the last text that may go out: judged work, sent by the user, or
   *  already outside (pulled from the service, or synced before this check existed). */
  fields?: Partial<Record<TextField, string>>;
  /** Hash of the last conversation log approved. */
  logKey?: string;
  by: 'user' | 'model' | 'outside';
  at: string;
  /** Private words the user accepted for this task. */
  words?: string[];
}

interface ApprovalFile {
  /** When the tasks already synced at the first start with this check were recorded as outside. */
  seededAt?: string;
  tasks: Record<string, Approval>;
}

const FILE = () => path.join(WALNUT_HOME, 'private-tasks', 'approved.json');
const MAX_ENTRIES = 20_000;

let approvals: Map<string, Approval> | null = null;
let seededAt: string | undefined;
let loading: Promise<Map<string, Approval>> | null = null;
let saveTimer: NodeJS.Timeout | null = null;
let saving: Promise<void> = Promise.resolve();

async function store(): Promise<Map<string, Approval>> {
  if (approvals) return approvals;
  loading ??= (async () => {
    const map = new Map<string, Approval>();
    try {
      const raw = JSON.parse(await fs.readFile(FILE(), 'utf8')) as ApprovalFile;
      if (typeof raw?.seededAt === 'string') seededAt = raw.seededAt;
      for (const [id, a] of Object.entries(raw?.tasks ?? {})) if (a && typeof a === 'object') map.set(id, a);
    } catch { /* none yet, or unreadable: judged again */ }
    approvals = map;
    return map;
  })();
  return loading;
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saving = saving.then(writeNow); }, 500);
  saveTimer.unref?.();
}

async function writeNow(): Promise<void> {
  const map = approvals;
  if (!map) return;
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value as string);
  try {
    await fs.mkdir(path.dirname(FILE()), { recursive: true });
    const tmp = `${FILE()}.${process.pid}.tmp`;
    const file: ApprovalFile = { ...(seededAt ? { seededAt } : {}), tasks: Object.fromEntries(map) };
    await fs.writeFile(tmp, JSON.stringify(file), 'utf8');
    await fs.rename(tmp, FILE());
  } catch (err) {
    log.task.warn('private tasks: approvals not saved', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Write pending approvals now (tests, shutdown). */
export async function flushApprovals(): Promise<void> {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; saving = saving.then(writeNow); }
  await saving;
}

/** Tests: forget what is in memory (the file is read again). */
export function resetApprovalsForTest(opts: { seeded?: boolean } = {}): void {
  approvals = null;
  seeding = null;
  seededAt = opts.seeded === false ? undefined : 'test';
  loading = null;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);
const fieldHashes = (t: Partial<PushText>): Partial<Record<TextField, string>> => {
  const out: Partial<Record<TextField, string>> = {};
  for (const f of TEXT_FIELDS) if (typeof t[f] === 'string') out[f] = hash(t[f]!);
  return out;
};

function record(map: Map<string, Approval>, taskId: string, patch: Partial<Approval> & Pick<Approval, 'by'>): void {
  const prev = map.get(taskId);
  map.delete(taskId); // re-insert: the newest are kept when the file is trimmed
  map.set(taskId, {
    ...prev,
    ...patch,
    fields: { ...prev?.fields, ...patch.fields },
    at: new Date().toISOString(),
    ...(prev?.words?.length || patch.words?.length ? { words: [...new Set([...(prev?.words ?? []), ...(patch.words ?? [])])] } : {}),
  });
  scheduleSave();
}

/**
 * Record that a task's text may go out: `model` after a work verdict on exactly this text,
 * `user` when the user sent it (their letter answer, the task menu), which also accepts every
 * private word the text matches now. Never throws.
 */
export async function approveTaskText(task: Pick<Task, 'id'> & Partial<PushText>, by: 'user' | 'model', words?: readonly string[]): Promise<void> {
  try {
    const accepted = by === 'user' ? acceptedEntries(words, [task.title, task.description, task.note, task.summary]) : [];
    record(await store(), task.id, { by, fields: fieldHashes({ title: task.title ?? '', description: task.description ?? '', note: task.note ?? '', summary: task.summary ?? '' }), words: accepted });
  } catch (err) {
    log.task.warn('private tasks: approval not recorded', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Text that is outside already (a pull wrote it from the service): pushing it back sends
 *  nothing new, so it is not judged. Only the fields given. Never throws. */
export async function approveOutsideText(taskId: string, fields: Partial<PushText>): Promise<void> {
  try {
    const hashes = fieldHashes(fields);
    if (Object.keys(hashes).length) record(await store(), taskId, { by: 'outside', fields: hashes });
  } catch (err) {
    log.task.warn('private tasks: approval not recorded', { taskId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** When this process started: a task last changed before it had its text pushed by the Walnut
 *  that ran then. */
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

let seeding: Promise<number> | null = null;

/**
 * Once, at the first push with this check: every task already synced and not changed since this
 * process started has its text outside (the Walnut before pushed it), so it is recorded as such;
 * only text changed after that is judged. Returns how many it recorded.
 */
export async function seedOutsideBaseline(
  tasks?: ReadonlyArray<Pick<Task, 'id' | 'source' | 'updated_at'> & Partial<PushText>>,
): Promise<number> {
  await store();
  if (seededAt) return 0;
  seeding ??= (async () => {
    const list = tasks ?? await (await import('../task-manager.js')).listTasks();
    const n = seedFrom(list);
    log.task.info('private tasks: recorded the text of tasks already synced', { count: n });
    return n;
  })().finally(() => { seeding = null; });
  return seeding;
}

function seedFrom(tasks: ReadonlyArray<Pick<Task, 'id' | 'source' | 'updated_at'> & Partial<PushText>>): number {
  const map = approvals!;
  if (seededAt) return 0;
  let n = 0;
  for (const t of tasks) {
    if (!t.source || t.source === 'local' || map.has(t.id)) continue;
    const at = Date.parse(t.updated_at ?? '');
    if (Number.isFinite(at) && at >= PROCESS_STARTED_AT) continue;
    record(map, t.id, { by: 'outside', fields: fieldHashes({ title: t.title ?? '', description: t.description ?? '', note: t.note ?? '', summary: t.summary ?? '' }) });
    n++;
  }
  seededAt = new Date().toISOString();
  scheduleSave();
  return n;
}

function acceptedEntries(words: readonly string[] | undefined, texts: ReadonlyArray<string | undefined>): string[] {
  const out: string[] = [];
  for (const rule of compilePrivateWords(words)) {
    if (texts.some((t) => t && ruleMatches(rule, t))) out.push(rule.entry);
  }
  return out;
}

/** The private words the user accepted for this task. */
export async function acceptedWords(taskId: string): Promise<readonly string[]> {
  return (await store()).get(taskId)?.words ?? [];
}

/** A neutralized copy's text (task-manager neutralTitle, and the emptied fields): nothing of the
 *  task, so nothing to judge. */
export function isNeutralText(text: string): boolean {
  return !text.trim() || /^\[Moved\] \(title removed\) \[open-walnut:[^\]]+\]$/.test(text);
}

export type PushVerdict = { ok: true } | { ok: false; state: 'private' | 'unjudged'; reason: string };

const judging = new Map<string, Promise<PushVerdict>>();
/** One retry of a model that did not answer, before the push is stopped. */
const MODEL_TRIES = 2;

/**
 * Judge the text a push carries, when any of it is new: a field whose text differs from the one
 * approved for the task (empty text is never new). `log` is a conversation log push (judged on its
 * own, by its last part). The same text pushed twice at once is judged once.
 */
export async function checkPushText(
  task: Pick<Task, 'id' | 'project'>, text: PushText, opts: { service?: string; log?: string } = {},
): Promise<PushVerdict> {
  const map = await store();
  if (!seededAt) await seedOutsideBaseline();
  const prev = map.get(task.id);
  const isLog = opts.log !== undefined;
  const hashes = fieldHashes(text);
  const changed = isLog
    ? prev?.logKey !== hash(opts.log!)
    : TEXT_FIELDS.some((f) => (text[f] ?? '').trim() && prev?.fields?.[f] !== hashes[f]);
  if (!changed) return { ok: true };
  const key = isLog ? `log:${hash(opts.log!)}` : JSON.stringify(hashes);
  const flight = `${task.id}:${key}`;
  const running = judging.get(flight);
  if (running) return running;
  const work = (async (): Promise<PushVerdict> => {
    let verdict: PrivacyVerdict | null = null;
    let failure = '';
    for (let attempt = 1; attempt <= MODEL_TRIES && !verdict; attempt++) {
      try {
        verdict = await judgeTaskPrivacy(isLog
          ? { title: text.title, description: opts.log!.slice(-3000), project: task.project, service: opts.service }
          : { ...text, project: task.project, service: opts.service });
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
    }
    if (!verdict) {
      log.task.warn('private tasks: the check on a push could not answer, the push was stopped', { taskId: task.id, error: failure });
      return { ok: false, state: 'unjudged', reason: `Walnut could not check whether the change is private (${failure.slice(0, 160)})` };
    }
    if (verdict.private) {
      log.task.info('private tasks: a push was judged private and stopped', { taskId: task.id, reason: verdict.reason });
      return { ok: false, state: 'private', reason: `Walnut judged it private: ${verdict.reason}` };
    }
    record(map, task.id, isLog ? { by: 'model', logKey: hash(opts.log!) } : { by: 'model', fields: hashes });
    return { ok: true };
  })().finally(() => judging.delete(flight));
  judging.set(flight, work);
  return work;
}

/** Wait for every running push check (tests). */
export async function settlePushChecks(): Promise<void> {
  while (judging.size) await Promise.allSettled([...judging.values()]);
}
