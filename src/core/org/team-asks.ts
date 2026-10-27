/**
 * Asks that go into a lead's team from outside it, kept for the lead's next team note
 * (team-note.ts). 2026-10-26: the main agent sent a project's worker a new request directly and
 * the project's lead never knew. A VP should know every new request into its teams: the user's
 * own message in a team task, the main agent's, another team's.
 *
 *   recorded   a message from a person (PERSON_SEND_SOURCES) or a peer note from a task outside
 *              the team, into a team task's session; never one from the lead or its own team
 *              (that is the team working), never a reply, never Walnut's own notices
 *   told       the lead's next team note lists them; then they are cleared
 *
 * WALNUT_HOME/org/team-asks.json, at most MAX_PER_LEAD per lead (the newest).
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { buildOrgTree, type OrgTaskNode } from './org-tree.js';
import type { TeamAsk } from './team-note.js';

const FILE = path.join(WALNUT_HOME, 'org', 'team-asks.json');
const MAX_PER_LEAD = 20;
const GIST_MAX = 200;

async function readAll(): Promise<Record<string, TeamAsk[]>> {
  try {
    const all = JSON.parse(await fs.readFile(FILE, 'utf8')) as Record<string, TeamAsk[]>;
    return all && typeof all === 'object' ? all : {};
  } catch {
    return {};
  }
}

let writing: Promise<unknown> = Promise.resolve();
function update(fn: (all: Record<string, TeamAsk[]>) => void): Promise<void> {
  const run = writing.then(async () => {
    const all = await readAll();
    fn(all);
    for (const k of Object.keys(all)) if (!all[k]?.length) delete all[k];
    const { writeFileAtomic } = await import('../config-manager.js');
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await writeFileAtomic(FILE, JSON.stringify(all, null, 2));
  });
  writing = run.catch(() => undefined);
  return run;
}

export async function pendingTeamAsks(leadId: string): Promise<TeamAsk[]> {
  const list = (await readAll())[leadId];
  return Array.isArray(list) ? list : [];
}

export function clearTeamAsks(leadId: string, ids: readonly string[]): Promise<void> {
  const gone = new Set(ids);
  return update((all) => { all[leadId] = (all[leadId] ?? []).filter((a) => !gone.has(a.id)); });
}

const ATTR = (name: string) => new RegExp(`\\b${name}="([^"]*)"`);
const ENTITIES: Record<string, string> = { '&quot;': '"', '&#39;': "'", '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
/** An attribute value as written (the envelope escapes it). */
const unescapeAttr = (v: string) => v.replace(/&(?:quot|#39|apos|lt|gt|amp);/g, (e) => ENTITIES[e] ?? e);

/** A peer note's sender and title, from its envelope; null for anything else (a reply, a notice). */
export function peerNoteSender(enqueued: string): { taskId: string; from: string; title: string } | null {
  const open = /^\s*<walnut-message\b[^>]*>/.exec(enqueued)?.[0];
  if (!open || !/\bkind="peer-note"/.test(open)) return null;
  const attr = (name: string) => unescapeAttr(ATTR(name).exec(open)?.[1] ?? '');
  const taskId = attr('from-task');
  // "Main [3ea08ceb]": the handle without its short id.
  const from = attr('from').replace(/\s*\[[0-9a-f]{6,}\]\s*$/i, '').trim();
  return { taskId, from: from || 'another task', title: attr('title').trim() };
}

function walk(nodes: readonly OrgTaskNode[], out: string[] = []): string[] {
  for (const n of nodes) { out.push(n.id); walk(n.workers, out); }
  return out;
}

/** The lead whose team holds `task`, and the ids of that team (the lead included); null when none. */
export function teamOf(tasks: readonly Task[], task: Task): { lead: Task; team: Set<string> } | null {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const tree = buildOrgTree(tasks);
  for (const p of tree.projects) {
    if (!p.lead) continue;
    const ids = walk(p.teams);
    if (!ids.includes(task.id)) continue;
    const lead = byId.get(p.lead.id);
    if (!lead || lead.phase === 'COMPLETE') return null;
    const team = new Set(ids);
    // Every project this lead leads is its team.
    for (const q of tree.projects) if (q.lead?.id === lead.id) for (const id of walk(q.teams)) team.add(id);
    team.add(lead.id);
    return { lead, team };
  }
  const parent = task.parent_task_id ? byId.get(task.parent_task_id) : undefined;
  if (parent?.org_role === 'lead' && parent.phase !== 'COMPLETE') return { lead: parent, team: new Set([parent.id, task.id]) };
  return null;
}

const gistOf = (text: string) => {
  const line = text.replace(/<[^>]+>/g, ' ').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > GIST_MAX ? `${line.slice(0, GIST_MAX - 1)}…` : line;
};

/**
 * Record a message into `sessionId` when it is an ask into a lead's team from outside the team.
 * `message` is what was said, `enqueued` the row as queued (a peer note's envelope), `messageId`
 * its queue row (a resend with the same id is the same ask). Never throws.
 */
export async function noteTeamAsk(
  sessionId: string, message: string, enqueued: string, source: string | undefined, messageId?: string,
): Promise<void> {
  try {
    const { PERSON_SEND_SOURCES } = await import('../session-message-queue.js');
    const person = PERSON_SEND_SOURCES.has(source ?? '');
    const peer = source === 'peer' ? peerNoteSender(enqueued) : null;
    if (!person && !peer) return;
    // The leader keeps the notes (pendingOrgDigest's rule): a replica's file nobody reads.
    const { role } = await import('../server-role.js');
    if (role() !== 'leader') return;
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const taskId = (await getSessionByClaudeId(sessionId))?.taskId;
    if (!taskId) return;
    const { listTasks } = await import('../task-manager.js');
    const tasks = await listTasks();
    const task = tasks.find((t) => t.id === taskId);
    // A plugin's own task (Task.plugin_only) is no team's work: what the user says there stays there.
    if (!task || task.org_role === 'lead' || task.org_role === 'main' || task.plugin_only || task.phase === 'COMPLETE') return;
    // Every person's and peer's send passes here: no open lead, no team.
    if (!tasks.some((t) => t.org_role === 'lead' && t.phase !== 'COMPLETE')) return;
    const owner = teamOf(tasks, task);
    if (!owner) return;
    if (peer && (!peer.taskId || owner.team.has(peer.taskId))) return; // the team working, or no sender to name
    const gist = gistOf(peer?.title || message);
    if (!gist) return;
    const ask: TeamAsk = {
      id: randomUUID(), taskId: task.id, title: task.title, from: peer ? peer.from : 'the user', gist, at: new Date().toISOString(),
      ...(messageId ? { messageId } : {}),
    };
    let fresh = true;
    await update((all) => {
      const list = all[owner.lead.id] ?? [];
      fresh = !messageId || !list.some((a) => a.messageId === messageId);
      if (fresh) all[owner.lead.id] = [...list, ask].slice(-MAX_PER_LEAD);
    });
    if (!fresh) return;
    log.session.info('team ask recorded', { sessionId, taskId: task.id, leadTaskId: owner.lead.id, from: peer ? peer.taskId : 'user' });
  } catch (err) {
    log.session.debug('team ask not recorded', { sessionId, error: err instanceof Error ? err.message : String(err) });
  }
}
