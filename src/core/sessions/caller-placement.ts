/**
 * Where work created FROM INSIDE a task lands.
 *
 * A coding session that files a task (because the user asked it to) used to put
 * it wherever the arguments said, and the arguments usually said nothing: the
 * task went to the Inbox, outside any folder, and its first run started in a
 * memory directory instead of the repo the caller was working in. Agents wrote
 * `task_create {"title":...}` and the board filled with orphans.
 *
 * The rule now, enforced here on the server so every surface (CLI shim, MCP,
 * daemon gateway) gets it from one request, cascades like this:
 *
 *     explicit argument  →  the calling task's value  →  the container default
 *
 *   - project: the caller's project unless the call names one ('' = Inbox, on
 *     purpose).
 *   - folder:  only inside the caller's project, and the folder tree follows
 *     the subtask tree. The caller's folder when its open tasks are only the
 *     caller and its own subtasks (finished tasks and subfolders don't count:
 *     the board hides the one and files the other apart); when it holds other
 *     open work too, a SUBFOLDER of it named after the caller, holding the
 *     caller and the new task (the caller moves in); when the caller has no
 *     folder, a new folder holding both (the same
 *     shape a fork produces). A folder made for the caller this way (or found
 *     holding only its family) stays the family's home (`family_group_id`):
 *     later subtasks join it even after other work lands there, instead of
 *     moving the family one level deeper per newcomer. A folder never follows
 *     work into another project, because a folder is that project's private
 *     structure.
 *   - parent: whatever a session files is a SUBTASK of that session's task
 *     (`parent_task_id`), the same relation a promoted side question gets:
 *     in the caller's project, in another one, and from a Personal AI
 *     conversation too. The board marks it with a Sub pill that leads back to
 *     the parent, and the parent counts it, so work an agent split off stays
 *     visibly attached to the work it came from wherever it lands.
 *   - tier: where on the board the caller sits (pinned, and its focus tier:
 *     Focus, Satellite, Parked or a custom tier; or unpinned). A worker's
 *     new task is born in the SAME tier unless the call names `pinned` or a
 *     `focus_tier`: work split off a Focus task is Focus work, and the user moves
 *     it later if not (user report 2026-09-25: a Focus task's subtask landed in
 *     Satellite). The tier follows work into another project too, because a tier
 *     is board-wide, not a project's structure.
 *   - host + cwd: travel together (a cwd is only meaningful on its host). At
 *     create time the caller's cwd is stamped on the task when it belongs to the
 *     host the task would launch on anyway; at start time a task with no cwd of
 *     its own takes the caller's host AND cwd as a pair.
 *
 * Only a WORKER caller (a session running a regular task) is placed from. The
 * Personal AI's own conversations are sessions too, but their tasks live in the
 * `Ask …` projects, and filing the user's work there would bury it: an ask keeps
 * the old defaults for project, folder, tier and cwd and only gets the parent
 * link (an ask often sits in Wait, which would park the work it files).
 * Humans and external processes keep the old behaviour entirely. The cloud
 * companion reads its caller from the projections the Mac pushes
 * (resolveCallerOnReplica) and files no folder (it holds none): the Mac places
 * the task beside its parent's folder when it takes the create.
 */

import path from 'node:path';
import { CLOUD_MODE, PROJECTS_MEMORY_DIR } from '../../constants.js';
import { bus, EventNames } from '../event-bus.js';
import { log } from '../../logging/index.js';

/** The caller's task, as placement needs it. */
export interface CallerTask {
  id: string;
  title: string;
  project: string;
  group_id?: string;
  group_label?: string;
  /** On the pinned board. Absent = not known (a hand-built caller in a test). */
  pinned?: boolean;
  /** The pinned tier; absent on a pinned task = Satellite. */
  focus_tier?: string;
  /** A project lead (org/org-tree.ts): its work lands in its project as top-level work, never in a folder. */
  orgLead?: boolean;
  /** A lead's other projects (Task.org_leads): its own as much as its task's project. */
  orgLeads?: string[];
}

/** The caller's session, as launch inheritance needs it. '' host = this box. */
export interface CallerSession {
  id: string;
  host: string;
  cwd?: string;
}

export type CallerPlacement =
  | { kind: 'human' }
  | { kind: 'external' }
  | { kind: 'unknown' }
  | { kind: 'untracked'; session: CallerSession }
  | { kind: 'ask'; task: CallerTask; session: CallerSession }
  | { kind: 'worker'; task: CallerTask; session: CallerSession };

/** Case-insensitive project identity (matches the registry's COLLATE NOCASE). */
export function sameProject(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

/** '' / '__local__' / 'local' / undefined all mean this box. */
export function normalizeHost(host: string | undefined | null): string {
  const h = (host ?? '').trim();
  return h === '__local__' || h === 'local' ? '' : h;
}

/**
 * Classify the caller behind an `x-walnut-caller-sid` header. Reads the task's
 * LIVE project and folder: `SessionRecord.project` is stamped when the session
 * starts and goes stale the moment the task moves.
 */
export async function resolveCallerPlacement(callerSid: string | undefined): Promise<CallerPlacement> {
  const sid = (callerSid ?? '').trim();
  if (!sid) return { kind: 'human' };
  if (CLOUD_MODE) return resolveCallerOnReplica(sid);
  const { resolveCaller } = await import('./session-send-core.js');
  const caller = await resolveCaller(sid).catch(() => ({ kind: 'external' as const }));
  if (caller.kind !== 'session') return { kind: caller.kind === 'human' ? 'human' : 'external' };
  const record = caller.record;
  const session: CallerSession = {
    id: record.claudeSessionId,
    host: normalizeHost(record.host),
    ...(record.cwd ? { cwd: record.cwd } : {}),
  };
  if (!record.taskId) return { kind: 'untracked', session };
  const { getTask, listFolderLabels } = await import('../task-manager.js');
  const task = await getTask(record.taskId).catch(() => undefined);
  if (!task) return { kind: 'untracked', session };
  const groupId = task.group_id || undefined;
  const label = groupId ? (await listFolderLabels().catch(() => new Map<string, string>())).get(groupId) : undefined;
  const callerTask: CallerTask = {
    id: task.id,
    title: task.title,
    project: task.project ?? '',
    ...(groupId ? { group_id: groupId } : {}),
    ...(label ? { group_label: label } : {}),
    pinned: Boolean(task.pinned),
    ...(task.pinned && task.focus_tier ? { focus_tier: task.focus_tier } : {}),
    ...(task.org_role === 'lead' ? { orgLead: true } : {}),
    ...(task.org_role === 'lead' && task.org_leads?.length ? { orgLeads: [...task.org_leads] } : {}),
  };
  return { kind: isAskTask(task) ? 'ask' : 'worker', task: callerTask, session };
}

/**
 * The same caller on the cloud companion, which keeps no session registry: the session
 * projection the Mac pushes names each session's task and where it stood, and the task
 * projection that task's live project, board tier and org role. 2026-10-15: while the Mac
 * was away a lead's create reached the companion, which read every session as unknown, so
 * its worker was born in the project the lead had guessed, with no parent link. A session
 * neither projection knows stays unknown (the old behaviour).
 */
async function resolveCallerOnReplica(sid: string): Promise<CallerPlacement> {
  const [{ readSessionProjection }, { readTaskProjection }] = await Promise.all([
    import('../session-projection.js'), import('../task-projection.js'),
  ]);
  const row = (await readSessionProjection().catch(() => null))?.sessions?.find((s) => s.id === sid);
  if (!row) return { kind: 'unknown' };
  const session: CallerSession = { id: sid, host: normalizeHost(row.host), ...(row.cwd ? { cwd: row.cwd } : {}) };
  if (!row.task_id) return { kind: 'untracked', session };
  const task = (await readTaskProjection().catch(() => null))?.tasks.find((t) => t.id === row.task_id);
  const project = task ? task.project ?? '' : row.project ?? '';
  // The folder rides the session row only; it is the task's while the task is still where the row saw it.
  const folder = row.group_id && sameProject(project, row.project) ? row.group_id : undefined;
  const pinned = task ? Boolean(task.pinned) : row.pinned;
  const tier = task ? task.focus_tier : row.focus_tier;
  const callerTask: CallerTask = {
    id: row.task_id,
    title: task?.title ?? row.task_title ?? '',
    project,
    ...(folder ? { group_id: folder } : {}),
    ...(folder && row.group_label ? { group_label: row.group_label } : {}),
    ...(typeof pinned === 'boolean' ? { pinned } : {}),
    ...(pinned && tier ? { focus_tier: tier } : {}),
    ...(task?.org_role === 'lead' ? { orgLead: true } : {}),
    ...(task?.org_role === 'lead' && task.org_leads?.length ? { orgLeads: [...task.org_leads] } : {}),
  };
  return { kind: isAskTask({ project, walnut_agent: task?.walnut_agent === true }) ? 'ask' : 'worker', task: callerTask, session };
}

/**
 * A Personal AI conversation: born `walnut_agent`, or filed under an agent's
 * `Ask …` project (the same two tests the chat drawer uses to list asks).
 */
export function isAskTask(task: { walnut_agent?: boolean; project?: string }): boolean {
  return task.walnut_agent === true || /^ask /i.test((task.project ?? '').trim());
}

/** What a create request asked for (undefined = not said). */
export interface PlacementRequest {
  project?: string;
  group_id?: string;
  /** Where the first start was told to run (task_create's cwd / host). Hints
   *  only: they decide what cwd the task records, never where it is filed. */
  launch_cwd?: string;
  launch_host?: string;
}

/** What the create should do. `project` undefined = let addTask apply its own default. */
export interface PlacementDecision {
  project?: string;
  group_id?: string;
  /** Once the task exists, file it beside the caller (joinOrCreateSiblingFolder
   *  with `nest`): the caller's folder, a subfolder of it, or a new folder. */
  placeBesideCaller: boolean;
  /** Set when the caller's placement was used (project, folder or both). */
  inheritedFrom?: string;
  /** The caller's task, for any session caller (worker or ask): the parent,
   *  wherever the new task lands. */
  parentTaskId?: string;
}

/** Pure: the placement rule table (see the module header). */
export function decidePlacement(req: PlacementRequest, caller: CallerPlacement): PlacementDecision {
  const explicitGroup = req.group_id === undefined ? undefined : (req.group_id || undefined);
  if (caller.kind === 'ask') {
    // Its `Ask …` project is never a place for the user's work, but the work
    // is still this conversation's: the parent link and nothing else.
    return { project: req.project, group_id: explicitGroup, placeBesideCaller: false, parentTaskId: caller.task.id };
  }
  if (caller.kind !== 'worker') {
    return { project: req.project, group_id: explicitGroup, placeBesideCaller: false };
  }
  const project = req.project !== undefined ? req.project : caller.task.project;
  const own = sameProject(project, caller.task.project);
  const parent = { parentTaskId: caller.task.id };
  // A lead's work is one of its project's teams: in the project, at the top, never in a folder made for the lead.
  if (caller.task.orgLead) {
    return {
      project, group_id: explicitGroup, placeBesideCaller: false,
      ...(req.project === undefined ? { inheritedFrom: caller.task.id } : {}),
      ...parent,
    };
  }
  // A folder is inherited only inside the caller's own project.
  if (req.group_id !== undefined || !own) {
    return {
      project,
      group_id: explicitGroup,
      placeBesideCaller: false,
      ...(req.project === undefined ? { inheritedFrom: caller.task.id } : {}),
      ...parent,
    };
  }
  // Join, nest or create is decided under the store lock against the caller's
  // CURRENT folder (placeInFolderBeside), never from this snapshot.
  return { project, placeBesideCaller: true, inheritedFrom: caller.task.id, ...parent };
}

/** Quoted words shorter than this are a token, not the user's request. */
export const PROJECT_WORDS_MIN = 4;

/** Lower case, letters and digits only (any script): "Lantern-Ops" and "lantern ops" read alike. */
function squash(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** The words of a text: "AcmeGenAIDocs" is acme, gen, ai, docs; "Lantern-Ops" two. */
function wordsOf(text: string): string[] {
  return text
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

/** "inbox" as a word, and the Chinese word for it. */
const INBOX_WORDS = /(^|[^a-z])inbox($|[^a-z])|\u6536\u4ef6\u7bb1/i;

/**
 * Do the user's words name this project? The whole name, starting and ending on word
 * edges ("Lantern Ops" in "put it under lantern-ops", "tidepool" for "Context
 * Hub"), or every word of it as a word ("the context of rail top" for "RailTopContext").
 * Part of a word never counts: "Personal" is not in "personally", "AI" not in "said". A
 * name in a script written without spaces (Chinese) is found anywhere in the words. ''
 * (the Inbox) is named by "inbox".
 */
export function projectNamedIn(words: string, project: string): boolean {
  const name = project.trim();
  if (!name) return INBOX_WORDS.test(words);
  const whole = squash(name);
  if (!whole) return false;
  if (!/^[a-z0-9]+$/.test(whole)) return squash(words).includes(whole);
  const said = wordsOf(words);
  // The whole name over a run of whole words.
  for (let i = 0; i < said.length; i++) {
    let run = '';
    for (let j = i; j < said.length && run.length < whole.length; j++) {
      run += said[j];
      if (run === whole) return true;
    }
  }
  const parts = wordsOf(name);
  return parts.length > 1 && parts.every((p) => said.includes(p));
}

/**
 * A worker files work only in its own project, unless the USER asked for another one.
 * 2026-10-14 and again 2026-10-15: a leader named a project it guessed from its
 * repository's name, and its worker landed outside the team. An agent-written
 * `project_reason` used to be enough; it is not any more (2026-10-29, the user: "it should
 * create the worker under itself, unless it was explicitly mentioned"). The create must
 * quote the user's own words naming that project (`user_words`, as answering a letter for
 * the user does), or it is refused with where it would have landed. A lead files in every
 * project it leads (the org chart put them under it). Null = go ahead. Asks, humans and
 * other callers are never asked.
 */
export function projectElsewhereRefusal(
  req: { project?: string; user_words?: unknown },
  caller: CallerPlacement,
): string | null {
  if (caller.kind !== 'worker' || req.project === undefined) return null;
  if (sameProject(req.project, caller.task.project)) return null;
  if (caller.task.orgLeads?.some((p) => sameProject(req.project!, p))) return null;
  const words = typeof req.user_words === 'string' ? req.user_words.replace(/\s+/g, ' ').trim() : '';
  if (words.length >= PROJECT_WORDS_MIN && projectNamedIn(words, req.project)) return null;
  const name = (p: string) => (p.trim() ? `project "${p.trim()}"` : 'the Inbox');
  const folder = caller.task.group_label ? `, folder "${caller.task.group_label}"` : '';
  const quoted = words ? ` The words you passed ("${words.length > 120 ? `${words.slice(0, 120)}\u2026` : words}") do not name ${name(req.project)}.` : '';
  return `Your task "${caller.task.title}" (${caller.task.id}) is in ${name(caller.task.project)}${folder}. `
    + 'Omit project and the new task lands beside yours, as your subtask. '
    + `File it in ${name(req.project)} only when the user asked for that: pass user_words with exactly what they `
    + 'said (quoted, in their language), naming that project. A project you picked yourself (from a repository, '
    + `a directory or a reason you wrote) is not the user's, and project_reason alone no longer files it there.${quoted}`;
}

/**
 * Where a task stands, for the worker rules. The companion's own rows carry no parent link
 * or org projects (its import keeps the board fields), so there the task projection the Mac
 * pushed answers.
 */
async function taskPlace(id: string): Promise<{
  id: string; title: string; project?: string; parent_task_id?: string; org_role?: string; org_leads?: string[]; walnut_agent?: boolean;
} | undefined> {
  if (CLOUD_MODE) {
    const { readTaskProjection } = await import('../task-projection.js');
    return (await readTaskProjection().catch(() => null))?.tasks.find((t) => t.id === id);
  }
  const { getTask } = await import('../task-manager.js');
  return getTask(id).catch(() => undefined);
}

/**
 * A lead moving its own worker (a task with a parent) into a project other than the lead's,
 * or the worker moving itself there, which is how a stray is made after the create. The same
 * rule as a create: only with the user's words naming that project (or into a project the
 * lead leads). Only that session is asked: humans, plugins, other sessions and unknown
 * callers never are. Null = go ahead.
 */
export async function workerMoveRefusal(input: {
  task: { id: string; title: string; project?: string; parent_task_id?: string };
  /** The project the write sets. */
  project: string;
  /** The parent after the write: '' = released, undefined = the task's own. */
  parentTaskId?: string;
  userWords?: unknown;
  /** Who writes (resolveCallerPlacement of the request's caller header). */
  caller: CallerPlacement;
}): Promise<string | null> {
  const { caller } = input;
  if (caller.kind !== 'worker') return null;
  if (sameProject(input.project, input.task.project)) return null;
  const parentId = input.parentTaskId !== undefined
    ? input.parentTaskId
    : input.task.parent_task_id || (CLOUD_MODE ? (await taskPlace(input.task.id))?.parent_task_id : undefined);
  if (!parentId) return null;
  // Only the lead's own worker, moved by the lead or by the worker itself. Tidying other
  // teams' work stays an agent's call (Main's reorg moves tasks between projects).
  if (caller.task.id !== parentId && caller.task.id !== input.task.id) return null;
  const parent = await taskPlace(parentId);
  // An ask (the Personal AI, Main) files work wherever it belongs: its own project is no team's.
  if (!parent || isAskTask(parent)) return null;
  if (sameProject(input.project, parent.project)) return null;
  if (parent.org_role === 'lead' && parent.org_leads?.some((p) => sameProject(input.project, p))) return null;
  const words = typeof input.userWords === 'string' ? input.userWords.replace(/\s+/g, ' ').trim() : '';
  if (words.length >= PROJECT_WORDS_MIN && projectNamedIn(words, input.project)) {
    log.session.info('worker moved to another project as the user asked', {
      taskId: input.task.id, parentId, project: input.project, callerSid: caller.session.id, userWords: words.slice(0, 300),
    });
    return null;
  }
  const name = (p: string) => (p.trim() ? `project "${p.trim()}"` : 'the Inbox');
  return `"${input.task.title}" (${input.task.id}) is a worker of "${parent.title}" (${parent.id}), and a worker stays `
    + `in its lead's project, ${name(parent.project ?? '')}. Move it to ${name(input.project)} only when the user asked `
    + 'for that: pass user_words with exactly what they said (quoted, in their language), naming that project. '
    + 'A project you picked yourself is not the user\'s.'
    + (words ? ` The words you passed ("${words.length > 120 ? `${words.slice(0, 120)}\u2026` : words}") do not name ${name(input.project)}.` : '');
}

/**
 * The board tier a worker's new task is born in: the caller's own, unless the
 * create names `pinned` or a `focus_tier` (''/null = not named). Undefined =
 * nothing inherited, and the route's defaults apply (Satellite for a create).
 * Only a worker: an ask's tier is where the conversation is parked, not where
 * the work belongs.
 */
export function inheritedTier(
  req: { pinned?: unknown; focus_tier?: unknown },
  caller: CallerPlacement,
): { pinned: boolean; focus_tier?: string } | undefined {
  if (caller.kind !== 'worker' || typeof caller.task.pinned !== 'boolean') return undefined;
  if (req.pinned !== undefined) return undefined;
  if (typeof req.focus_tier === 'string' && req.focus_tier.trim() !== '') return undefined;
  if (!caller.task.pinned) return { pinned: false };
  return caller.task.focus_tier ? { pinned: true, focus_tier: caller.task.focus_tier } : { pinned: true };
}

/**
 * The cwd a task a worker creates should RECORD, or undefined.
 *
 * A task stores a cwd but no host: a later start from the board runs it on the
 * project's default host. So a cwd is recorded only when it belongs to that
 * host, otherwise a restart sends a path to a machine it does not exist on:
 *   - the create names a host: record its cwd only if that host IS the default;
 *   - it names only a cwd: that cwd (its start runs on the default host too);
 *   - it names neither and lands in the caller's project: the caller's cwd, when
 *     the caller runs on the default host and the cwd is not simply the default
 *     the task would get anyway (recording that would freeze it, so a later
 *     change of the project's default_cwd would no longer reach this task).
 */
export async function createTimeCwd(
  req: PlacementRequest,
  caller: CallerPlacement,
  decision: PlacementDecision,
): Promise<string | undefined> {
  if (caller.kind !== 'worker') return undefined;
  const project = decision.project ?? '';
  const { getProjectMetadata } = await import('../task-manager.js');
  const meta = await getProjectMetadata(project).catch(() => null);
  const defaultHost = normalizeHost(meta?.default_host);
  if (req.launch_host !== undefined) {
    return normalizeHost(req.launch_host) === defaultHost ? req.launch_cwd : undefined;
  }
  if (req.launch_cwd !== undefined) return req.launch_cwd;
  const cwd = caller.session.cwd;
  if (!cwd || !sameProject(project, caller.task.project) || caller.session.host !== defaultHost) return undefined;
  const memoryDir = path.join(PROJECTS_MEMORY_DIR, (project || 'inbox').toLowerCase());
  return cwd === meta?.default_cwd || cwd === memoryDir ? undefined : cwd;
}

/**
 * The host + cwd pair a start inherits from its caller, or undefined. Applies
 * only to a worker starting another task of its own project that names neither
 * and has no cwd of its own (task / parent chain), so an explicit or recorded
 * place always wins and the pair never splits across machines.
 */
export async function inheritedLaunchPair(
  callerSid: string | undefined,
  task: { id: string; project?: string },
): Promise<{ host: string; cwd: string } | undefined> {
  const caller = await resolveCallerPlacement(callerSid).catch(() => undefined);
  if (caller?.kind !== 'worker' || !caller.session.cwd) return undefined;
  if (caller.task.id === task.id || !sameProject(task.project, caller.task.project)) return undefined;
  const host = caller.session.host;
  if (host) {
    const { getConfig } = await import('../config-manager.js');
    const entry = (await getConfig()).hosts?.[host];
    if (!entry || entry.enabled === false) {
      log.session.warn('caller host is not usable, launching from project defaults', { host, taskId: task.id });
      return undefined;
    }
  }
  return { host, cwd: caller.session.cwd };
}

/**
 * Put `newTaskId` beside `source`: into the source's folder when it has one,
 * otherwise into a new folder holding both, labelled with the source title and
 * refined to an AI group name in the background. `nest` (a subtask) nests
 * instead of joining a folder shared with other work (placeInFolderBeside).
 * Best-effort: a failure leaves the new task standalone in its project and is
 * reported, never thrown. Shared by forks and side-thread promotion (siblings,
 * never nested) and caller placement (subtasks, nested).
 */
export async function joinOrCreateSiblingFolder(
  source: { id: string; title: string; group_id?: string },
  newTaskId: string,
  opts: { eventSource: string; refineTitles?: string[]; nest?: boolean },
): Promise<{ groupId?: string; label?: string; created: boolean; parentId?: string; error?: string }> {
  const { placeInFolderBeside, renameGroup } = await import('../task-manager.js');
  try {
    // One write lock decides join-or-create against the source's CURRENT folder
    // (a stale "no folder" must never merge a folder the user just made).
    const r = await placeInFolderBeside(source.id, newTaskId, source.title, { nest: opts.nest });
    if (!r.created) return { groupId: r.group_id, label: r.label, created: false };
    bus.emit(EventNames.TASK_GROUPS_CHANGED, {
      group_id: r.group_id, label: r.label, ...(r.parent_id ? { parent_id: r.parent_id } : {}),
    }, ['web-ui'], { source: opts.eventSource });
    const gid = r.group_id;
    const titles = opts.refineTitles ?? [source.title];
    void (async () => {
      try {
        const { summarizeGroupLabel } = await import('../fork-title.js');
        const label = await summarizeGroupLabel(titles);
        if (!label) return;
        await renameGroup(gid, label);
        bus.emit(EventNames.TASK_GROUPS_CHANGED, { group_id: gid, label }, ['web-ui'], { source: opts.eventSource });
        log.session.info('sibling folder label refined', { groupId: gid, label });
      } catch (err) {
        log.session.warn('sibling folder label refine failed', {
          groupId: gid, error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return { groupId: gid, label: r.label, created: true, ...(r.parent_id ? { parentId: r.parent_id } : {}) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.session.warn('could not put the new task beside its source', {
      sourceTaskId: source.id, newTaskId, error,
    });
    return { created: false, error };
  }
}
