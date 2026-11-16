/**
 * task_send's scope check: a session's message that hands an OPEN task work it does not hold is
 * refused (409 scope_mismatch) until the sender either makes a new task or says why it is the
 * target's own deliverable (`same_deliverable`).
 *
 * Why (2026-11-16, a VP's own review): a lead handed a regional outage's half-done fix, written
 * by another task, to an open task whose deliverable was an earlier code review, because both
 * edited the same package and file. The routing contract already said "decide by deliverable,
 * not shared files"; the lead never read the target's deliverable. So the server reads it:
 *
 *   send ──► refs the message names (code reviews, tickets and incidents by number, another
 *   task's files) ──► each held by the target? (its title, description, tags, links, note,
 *   status, the requests it was sent before, its own family of tasks)
 *        all held ──► delivered as before
 *        some not ──► 409 scope_mismatch {refs, deliverable}; nothing sent
 *   again with same_deliverable:"<why>" ──► delivered, led by one line naming the refs and the why
 *
 * Who meets it: a session's task_send (the route sets `checkScope`) to another open task that is
 * not an org node and not above the sender in the org. Never: the person, scripts, Walnut's own
 * sends, replies (in_reply_to), answers for the user (answers_ask), a COMPLETE target (force has
 * its own check), notes up the org. A ref the SENDER's own task holds is about the sender's own
 * work (a dependency note between two owners) and passes, unless the sender is a lead or Main,
 * whose notes hold every team's numbers.
 *
 * Fails open: past SCOPE_CHECK_DEADLINE_MS or on any error the message goes as before, logged.
 */
import { log } from '../../logging/index.js';
import { deliverableLine } from '../task-deliverable.js';
import type { Task } from '../types.js';

export const SCOPE_MISMATCH_CODE = 'scope_mismatch' as const;
export const SCOPE_CHECK_DEADLINE_MS = 400;
/** A same_deliverable reason long enough to say something. */
export const SAME_DELIVERABLE_MIN = 10;
/** Refs listed in a refusal; the rest are counted. */
const REFS_SHOWN = 8;

export type ScopeRefKind = 'review' | 'ticket' | 'task_files';

export interface ScopeRef {
  kind: ScopeRefKind;
  /** As the message wrote it, normalized (CR-123, ABC-42, a task id). */
  ref: string;
  /** Its number alone when it has one of 5 digits or more: matched in the target as a whole number. */
  digits?: string;
}

/** Hyphenated words that look like issue keys and are not: standards, hashes, encodings, models. */
const NOT_A_KEY = new Set([
  'UTF', 'ISO', 'SHA', 'AES', 'RFC', 'HTTP', 'HTTPS', 'TLS', 'SSL', 'RSA', 'GPT', 'MD', 'CRC', 'IEEE', 'ECMA',
  'ES', 'WCAG', 'ARM', 'AL', 'IPV', 'TCP', 'UDP', 'DDR', 'PCI', 'USB', 'HDMI', 'BASE', 'CP', 'WIN', 'UTC', 'GMT',
]);

const REVIEW_RE = /\b(CR|PR|MR)[-\s]?#?(\d{3,})\b/gi;
const PULL_URL_RE = /\/pull\/(\d{2,})\b/g;
const KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{2,})\b/g;
const TICKET_WORD_RE = /\b(?:ticket|incident|issue|case|sev[\d.]*|lse|coe|tt)\s*(?:#|no\.?|id|number)?\s*[:#]?\s*([A-Za-z]?\d{5,})\b/gi;
const TICKET_WORD_ZH_RE = /(?:\u5de5\u5355|\u4e8b\u6545|\u4e8b\u4ef6|\u95ee\u9898\u5355|\u5355\u53f7)\s*(?:\u53f7)?\s*[:\uff1a#]?\s*([A-Za-z]?\d{5,})/g;
/** A path into a Walnut task's own directory (`.../tasks/<task id>/...`): that task's work. */
const TASK_DIR_RE = /\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|m[a-z0-9]{6,8}-[a-z0-9]{4})(?=\/|\s|$|[),.;:'"`])/g;

const digitsOf = (s: string): string | undefined => {
  const d = s.replace(/\D/g, '');
  return d.length >= 5 ? d : undefined;
};

/** Every code review, ticket, incident and other task's files a message names, once each. */
export function extractScopeRefs(text: string): ScopeRef[] {
  const out = new Map<string, ScopeRef>();
  const add = (r: ScopeRef) => { const k = `${r.kind}:${r.ref.toUpperCase()}`; if (!out.has(k)) out.set(k, r); };
  for (const m of text.matchAll(REVIEW_RE)) add({ kind: 'review', ref: `${m[1].toUpperCase()}-${m[2]}`, digits: digitsOf(m[2]) });
  for (const m of text.matchAll(PULL_URL_RE)) add({ kind: 'review', ref: `PR-${m[1]}`, digits: digitsOf(m[1]) });
  for (const m of text.matchAll(KEY_RE)) {
    const prefix = m[1];
    if (/^(CR|PR|MR)$/.test(prefix) || NOT_A_KEY.has(prefix)) continue;
    add({ kind: 'ticket', ref: `${prefix}-${m[2]}`, digits: digitsOf(m[2]) });
  }
  for (const re of [TICKET_WORD_RE, TICKET_WORD_ZH_RE]) {
    for (const m of text.matchAll(re)) add({ kind: 'ticket', ref: m[1].toUpperCase(), digits: digitsOf(m[1]) });
  }
  for (const m of text.matchAll(TASK_DIR_RE)) add({ kind: 'task_files', ref: m[1] });
  return [...out.values()];
}

/** The words a task holds about its own work: what a ref is looked for in. */
export function heldText(task: Partial<Task>, priorAsks: readonly string[] = []): string {
  const status = task.status_report as unknown;
  const parts: unknown[] = [
    task.title, task.description, task.summary, task.note,
    ...(task.tags ?? []), ...(task.auto_links ?? []), ...Object.values(task.link_names ?? {}),
    status ? JSON.stringify(status) : '', ...priorAsks,
  ];
  return parts.filter((p): p is string => typeof p === 'string' && !!p).join('\n');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does `text` hold this ref: its key (any case), or its number as a whole number? */
export function holdsRef(text: string, ref: ScopeRef): boolean {
  if (!text) return false;
  if (new RegExp(`(?<![A-Za-z0-9])${escapeRe(ref.ref)}(?![0-9])`, 'i').test(text)) return true;
  if (ref.kind === 'task_files') return text.toLowerCase().includes(ref.ref.slice(0, 8).toLowerCase());
  return !!ref.digits && new RegExp(`(?<!\\d)${ref.digits}(?!\\d)`).test(text);
}

export function describeRef(r: ScopeRef, title?: string): string {
  if (r.kind === 'task_files') return `files of task ${r.ref}${title ? ` ("${title}")` : ''}`;
  return r.ref;
}

export type ScopeVerdict =
  | { kind: 'pass'; skipped?: 'timeout' | 'error' }
  | { kind: 'refuse'; status: 400 | 409; code: 'bad_request' | typeof SCOPE_MISMATCH_CODE; message: string; detail: Record<string, unknown> }
  | { kind: 'lead'; line: string };

export interface ScopeCheckInput {
  /** The sender's own task, when its session has one. */
  callerTaskId?: string;
  targetTaskId: string;
  /** The message as sent: its title and text. */
  text: string;
  sameDeliverable?: string;
}

type TaskLookup = (id: string) => Promise<Task | undefined>;

interface ScopeDeps {
  getTask: TaskLookup;
  /** Previews of earlier requests sent to this task (what it was already given). */
  priorAsks: (taskId: string) => Promise<string[]>;
  goesUp: (from: string | undefined, to: string) => Promise<boolean>;
}

async function defaultDeps(): Promise<ScopeDeps> {
  const { getTask } = await import('../task-manager.js');
  return {
    getTask: (id) => getTask(id).catch(() => undefined),
    priorAsks: async (taskId) => {
      const { listAllSessionRequests } = await import('../session-requests.js');
      return (await listAllSessionRequests()).filter((r) => r.toTaskId === taskId).map((r) => r.preview ?? '');
    },
    goesUp: async (from, to) => (await import('./reply-direction.js')).goesUp(from, to),
  };
}

let injectedDeps: ScopeDeps | null = null;
/** Tests only: replace the store reads. */
export function _injectScopeDepsForTesting(deps: ScopeDeps | null): void { injectedDeps = deps; }

const isOrgNode = (t: Pick<Task, 'org_role'> | undefined) => t?.org_role === 'main' || t?.org_role === 'lead';

/** The ids of `start` and every task above it (a cycle in bad data stops at the first repeat). */
async function lineage(start: Task | undefined, get: TaskLookup): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let t = start; t && !ids.has(t.id) && ids.size < 10; t = t.parent_task_id ? await get(t.parent_task_id) : undefined) ids.add(t.id);
  return ids;
}

async function judge(input: ScopeCheckInput, deps: ScopeDeps): Promise<ScopeVerdict> {
  const refs = extractScopeRefs(input.text);
  if (!refs.length) return { kind: 'pass' };
  const target = await deps.getTask(input.targetTaskId);
  if (!target || target.phase === 'COMPLETE' || isOrgNode(target)) return { kind: 'pass' };
  if (input.callerTaskId === target.id) return { kind: 'pass' };
  if (await deps.goesUp(input.callerTaskId, target.id)) return { kind: 'pass' };
  const caller = input.callerTaskId ? await deps.getTask(input.callerTaskId) : undefined;
  const held = heldText(target, await deps.priorAsks(target.id));
  // A worker's own refs are its own work (a dependency note between owners); a lead's hold every team's.
  const callerHeld = caller && !isOrgNode(caller) ? heldText(caller) : '';
  const targetLine = await lineage(target, deps.getTask);
  const titles = new Map<string, string>();
  const foreign: ScopeRef[] = [];
  for (const ref of refs) {
    if (holdsRef(held, ref)) continue;
    if (ref.kind === 'task_files') {
      const owner = await deps.getTask(ref.ref);
      if (!owner) continue; // not a task of this Walnut: a path, nothing more
      if (owner.id === caller?.id || isOrgNode(owner)) continue;
      // The target's own family: itself, a task above it, or one of its subtasks.
      if (targetLine.has(owner.id) || (await lineage(owner, deps.getTask)).has(target.id)) continue;
      titles.set(ref.ref, owner.title);
    } else if (callerHeld && holdsRef(callerHeld, ref)) {
      continue;
    }
    foreign.push(ref);
  }
  if (!foreign.length) return { kind: 'pass' };
  const named = foreign.slice(0, REFS_SHOWN).map((r) => describeRef(r, titles.get(r.ref)));
  const more = foreign.length > REFS_SHOWN ? ` and ${foreign.length - REFS_SHOWN} more` : '';
  const why = (input.sameDeliverable ?? '').replace(/\s+/g, ' ').trim();
  if (input.sameDeliverable !== undefined) {
    if (why.length < SAME_DELIVERABLE_MIN) {
      return { kind: 'refuse', status: 400, code: 'bad_request',
        message: `same_deliverable needs a reason (at least ${SAME_DELIVERABLE_MIN} characters): why ${named.join(', ')} belong to "${target.title}"'s own deliverable.`,
        detail: {} };
    }
    return { kind: 'lead',
      line: `The sender says this is your own deliverable ("${why.slice(0, 300)}"), though it names ${named.join(', ')}${more}, which your task did not hold yet. If it is not, tell the sender it belongs in a task of its own.` };
  }
  const deliverable = deliverableLine(target);
  return {
    kind: 'refuse', status: 409, code: SCOPE_MISMATCH_CODE,
    message: `Not sent: this message names ${named.join(', ')}${more}, which "${target.title}" (${target.id}) does not hold. `
      + `Its deliverable: "${deliverable}". The same package, component or file is not the same deliverable: the fix for another `
      + 'incident, ticket or code review is new work, so task_create it (two owners whose changes depend on each other coordinate with '
      + 'task_send). If it really is this task\'s own deliverable (its own revision, a follow-up of its request), send it again with '
      + 'same_deliverable:"<why>".',
    detail: { taskId: target.id, deliverable, refs: foreign.map((r) => ({ kind: r.kind, ref: r.ref, ...(titles.has(r.ref) ? { title: titles.get(r.ref) } : {}) })) },
  };
}

/** Judge one send; never throws, and passes when the check cannot finish in time. */
export async function checkSendScope(input: ScopeCheckInput): Promise<ScopeVerdict> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<ScopeVerdict>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'pass', skipped: 'timeout' }), SCOPE_CHECK_DEADLINE_MS);
    timer.unref?.();
  });
  try {
    const deps = injectedDeps ?? await defaultDeps();
    const verdict = await Promise.race([judge(input, deps), late]);
    if (verdict.kind === 'pass' && verdict.skipped) {
      log.session.warn('send scope check skipped', { targetTaskId: input.targetTaskId, reason: verdict.skipped });
    }
    return verdict;
  } catch (err) {
    log.session.warn('send scope check skipped', {
      targetTaskId: input.targetTaskId, reason: 'error', error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'pass', skipped: 'error' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
