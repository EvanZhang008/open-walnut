/**
 * The org's few writes and reads on the primary: the main agent's task, a
 * project's lead, who the main agent talks to, and the short update note that
 * rides the next message into the main agent (the shape lives in org-tree.ts).
 *
 * The main agent must stay readable (user, 2026-10-21: "never crowded"), so it
 * is never woken by the work below it. What changed reaches it as ONE folded
 * note on the next message that goes in anyway, one line per project that
 * moved, at most six; the detail stays with the project's lead.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { ASK_WALNUT_PROJECT } from '../sessions/ask-list.js';
import { createEnvelopeKit } from '../peers/envelope-kit.js';
import {
  DIGEST_FOLD_MS, DIGEST_MAX_LINES, buildOrgTree, findProjectNode, formatAlertLine, formatDigestLine, isOrgMember, orgDigest, pickLead,
  pickMain, planOrgNote, projectKey, type OrgAlert, type OrgDigestState, type OrgTaskLike, type OrgTree,
} from './org-tree.js';

export const MAIN_TASK_TITLE = 'Main';

const kit = createEnvelopeKit();

export class OrgError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = 'OrgError';
  }
}

/** One org write at a time, so two first contacts never make two leads (or two mains). */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

// The cached store, not a SQL scan: a fresh scan parses every row's payload on the event loop.
async function orgTasks(): Promise<OrgTaskLike[]> {
  const { listTasks } = await import('../task-manager.js');
  return listTasks();
}

export async function getOrgTree(): Promise<OrgTree> {
  return buildOrgTree(await orgTasks());
}

/** The main agent's task, made on first use. Never more than one. */
export function ensureMainTask(): Promise<Task> {
  return serial(async () => {
    const { addTask, getTask } = await import('../task-manager.js');
    const existing = pickMain(await orgTasks());
    if (existing) {
      // A Main parked by an older build comes back onto the list (main-stays-active.ts).
      if (existing.phase === 'WAITING') {
        const { updateTask } = await import('../task-manager.js');
        await updateTask(existing.id, { phase: 'IN_PROGRESS' }, { source: 'internal' })
          .catch((err) => log.task.warn('org: parked main agent not restored', { taskId: existing.id, error: err instanceof Error ? err.message : String(err) }));
      }
      return getTask(existing.id);
    }
    const { task } = await addTask({
      title: MAIN_TASK_TITLE,
      project: ASK_WALNUT_PROJECT,
      source: 'local',
      walnut_agent: true,
      org_role: 'main',
    });
    log.task.info('org: main agent task created', { taskId: task.id });
    // The baseline starts now, so Main's first follow-up already hears what moved since.
    await writeDigestState(task.id, orgDigest(await orgTasks(), undefined, new Date().toISOString()).next)
      .catch((err) => log.task.warn('org digest: baseline not recorded', { taskId: task.id, error: err instanceof Error ? err.message : String(err) }));
    return task;
  });
}

/** A project's lead, made on first contact. Local: a lead is never pushed to a sync backend. */
export function ensureProjectLead(project: string): Promise<Task> {
  const name = project.trim();
  if (!name) return Promise.reject(new OrgError('no_lead_for_inbox', 400, 'The Inbox has no lead: talk to its tasks directly.'));
  return serial(async () => {
    const { addTask, getTask, updateTask } = await import('../task-manager.js');
    const tasks = await orgTasks();
    const existing = pickLead(tasks, name);
    if (existing?.phase === 'COMPLETE') {
      // A lead someone closed is brought back rather than replaced: its history is the project's.
      log.task.info('org: project lead reopened', { taskId: existing.id, project: name });
      // A contact is a deliberate ask, so it may move the lead out of COMPLETE.
      return (await updateTask(existing.id, { phase: 'TODO' }, { source: 'api' })).task;
    }
    if (existing) return getTask(existing.id);
    const canonical = tasks.find((t) => isOrgMember(t) && projectKey(t.project) === projectKey(name))?.project?.trim() || name;
    // No folder of its own: a lead runs where its project's tasks start (contactLaunch), and
    // a folder recorded here would freeze the project's default as it is today.
    const { task } = await addTask({
      title: `${canonical} lead`,
      project: canonical,
      source: 'local',
      org_role: 'lead',
      description: `Leads the work in project "${canonical}" and reports it to the main agent. Made by Walnut.`,
    });
    log.task.info('org: project lead created', { taskId: task.id, project: canonical });
    return task;
  });
}

/** Where a chat with an org contact would start: a folder and its host (null = this Mac). */
export interface ContactLaunch { cwd: string; host: string | null }

/**
 * Where a task with no session would start, read only (task-launch-plan.ts): its
 * own folder, else its project's, else the project's memory folder, which the
 * start makes. None when the start would refuse (a remote host with no folder, an
 * unknown host) or the memory folder would fall outside PROJECTS_MEMORY_DIR.
 */
export async function contactLaunch(task: Task): Promise<ContactLaunch | undefined> {
  try {
    const { insideMemoryFolders, resolveTaskLaunchReadOnly } = await import('../sessions/task-launch-plan.js');
    const plan = await resolveTaskLaunchReadOnly(task, { taskIdPrefix: task.id, source: 'org-contact' });
    if (plan.createLocalDirectory && !insideMemoryFolders(plan.cwd)) return undefined;
    return { cwd: plan.cwd, host: plan.host || null };
  } catch (err) {
    log.task.info('org: no launch place for contact', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

export interface OrgContact {
  task: Task;
  /** 'lead' = the project's lead, 'team' = a project's only team, 'task' = a task named by id. */
  kind: 'lead' | 'team' | 'task';
  project: string;
}

/**
 * Who `to` means: a task id (or unique prefix), or a project name (its lead,
 * else its one team). A project with two or more teams gets its lead now.
 */
export async function resolveOrgContact(to: string): Promise<OrgContact> {
  const want = to.trim();
  if (!want) throw new OrgError('missing_to', 400, '`to` is required: a project name or a task id.');
  const { getTask } = await import('../task-manager.js');
  const tree = await getOrgTree();
  const node = findProjectNode(tree, want);
  if (node) {
    if (node.contactId) {
      const task = await getTask(node.contactId);
      return { task, kind: node.lead ? 'lead' : 'team', project: node.project };
    }
    return { task: await ensureProjectLead(node.project), kind: 'lead', project: node.project };
  }
  // A project whose work is all done still has the lead someone closed: bring it back.
  if (pickLead(await orgTasks(), want)) {
    const lead = await ensureProjectLead(want);
    return { task: lead, kind: 'lead', project: (lead.project ?? want).trim() };
  }
  const task = await getTask(want).catch(() => null);
  if (!task) {
    throw new OrgError('unknown_contact', 404,
      `No project with open work or task named "${want}". To start new work there, create a task in that project (task_create).`);
  }
  return { task, kind: task.org_role === 'lead' ? 'lead' : 'task', project: (task.project ?? '').trim() };
}

/** What one org node reports to the agent asking: its direct reports, compactly. */
export interface OrgReportRow {
  id?: string;
  title: string;
  kind: 'project' | 'team' | 'worker';
  project: string;
  phase?: string;
  open: number;
  running: number;
  needs_you: number;
  waiting: number;
  /** For a project: who to talk to (task_send / org_send). */
  contact?: { id?: string; title: string; kind: 'lead' | 'team' };
  /** The few that wait on the user, by title, so the main agent can name them. */
  waiting_on_user?: { id: string; title: string }[];
  /** A project with no one contact (the Inbox): its first tasks. */
  teams?: { id: string; title: string }[];
}

function waitingOnUser(nodes: import('./org-tree.js').OrgTaskNode[], limit = 3): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  const walk = (list: import('./org-tree.js').OrgTaskNode[]) => {
    for (const n of list) {
      if (out.length >= limit) return;
      if (n.phase === 'NEED_ACTION') out.push({ id: n.id, title: n.title });
      walk(n.workers);
    }
  };
  walk(nodes);
  return out;
}

/** The reports of `of`: the main agent (or nobody) → projects; a lead → its project's teams; a task → its workers. */
export async function orgReportsOf(of: Task | undefined): Promise<{ of: string; rows: OrgReportRow[] }> {
  const tree = await getOrgTree();
  if (!of || of.org_role === 'main') {
    return {
      of: 'main',
      rows: tree.projects.map((p) => {
        const contact: OrgReportRow['contact'] = p.contactId
          ? {
            id: p.contactId,
            title: p.lead?.title ?? p.teams.find((t) => t.id === p.contactId)?.title ?? p.contactId,
            kind: p.lead ? 'lead' : 'team',
          }
          : p.needsLead ? { title: `${p.project} lead (made on first contact)`, kind: 'lead' } : undefined;
        return {
          title: p.project || 'Inbox',
          kind: 'project' as const,
          project: p.project,
          open: p.counts.open, running: p.counts.running, needs_you: p.counts.needsYou, waiting: p.counts.waiting,
          ...(contact ? { contact } : {}),
          // The Inbox has no lead: name its first few tasks so they can be talked to directly.
          ...(!contact ? { teams: p.teams.slice(0, 5).map((t) => ({ id: t.id, title: t.title })) } : {}),
          ...(p.counts.needsYou ? { waiting_on_user: waitingOnUser(p.teams) } : {}),
        };
      }),
    };
  }
  const row = (n: import('./org-tree.js').OrgTaskNode, kind: 'team' | 'worker'): OrgReportRow => ({
    id: n.id, title: n.title, kind, project: n.project, phase: n.phase,
    open: n.counts.open, running: n.counts.running, needs_you: n.counts.needsYou, waiting: n.counts.waiting,
  });
  if (of.org_role === 'lead') {
    const node = tree.projects.find((p) => projectKey(p.project) === projectKey(of.project));
    return { of: of.id, rows: (node?.teams ?? []).map((n) => row(n, 'team')) };
  }
  const find = (list: import('./org-tree.js').OrgTaskNode[]): import('./org-tree.js').OrgTaskNode | undefined => {
    for (const n of list) {
      if (n.id === of.id) return n;
      const hit = find(n.workers);
      if (hit) return hit;
    }
    return undefined;
  };
  let node: import('./org-tree.js').OrgTaskNode | undefined;
  for (const p of tree.projects) { node = find(p.teams); if (node) break; }
  return { of: of.id, rows: (node?.workers ?? []).map((n) => row(n, 'worker')) };
}

// ── The update note ──

const DIGEST_FILE = path.join(WALNUT_HOME, 'org', 'main-digest.json');

async function readDigestState(mainId: string): Promise<OrgDigestState | undefined> {
  try {
    const all = JSON.parse(await fs.readFile(DIGEST_FILE, 'utf8')) as Record<string, OrgDigestState>;
    const state = all[mainId];
    return state && typeof state.at === 'string' && state.needsYou && typeof state.needsYou === 'object' ? state : undefined;
  } catch {
    return undefined;
  }
}

async function writeDigestState(mainId: string, state: OrgDigestState): Promise<void> {
  const { writeFileAtomic } = await import('../config-manager.js');
  await fs.mkdir(path.dirname(DIGEST_FILE), { recursive: true });
  // One main agent at a time: an older main's state is dead weight.
  await writeFileAtomic(DIGEST_FILE, JSON.stringify({ [mainId]: state }, null, 2));
}

function ago(fromIso: string, nowMs: number): string {
  const mins = Math.max(0, Math.round((nowMs - Date.parse(fromIso)) / 60_000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * The note's text: who it is from, what newly needs the user (each alert once),
 * one line per moved project, and where the detail is.
 */
export function buildDigestText(
  mainTask: Pick<Task, 'id' | 'title'>, lines: string[], more: number, since: string, nowMs: number,
  alerts: string[] = [], alertsMore = 0,
): string {
  const list = (items: string[]) => items.map((l) => `- ${l}`).join('\n');
  const needs = alerts.length
    ? `Needs the user now:\n${list(alerts)}${alertsMore > 0 ? `\n- and ${alertsMore} more` : ''}\n`
    : '';
  const moved = lines.length
    ? (alerts.length ? 'Work moved:\n' : '') + list(lines)
      + (more > 0 ? `\n- and ${more} more project${more === 1 ? '' : 's'}` : '') + '\n'
    : '';
  const how = alerts.length
    ? 'Tell the user what is under "Needs the user now" in your reply, one line each; the rest is background.'
    : 'Background only: mention it when it matters to what the user says.';
  const body = (lines.length ? `Org update since ${ago(since, nowMs)}:\n` : 'Org update:\n')
    + needs + moved + `${how} Detail: org_get, or ask that project's lead.`;
  return kit.buildWalnutMessage({
    kind: 'notification',
    attrs: { from: 'Walnut', about: kit.sessionHandle(mainTask.title, undefined) || 'Main', 'about-task': mainTask.id, outcome: 'org-update', note: 'automated Walnut status notice' },
    body,
  });
}

/** An infrastructure failure still standing after this long is no longer Walnut's alone to fix. */
const INFRA_ALERT_AFTER_MS = 15 * 60_000;

/**
 * What newly needs the user, read off the current session of each open task and
 * lead in the org (OrgAlert): a question or an approval it waits on, or a failure.
 * Main's own prompts are its own chat's business.
 */
async function orgAlerts(tasks: readonly OrgTaskLike[], nowMs: number): Promise<OrgAlert[]> {
  const bySession = new Map<string, OrgTaskLike>();
  for (const t of tasks) {
    if (!isOrgMember(t) && !(t.org_role === 'lead' && t.phase !== 'COMPLETE')) continue;
    for (const sid of [t.session_id, t.exec_session_id]) if (sid) bySession.set(sid, t);
  }
  if (!bySession.size) return [];
  const { listSessionsForTasks } = await import('../session-tracker.js');
  const { isInfraSessionError } = await import('../session-error-kind.js');
  const alerts: OrgAlert[] = [];
  const seen = new Set<string>();
  for (const r of await listSessionsForTasks(new Set(), new Set(bySession.keys()))) {
    const task = bySession.get(r.claudeSessionId);
    if (!task || seen.has(task.id)) continue;
    const base = { project: (task.project ?? '').trim(), title: task.title };
    const ask = r.pendingPermission;
    if (ask) {
      const question = ask.toolName === 'AskUserQuestion';
      alerts.push({ ...base, key: `ask:${task.id}:${ask.requestId}`, kind: question ? 'question' : 'permission', ...(!question && ask.toolName ? { tool: ask.toolName } : {}) });
      seen.add(task.id);
    } else if (r.process_status === 'error') {
      // One key per failure: the transition into 'error' (newest first), so a failed session
      // written as failed again is no news and a second failure after a resume is.
      const entry = r.status_history?.[0]?.process_status === 'error' ? r.status_history[0] : undefined;
      // A lost host or daemon is Walnut's to recover (session-auto-recover.ts); it is the
      // user's once it has stayed lost (recovery gave up, or is off).
      if (isInfraSessionError(r) && !(entry && nowMs - Date.parse(entry.timestamp) >= INFRA_ALERT_AFTER_MS)) continue;
      alerts.push({ ...base, key: `error:${task.id}:${r.claudeSessionId}:${entry?.timestamp ?? ''}`, kind: 'error' });
      seen.add(task.id);
    }
  }
  return alerts.sort((a, b) => a.project.localeCompare(b.project) || a.title.localeCompare(b.title));
}

let digestFoldMs = DIGEST_FOLD_MS;
/** Tests shorten the fold window (null restores it). */
export function _setDigestFoldMsForTesting(ms: number | null): void {
  digestFoldMs = ms ?? DIGEST_FOLD_MS;
}

/** Notes handed out but not yet recorded: two sends racing into the main agent carry one note. */
const claims = new Map<string, number>();
const CLAIM_MS = 60_000;

export interface PendingOrgDigest {
  text: string;
  markTold(): Promise<void>;
}

/**
 * The note the next message into the main agent's session should carry, or
 * null: not the main agent, nothing moved, or the first message (which only
 * records where things stand). Never throws.
 */
export async function pendingOrgDigest(sessionId: string, nowMs = Date.now()): Promise<PendingOrgDigest | null> {
  try {
    const { role } = await import('../server-role.js');
    if (role() !== 'leader') return null;
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const record = await getSessionByClaudeId(sessionId);
    if (!record?.taskId) return null;
    // Every send into every session passes here: one indexed read decides, the board is read only for the main agent.
    const { listTasksByIds } = await import('../task-manager.js');
    const own = (await listTasksByIds([record.taskId]))[0];
    if (own?.org_role !== 'main') return null;
    // Claimed before the next await, so two sends racing here never both carry the note.
    const mainId = own.id;
    const claimedAt = claims.get(mainId);
    if (claimedAt && nowMs - claimedAt < CLAIM_MS) return null;
    claims.set(mainId, nowMs);
    let handedOut = false;
    try {
      const tasks = await orgTasks();
      const prev = await readDigestState(mainId);
      const now = new Date(nowMs).toISOString();
      const digest = orgDigest(tasks, prev, now);
      const alerts = await orgAlerts(tasks, nowMs);
      if (!prev) {
        await writeDigestState(mainId, { ...digest.next, alerts: alerts.map((a) => a.key) });
        return null;
      }
      const plan = planOrgNote(prev, digest, alerts, nowMs, digestFoldMs);
      if (plan.kind === 'none') {
        // A state from before alerts: what needs the user right now is recorded as known.
        if (!prev.alerts) await writeDigestState(mainId, plan.next);
        return null;
      }
      const lines = plan.kind === 'full' ? digest.lines : [];
      const shown = lines.slice(0, DIGEST_MAX_LINES).map(formatDigestLine);
      handedOut = true;
      return {
        text: buildDigestText(own, shown, lines.length - shown.length, prev.at, nowMs, plan.alerts.map(formatAlertLine), plan.more),
        markTold: async () => {
          await writeDigestState(mainId, plan.next).catch((err) => log.session.warn('org digest: state not recorded', {
            sessionId, error: err instanceof Error ? err.message : String(err),
          }));
          claims.delete(mainId);
          log.session.info('org digest queued', { sessionId, taskId: mainId, kind: plan.kind, projects: lines.length, alerts: plan.alerts.length });
        },
      };
    } finally {
      if (!handedOut) claims.delete(mainId);
    }
  } catch (err) {
    log.session.warn('org digest skipped', { sessionId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
