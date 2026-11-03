/**
 * The Org page's Watching (2026-11-02, the user, through his VP: "if it watching then concideras
 * pinnedl rename this to watching ... same wathcing as regular home pannel"). There is one list of
 * tasks the user keeps in view: the Watch of the home task panel (`Task.watched_at`). The Org page's
 * Watching tab of a node lists the watched tasks of that node's work, and its eye watches a task or
 * stops watching it, the same write as Home's.
 *
 * Before, a task was pinned to one Org node (`Task.org_pins`, 2026-10-31), a second list apart
 * from the watch. Those pins are carried over as watches (carryPinsToWatch, at the primary's boot);
 * the pins stay on the row for an older Walnut, which still shows them on its Pinned tab, and
 * stopping a watch takes them off too (task-manager updateTask), so a pin never brings a watch
 * back. The routes and the `org_pin` op that pinned now watch, so an older page or session that
 * still pins reaches the same list.
 */
import type { Task } from '../types.js';
import { log } from '../../logging/index.js';
import { OrgError, orgTasks } from './org-store.js';
import { ORG_MAIN_NODE, orgProjectNode, projectKey } from './org-tree.js';
import type { OrgWriter } from './org-node-edit.js';

type NodeTask = Pick<Task, 'project' | 'org_role' | 'org_name' | 'org_leads' | 'phase'>;

/** The row a project shows under: its own, or the VP that leads it now (Task.org_leads). */
function rowNode(project: string, tasks: readonly NodeTask[]): string {
  const key = projectKey(project);
  const lead = tasks.find((t) => t.org_role === 'lead' && t.phase !== 'COMPLETE' && projectKey(t.project) !== key
    && (t.org_leads ?? []).some((p) => projectKey(p) === key));
  return orgProjectNode(lead ? lead.project : project);
}

/**
 * The node a caller names: `main` / `CEO`, a node key (`project:<key>`), the name the user gave a
 * VP (with or without "VP"), or a project's name, with or without "VP" ("Inbox" for the Inbox). A
 * project another VP leads names that VP's node, the row it shows under. Null when it names no node.
 */
export function resolvePinNode(raw: string, tasks: readonly NodeTask[]): string | null {
  const want = raw.trim();
  if (!want) return null;
  if (/^(main|ceo)$/i.test(want)) return ORG_MAIN_NODE;
  const isProject = (key: string) => tasks.some((t) => projectKey(t.project) === key);
  const prefixed = want.match(/^project:(.*)$/i);
  if (prefixed) {
    const key = projectKey(prefixed[1]);
    return isProject(key) ? rowNode(key, tasks) : null;
  }
  // The whole words first (a project may be called "Field lead"), then without the role word.
  for (const name of [want, want.replace(/\s+(VP|lead)$/i, '')].map(projectKey)) {
    if (!name) continue;
    const named = tasks.find((t) => t.org_role === 'lead' && t.phase !== 'COMPLETE' && t.org_name && projectKey(t.org_name) === name);
    if (named) return orgProjectNode(named.project);
    if (isProject(name)) return rowNode(name, tasks);
  }
  if (/^inbox$/i.test(want)) return orgProjectNode('');
  return null;
}

/** A node as the user reads it: "the CEO", "the Fruit VP". */
export function pinNodeName(node: string, tasks: readonly NodeTask[]): string {
  if (node === ORG_MAIN_NODE) return 'the CEO';
  const key = node.slice('project:'.length);
  if (!key) return 'the Inbox';
  const lead = tasks.find((t) => t.org_role === 'lead' && t.phase !== 'COMPLETE' && projectKey(t.project) === key);
  const name = lead?.org_name?.trim() || tasks.find((t) => projectKey(t.project) === key)?.project?.trim() || key;
  return `the ${name} VP`;
}

/** The node a watched task shows under on the Org page: the VP whose work holds its project. */
export function watchNodeOf(task: Pick<Task, 'project'>, tasks: readonly NodeTask[]): string {
  return rowNode(task.project ?? '', tasks);
}

export interface WatchResult { task: Task; watched: boolean; node: string; nodeName: string; changed: boolean }

/**
 * Watch `taskId` (Home's Watching, shown on the Org page under the node its work belongs to), or
 * stop watching it. `rawNode` is what an older pin named; the task shows under its own node
 * whatever it names. Watching twice changes nothing.
 */
export async function setOrgWatch(taskId: string, watched: boolean, writer: OrgWriter, rawNode = ''): Promise<WatchResult> {
  const tm = await import('../task-manager.js');
  const task = await tm.getTask(taskId).catch(() => null);
  if (!task) throw new OrgError('task_not_found', 404, `No task with id "${taskId}".`);
  // A plugin's own task shows only in its plugin's view, so a watch of it would show on no Org node.
  if (watched && task.plugin_only) throw new OrgError('not_on_org', 409, `"${task.title}" shows only in its plugin's view, never on the Org page.`);
  // An older page or session still names a node; one that names none of the org is still refused,
  // so a typo is not taken for a watch.
  const tasks = await orgTasks();
  if (rawNode.trim() && watched && !resolvePinNode(rawNode, tasks)) {
    throw new OrgError('not_org_node', 404, `"${rawNode}" names no node of the org: pass "main", a project's name, or a VP's name, or no node at all.`);
  }
  const node = watchNodeOf(task, tasks);
  const nodeName = pinNodeName(node, tasks);
  const was = !!task.watched_at;
  // Stopping clears an old pin too, whether or not a watch was on (an older Walnut may have pinned it since).
  if (was === watched && (watched || !task.org_pins?.length)) return { task, watched, node, nodeName, changed: false };
  // The same write as Home's eye (PATCH watched_at), so every surface reads it the same way.
  const res = await tm.updateTask(task.id, { watched_at: watched ? new Date().toISOString() : '' }, { source: 'api' });
  log.task.info(watched ? 'org: task watched' : 'org: task no longer watched', { taskId: task.id, node, by: writer.by });
  return { task: res.task, watched, node, nodeName, changed: true };
}

/**
 * Carry every Org pin over as a watch: a task pinned to a node and not watched is watched from the
 * time of its first pin, so nothing the user pinned leaves his view. Runs once a boot on the
 * primary; a task with no pin left (a watch stopped takes them off) is never touched again.
 */
export async function carryPinsToWatch(): Promise<number> {
  const tm = await import('../task-manager.js');
  const due = (await tm.listTasks()).filter((t) => t.org_pins?.length && !t.watched_at && !t.plugin_only);
  let carried = 0;
  for (const t of due) {
    const first = t.org_pins!.map((p) => p.at).filter((at) => Number.isFinite(Date.parse(at))).sort()[0] ?? new Date().toISOString();
    try {
      // Raw, under the row's own lock: no updated_at bump, so no list reshuffles on upgrade.
      const res = await tm.updateTaskRaw(t.id, (cur) => (cur.watched_at || !cur.org_pins?.length ? null : { watched_at: first }), { emitEvent: true, source: 'internal' });
      if (res.changed) carried++;
    } catch (err) {
      log.task.warn('org: carrying a pin over as a watch failed', { taskId: t.id, error: String(err) });
    }
  }
  if (carried) log.task.info('org: pins carried over as watches', { carried });
  return carried;
}
