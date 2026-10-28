/**
 * Making and naming the org's nodes from the Org page (2026-10-26, the user: "in org chart should
 * be able to create VP or Project, project has a VP automatically, Create vp means a VP, don't
 * have a project that is fine, I usually will drag, in org chart during regular or creation, I
 * can define VP name, some Instruction").
 *
 *  - A new project is a project with its own VP: its lead, shaped as the one a project's first
 *    contact makes (org-store.ts ensureProjectLead).
 *  - A new VP is the same lead, marked `org_vp_only`: the project it lives in is only its home,
 *    so the chart lists that project only while it has open work. Projects are put under it by
 *    dragging them there (setProjectVp), as under any VP.
 *  - A VP's name is `org_name` (shown as "<name> VP", and an agent may address it by it); the
 *    title stays its session's own, which its turn-end topic may grow. The CEO keeps its name.
 *  - Instructions are the CEO's or a VP's standing instructions (Task.org_instructions), written
 *    by the user or by any agent (2026-10-27, the user: "all human action can be done by agent
 *    also"); each write records who wrote it (`by`, `by_name`), which the Org page shows and the
 *    prompt names. Its session prompt carries them (session-context.ts orgInstructionsLine), so a new or
 *    resumed session reads them, and a running one is told an edit by the instruction notice.
 *    Once set, they are never removed, only cleared (`text: ''`): a session's stored prompt may
 *    still hold the old words, and only a newer version (the cleared one) tells it to drop them.
 *
 * Every write runs inside the org lock, so two names checked at once cannot both be taken.
 */
import type { Task } from '../types.js';
import { log } from '../../logging/index.js';
import { bus, EventNames } from '../event-bus.js';
import { OrgError, ensureLeadNow, leadDescription, orgTasks, withOrgLock } from './org-store.js';
import { ORG_INSTRUCTIONS_MAX, isOrgMember, pickLead, pickOwnLead, projectKey } from './org-tree.js';
import { defaultOrgInstructions, isDefaultOrgInstructions } from './core-instructions.js';
import { orgInstructionsAuthor, type OrgInstructionsWriter } from './instructions-author.js';

/** Who writes: the user, or an agent (its task, and its name as the user reads it). */
export interface OrgWriter {
  by: OrgInstructionsWriter;
  byName?: string;
}

const USER: OrgWriter = { by: 'human' };

/**
 * A stamp of `text` by `writer`, now. A row the user wrote carries no name. An agent's words written
 * on the user's word (`forUser`: it passed override_user) count as the user's: they replace Walnut's
 * default in the prompt, as the user's own would.
 */
function stamp(text: string, writer: OrgWriter, forUser?: boolean): NonNullable<Task['org_instructions']> {
  const agent = writer.by !== 'human';
  return {
    text, at: new Date().toISOString(), by: writer.by,
    ...(agent && writer.byName ? { by_name: writer.byName } : {}),
    ...(agent && forUser ? { for_user: true } : {}),
  };
}

export const ORG_NAME_MAX = 60;

/** addTask announces nothing: a lead made here is shown to every open page by this event. */
function announceCreated(task: Task): void {
  bus.emit(EventNames.TASK_CREATED, { task }, ['web-ui'], { source: 'org-chart' });
}

/** A raw write to a closed lead, announced as an update (emitEvent would call it completed again). */
function announceUpdated(task: Task | undefined): void {
  if (task) bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'org-chart' });
}

function oneLine(raw: unknown, what: string): string {
  if (typeof raw !== 'string') throw new OrgError('bad_name', 400, `${what} must be a string.`);
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name) throw new OrgError('bad_name', 400, `${what} must not be empty.`);
  if (name.length > ORG_NAME_MAX) throw new OrgError('bad_name', 400, `${what} is at most ${ORG_NAME_MAX} characters.`);
  if (projectKey(name) === projectKey('Inbox')) throw new OrgError('bad_name', 400, 'The Inbox has no VP: pick another name.');
  // "Ask …" is where the console's agents keep their asks (sessions/ask-agent.ts).
  if (/^ask\s/i.test(name)) throw new OrgError('bad_name', 400, 'Names starting with "Ask" belong to the chat\'s agents: pick another.');
  return name;
}

/** A VP's name as typed, without the role word the UI adds ("Growth VP" is "Growth"). */
export function cleanVpName(raw: unknown): string {
  const name = oneLine(raw, 'The VP\'s name').replace(/\s+(VP|lead)$/i, '').trim();
  if (!name) throw new OrgError('bad_name', 400, 'The VP\'s name must not be empty.');
  return name;
}

/** `null` asks to remove them, which is a clear: see the module note. */
function cleanInstructions(raw: unknown): string {
  if (raw === null) return '';
  if (typeof raw !== 'string') throw new OrgError('bad_instructions', 400, '`instructions` must be a string.');
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (text.length > ORG_INSTRUCTIONS_MAX) {
    throw new OrgError('bad_instructions', 400, `Instructions are at most ${ORG_INSTRUCTIONS_MAX} characters (these are ${text.length}).`);
  }
  return text;
}

/**
 * An agent's own lines are read after Walnut's default for the role (core-instructions.ts), and
 * every editor opens on the two together, so together they keep within the limit: a box that
 * opened past it could not be saved as it stood. Words the user asked for replace the default.
 */
function refuseLongAgentLines(role: string | undefined, text: string, writer: OrgWriter, forUser?: boolean): void {
  const def = writer.by === 'human' || forUser ? '' : defaultOrgInstructions(role);
  if (!def || !text) return;
  const max = ORG_INSTRUCTIONS_MAX - def.length - 2;
  if (text.length > max) {
    throw new OrgError('bad_instructions', 400,
      `An agent's instructions are read after Walnut's default for the role (${def.length} characters), so they are at most ${max} characters (these are ${text.length}). `
      + 'Shorten them, or pass override_user when the user asked for words that replace the default.');
  }
}

/**
 * What `name` would collide with on the org chart, besides the node's own project: another open
 * VP's name or project (or one it leads), or a project with open work. Two cards with one name
 * read as one VP, and a VP named after a project it does not lead reads as that project's.
 */
function nameTaken(tasks: readonly Task[], name: string, own?: { id?: string; project?: string }): string | undefined {
  const key = projectKey(name);
  const mine = own?.project !== undefined ? projectKey(own.project) : undefined;
  for (const t of tasks) {
    if (t.phase === 'COMPLETE' || t.id === own?.id) continue;
    if (t.org_role === 'lead') {
      if (t.org_name?.trim() && projectKey(t.org_name) === key) return `the ${t.org_name.trim()} VP`;
      for (const p of [t.project ?? '', ...(t.org_leads ?? [])]) {
        if (projectKey(p) === key && projectKey(p) !== mine) return `the project ${p}`;
      }
    } else if (isOrgMember(t) && projectKey(t.project) === key && key !== mine) {
      return `the project ${t.project}`;
    }
  }
  return undefined;
}

function refuseTaken(tasks: readonly Task[], name: string, own?: { id?: string; project?: string }): void {
  const other = nameTaken(tasks, name, own);
  if (other) throw new OrgError('name_taken', 409, `"${name}" is already on the org chart (${other}): pick another name.`);
}

/**
 * A closed lead coming back starts clean; words it was told before are cleared, not dropped,
 * and the clear names who brought it back.
 */
function cleanSlate(task: Task | undefined, writer: OrgWriter): Partial<Task> {
  return {
    org_vp_only: null as unknown as boolean,
    org_name: null as unknown as string,
    org_leads: null as unknown as string[],
    org_instructions: (task?.org_instructions ? stamp('', writer) : null) as Task['org_instructions'],
  };
}

/**
 * The user's own words are theirs until an agent says the user asked for the change, as a Board
 * project status the user picked is (board_project_set override_user): an agent replacing or
 * clearing them, directly or by bringing a closed VP back, passes `override_user`.
 */
function refuseUserWords(prior: Task['org_instructions'], writer: OrgWriter, override: boolean | undefined): void {
  const userWrote = !!prior?.text.trim() && orgInstructionsAuthor(prior).usersWords;
  if (writer.by !== 'human' && userWrote && !override) {
    throw new OrgError('user_wrote', 409, 'The user wrote these instructions. Replace or clear them only when the user asked for it, and then pass override_user: true.');
  }
}

export interface NewOrgNodeInput {
  /** The project's name (a new project), or the VP's (a new VP). */
  name: unknown;
  /** A new project only: its VP's name, when not the project's. */
  vpName?: unknown;
  instructions?: unknown;
  /** An agent bringing back a closed VP whose instructions the user wrote says so (else 409 user_wrote). */
  overrideUser?: unknown;
}

/**
 * A new project with its own VP (`vpOnly` false), or a new VP to put projects under. Returns its
 * lead. `human`: asked for by name, by the user or an agent (a deleted project of that name comes
 * back, as POST /projects does); `writer`: who, for the instructions' stamp.
 */
export async function createOrgNode(input: NewOrgNodeInput, vpOnly: boolean, opts: { human?: boolean; writer?: OrgWriter } = {}): Promise<Task> {
  const name = vpOnly ? cleanVpName(input.name) : oneLine(input.name, 'The project\'s name');
  const vpName = !vpOnly && typeof input.vpName === 'string' && input.vpName.trim() ? cleanVpName(input.vpName) : '';
  const given = input.instructions === undefined ? '' : cleanInstructions(input.instructions);
  // A new VP saved with the default's own words follows the default.
  const instructions = isDefaultOrgInstructions('lead', given) ? '' : given;
  refuseLongAgentLines('lead', instructions, opts.writer ?? USER, input.overrideUser === true);
  return withOrgLock(async () => {
    const tm = await import('../task-manager.js');
    const tasks = await orgTasks();
    const key = projectKey(name);
    const open = tasks.some((t) => isOrgMember(t) && projectKey(t.project) === key);
    const lead = pickLead(tasks, name);
    const own = pickOwnLead(tasks, name);
    const openLead = [lead, own].find((t) => t && t.phase !== 'COMPLETE');
    if (open || openLead) {
      throw new OrgError('project_exists', 409,
        `"${name}" is already a project in the org${openLead ? ` (led by the ${openLead.org_name?.trim() || openLead.project} VP)` : ''}: `
        + 'pick another name, or drag that project where you want it.');
    }
    refuseTaken(tasks, name, { project: name });
    if (vpName) refuseTaken(tasks, vpName, { project: name });
    // A closed lead comes back below with a clean slate: checked before anything is written.
    if (own) refuseUserWords(own.org_instructions, opts.writer ?? USER, input.overrideUser === true);
    // A project the user deleted comes back on their explicit ask; a renamed one is not this one.
    const made = await tm.ensureProject(name, 'local', { writer: 'org-chart', human: opts.human === true }).catch((err: unknown) => {
      if (err instanceof tm.InvalidProjectNameError) throw new OrgError('bad_name', 400, err.message);
      throw err;
    });
    if (projectKey(made.name) !== key) {
      throw new OrgError('project_unavailable', 409, made.name
        ? `"${name}" was renamed to "${made.name}", which is a project already: drag that one where you want it.`
        : `"${name}" was a project that was deleted: make it again from the Board, or pick another name.`);
    }
    // A closed VP that still lists the project lets go of it, so the new lead is the one leading it.
    for (const t of tasks) {
      if (t.org_role !== 'lead' || t.phase !== 'COMPLETE' || projectKey(t.project) === key) continue;
      const rest = (t.org_leads ?? []).filter((p) => projectKey(p) !== key);
      // null clears a payload field.
      if (rest.length !== (t.org_leads ?? []).length) {
        announceUpdated((await tm.updateTaskRaw(t.id, { org_leads: rest.length ? rest : (null as unknown as string[]) }, { source: 'api' })).task);
      }
    }
    // A lead this project had, closed: it comes back with a clean slate, its history the project's.
    let id: string;
    if (own) {
      await tm.updateTask(own.id, { phase: 'TODO' }, { source: 'api' });
      id = own.id;
    } else {
      const { task } = await tm.addTask({
        title: `${made.name} lead`, project: made.name, source: 'local', org_role: 'lead', description: leadDescription([made.name]),
      });
      id = task.id;
    }
    const fields: Partial<Task> = { ...cleanSlate(own, opts.writer ?? USER) };
    if (vpOnly) fields.org_vp_only = true;
    if (vpName && projectKey(vpName) !== key) fields.org_name = vpName;
    if (instructions) fields.org_instructions = stamp(instructions, opts.writer ?? USER, input.overrideUser === true);
    // A new lead is announced whole once it is written; a reopened one by its own updates.
    await tm.updateTaskRaw(id, fields, { emitEvent: !!own, source: 'api' });
    log.task.info('org: node made on the Org page', { taskId: id, project: made.name, vpOnly, named: !!vpName, reopened: !!own, instructions: instructions.length });
    const final = await tm.getTask(id);
    if (!own) announceCreated(final);
    return final;
  });
}

export interface OrgNodeEdit {
  /** A VP's name; its project's name (or '') goes back to that. */
  name?: unknown;
  /** The node's standing instructions; '' (or null) clears them. */
  instructions?: unknown;
  /** An agent replacing or clearing words the user wrote says so (else 409 user_wrote). */
  overrideUser?: unknown;
}

interface CleanEdit { name?: string; instructions?: string; overrideUser?: boolean }

/** The edit's own checks, before anything is written. */
function cleanEdit(edit: OrgNodeEdit, role: string | undefined): CleanEdit {
  const out: CleanEdit = {};
  if (edit.name !== undefined) {
    if (role !== 'lead') throw new OrgError('bad_name', 400, 'The CEO keeps its name.');
    out.name = edit.name === '' ? '' : cleanVpName(edit.name);
  }
  if (edit.instructions !== undefined) out.instructions = cleanInstructions(edit.instructions);
  if (edit.overrideUser === true) out.overrideUser = true;
  return out;
}

/** editOrgNode's body, inside the org lock. */
async function editNow(task: Task, edit: CleanEdit, writer: OrgWriter): Promise<Task> {
  const tm = await import('../task-manager.js');
  const patch: Partial<Task> = {};
  if (edit.name !== undefined) {
    const own = edit.name && projectKey(edit.name) !== projectKey(task.project) ? edit.name : '';
    if (own !== (task.org_name?.trim() ?? '')) {
      if (own) refuseTaken(await orgTasks(), own, { id: task.id, project: task.project ?? '' });
      patch.org_name = (own || null) as string;
    }
  }
  if (edit.instructions !== undefined) {
    // The default's own words are no words of the user's: the role keeps following the default.
    const text = isDefaultOrgInstructions(task.org_role, edit.instructions) ? '' : edit.instructions;
    // Nothing set and nothing asked writes nothing; a clear of set words is a new version, and so
    // is an agent's own words made the user's on the user's word.
    const madeUsers = !!text && writer.by !== 'human' && edit.overrideUser === true && !orgInstructionsAuthor(task.org_instructions).usersWords;
    if ((text !== (task.org_instructions?.text ?? '') || madeUsers) && (text || task.org_instructions)) {
      refuseUserWords(task.org_instructions, writer, edit.overrideUser);
      refuseLongAgentLines(task.org_role, text, writer, edit.overrideUser);
      patch.org_instructions = stamp(text, writer, edit.overrideUser);
    }
  }
  if (Object.keys(patch).length) {
    await tm.updateTaskRaw(task.id, patch, { emitEvent: true, source: 'api' });
    log.task.info('org: node edited on the Org page', {
      taskId: task.id, role: task.org_role, named: 'org_name' in patch, instructions: patch.org_instructions?.text.length,
      by: patch.org_instructions?.by,
    });
  }
  return tm.getTask(task.id);
}

async function orgNode(taskId: string): Promise<Task> {
  const tm = await import('../task-manager.js');
  const task = await tm.getTask(taskId).catch(() => null);
  if (!task || (task.org_role !== 'main' && task.org_role !== 'lead')) {
    throw new OrgError('not_org_node', 404, `No CEO or VP with id "${taskId}".`);
  }
  return task;
}

/** Rename a VP, or set the CEO's or a VP's instructions. Unchanged fields write nothing. */
export async function editOrgNode(taskId: string, edit: OrgNodeEdit, writer: OrgWriter = USER): Promise<Task> {
  const task = await orgNode(taskId);
  const clean = cleanEdit(edit, task.org_role);
  return withOrgLock(async () => editNow(await orgNode(taskId), clean, writer));
}

/**
 * A project's VP: its name and instructions, its lead made first when the project has none (one
 * team, never talked to). Everything is checked before the lead is made, so a refused edit leaves
 * no lead behind; a closed lead brought back for it starts clean, as one a new project reopens.
 */
export async function editProjectVp(project: string, edit: OrgNodeEdit, writer: OrgWriter = USER): Promise<Task> {
  const name = project.trim();
  if (!name || projectKey(name) === projectKey('Inbox')) throw new OrgError('no_lead_for_inbox', 400, 'The Inbox has no VP.');
  const clean = cleanEdit(edit, 'lead');
  return withOrgLock(async () => {
    const tm = await import('../task-manager.js');
    const tasks = await orgTasks();
    const key = projectKey(name);
    const before = pickOwnLead(tasks, name);
    if (!before && !tasks.some((t) => isOrgMember(t) && projectKey(t.project) === key)) {
      throw new OrgError('unknown_project', 404, `No project "${name}" in the org.`);
    }
    // Checked as editNow will, against the lead that will take the edit (one the project was put
    // under leads it from its own project), before any lead is made or reopened.
    const target = pickLead(tasks, name);
    const home = target?.project ?? name;
    if (clean.name && projectKey(clean.name) !== projectKey(home)) refuseTaken(tasks, clean.name, { id: target?.id, project: home });
    // A new lead is announced by ensureLeadNow; a reopened one by its updates.
    // A closed own lead comes back with a clean slate (below): the user's words in it are checked first.
    if (target?.phase === 'COMPLETE' && before?.id === target.id) refuseUserWords(target.org_instructions, writer, clean.overrideUser);
    const lead = await ensureLeadNow(name);
    if (before?.phase === 'COMPLETE' && before.id === lead.id) {
      await tm.updateTaskRaw(lead.id, cleanSlate(before, writer), { emitEvent: true, source: 'api' });
    }
    return editNow(await tm.getTask(lead.id), clean, writer);
  });
}
