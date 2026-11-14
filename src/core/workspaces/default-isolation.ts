/**
 * A code task starts in its own isolated workspace by default.
 *
 * "A code task" here: the first session of an ordinary task, whose folder is one
 * a workspace provider claims on its host (a git repository for the built-in
 * git-worktree, a plugin's marker or detect step for a plugin provider). The
 * provider that claims the folder with the highest priority makes it, exactly the
 * one the draft's provider pills would pick (candidates.ts).
 *
 * Whether the default is on, most specific first:
 *
 *   the start itself     task_start / task_create `workspace: false` (no_workspace)
 *   the task's project   project setting `isolated_workspace`: 'on' | 'off'
 *   everyone else        the experiment `isolated_workspace_by_default` (Settings)
 *
 * Never isolated by default, whatever the settings say (each would be wrong):
 *   - a task that already has a workspace, or already ran a session (a continue,
 *     an engine switch, a transfer, a recovery keeps the folder its conversation ran in);
 *   - org nodes (Main, a VP, a lead, a router), Walnut's own agents, plugin tasks, router areas:
 *     they run in their own task directory, never in a repository copy;
 *   - a folder that is a task directory (the task's own or another's: it already is
 *     someone's private copy) or inside another task's workspace (a teammate shares
 *     its lead's copy on purpose, and a workspace is never made from inside one);
 *   - a top provider that needs inputs nobody gave (a list of packages): the start
 *     goes on in the folder, and the log says why;
 *   - a host that cannot answer in time: the start goes on in the folder.
 *
 * The draft (web) decides for its own Start: it shows the option on by default and
 * sends either a workspace or nothing (draft-workspace-model.ts).
 */

import type { Task } from '../types.js'
import type { WorkspaceCandidate } from './types.js'
import { workspaceCandidates } from './candidates.js'
import { log } from '../../logging/index.js'
import { KEEP_SOURCES } from '../sessions/start-placement.js'

export const ISOLATION_EXPERIMENT = 'isolated_workspace_by_default' as const
/** Project metadata key: 'on' isolates this project's code tasks, 'off' never does; absent follows the global setting. */
export const PROJECT_ISOLATION_KEY = 'isolated_workspace'
export type ProjectIsolation = 'on' | 'off'

/** Plugin detect steps get less time than the draft's (the start waits on it). */
const DEFAULT_DETECT_BUDGET_MS = 8_000

/** Starts that continue or move existing work (placement keeps their place too), or run a watcher, never a new piece of work. */
export const NOT_NEW_WORK: ReadonlySet<string> = new Set([...KEEP_SOURCES, 'router-runtime', 'routine', 'health-alarm'])

export function readProjectIsolation(meta: Record<string, unknown> | null | undefined): ProjectIsolation | undefined {
  const v = meta?.[PROJECT_ISOLATION_KEY]
  return v === 'on' || v === 'off' ? v : undefined
}

/** Is the default on for this start? Pure. */
export function isolationOn(input: { globalOn: boolean; project?: ProjectIsolation; optOut?: boolean }): boolean {
  if (input.optOut) return false
  if (input.project) return input.project === 'on'
  return input.globalOn
}

/** Why this task's start is never isolated by default (null: it may be). Pure. */
export function notACodeTaskStart(
  task: Pick<Task, 'workspace' | 'session_id' | 'exec_session_id' | 'session_ids' | 'phase' | 'org_role' | 'walnut_agent' | 'plugin_only' | 'router_area_id'>,
  params: { workspace?: unknown; noWorkspace?: boolean; idle?: boolean; source?: string; startAttemptId?: string },
): string | null {
  if (params.workspace) return 'the start names its own workspace'
  if (params.noWorkspace) return 'the start opted out (workspace: false)'
  if (task.workspace) return 'the task already has a workspace'
  if (task.session_id || task.exec_session_id || task.session_ids?.length) return 'the task already ran a session (its conversation keeps its folder)'
  if (task.phase === 'COMPLETE') return 'the task is complete'
  if (task.org_role) return `an org node (${task.org_role}) runs in its own directory`
  if (task.walnut_agent || task.plugin_only || task.router_area_id) return 'a Walnut agent, plugin or router task'
  if (params.idle) return 'an idle start'
  if (params.startAttemptId) return 'a confirmed launch keeps its frozen plan'
  const source = params.source ?? ''
  if (NOT_NEW_WORK.has(source) || source.startsWith('routine')) return `a ${source} start continues existing work`
  return null
}

function inside(child: string, parent: string): boolean {
  const p = parent.replace(/\/+$/, '')
  const c = child.replace(/\/+$/, '')
  return !!p && (c === p || c.startsWith(`${p}/`))
}

/** The default task-directory layout (lib/task-dir.ts), for a host whose root Walnut has not heard. */
const TASK_DIR_SHAPE = /\/open-walnut\/tasks\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}(\/|$)/

/** Why this folder is no place for a default workspace (null: it may be). Pure. */
export function notACodeFolder(cwd: string, ctx: { taskDirRoot?: string | null; workspaceRoots?: string[] }): string | null {
  if (!cwd || (!cwd.startsWith('/') && !cwd.startsWith('~/'))) return 'no folder'
  if ((ctx.taskDirRoot && inside(cwd, ctx.taskDirRoot)) || TASK_DIR_SHAPE.test(cwd)) return 'a task directory is already a task\'s own folder'
  const shared = (ctx.workspaceRoots ?? []).find((root) => inside(cwd, root))
  if (shared) return `it is inside the workspace ${shared}, which another task works in (a teammate shares its lead's copy on purpose)`
  return null
}

/**
 * The provider a default workspace uses: the best one that claims the folder, with
 * its fields' defaults and what its detect step suggested for the folder. None when nothing claims it, or the best needs inputs nobody gave. Pure.
 */
export function defaultProvider(candidates: WorkspaceCandidate[]): { pick: { provider: string; inputs: Record<string, unknown>; displayName: string } | null; why?: string } {
  const top = [...candidates].filter((c) => c.claimed).sort((a, b) => b.priority - a.priority)[0]
  if (!top) return { pick: null, why: 'no provider claims this folder' }
  const props = top.inputSchema?.properties ?? {}
  const inputs: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(props)) if (field.default !== undefined) inputs[key] = field.default
  // What its detect step suggested for this folder wins over the schema's defaults (only fields it declares).
  for (const [key, value] of Object.entries(top.inputs ?? {})) if (key in props) inputs[key] = value
  const missing = (top.inputSchema?.required ?? []).filter((k) => inputs[k] === undefined || inputs[k] === '' || (Array.isArray(inputs[k]) && !(inputs[k] as unknown[]).length))
  if (missing.length) return { pick: null, why: `${top.displayName} needs ${missing.map((k) => props[k]?.title ?? k).join(', ')}` }
  return { pick: { provider: top.provider, inputs, displayName: top.displayName } }
}

export interface DefaultWorkspaceDeps {
  globalOn(): Promise<boolean>
  projectIsolation(project: string | undefined): Promise<ProjectIsolation | undefined>
  candidates(cwd: string, host: string, budgetMs: number): Promise<{ candidates: WorkspaceCandidate[]; degraded?: string }>
  taskDirRoot(taskId: string, host: string): Promise<string | null>
  listTasks(): Promise<Task[]>
}

const realDeps: DefaultWorkspaceDeps = {
  async globalOn() {
    const { getConfig } = await import('../config-manager.js')
    const { experimentalEnabled } = await import('../experimental.js')
    return experimentalEnabled((await getConfig()).experimental, ISOLATION_EXPERIMENT)
  },
  async projectIsolation(project) {
    if (!project?.trim()) return undefined
    const { launchProjectName } = await import('../sessions/project-launch-defaults.js')
    const name = await launchProjectName(project)
    if (!name) return undefined
    const tm = await import('../task-manager.js')
    return readProjectIsolation(await Promise.resolve().then(() => tm.getProjectMetadata(name)).catch(() => null))
  },
  candidates: workspaceCandidates,
  async taskDirRoot(taskId, host) {
    const { taskDirForHost } = await import('../sessions/task-dir-place.js')
    const dir = await taskDirForHost(taskId, host).catch(() => null)
    return dir ? dir.replace(/\/[^/]+\/?$/, '') : null
  },
  async listTasks() {
    const tm = await import('../task-manager.js')
    return tm.listTasks()
  },
}

let deps: DefaultWorkspaceDeps = realDeps

export function __setDefaultWorkspaceDepsForTesting(next: Partial<DefaultWorkspaceDeps> | null): void {
  deps = next ? { ...realDeps, ...next } : realDeps
}

/** The roots of every workspace Walnut keeps on that host: a folder inside one is already a task's own copy. */
async function workspaceRootsOn(host: string): Promise<string[]> {
  return (await deps.listTasks().catch(() => [] as Task[]))
    .map((t) => t.workspace)
    .filter((ws): ws is NonNullable<Task['workspace']> => !!ws?.root && ws.state !== 'removed' && ws.host === host)
    .map((ws) => ws.root!)
}

/**
 * A draft's default sent before the host answered (`workspace: { auto: true }`): the provider
 * that claims the folder, with its inputs, or null (the folder itself). The draft showed the
 * default, so the settings are not read again here.
 */
export async function draftDefaultAsk(cwd: string, host: string): Promise<{ provider: string; inputs: Record<string, unknown> } | null> {
  try {
    const answer = await deps.candidates(cwd, host, DEFAULT_DETECT_BUDGET_MS)
    const pick = answer.degraded ? null : defaultProvider(answer.candidates).pick
    return pick ? { provider: pick.provider, inputs: pick.inputs } : null
  } catch {
    return null
  }
}

export interface DefaultWorkspace {
  /** The host it is made on: '__local__' or a config.hosts key. */
  host: string
  provider: string
  inputs: Record<string, unknown>
  displayName: string
}

/**
 * The workspace this start makes by default, or null (start in the folder as
 * before). `place` is where the start would run without one. Never throws: a
 * failure to decide is a start in the folder, logged.
 */
export async function defaultWorkspaceFor(
  task: Task,
  params: { workspace?: unknown; noWorkspace?: boolean; idle?: boolean; source?: string; startAttemptId?: string },
  place: () => Promise<{ cwd: string; host?: string; createTaskDir?: boolean }>,
): Promise<DefaultWorkspace | null> {
  const skip = (why: string, extra: Record<string, unknown> = {}) => {
    log.session.info('default workspace skipped', { taskId: task.id, why, ...extra })
    return null
  }
  try {
    const not = notACodeTaskStart(task, params)
    if (not) return null
    const { role } = await import('../server-role.js')
    if (role() === 'replica') return null
    const on = isolationOn({ globalOn: await deps.globalOn(), project: await deps.projectIsolation(task.project), optOut: params.noWorkspace })
    if (!on) return null
    const where = await place()
    const host = !where.host || where.host === 'local' ? '__local__' : where.host
    if (where.createTaskDir) return skip('it starts in its own task directory', { cwd: where.cwd })
    const folder = notACodeFolder(where.cwd, { taskDirRoot: await deps.taskDirRoot(task.id, host), workspaceRoots: await workspaceRootsOn(host) })
    if (folder) return skip(folder, { cwd: where.cwd, host })
    const answer = await deps.candidates(where.cwd, host, DEFAULT_DETECT_BUDGET_MS)
    if (answer.degraded) return skip(`the host could not say which providers claim the folder (${answer.degraded})`, { cwd: where.cwd, host })
    const { pick, why } = defaultProvider(answer.candidates)
    if (!pick) return skip(why ?? 'no provider', { cwd: where.cwd, host })
    log.session.info('default workspace chosen', { taskId: task.id, provider: pick.provider, cwd: where.cwd, host })
    return { ...pick, host }
  } catch (err) {
    return skip(`could not decide: ${err instanceof Error ? err.message : String(err)}`)
  }
}
