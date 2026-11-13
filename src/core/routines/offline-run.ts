/**
 * A task-targeted routine's run started on an always-on host while the Mac is away
 * (2026-11-13: the four VP reflections at 20:00 Pacific and Main's at 21:00 came due
 * while the Mac slept, and none of them ran).
 *
 * Such a routine (`session` into its target task, `main-agent` into Main) normally
 * delivers into its owner's conversation, on the Mac. While the Mac is away the
 * owner's conversation cannot take a turn, and starting it on another host would make
 * a second copy of it. So the host's daemon starts a fresh routine-run task instead,
 * through the clock start it already has (clock-host-start-v1: trigger-clock-core.ts
 * ClockStartSpec, clock-host-start-core.ts), only when no server of this Walnut
 * answers it. The run is the routine's, not a task the user delegated: it is filed
 * under "Routines" like any claude-code routine's run. It works for the owner, as its
 * deputy for this one run, through Walnut's API only:
 *
 *  - its first message is the routine's own instructions, unchanged;
 *  - its context is the generic one built for its own task (session-context.ts, with
 *    START_TASK_TOKEN where its id goes: the user's rules as they are now, no org
 *    role), then a short owner section: who the owner is, that the instructions'
 *    "you" means the owner, how to read its conversation and memory and write its
 *    memory, notes and messages through the API, what a refused write means, and
 *    the owner's own standing instructions and memory as a quoted, dated copy;
 *  - a path the instructions name in the Mac's notes vault is said to be that note
 *    (note_read / note_write by vault path), never a file on the host.
 *
 * Which routines (offlinePortability, item by item): enabled; no check, wake counter
 * or init batch; a `session` routine with a target or a `main-agent` one; instructions
 * that ride a start, name no task card, no Mac tool and no file but notes; and either
 * declared portable (`placement.portable` on its config) or owned by the org's Main or
 * a lead. The owner's own folder (a repo, its task dir) never pins it: the run is in
 * the host's Walnut home. A routine whose owner's conversation is on that host already
 * keeps its own delivery there (clock-placement.ts `deliver`), never a second worker.
 *
 * Nothing here moves a clock or decides when a run starts: clock-placement.ts picks
 * the host and carries the spec, and the daemon starts it only when the primary does
 * not answer. Nothing here makes an org role, completes a task or touches credentials, and
 * the org switch holds: with the org off, a routine aimed at Main or a VP starts no run here.
 */

import os from 'node:os';
import { NOTES_DIR, WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { START_CONTEXT_MAX, START_MESSAGE_MAX, START_TASK_TOKEN, validateClockStartSpec, type ClockStartSpec } from '../../providers/trigger-clock-core.js';
import { listEntityRefs } from '../../utils/entity-refs.js';
import type { CronJob } from '../cron/types.js';
import { isUnder, namedPaths, namesTooManyPaths } from '../hosts/named-paths.js';
import { needsMacTools } from '../hosts/placement.js';
import { AGENT_MEMORY_MAX_CHARS } from '../sessions/agent-memory.js';
import { routinePlacementOf, walnutHomeOn } from './run-placement.js';
import { pickDeliverySession, type DeliverySessionCandidate } from './session-target.js';
import { promptOf } from './trigger-push.js';

/** The task a routine works for, as far as a detached run needs it. */
export interface OfflineOwner {
  id: string;
  title: string;
  project?: string;
  phase?: string;
  transferred_to?: string;
  org_role?: string;
  org_name?: string;
  org_instructions?: { text: string; at?: string };
  agent_memory?: { text: string; at?: string };
}

/** A path the instructions name in the Mac's notes vault, and the note it is. */
export interface NoteRef {
  /** As the instructions write it. */
  named: string;
  /** Vault-relative ('' = the vault itself). */
  note: string;
}

export type OfflinePortability =
  | {
    ok: true;
    notes: NoteRef[];
    /** Declared portable on its config: any owner. */
    declared: boolean;
    /** Not declared and the owner was not given: offlineRoutineStartOf decides on the owner's role. */
    needsOrgOwner: boolean;
    capabilities: readonly string[];
  }
  | { ok: false; why: string };

/** Longest copy of the owner's standing instructions a run carries. */
export const OFFLINE_OWNER_INSTRUCTIONS_MAX = 8_000;
/** Longest copy of the owner's memory a run carries: a whole MEMORY.md fits. */
export const OFFLINE_OWNER_MEMORY_MAX = AGENT_MEMORY_MAX_CHARS;

const RUN_PROJECT = 'Routines';
const ORG_ROLES = new Set(['main', 'lead']);
/** The rest of a path the path reader stopped at: a `<YYYY-MM-DD>` placeholder and what follows it. */
const PATH_TAIL_RE = /^[^\s"'`()[\]{},;|]*/;

/** Every path the text names, whole (placeholders included), trailing punctuation dropped. */
function wholePaths(text: string): string[] {
  const out: string[] = [];
  for (const p of namedPaths(text, () => true, { max: 64 })) {
    const at = text.indexOf(p);
    const whole = (at >= 0 ? p + (PATH_TAIL_RE.exec(text.slice(at + p.length))?.[0] ?? '') : p).replace(/[.,:;!?]+$/, '');
    if (!out.includes(whole)) out.push(whole);
  }
  return out;
}

/**
 * Whether a detached worker may run this routine, item by item. Sync: the caller holds
 * the job; `owner` is its owner task when known (a session routine's target, Main).
 */
export function offlinePortability(
  job: CronJob,
  owner?: OfflineOwner | null,
  env: { notesDir: string; userHome: string } = { notesDir: NOTES_DIR, userHome: os.homedir() },
): OfflinePortability {
  if (!job.enabled) return { ok: false, why: 'it is disabled' };
  if (job.check) return { ok: false, why: 'it is a trigger (a check decides its fires on its host)' };
  if (job.wake) return { ok: false, why: 'it runs on a wake counter this server keeps' };
  if (job.initProcessor) return { ok: false, why: 'its init batch is built on this server' };
  const type = job.executor?.type;
  if (type !== 'session' && type !== 'main-agent') return { ok: false, why: 'it is not a session or main routine' };
  const config = (job.executor?.config ?? {}) as Record<string, unknown>;
  if (type === 'session' && !(typeof config.target === 'string' && config.target.trim())) return { ok: false, why: 'it has no target task' };
  const message = promptOf(job);
  if (!message.trim()) return { ok: false, why: 'its instructions are empty' };
  if (message.length > START_MESSAGE_MAX) return { ok: false, why: 'its instructions are too long to carry' };
  if (listEntityRefs(message).length > 0) return { ok: false, why: 'it names a card (a task or project pill) this server expands' };
  if (needsMacTools(message, undefined)) return { ok: false, why: 'it needs the Mac\'s tools' };
  if (namesTooManyPaths(message)) return { ok: false, why: 'it names more files than are checked' };
  const notesDir = env.notesDir.replace(/\/+$/, '');
  const notes: NoteRef[] = [];
  for (const named of wholePaths(message)) {
    const abs = named.startsWith('~/') ? `${env.userHome.replace(/\/+$/, '')}${named.slice(1)}` : named;
    if (!isUnder(abs, notesDir)) return { ok: false, why: `it names ${named}, a file only on its machine` };
    notes.push({ named, note: abs.slice(notesDir.length).replace(/^\/+/, '') });
  }
  const checked = routinePlacementOf(config.placement);
  if (!checked.ok) return { ok: false, why: `its placement is not valid (${checked.error})` };
  const declared = !!checked.placement;
  const capabilities = checked.placement?.capabilities ?? [];
  if (owner && owner.phase === 'COMPLETE') return { ok: false, why: 'its owner task is complete' };
  if (declared || type === 'main-agent') return { ok: true, notes, declared, needsOrgOwner: false, capabilities };
  if (!owner) return { ok: true, notes, declared, needsOrgOwner: true, capabilities };
  if (!ORG_ROLES.has(owner.org_role ?? '')) return { ok: false, why: 'its owner is not the org main or lead, and it is not declared placement.portable' };
  return { ok: true, notes, declared, needsOrgOwner: false, capabilities };
}

/** offlinePortability as a predicate (clock-placement.ts OfflineClockWork.portable). */
export function isOfflinePortable(job: CronJob, owner?: OfflineOwner | null, env?: { notesDir: string; userHome: string }): boolean {
  return offlinePortability(job, owner, env).ok;
}

export interface OfflineRunDeps {
  /** This Walnut's home here (the start's tenant key). */
  home: string;
  /** This Walnut's notes vault here. */
  notesDir: string;
  /** This account's home folder (a `~/` path). */
  userHome: string;
  getTask(id: string): Promise<OfflineOwner | null>;
  /** The org's Main now, never made here. */
  mainTask(): Promise<OfflineOwner | null>;
  /** The org switch (Settings > Org): off, a routine aimed at Main or a VP is skipped (org-enabled.ts). */
  orgEnabled(): Promise<boolean>;
  ownerSessions(taskId: string): Promise<DeliverySessionCandidate[]>;
  /** The host may start a run as this server would (configured, Claude Code engine, no session server), or why not. */
  hostReady(host: string): Promise<{ effort?: string } | string>;
  /** Its fleet capability tags; null when no card was read for it. */
  hostTags(host: string): Promise<readonly string[] | null>;
  /**
   * Why the host's copy cannot serve these notes (it keeps no notes, or one is left out of its
   * copy), or null: a note read and written while the Mac is away is that copy's (host-replica.ts).
   */
  notesBlocker(host: string, notes: readonly string[]): Promise<string | null>;
  /** Its account's home as its daemon reported it; null when unknown. */
  remoteHome(host: string): Promise<string | null>;
  launchMode(host: string, cwd: string): Promise<string>;
  /** The generic session context for the run's own task (session-context.ts buildSessionContext). */
  sessionContext(task: { id: string; title: string; project: string }, cwd: string, host: string): Promise<string>;
  /**
   * The owner's conversation as saved now: its session's transcript, unclipped (session-projection.ts
   * buildSessionTranscript full), or `{ notStarted }` when it has no session. Throws when it cannot be read.
   */
  ownerTranscript(ownerId: string): Promise<OwnerTranscript>;
}

/** The owner's conversation as read for a run (offlineRoutineStartOf samples it). */
export type OwnerTranscript =
  | { notStarted: true }
  | { sessionId: string; savedAt: string; truncated: boolean; messages: ReadonlyArray<{ role: string; text: string; timestamp: string; kind?: string }> };

/** The most of the owner's conversation a run carries, whole messages only. */
export const OWNER_SAMPLE_MAX_BYTES = 24 * 1024;
/** A row's time and speaker line, counted against the budget with its text. */
const ROW_OVERHEAD_BYTES = 48;

/** The sample a run carries: the newest visible messages that fit whole, oldest first, and what was left out. */
export interface OwnerSample {
  sessionId?: string;
  savedAt?: string;
  notStarted?: true;
  /** The transcript itself was a tail (older messages not read). */
  truncated: boolean;
  rows: Array<{ role: string; text: string; timestamp: string }>;
  /** Messages newer than the oldest one kept, too long to fit whole: never cut, named only. */
  leftOut: Array<{ role: string; timestamp: string; chars: number }>;
  /** Older visible messages not in the sample (the budget ran out). */
  older: number;
}

/** The newest visible messages (a person's and the agent's words, not tool rows) that fit whole in the budget. */
export function sampleOwnerTranscript(t: OwnerTranscript, maxBytes: number = OWNER_SAMPLE_MAX_BYTES): OwnerSample {
  if ('notStarted' in t) return { notStarted: true, truncated: false, rows: [], leftOut: [], older: 0 };
  const visible = t.messages.filter((m) => !m.kind && (m.role === 'user' || m.role === 'assistant') && m.text.trim());
  const rows: OwnerSample['rows'] = [];
  const leftOut: OwnerSample['leftOut'] = [];
  let used = 0;
  let i = visible.length - 1;
  for (; i >= 0; i--) {
    const m = visible[i];
    const bytes = Buffer.byteLength(m.text, 'utf8') + ROW_OVERHEAD_BYTES;
    // A message that alone is over the budget is never cut: named and skipped. One that does not
    // fit what is left ends the sample: it and the older ones are "older, not here".
    if (bytes > maxBytes) { leftOut.push({ role: m.role, timestamp: m.timestamp, chars: m.text.length }); continue; }
    if (used + bytes > maxBytes) break;
    used += bytes;
    rows.push({ role: m.role, text: m.text, timestamp: m.timestamp });
  }
  return {
    sessionId: t.sessionId, savedAt: t.savedAt, truncated: t.truncated,
    rows: rows.reverse(), leftOut: leftOut.reverse(), older: Math.max(0, i + 1),
  };
}

function sampleSection(s: OwnerSample, ownerId: string): string {
  if (s.notStarted) return `<owner_conversation task="${ownerId}" state="not_started">\nIt has no conversation yet.\n</owner_conversation>\n`;
  const head = `<owner_conversation task="${ownerId}" session="${s.sessionId ?? ''}" saved_at="${quoteSafe(s.savedAt ?? '').replace(/"/g, '')}" messages="${s.rows.length}" older_not_here="${s.older}" left_out="${s.leftOut.length}"${s.truncated ? ' transcript_truncated="true"' : ''}>`;
  const lines = s.rows.map((r) => `[${r.timestamp}] ${r.role === 'user' ? 'user' : 'agent'}:\n${quoteSafe(r.text)}`);
  const left = s.leftOut.map((l) => `[${l.timestamp}] ${l.role === 'user' ? 'user' : 'agent'}: (left out: ${l.chars} characters, too long to carry whole)`);
  return `${head}\n${[...lines, ...left].join('\n\n')}\n</owner_conversation>\n`;
}

/** The task a routine works for: a session routine's target (a moved task's new one), or Main. */
async function ownerOf(job: CronJob, deps: Pick<OfflineRunDeps, 'getTask' | 'mainTask'>): Promise<OfflineOwner | null> {
  if (job.executor?.type === 'main-agent') return deps.mainTask();
  const target = (job.executor?.config as { target?: unknown } | undefined)?.target;
  if (typeof target !== 'string' || !target.trim()) return null;
  let task = await deps.getTask(target.trim());
  for (let hop = 0; hop < 8 && task?.phase === 'COMPLETE' && task.transferred_to; hop++) task = await deps.getTask(task.transferred_to);
  return task && task.phase !== 'COMPLETE' ? task : null;
}

/** The task a routine works for (clock-placement.ts watches its conversation), or null; never makes Main. */
export async function offlineOwnerIdOf(job: CronJob, deps: Pick<OfflineRunDeps, 'getTask' | 'mainTask'> = defaultOfflineRunDeps()): Promise<string | null> {
  return (await ownerOf(job, deps).catch(() => null))?.id ?? null;
}

/** Text safe inside a quote tag: no closing tag of ours, no NUL. */
function quoteSafe(text: string): string {
  return text.replace(/\u0000/g, '').replace(/<\/(owner_[a-z]+)>/g, '<\\/$1>');
}

/** A whole copy in its tag, or, past `max`, none of it and where to read it whole: never a cut copy of the owner's rules. */
function quoted(tag: string, copy: { text: string; at?: string } | undefined, max: number, readWhole: string): string {
  const text = copy?.text?.trim();
  if (!text) return '';
  if (text.length > max) return `(${tag} is ${text.length} characters, too long to copy here: ${readWhole} before you act.)\n`;
  return `<${tag}${copy?.at ? ` at="${quoteSafe(copy.at).replace(/"/g, '')}"` : ''}>\n${quoteSafe(text)}\n</${tag}>\n`;
}

function ownerName(owner: OfflineOwner): string {
  const title = `"${owner.title.replace(/"/g, '\'')}" (id ${owner.id})`;
  if (owner.org_role === 'main') return `${title}, the user's main agent`;
  if (owner.org_role === 'lead') {
    const name = owner.org_name?.trim() ? `, the "${owner.org_name.trim().replace(/"/g, '\'')}" VP,` : ',';
    return `${title}${name} the lead (VP) of project "${(owner.project ?? '').replace(/"/g, '\'')}"`;
  }
  return title;
}

/** The owner section of the run's context: stable rules, then the owner's own words, quoted. */
export function ownerSection(job: CronJob, owner: OfflineOwner, host: string, notes: readonly NoteRef[], opts: { quotes?: boolean; sample?: OwnerSample } = {}): string {
  const id = owner.id;
  const lines = [
    '## This run works for another task',
    '',
    `This is a scheduled run of the routine "${job.name.replace(/"/g, '\'')}" (id ${job.id}). It belongs to the task ${ownerName(owner)}. `
      + `That task's machine was away when the run came due, so Walnut started this run on ${host} in its place. `
      + 'The routine\'s instructions (your first message) are written to that task: "you", "your file", "your chat", "your MEMORY.md" '
      + 'and "your own instructions" in them mean that task, not yours.',
    '',
    '- Do the work yourself, in this session: you are its deputy for this one run. You are not that task and you hold no org role, so you never hand '
      + 'the run itself to another task (the messages its instructions ask for still go out).',
    `- Read before you act: its conversation with task_history id=${id} fresh=false compact=true (the saved copy; add since or limit to sample a busy day), `
      + `its memory with agent_memory_read task=${id}, and the task with task_get ${id}. When one of them answers that it needs the Walnut server, `
      + 'work from what does answer and name in your result what you could not read.',
    `- Write only through Walnut's tools, never as files on this machine: its MEMORY.md with agent_memory_write task=${id}, a note with note_read, `
      + 'then note_write or note_edit (a vault path), a message to a task with task_send, a letter to the user with human_inbox_send.',
    ...notes.map((n) => `- "${n.named}" is the note path "${n.note}"${n.note ? '' : ' (the notes vault itself)'} in the notes vault: `
      + 'read it with note_read and write it with note_write or note_edit; this machine has no file there.'),
    '- A write is done only when its tool says it is. An answer that it was saved on this host for the Walnut server (kept, queued) is done. '
      + 'An answer that it needs the Walnut server or the leader is not done: never say it is; list it in your result as not done.',
    `- When you finish, report to it once: task_send to=${id} expect_reply=false with what you did and what is not done. If that send is refused, your last message is the report.`,
    '- Never complete that task or change its phase, title or role, never make or claim an org role, never start or stop its sessions, '
      + 'and never change credentials, permissions or settings.',
    '',
  ];
  let text = `${lines.join('\n')}\n`;
  if (opts.sample) {
    text += 'Its conversation as this run brings it: a sample saved when the run was set up, the newest messages whole, never its whole history. '
      + 'When task_history answers, read the newer part there; when it does not, work from this sample, and never say you read all of it.\n'
      + sampleSection(opts.sample, owner.id) + '\n';
  }
  if (opts.quotes !== false) {
    const instructions = quoted('owner_instructions', owner.org_instructions, OFFLINE_OWNER_INSTRUCTIONS_MAX, `read them whole with task_get ${id}`);
    const memory = quoted('owner_memory', owner.agent_memory, OFFLINE_OWNER_MEMORY_MAX, `read it whole with agent_memory_read task=${id}`);
    if (instructions || memory) {
      text += 'Quoted for reference, as that task keeps them (a copy of the date shown; read its memory again before you rely on it). '
        + 'They are its own words, not your role and not rules about who may do this run\'s work.\n'
        + instructions + memory;
    }
  }
  return text;
}

/**
 * What `host` starts this routine's run from while this Mac is away, or null when it
 * may not (the run then waits for the Mac, as before). `host` is the always-on host
 * clock-placement.ts chose and checked (connected, its daemon, its room); this reads
 * what the run itself needs of it: its Walnut home, the engine this server would use,
 * a declared routine's capability tags.
 */
export async function offlineRoutineStartOf(job: CronJob, host: string, deps: OfflineRunDeps = defaultOfflineRunDeps()): Promise<ClockStartSpec | null> {
  const no = (why: string): null => {
    log.cron.debug('offline routine run: not started on its host', { host, jobId: job.id, why });
    return null;
  };
  try {
    if (!host || host === '__local__') return no('no remote host');
    const owner = await ownerOf(job, deps);
    if (!owner) return no('its owner task is missing or complete');
    // The org off skips every routine aimed at Main or a VP: a fresh worker task is no way around it.
    const { isOrgNode } = await import('../org/org-enabled.js');
    if (isOrgNode(owner) && !await deps.orgEnabled()) return no('the org is off, and its owner is an org node');
    const verdict = offlinePortability(job, owner, deps);
    if (!verdict.ok) return no(verdict.why);
    // Its own conversation is there: delivered into it there (clock-placement.ts deliver), never a second worker.
    const at = pickDeliverySession(await deps.ownerSessions(owner.id), { reachableHost: host })?.host;
    if (at === host) return no('its owner\'s conversation runs on that host');
    const ready = await deps.hostReady(host);
    if (typeof ready === 'string') return no(ready);
    if (verdict.capabilities.length) {
      const tags = await deps.hostTags(host);
      if (!tags) return no('the host\'s capabilities are not known');
      const lacks = verdict.capabilities.filter((t) => !tags.includes(t));
      if (lacks.length) return no(`the host does not have ${lacks.join(', ')}`);
    }
    // A note it names must be one the host's copy keeps: there it is read and written while the Mac is away.
    if (verdict.notes.length) {
      const blocked = await deps.notesBlocker(host, verdict.notes.map((n) => n.note));
      if (blocked) return no(blocked);
    }
    const cwd = await walnutHomeOn(host, { localHome: async () => deps.home, remoteHome: (h) => deps.remoteHome(h) });
    if (!cwd) return no('the host\'s Walnut home is not known');
    // Its conversation, read now: a run with no sample of it (it could not be read) is not handed over.
    let sample: OwnerSample;
    try {
      sample = sampleOwnerTranscript(await deps.ownerTranscript(owner.id));
    } catch (err) {
      return no(`its owner's conversation could not be read (${err instanceof Error ? err.message : String(err)})`);
    }
    const title = `Routine: ${job.name}`;
    const generic = await deps.sessionContext({ id: START_TASK_TOKEN, title, project: RUN_PROJECT }, cwd, host);
    // The quoted copies go first when the whole would not fit; the rules and the sample never do.
    let context = `${generic.trimEnd()}\n\n${ownerSection(job, owner, host, verdict.notes, { sample })}`;
    if (context.length > START_CONTEXT_MAX) context = `${generic.trimEnd()}\n\n${ownerSection(job, owner, host, verdict.notes, { quotes: false, sample })}`;
    if (context.length > START_CONTEXT_MAX) return no('its context is too long to carry');
    const spec = validateClockStartSpec({
      home: deps.home, host, title, project: RUN_PROJECT, cwd,
      message: (await import('../sessions/send-frame.js')).frameAsWalnut(promptOf(job), 'routine', `routine:${job.id}:${job.name}`),
      mode: await deps.launchMode(host, cwd), modeNamed: false,
      ...(ready.effort ? { effort: ready.effort } : {}), context,
    });
    return spec.ok ? spec.spec : no(spec.error);
  } catch (err) {
    return no(err instanceof Error ? err.message : String(err));
  }
}

let overrides: Partial<OfflineRunDeps> | null = null;
/** Test seam: facts a test names in place of the real readers (the rest stay real). */
export function __setOfflineRunDepsForTesting(next: Partial<OfflineRunDeps> | null): void { overrides = next; }

/** The real wiring (with any test overrides on top): this server's config, task store, and the host facts portable clocks read. */
export function defaultOfflineRunDeps(): OfflineRunDeps {
  return { ...realDeps(), ...(overrides ?? {}) };
}

/**
 * The host facts are the ones clock-portable.ts judged the host by (its capability card with
 * the profile fallback, its Walnut home from the hello or the probe), read through the same
 * readers, so a host it seats is never one this file cannot place the run on. Imported when
 * read: clock-portable.ts never imports this file.
 */
function realDeps(): OfflineRunDeps {
  const env = async () => (await import('./clock-portable.js')).defaultPortableClockEnv().run;
  return {
    home: WALNUT_HOME,
    notesDir: NOTES_DIR,
    userHome: os.homedir(),
    async getTask(id) {
      const { getTask } = await import('../task-manager.js');
      return await getTask(id).catch(() => null);
    },
    orgEnabled: async () => (await import('../org/org-enabled.js')).isOrgEnabled(),
    async mainTask() {
      const [{ orgTasks }, { pickMain }] = await Promise.all([import('../org/org-store.js'), import('../org/org-tree.js')]);
      return pickMain(await orgTasks()) ?? null;
    },
    async ownerSessions(taskId) {
      const { getSessionsForTask } = await import('../session-tracker.js');
      return await getSessionsForTask(taskId).catch(() => []);
    },
    async hostReady(host) {
      const [{ getConfig, isFallbackConfig }, { resolveDefaultEngine }, { normalizeEngine }, { VALID_SESSION_EFFORT_IDS }] = await Promise.all([
        import('../config-manager.js'), import('../agents/default-engine.js'), import('../agents/engine-registry.js'), import('../types.js'),
      ]);
      const config = await getConfig();
      if (isFallbackConfig(config)) return 'the config could not be read';
      if (!config.hosts?.[host]) return 'the host is not configured';
      if (config.session_server?.enabled) return 'a session server runs sessions another way';
      if (normalizeEngine(resolveDefaultEngine(config, { host })) !== undefined) return 'its engine is not Claude Code';
      const effort = config.agent?.session_effort;
      return effort && VALID_SESSION_EFFORT_IDS.has(effort) ? { effort } : {};
    },
    hostTags: async (host) => (await (await env()).capabilities(host))?.tags ?? null,
    async notesBlocker(host, notes) {
      const [{ getConfig }, { hostKeepFor }, { leftOut }] = await Promise.all([
        import('../config-manager.js'), import('../host-replica.js'), import('../replication/keep-rule.js'),
      ]);
      const keep = hostKeepFor(await getConfig(), host);
      if (!keep.notes) return 'the host keeps no copy of the notes';
      const out = notes.find((n) => n && leftOut(n, keep.notesExclude));
      return out ? `the note ${out} is left out of the host's copy` : null;
    },
    remoteHome: async (host) => (await env()).remoteHome(host),
    async launchMode(host, cwd) {
      const { resolveClaudeLaunchMode } = await import('../../providers/claude-launch-mode.js');
      return (await resolveClaudeLaunchMode(host, cwd)).mode;
    },
    async ownerTranscript(ownerId) {
      // The session its routines are delivered into (session-target.ts), else its newest one.
      const { getSessionsForTask } = await import('../session-tracker.js');
      const sessions = await getSessionsForTask(ownerId);
      const visible = sessions.filter((s) => !s.archived);
      const picked = pickDeliverySession(visible)
        ?? [...visible].sort((a, b) => (b.lastActiveAt || b.startedAt || '').localeCompare(a.lastActiveAt || a.startedAt || ''))[0];
      if (!picked) return { notStarted: true };
      const { buildSessionTranscript } = await import('../session-projection.js');
      const t = await buildSessionTranscript(picked.claudeSessionId, { full: true });
      return { sessionId: t.sessionId, savedAt: t.exportedAt, truncated: t.truncated, messages: t.messages };
    },
    async sessionContext(task, cwd, host) {
      const { buildSessionContext } = await import('../sessions/session-context.js');
      const asTask = { ...task } as unknown as import('../types.js').Task;
      return (await buildSessionContext(START_TASK_TOKEN, cwd, host, { task: asTask })).systemPrompt;
    },
  };
}
