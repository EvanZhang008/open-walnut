/**
 * The org's few writes and reads on the primary: the main agent's task, a
 * project's lead, who the main agent talks to, and the short update note that
 * rides the next message into the main agent (the shape lives in org-tree.ts).
 *
 * The main agent must stay readable (user, 2026-10-21: "never crowded"), so it
 * is never woken by the work below it. What changed reaches it as ONE folded
 * note on the next message that goes in anyway, one line per project that
 * moved, at most six; the detail stays with the project's lead, which hears its
 * own teams' news the same way (team-note.ts).
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { bus, EventNames } from '../event-bus.js';
import { ASK_WALNUT_PROJECT } from '../sessions/ask-list.js';
import { createEnvelopeKit } from '../peers/envelope-kit.js';
import {
  DIGEST_FOLD_MS, DIGEST_MAX_LINES, buildOrgTree, findProjectNode, formatAlertLine, formatDigestLine, isOrgMember, leadsAlso, orgDigest, pickLead,
  pickMain, pickOwnLead, planOrgNote, projectKey, successorOf, type OrgAlert, type OrgDigestState, type OrgTaskLike, type OrgTree,
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
/** Org writes one at a time (a lead made twice, a move racing a move). org-node-edit.ts takes it too. */
export function withOrgLock<T>(fn: () => Promise<T>): Promise<T> {
  return serial(fn);
}
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

// The cached store, not a SQL scan: a fresh scan parses every row's payload on the event loop.
/**
 * The tasks the org reads. A test run's tasks (src/core/test-run.ts) are in it only for a
 * test run's own request, unmarked: a person's contact never reuses a hidden test lead, and a
 * test window's Org works on what it made.
 */
export async function orgTasks(): Promise<Task[]> {
  const { listTasks } = await import('../task-manager.js');
  const { ambientTestRun, isTestRunTask, unmarkForTestViewer } = await import('../test-run.js');
  const tasks = await listTasks();
  return ambientTestRun() !== undefined ? tasks.map(unmarkForTestViewer) : tasks.filter((t) => !isTestRunTask(t));
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
  return serial(() => ensureLeadNow(name));
}

/** ensureProjectLead's body, for a caller already inside `serial` (withOrgLock). */
export async function ensureLeadNow(name: string): Promise<Task> {
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
  const canonical = canonicalProject(tasks, name);
  // No folder of its own: a lead runs where its project's tasks start (contactLaunch), and
  // a folder recorded here would freeze the project's default as it is today.
  const { task } = await addTask({
    title: `${canonical} lead`,
    project: canonical,
    source: 'local',
    org_role: 'lead',
    description: leadDescription([canonical]),
  });
  log.task.info('org: project lead created', { taskId: task.id, project: canonical });
  // addTask announces nothing: open pages learn the new lead from this.
  bus.emit(EventNames.TASK_CREATED, { task }, ['web-ui'], { source: 'org' });
  return task;
}

function canonicalProject(tasks: readonly OrgTaskLike[], name: string): string {
  return tasks.find((t) => isOrgMember(t) && projectKey(t.project) === projectKey(name))?.project?.trim()
    || pickOwnLead(tasks, name)?.project?.trim()
    || name.trim();
}

const LEAD_DESCRIPTION_HEAD = 'Leads the work in project';

/** A lead's description, while Walnut wrote it: the projects it leads. */
export function leadDescription(projects: readonly string[]): string {
  const names = projects.map((p) => `"${p}"`);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  return `${LEAD_DESCRIPTION_HEAD}${names.length > 1 ? 's' : ''} ${list} and reports it to the main agent. Made by Walnut.`;
}

// ── One VP for several projects (the org chart's drag) ──

/** What one VP change did, for the response and the chart's toast. */
export interface ProjectVpResult {
  project: string;
  /** The project whose lead leads it now; '' = its own. */
  vp: string;
  /** The lead that leads it now, when there is one. */
  lead?: { id: string; title: string };
  /** Leads that had no session to hand over from, closed at once. */
  closed: string[];
  /** Leads asked to sum up their work for the lead that takes over; a replaced one is closed after that turn. */
  handover: string[];
  /** Tasks whose leader moved to the new lead (their parent link). */
  moved: string[];
  /** Nothing to do: it was already so. */
  unchanged?: boolean;
}

/** A lead that hands its work on one project over to another lead. */
interface Handover {
  from: Task;
  to: Task;
  project: string;
  /** The projects the new lead takes from it. */
  led: string[];
  /** A take-over: `from` no longer leads anything and is closed after it hands over. */
  ends: boolean;
}

function patchLeads(list: readonly string[]): Partial<Task> {
  // null clears a payload field (normalizeNullClears).
  return { org_leads: list.length ? [...list] : (null as unknown as string[]) };
}

async function writeLeads(lead: Task, list: readonly string[]): Promise<void> {
  const { updateTaskRaw, updateDescription } = await import('../task-manager.js');
  const own = (lead.project ?? '').trim();
  const others = list.filter((p) => projectKey(p) !== projectKey(own));
  await updateTaskRaw(lead.id, patchLeads(others), { emitEvent: true, source: 'api' });
  // Only a description Walnut wrote is kept up to date; the user's own stays theirs.
  if (!lead.description || lead.description.startsWith(LEAD_DESCRIPTION_HEAD)) {
    await updateDescription(lead.id, leadDescription([own, ...others]));
  }
}

function uniqueProjects(list: readonly string[]): string[] {
  const seen = new Set<string>();
  return list.filter((p) => { const k = projectKey(p); if (!k || seen.has(k)) return false; seen.add(k); return true; });
}

/** Move the open direct subtasks of `from` (in `project`, or any) to `to`. */
async function moveWorkers(tasks: readonly Task[], from: string, to: string, project?: string): Promise<string[]> {
  const { updateTask } = await import('../task-manager.js');
  const moved: string[] = [];
  for (const t of tasks) {
    if (t.parent_task_id !== from || t.phase === 'COMPLETE' || t.id === to) continue;
    if (project !== undefined && projectKey(t.project) !== projectKey(project)) continue;
    try {
      await updateTask(t.id, { parent_task_id: to }, { source: 'api' });
      moved.push(t.id);
    } catch (err) {
      log.task.warn('org: worker not moved to its new lead', { taskId: t.id, from, to, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return moved;
}

/** Is `name` a project the org knows: open work, or a lead of its own? */
function knownProject(tasks: readonly OrgTaskLike[], name: string): boolean {
  return !!findProjectNode(buildOrgTree(tasks), name) || !!pickOwnLead(tasks, name)
    || tasks.some((t) => leadsAlso(t, name));
}

function hasLeadSession(task: Task): boolean {
  return !!(task.session_id || task.exec_session_id);
}

/** A JSON argument inside a shell command quoted with single quotes. */
function shellJson(value: unknown): string {
  return JSON.stringify(value).replace(/'/g, "'\\''");
}

/** The words a lead reads when its project moves: sum up and send it on. Walnut closes a replaced lead itself. */
export function buildHandoverText(h: Pick<Handover, 'project' | 'led' | 'ends'> & { from: Pick<Task, 'id'>; to: Pick<Task, 'id' | 'title'> }): string {
  const to = `"${h.to.title}" (${h.to.id})`;
  const projects = h.ends ? h.led : [h.project];
  const names = projects.map((p) => `"${p}"`).join(', ');
  const what = h.ends
    ? `The user put project "${h.project}" under ${to} in the org chart: that lead leads ${names} from now on, and your open workers already report to it. No task changed project. Walnut closes your task once you have handed over.`
    : `The user gave project "${h.project}" back to its own lead ${to} in the org chart: you no longer lead it, and your open workers in it already report to that lead. No task changed project.`;
  const send = shellJson({ to: h.to.id, title: `Handover: ${h.project}`, text: '<your summary>', expect_reply: false });
  return kit.buildWalnutMessage({
    kind: 'notification',
    attrs: {
      from: 'Walnut',
      about: h.project,
      'about-task': h.to.id,
      title: `Hand over "${h.project}" to ${h.to.title}`,
      outcome: 'handover',
      note: 'the user moved this project in the org chart: act on it',
    },
    body: `${what}\n\nHand over now:\n`
      + `1. Sum up your work on ${names} in a few short lines: what is open and who has it, what is decided, what waits on whom, and anything the new lead must not miss.\n`
      + `2. Send it to the new lead (this starts that lead when it has not started yet):\n   walnut tools call org_send '${send}'`,
  });
}

/** The words a lead that takes a project over reads, mid-turn only (adopt-notice.ts's rule: never woken for this). */
function buildTakeOverText(lead: Pick<Task, 'id'>, project: string, led: readonly string[]): string {
  return kit.buildWalnutMessage({
    kind: 'notification',
    attrs: { from: 'Walnut', about: project, 'about-task': lead.id, outcome: 'vp', note: 'automated Walnut status notice' },
    body: `The user put project "${project}" under you in the org chart: you lead ${led.map((p) => `"${p}"`).join(', ')} from now on, `
      + 'each its own project (org_get lists their teams). A status notice, not a request: nothing waits on an answer.',
  });
}

/** The lead's newest listable session, or null. */
export async function leadSession(taskId: string, onlyRunning = false): Promise<import('../types.js').SessionRecord | null> {
  const { getSessionsForTask, isListableSession } = await import('../session-tracker.js');
  const rows = (await getSessionsForTask(taskId))
    .filter((r) => !r.archived && isListableSession(r) && (!onlyRunning || r.process_status === 'running'));
  rows.sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''));
  return rows[0] ?? null;
}

/** Ask a lead to hand over (its newest session; a stopped one is resumed). Null when it could not be told. */
async function askHandover(h: Handover): Promise<{ sessionId: string; messageId?: string } | null> {
  const fields = { from: h.from.id, to: h.to.id, project: h.project };
  try {
    const target = await leadSession(h.from.id);
    if (!target) return null;
    const text = buildHandoverText(h);
    const { deliverToSession } = await import('../sessions/session-send-core.js');
    const { delivery, messageId } = await deliverToSession(target, {
      busText: text, enqueueText: text, source: 'walnut-notify', taskId: h.from.id,
    });
    log.task.info('org: handover asked', { ...fields, sessionId: target.claudeSessionId, delivery, messageId });
    return { sessionId: target.claudeSessionId, ...(messageId ? { messageId } : {}) };
  } catch (err) {
    log.task.warn('org: handover not asked', { ...fields, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Tell the lead that took a project over, when it is mid-turn (the notice rides along); never wake it. */
async function tellTakeOver(lead: Task, project: string): Promise<void> {
  try {
    const target = await leadSession(lead.id, true);
    if (!target) return;
    const { getTask } = await import('../task-manager.js');
    const now = await getTask(lead.id);
    const text = buildTakeOverText(now, project, [(now.project ?? '').trim(), ...(now.org_leads ?? [])]);
    const { deliverToSession } = await import('../sessions/session-send-core.js');
    await deliverToSession(target, { busText: text, enqueueText: text, source: 'walnut-notify', taskId: lead.id });
  } catch (err) {
    log.task.info('org: take-over notice not sent', { taskId: lead.id, project, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Put `project` under `vp`'s VP (its lead), or give it back its own (`vp` = '').
 * Both projects stay what they are: no task changes project. The VP's lead gets
 * the project in `org_leads`, and the project's open workers report to it. The
 * lead that stops leading the project sums up its work for the one that takes
 * over (a Walnut notice into its session); a replaced lead is then closed by
 * Walnut once that turn is over (handover-close.ts), and one with no session to
 * hand over from is closed at once. Giving it back reopens the project's own lead
 * (made, when workers need one) and withdraws a handover nobody has read. A VP is
 * one level: putting a VP's project under another moves the projects it led along.
 */
export async function setProjectVp(project: string, vp: string): Promise<ProjectVpResult> {
  const name = project.trim();
  const target = vp.trim();
  if (!name) throw new OrgError('no_vp_for_inbox', 400, 'The Inbox has no VP: its tasks are talked to one by one.');
  if (/^inbox$/i.test(target)) throw new OrgError('no_vp_for_inbox', 400, 'The Inbox is not a VP.');
  const { result, handovers, newLead } = await serial(() => moveProjectNow(name, target));
  const { closeAfterHandover } = await import('./handover-close.js');
  for (const h of handovers) {
    const asked = await askHandover(h);
    if (!asked) continue;
    result.handover.push(h.from.id);
    if (h.ends) closeAfterHandover({ taskId: h.from.id, project: h.project, ...asked });
  }
  if (newLead && !result.unchanged) await tellTakeOver(newLead, result.project);
  return result;
}

async function moveProjectNow(name: string, target: string): Promise<{ result: ProjectVpResult; handovers: Handover[]; newLead?: Task }> {
  const { completeTask, getTask, listTasks, updateTask } = await import('../task-manager.js');
  const { cancelHandovers } = await import('./handover-close.js');
  const tasks = await listTasks();
  if (!knownProject(tasks, name)) throw new OrgError('unknown_project', 404, `No project "${name}" in the org.`);
  const canonical = canonicalProject(tasks, name);
  const key = projectKey(name);
  const none = (extra: Partial<ProjectVpResult> = {}) => ({
    result: { project: canonical, vp: '', closed: [], handover: [], moved: [], unchanged: true, ...extra }, handovers: [],
  });

  // Back to its own VP.
  if (!target || projectKey(target) === key) {
    const vps = tasks.filter((t) => leadsAlso(t, name));
    if (!vps.length) return none();
    // A replaced lead that has not handed over yet stays: it leads its project again.
    await cancelHandovers(canonical);
    let own = pickOwnLead(tasks, name);
    if (own?.phase === 'COMPLETE') own = (await updateTask(own.id, { phase: 'TODO' }, { source: 'api' })).task;
    const workers = tasks.filter((t) => vps.some((l) => t.parent_task_id === l.id) && t.phase !== 'COMPLETE' && projectKey(t.project) === key);
    const talked = vps.filter((l) => l.phase !== 'COMPLETE' && hasLeadSession(l));
    // Workers need someone to report to, and so does a handover; else the lead is made on first contact.
    if (!own && (workers.length || talked.length)) own = await ensureLeadNow(canonical);
    const moved: string[] = [];
    if (own) for (const l of vps) moved.push(...await moveWorkers(tasks, l.id, own.id, name));
    for (const l of vps) await writeLeads(l, (l.org_leads ?? []).filter((p) => projectKey(p) !== key));
    log.task.info('org: project has its own VP again', { project: canonical, from: vps.map((l) => l.id), lead: own?.id, moved: moved.length });
    const to = own;
    return {
      result: { project: canonical, vp: '', ...(own ? { lead: { id: own.id, title: own.title } } : {}), closed: [], handover: [], moved },
      handovers: to ? talked.map((l) => ({ from: l, to, project: canonical, led: [canonical], ends: false })) : [],
    };
  }

  if (!knownProject(tasks, target)) throw new OrgError('unknown_project', 404, `No project "${target}" in the org.`);
  // The target's VP: its own lead, or the VP it is under (one level).
  let lead = pickLead(tasks, target) ?? await ensureLeadNow(canonicalProject(tasks, target));
  if (lead.phase === 'COMPLETE') lead = (await updateTask(lead.id, { phase: 'TODO' }, { source: 'api' })).task;
  if (projectKey(lead.project) === key || leadsAlso(lead, name)) {
    return none({ vp: (lead.project ?? '').trim(), lead: { id: lead.id, title: lead.title } });
  }
  // An earlier handover of this project now goes to the new VP instead.
  await cancelHandovers(canonical);
  const fresh = await getTask(lead.id);
  const now = await listTasks();
  const owns = now.filter((l) => l.org_role === 'lead' && l.id !== fresh.id && projectKey(l.project) === key);
  const before = now.filter((l) => l.org_role === 'lead' && l.id !== fresh.id && leadsAlso(l, name));
  const led = uniqueProjects([canonical, ...owns.flatMap((l) => l.org_leads ?? [])]);
  // The VP first: a failure after this leaves the project led twice, never by no one.
  await writeLeads(fresh, uniqueProjects([...(fresh.org_leads ?? []), ...led]));
  const moved: string[] = [];
  const closed: string[] = [];
  const handovers: Handover[] = [];
  for (const l of owns) {
    // The project's own lead: what it led moved with it, its workers report to the VP, and it hands over.
    if (l.org_leads?.length) await writeLeads(l, []);
    moved.push(...await moveWorkers(now, l.id, fresh.id));
    if (l.phase === 'COMPLETE') continue;
    if (hasLeadSession(l)) handovers.push({ from: l, to: fresh, project: canonical, led, ends: true });
    else { await completeTask(l.id, { source: 'org' }); closed.push(l.id); } // never talked: nothing to hand over
  }
  for (const l of before) {
    // The VP it was under before: it keeps its own project and hands this one over.
    await writeLeads(l, (l.org_leads ?? []).filter((p) => projectKey(p) !== key));
    moved.push(...await moveWorkers(now, l.id, fresh.id, name));
    if (l.phase !== 'COMPLETE' && hasLeadSession(l)) handovers.push({ from: l, to: fresh, project: canonical, led: [canonical], ends: false });
  }
  log.task.info('org: project put under another VP', { project: canonical, vp: fresh.project, lead: fresh.id, closed, moved: moved.length });
  return {
    result: { project: canonical, vp: (fresh.project ?? '').trim(), lead: { id: fresh.id, title: fresh.title }, closed, handover: [], moved },
    handovers,
    newLead: fresh,
  };
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
  /** The lead `to` named handed its project over: this is the lead that took it (org/retired-lead.ts). */
  handedOverBy?: { id: string; title: string };
}

/**
 * Who `to` means: a task id (or unique prefix), or a project name (its lead,
 * else its one team). A project with two or more teams gets its lead now.
 * `askerTaskId`: the task of the session asking ('' for another program); the
 * human passes none, and reaches a lead that handed over as it is.
 */
export async function resolveOrgContact(to: string, opts: { askerTaskId?: string } = {}): Promise<OrgContact> {
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
  // A VP by the name the user gave it ("Green Thumb", "Green Thumb VP"), as the org chart shows it.
  const tasks = await orgTasks();
  const named = namedLead(tasks, want);
  if (named) {
    const lead = await getTask(named.id);
    return { task: lead, kind: 'lead', project: (lead.project ?? '').trim() };
  }
  // A project whose work is all done still has the lead someone closed: bring it back.
  if (pickLead(tasks, want)) {
    const lead = await ensureProjectLead(want);
    return { task: lead, kind: 'lead', project: (lead.project ?? want).trim() };
  }
  const task = await getTask(want).catch(() => null);
  if (!task) {
    throw new OrgError('unknown_contact', 404,
      `No project with open work or task named "${want}". To start new work there, create a task in that project (task_create).`);
  }
  // A lead that handed its project over: for an agent, the one who answers for that project is the
  // lead that took it (the human, and that lead itself, reach the old one). Through
  // ensureProjectLead, so a successor someone closed is brought back as a project name would.
  const project = (task.project ?? '').trim();
  const successor = task.org_role === 'lead' && opts.askerTaskId !== undefined ? successorOf(await orgTasks(), task) : undefined;
  if (successor && successor.id !== opts.askerTaskId) {
    const lead = await ensureProjectLead(project);
    if (lead.id !== task.id) return { task: lead, kind: 'lead', project, handedOverBy: { id: task.id, title: task.title } };
  }
  return { task, kind: task.org_role === 'lead' ? 'lead' : 'task', project };
}

/** The open lead the user named `want` (Task.org_name), with or without the role word. */
function namedLead(tasks: readonly OrgTaskLike[], want: string): OrgTaskLike | undefined {
  const key = projectKey(want.replace(/\s+(VP|lead)$/i, ''));
  if (!key) return undefined;
  return tasks.find((t) => t.org_role === 'lead' && t.phase !== 'COMPLETE' && t.org_name && projectKey(t.org_name) === key);
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
      if (n.userState === 'needs') out.push({ id: n.id, title: n.title });
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
            title: (p.lead?.name ? `${p.lead.name} VP` : p.lead?.title) ?? p.teams.find((t) => t.id === p.contactId)?.title ?? p.contactId,
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
    // Its own project's teams, and those of every project put under it.
    const nodes = tree.projects.filter((p) => p.lead?.id === of.id || projectKey(p.project) === projectKey(of.project));
    return { of: of.id, rows: nodes.flatMap((p) => p.teams).map((n) => row(n, 'team')) };
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
 * The note the next message into the main agent's (or a lead's, team-note.ts) session should carry, or
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
    // A lead hears its own teams' news the same way (team-note.ts).
    if (own?.org_role === 'lead' && own.phase !== 'COMPLETE') {
      const { pendingTeamNote } = await import('./team-note.js');
      return pendingTeamNote(own, sessionId, nowMs);
    }
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
