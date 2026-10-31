/**
 * Tasks pinned to an Org node (2026-10-31, the user, translated: "for this VP I have some tasks I want
 * to pin here ... it shows which ones are my special focus"; picked design B: a Pinned tab first in the node's Task
 * view, and the node's pins listed under its chat in the Org list, each unpinned right there).
 *
 * A pin is the user's focus on one node, kept apart from the board's own pins (Focus / Satellite /
 * Parked). It lives on the pinned task (`Task.org_pins`), one entry per node, so a task pinned to
 * the CEO and to its VP shows in both, and it goes wherever the task goes. A node is the Org page's
 * row key: `main` for the CEO, `project:<key>` for a VP (projectKey of its project). The user or
 * any agent pins and unpins (2026-10-27, the user: "all human action can be done by agent also");
 * each pin records who made it. Writes run inside the org lock, so two pins of one task at once
 * both land.
 */
import type { OrgPin, Task } from '../types.js';
import { log } from '../../logging/index.js';
import { OrgError, orgTasks, withOrgLock } from './org-store.js';
import { ORG_MAIN_NODE, nodePins, orgProjectNode, projectKey } from './org-tree.js';
import type { OrgWriter } from './org-node-edit.js';

/** A node holds at most this many pins: a focus list, not a second board. */
export const ORG_PINS_MAX = 50;

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

export interface PinResult { task: Task; node: string; nodeName: string; changed: boolean }

/** Pin `taskId` to `node` (as the caller named it), or take that pin off. Pinning twice changes nothing. */
export function setOrgPin(taskId: string, rawNode: string, pinned: boolean, writer: OrgWriter): Promise<PinResult> {
  return withOrgLock(async () => {
    const tm = await import('../task-manager.js');
    const task = await tm.getTask(taskId).catch(() => null);
    if (!task) throw new OrgError('task_not_found', 404, `No task with id "${taskId}".`);
    // A plugin's own task shows only in its plugin's view, so a pin of it would show nowhere.
    if (pinned && task.plugin_only) throw new OrgError('not_on_org', 409, `"${task.title}" shows only in its plugin's view, never on the Org page.`);
    const tasks = await orgTasks();
    // Unpinning takes any node the task holds, even one no row shows any more.
    // A project named by its name counts too: once another VP leads it, its pins still show under
    // that VP's row, and resolvePinNode names the VP's own node.
    const held = (n: string) => task.org_pins?.some((p) => p.node === n) ?? false;
    const raw = rawNode.trim();
    const node = !pinned && held(raw) ? raw
      : !pinned && raw && held(orgProjectNode(raw)) ? orgProjectNode(raw)
      : resolvePinNode(rawNode, tasks);
    if (!node) throw new OrgError('not_org_node', 404, `"${rawNode}" names no node of the org: pass "main", a project's name, or a VP's name.`);
    const pins = task.org_pins ?? [];
    const has = pins.some((p) => p.node === node);
    const nodeName = pinNodeName(node, tasks);
    if (has === pinned) return { task, node, nodeName, changed: false };
    // Counted as the page shows them: open tasks (a done one may be off the loaded list).
    if (pinned && nodePins(tasks.filter((t) => t.phase !== 'COMPLETE' && !t.plugin_only), node).length >= ORG_PINS_MAX) {
      throw new OrgError('too_many_pins', 409, `${nodeName} already holds ${ORG_PINS_MAX} open pins. Unpin one first.`);
    }
    const pin: OrgPin = { node, at: new Date().toISOString(), by: writer.by, ...(writer.byName ? { by_name: writer.byName } : {}) };
    // Read-modify-write of the row as stored, under the task's own lock: another write of the task
    // (a phase move, a sync pull) never takes the pin back out.
    const res = await tm.updateTaskRaw(task.id, (current) => {
      const now = current.org_pins ?? [];
      if (now.some((p) => p.node === node) === pinned) return null;
      const next = pinned ? [...now, pin] : now.filter((p) => p.node !== node);
      return { org_pins: (next.length ? next : null) as unknown as OrgPin[] };
    }, { emitEvent: true, source: 'api' });
    if (res.changed) log.task.info(pinned ? 'org: task pinned to a node' : 'org: task unpinned from a node', { taskId: task.id, node, by: writer.by });
    return { task: res.task ?? await tm.getTask(task.id), node, nodeName, changed: res.changed };
  });
}
