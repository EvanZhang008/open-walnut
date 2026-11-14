/**
 * Project scripts: named commands of a project or a repository.
 *
 * Two lists, one view:
 *  - the project's own (project metadata `scripts`, edited in the UI);
 *  - the repository's file, `walnut.json` at the git top of the folder, read
 *    live on its host.
 *
 * A script runs three ways:
 *  - by hand from a session's Scripts menu: the browser types it into the
 *    session's terminal (nothing here runs it);
 *  - `setup`: right after an isolated workspace is made (manager.ts runCreate).
 *    With `wait` (the default) the task's first session starts only after it
 *    ends; it starts either way, and its prompt says how setup went;
 *  - `teardown`: when the task completes, before the cleanup check (cleanup.ts),
 *    once per completion.
 * Setup and teardown are daemon jobs (`workspace.runScript`, capability
 * workspace-scripts-v1) that run only inside a workspace root. The project's
 * setup (teardown) script wins over the file's.
 *
 * A file's setup or teardown runs by itself only once the user allowed that
 * exact file (its content hash, scripts-trust.ts): a branch
 * someone else wrote must not run commands on this machine unasked. Until then
 * the run is recorded as skipped, with the reason, and "Run setup again" (a
 * person's own click) still runs it.
 */

import { createHash } from 'node:crypto'
import type { Task } from '../types.js'
import type { ProjectScript, ProjectScriptSource, ResolvedProjectScript, TaskWorkspace, WorkspaceScriptRun } from './types.js'
import { WorkspaceError, replyError, hostLabel } from './daemon-client.js'
import { isLaunchReady, setupBlocksLaunch, setupHoldsLaunch } from './decisions.js'
import { LOST_SLACK_MS, START_RPC_MS, errText, managerDeps, madeHere, pollJob, stamp } from './manager.js'
import { log } from '../../logging/index.js'

export const MAX_SCRIPTS = 32
const NAME_MAX = 60
const COMMAND_MAX = 4000
const DEFAULT_TIMEOUT_S = 900
const MAX_TIMEOUT_S = 3600
/** How much of a run's output the task row keeps. */
const OUTPUT_KEEP = 4000
const FILE_RPC_MS = 15_000
/** A running script's progress line is written to the task row at most this often. */
const PROGRESS_WRITE_MS = 5_000
export const UNTRUSTED_FILE_ERROR = 'this walnut.json is new or changed since it was last allowed, so Walnut did not run it by itself'

// ── shapes ──

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'script'
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  taken.add(id)
  return id
}

/** One script, cleaned, or a sentence naming what is wrong with it. */
function cleanScript(raw: unknown, index: number): Omit<ProjectScript, 'id'> & { id?: string } | string {
  const where = `Script ${index + 1}`
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `${where} is not an object`
  const r = raw as Record<string, unknown>
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  if (!name) return `${where} needs a name`
  if (name.length > NAME_MAX) return `"${name.slice(0, 20)}…": a name is at most ${NAME_MAX} characters`
  const command = typeof r.command === 'string' ? r.command.replace(/\r\n?/g, '\n').trim() : ''
  if (!command) return `"${name}" needs a command`
  if (command.length > COMMAND_MAX || command.includes('\0')) return `"${name}": a command is at most ${COMMAND_MAX} characters`
  const out: Omit<ProjectScript, 'id'> & { id?: string } = { name, command }
  if (typeof r.id === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(r.id)) out.id = r.id
  if (r.setup === true) {
    out.setup = true
    if (r.wait === false) out.wait = false
  }
  if (r.teardown === true) out.teardown = true
  if (r.timeout_sec !== undefined && r.timeout_sec !== null) {
    const t = Number(r.timeout_sec)
    if (!Number.isFinite(t) || t < 1) return `"${name}": the time limit must be a number of seconds`
    out.timeout_sec = Math.min(MAX_TIMEOUT_S, Math.floor(t))
  }
  return out
}

/**
 * The project's list as the editor saves it: every entry valid, names unique,
 * at most one setup and one teardown script. Returns the list or a sentence.
 */
export function sanitizeProjectScripts(raw: unknown): ProjectScript[] | string {
  if (!Array.isArray(raw)) return 'scripts must be a list'
  if (raw.length > MAX_SCRIPTS) return `A project holds at most ${MAX_SCRIPTS} scripts`
  const taken = new Set<string>()
  const names = new Set<string>()
  const out: ProjectScript[] = []
  for (let i = 0; i < raw.length; i++) {
    const s = cleanScript(raw[i], i)
    if (typeof s === 'string') return s
    const key = s.name.toLowerCase()
    if (names.has(key)) return `Two scripts are named "${s.name}"`
    names.add(key)
    out.push({ ...s, id: s.id && !taken.has(s.id) ? (taken.add(s.id), s.id) : uniqueId(slug(s.name), taken) })
  }
  if (out.filter((s) => s.setup).length > 1) return 'Only one script can run when a workspace is made'
  if (out.filter((s) => s.teardown).length > 1) return 'Only one script can run when the task completes'
  return out
}

/** The project's saved list as stored (a damaged entry is dropped, not fatal). */
export function storedProjectScripts(raw: unknown): ProjectScript[] {
  if (!Array.isArray(raw)) return []
  const taken = new Set<string>()
  const out: ProjectScript[] = []
  raw.slice(0, MAX_SCRIPTS).forEach((r, i) => {
    const s = cleanScript(r, i)
    if (typeof s !== 'string') out.push({ ...s, id: uniqueId(s.id ?? slug(s.name), taken) })
  })
  return out
}

export interface ScriptsFileParse {
  scripts: ProjectScript[]
  /** The file as a whole could not be read (bad JSON, no list). */
  error?: string
  /** Entries skipped, each with why. */
  warnings: string[]
}

/** A repository's scripts file (walnut.json): `{ "scripts": [{ name, command, setup?, wait?, teardown?, timeout_sec? }] }`. */
export function parseScriptsFile(name: string, content: string): ScriptsFileParse {
  let doc: unknown
  try {
    doc = JSON.parse(content)
  } catch (err) {
    return { scripts: [], warnings: [], error: `${name} is not valid JSON (${errText(err).slice(0, 120)})` }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { scripts: [], warnings: [], error: `${name} must hold an object` }
  const list = (doc as Record<string, unknown>).scripts
  if (list === undefined) return { scripts: [], warnings: [] }
  if (!Array.isArray(list)) return { scripts: [], warnings: [], error: `"scripts" in ${name} must be a list` }
  const taken = new Set<string>()
  const names = new Set<string>()
  const warnings: string[] = []
  const scripts: ProjectScript[] = []
  let setupSeen = false
  let teardownSeen = false
  for (let i = 0; i < list.length && scripts.length < MAX_SCRIPTS; i++) {
    const s = cleanScript(list[i], i)
    if (typeof s === 'string') { warnings.push(s); continue }
    if (names.has(s.name.toLowerCase())) { warnings.push(`"${s.name}" appears twice; the first one is used`); continue }
    names.add(s.name.toLowerCase())
    if (s.setup && setupSeen) { warnings.push(`"${s.name}": only the first setup script runs`); delete s.setup; delete s.wait }
    if (s.teardown && teardownSeen) { warnings.push(`"${s.name}": only the first teardown script runs`); delete s.teardown }
    setupSeen ||= !!s.setup
    teardownSeen ||= !!s.teardown
    scripts.push({ ...s, id: uniqueId(`file-${slug(s.name)}`, taken) })
  }
  if (list.length > MAX_SCRIPTS) warnings.push(`only the first ${MAX_SCRIPTS} scripts are read`)
  return { scripts, warnings }
}

/** The script that plays a role: the project's own first, else the file's. */
export function scriptFor(role: 'setup' | 'teardown', scripts: readonly ResolvedProjectScript[]): ResolvedProjectScript | null {
  return scripts.find((s) => s.source === 'project' && s[role]) ?? scripts.find((s) => s.source !== 'project' && s[role]) ?? null
}

// ── reading both lists ──

export interface ScriptsFileInfo {
  name: string
  path: string
  /** The content's hash (what a recorded run is matched against). */
  hash?: string
  /** What "allow it" records: this content, in this repository, on this host. */
  key?: string
  /** Read as committed at this ref (a draft: what the new worktree will hold). */
  ref?: string
  error?: string
  warnings?: string[]
}

export interface ScriptsView {
  /** Where the scripts run: the workspace root, or the folder's git top. */
  dir?: string
  host: string
  project?: string
  scripts: ResolvedProjectScript[]
  file?: ScriptsFileInfo
  /** Why the repository's file could not be read (offline host, older daemon, no folder). */
  file_unavailable?: string
  /** The project allowed this exact file to run its setup and teardown by itself. */
  file_trusted?: boolean
  setup?: string
  teardown?: string
}

/** The content's hash (outer whitespace aside: a working copy and `git show` agree). */
export function fileHash(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex').slice(0, 32)
}

/**
 * The allow key of a file: its content in its repository (the common git dir,
 * the same for the checkout and its worktrees) on its host. The same bytes in
 * another repository run other code (its package.json, its setup.sh), so they ask again.
 */
export function trustKey(host: string, repo: string, hash: string): string {
  return createHash('sha256').update(`${host}\n${repo}\n${hash}`).digest('hex').slice(0, 32)
}

/** The project's saved scripts. */
export async function projectScriptsOf(project: string | undefined): Promise<ProjectScript[]> {
  if (!project) return []
  try {
    const meta = await managerDeps().projectMeta(project)
    return storedProjectScripts(meta?.scripts)
  } catch {
    return []
  }
}

/** The repository's file on its host: walnut.json at the git top of `dir`. */
export async function readScriptsFile(host: string, dir: string, ref?: string): Promise<{ dir: string; file?: ScriptsFileInfo; scripts: ProjectScript[]; unavailable?: string }> {
  let res: Record<string, unknown>
  try {
    res = await managerDeps().rpc(host, 'workspace.scriptsFile', { dir, ...(ref ? { ref } : {}) }, FILE_RPC_MS)
  } catch (err) {
    return { dir, scripts: [], unavailable: errText(err) }
  }
  if (!res.ok) return { dir, scripts: [], unavailable: replyError(res, 'the host could not read it') }
  const base = typeof res.dir === 'string' ? res.dir : dir
  const f = res.file as { name?: string; path?: string; content?: string; error?: string } | null | undefined
  if (!f || typeof f.name !== 'string') return { dir: base, scripts: [] }
  const info: ScriptsFileInfo = { name: f.name, path: String(f.path ?? f.name) }
  if (typeof f.content !== 'string') return { dir: base, scripts: [], file: { ...info, error: f.error ?? 'could not be read' } }
  info.hash = fileHash(f.content)
  info.key = trustKey(host, typeof res.repo === 'string' && res.repo ? res.repo : base, info.hash)
  if (ref) info.ref = ref
  const parsed = parseScriptsFile(f.name, f.content)
  return {
    dir: base, scripts: parsed.scripts,
    file: { ...info, ...(parsed.error ? { error: parsed.error } : {}), ...(parsed.warnings.length ? { warnings: parsed.warnings } : {}) },
  }
}

/** Both lists for a folder on a host, project first. */
export async function scriptsFor(opts: { project?: string; host?: string; dir?: string; ref?: string }): Promise<ScriptsView> {
  const host = opts.host && opts.host !== 'local' ? opts.host : '__local__'
  const own = (await projectScriptsOf(opts.project)).map((s) => ({ ...s, source: 'project' as ProjectScriptSource }))
  const view: ScriptsView = { host, ...(opts.project ? { project: opts.project } : {}), scripts: own }
  if (opts.dir) {
    const file = await readScriptsFile(host, opts.dir, opts.ref)
    view.dir = file.dir
    if (file.file) view.file = file.file
    if (file.file?.key) view.file_trusted = (await managerDeps().scriptsTrust().catch(() => [] as string[])).includes(file.file.key)
    if (file.unavailable) view.file_unavailable = file.unavailable
    view.scripts = [...own, ...file.scripts.map((s) => ({ ...s, source: 'walnut.json' as ProjectScriptSource }))]
  }
  const setup = scriptFor('setup', view.scripts)
  const teardown = scriptFor('teardown', view.scripts)
  if (setup) view.setup = setup.id
  if (teardown) view.teardown = teardown.id
  return view
}

/** The environment a setup or teardown run gets (a manual run in the terminal gets the same words). */
export function scriptEnv(task: Pick<Task, 'id'>, ws: TaskWorkspace, trigger: 'setup' | 'teardown' | 'manual'): Record<string, string> {
  return {
    WALNUT_TASK_ID: task.id,
    WALNUT_SCRIPT_TRIGGER: trigger,
    ...(ws.root ? { WALNUT_WORKSPACE_ROOT: ws.root } : {}),
    ...(ws.source_repo ? { WALNUT_SOURCE_REPO: ws.source_repo } : { WALNUT_SOURCE_REPO: ws.anchor }),
    ...(ws.branch ? { WALNUT_BRANCH: ws.branch } : {}),
  }
}

// ── setup and teardown runs ──

type Role = 'setup' | 'teardown'

function tail(output: unknown): string | undefined {
  if (typeof output !== 'string' || !output.trim()) return undefined
  const t = output.replace(/\s+$/, '')
  return t.length > OUTPUT_KEEP ? `…${t.slice(-OUTPUT_KEEP)}` : t
}

/** Write one role's run record (only while the workspace is still the one it ran in). */
async function writeRun(taskId: string, root: string | undefined, role: Role, fn: (cur: WorkspaceScriptRun | undefined) => WorkspaceScriptRun | null): Promise<Task | null> {
  return managerDeps().write(taskId, (cur) => {
    if (!cur || cur.root !== root || !isLaunchReady(cur)) return null
    const next = fn(cur[role])
    return next ? stamp(cur, { [role]: next }) : null
  })
}

/** Record a run as started (null: one is running already, or the workspace changed). */
async function beginRun(task: Task, ws: TaskWorkspace, role: Role, script: ResolvedProjectScript, opts: { wait?: boolean; forCompletion?: string }): Promise<string | null> {
  const deps = managerDeps()
  const jobId = deps.jobId()
  const run: WorkspaceScriptRun = {
    name: script.name, command: script.command, source: script.source, state: 'running', job_id: jobId,
    started_at: new Date(deps.now()).toISOString(), progress: 'Starting',
    ...(role === 'setup' ? { wait: opts.wait !== false } : {}),
    ...(opts.forCompletion !== undefined ? { for_completion: opts.forCompletion } : {}),
  }
  const written = await writeRun(task.id, ws.root, role, (cur) => (cur?.state === 'running' ? null : run))
  if (!written) return null
  log.web.info(`workspace ${role} script started`, { taskId: task.id, root: ws.root, script: script.name, source: script.source, jobId })
  return jobId
}

/** A file script the project has not allowed: recorded as skipped, never run. */
async function skipUntrusted(task: Task, ws: TaskWorkspace, role: Role, script: ResolvedProjectScript, view: ScriptsView, opts: { wait?: boolean; forCompletion?: string }): Promise<WorkspaceScriptRun | null> {
  const at = new Date(managerDeps().now()).toISOString()
  const run: WorkspaceScriptRun = {
    name: script.name, command: script.command, source: script.source, state: 'skipped', error: UNTRUSTED_FILE_ERROR,
    untrusted: true, ...(view.file?.hash ? { file_hash: view.file.hash } : {}), started_at: at, ended_at: at,
    ...(role === 'setup' ? { wait: opts.wait !== false } : {}),
    ...(opts.forCompletion !== undefined ? { for_completion: opts.forCompletion } : {}),
  }
  const written = await writeRun(task.id, ws.root, role, (cur) => (cur?.state === 'running' ? null : run))
  log.web.info(`workspace ${role} script not run: the repository file is not allowed`, { taskId: task.id, root: ws.root, script: script.name })
  return written ? run : null
}

/** The role's script may run by itself: the project's own, or a file the project allowed. */
function mayRunUnasked(script: ResolvedProjectScript, view: ScriptsView): boolean {
  return script.source === 'project' || view.file_trusted === true
}

/** Start the recorded run on the host and follow it to its end. */
async function driveRun(task: Task, ws: TaskWorkspace, role: Role, script: ResolvedProjectScript, jobId: string): Promise<WorkspaceScriptRun | null> {
  try {
    const res = await managerDeps().rpc(ws.host, 'workspace.runScript', {
      provider: ws.provider, root: ws.root, cwd: ws.cwd, jobId, command: script.command,
      env: scriptEnv(task, ws, role), timeoutSec: script.timeout_sec ?? DEFAULT_TIMEOUT_S,
      // A teardown's leftover processes end with it: the folder is removed next.
      ...(role === 'teardown' ? { endGroup: true } : {}),
    }, START_RPC_MS)
    if (!res.ok) {
      // A busy host (a setup still in this workspace, too many runs) is no answer for
      // this completion: the next cleanup check runs the teardown again.
      const retryLater = role === 'teardown' && res.code === 'busy'
      return finishRun(task.id, ws.root, role, jobId, { state: 'skipped', error: replyError(res, 'the host refused to run it'), ...(retryLater ? { for_completion: undefined } : {}) })
    }
  } catch (err) {
    if (!(err instanceof WorkspaceError) || err.code !== 'host-timeout') {
      return finishRun(task.id, ws.root, role, jobId, { state: 'skipped', error: errText(err) })
    }
    // A lost answer: the job may run anyway; the poll finds out.
  }
  return awaitRun(task.id, ws, role, jobId, (script.timeout_sec ?? DEFAULT_TIMEOUT_S) * 1000)
}

/** Run one script in the workspace as a daemon job, recorded on the row; resolves when it ended. */
async function runRole(task: Task, ws: TaskWorkspace, role: Role, script: ResolvedProjectScript, opts: { wait?: boolean; forCompletion?: string } = {}): Promise<WorkspaceScriptRun | null> {
  const jobId = await beginRun(task, ws, role, script, opts)
  return jobId ? driveRun(task, ws, role, script, jobId) : null
}

async function awaitRun(taskId: string, ws: TaskWorkspace, role: Role, jobId: string, budgetMs: number): Promise<WorkspaceScriptRun | null> {
  // A chatty install changes its last line every poll; the row (and every client) hears it every few seconds.
  const outcome = await pollJob(ws.host, jobId, budgetMs + LOST_SLACK_MS, async (progress) => {
    await writeRun(taskId, ws.root, role, (cur) => (cur?.job_id === jobId && cur.state === 'running' ? { ...cur, progress } : null))
  }, { minGapMs: PROGRESS_WRITE_MS })
  if (outcome.state === 'lost') return finishRun(taskId, ws.root, role, jobId, { state: 'failed', error: outcome.error })
  if (outcome.state === 'failed') return finishRun(taskId, ws.root, role, jobId, { state: 'failed', error: outcome.error })
  const r = outcome.result
  const code = typeof r.exitCode === 'number' ? r.exitCode : null
  const timedOut = r.timedOut === true
  const ok = code === 0 && !timedOut
  const secs = Math.round((Number(r.ms) || 0) / 1000)
  return finishRun(taskId, ws.root, role, jobId, {
    state: ok ? 'done' : 'failed', exit_code: code, ...(timedOut ? { timed_out: true } : {}),
    ...(ok ? {} : { error: timedOut ? `timed out after ${secs}s` : code === null ? `stopped by ${String(r.signal ?? 'a signal')}` : `exited with code ${code}` }),
    output: tail(r.output),
  })
}

async function finishRun(taskId: string, root: string | undefined, role: Role, jobId: string, patch: Partial<WorkspaceScriptRun>): Promise<WorkspaceScriptRun | null> {
  const endedAt = new Date(managerDeps().now()).toISOString()
  let ended: WorkspaceScriptRun | null = null
  await writeRun(taskId, root, role, (cur) => {
    if (!cur || cur.job_id !== jobId) return null
    const next: WorkspaceScriptRun = { ...cur, ...patch, ended_at: endedAt }
    delete next.progress
    for (const k of Object.keys(next) as Array<keyof WorkspaceScriptRun>) if (next[k] === undefined) delete next[k]
    ended = next
    return next
  })
  const run = ended as WorkspaceScriptRun | null
  log.web.info(`workspace ${role} script ended`, { taskId, root, state: run?.state, exit: run?.exit_code, error: run?.error })
  return run
}

/** A task completed while its setup ran: the cleanup check, which waited for it, goes now. */
async function cleanupIfCompleted(taskId: string): Promise<boolean> {
  const task = await managerDeps().getTask(taskId)
  if (task?.phase !== 'COMPLETE' || !task.workspace) return false
  const { onTaskCompleted } = await import('./cleanup.js')
  void onTaskCompleted(taskId, { grace: false })
  return true
}

/** After its setup ended: a completed task's cleanup may go now, a start that waited may start. */
async function afterSetup(taskId: string): Promise<void> {
  if (await cleanupIfCompleted(taskId)) return
  const task = await managerDeps().getTask(taskId)
  if (!task?.workspace) return
  if (task.workspace.pending_start) {
    const { launchPending } = await import('./manager.js')
    await launchPending(taskId)
  }
}

/**
 * A workspace was just made: run its setup script. A waiting setup resolves when
 * it ends; one that does not wait resolves at once and runs on.
 */
export async function runSetupAfterCreate(taskId: string): Promise<void> {
  const deps = managerDeps()
  const task = await deps.getTask(taskId)
  const ws = task?.workspace
  if (!task || !ws || !isLaunchReady(ws) || !ws.root) return
  const view = await scriptsFor({ project: task.project, host: ws.host, dir: ws.root })
  const script = scriptFor('setup', view.scripts)
  if (!script) {
    if (view.file_unavailable) log.web.info('workspace setup: the repository file could not be read', { taskId, root: ws.root, why: view.file_unavailable })
    return
  }
  const wait = script.wait !== false
  if (!mayRunUnasked(script, view)) {
    await skipUntrusted(task, ws, 'setup', script, view, { wait })
    return
  }
  const run = runRole(task, ws, 'setup', script, { wait }).catch((err) => {
    log.web.warn('workspace setup failed to run', { taskId, error: errText(err) })
    return null
  })
  // A waiting run holds the start (runCreate launches after it); either way its end
  // lets the cleanup of a task completed meanwhile go, since that check waited for it.
  if (wait) {
    await run
    await cleanupIfCompleted(taskId)
    return
  }
  void run.then(() => cleanupIfCompleted(taskId))
}

/**
 * "Run setup again": the setup script as the lists say now. Answers once it
 * started. A person's click runs a file the user has not allowed too (they see
 * its command); `allow` also lets that file run by itself from now on.
 */
export async function rerunSetup(taskId: string, opts: { allow?: boolean; expectHash?: string } = {}): Promise<Task> {
  const deps = managerDeps()
  if (deps.cloudMode()) throw new WorkspaceError('Isolated workspaces are run by the Walnut on your Mac.', 409, 'cloud')
  const task = await deps.getTask(taskId)
  if (!task) throw new WorkspaceError(`Task ${taskId} not found`, 404, 'not-found')
  const ws = task.workspace
  if (!ws || !isLaunchReady(ws) || !ws.root) throw new WorkspaceError('This task has no workspace to set up.', 409, 'none')
  if (!(await madeHere(ws))) throw new WorkspaceError('This workspace was made by another Walnut, so this one will not run scripts in it.', 409, 'other-walnut')
  if (ws.setup?.state === 'running') throw new WorkspaceError('Its setup script is running already.', 409, 'busy')
  if (ws.teardown?.state === 'running') throw new WorkspaceError('Its teardown script is running.', 409, 'busy')
  const view = await scriptsFor({ project: task.project, host: ws.host, dir: ws.root })
  const script = scriptFor('setup', view.scripts)
  if (!script) {
    throw new WorkspaceError(view.file_unavailable
      ? `No setup script found (${view.file_unavailable}).`
      : 'Neither the project nor the repository has a setup script.', 404, 'no-script')
  }
  // The card the click came from showed the file as it was: an edit since (a pull,
  // another branch) is not what the user agreed to run.
  if (opts.expectHash && script.source !== 'project' && view.file?.hash !== opts.expectHash) {
    throw new WorkspaceError(`The workspace's ${view.file?.name ?? 'walnut.json'} changed since; nothing ran. Open the Scripts menu to see it as it is now.`, 409, 'file-changed')
  }
  if (opts.allow && script.source !== 'project' && view.file?.key && !view.file_trusted) {
    await deps.allowScriptsFile(view.file.key)
    log.web.info('workspace scripts file allowed', { taskId, root: ws.root, file: view.file.path })
  }
  // A run again holds only a start still waiting for the workspace (a failed setup
  // held it); a task whose session started has it working already.
  const jobId = await beginRun(task, ws, 'setup', script, { wait: !!ws.pending_start })
  if (!jobId) throw new WorkspaceError('This task\'s workspace changed meanwhile; reload and try again.', 409, 'conflict')
  // Answers now, the row says running; the run goes on in the background.
  void driveRun(task, ws, 'setup', script, jobId)
    .then(() => afterSetup(taskId), (err) => log.web.warn('workspace setup rerun failed', { taskId, error: errText(err) }))
  return (await deps.getTask(taskId)) ?? task
}

/** A failed or not yet allowed setup held the person's start: start the session anyway. */
export async function startAnyway(taskId: string): Promise<Task> {
  const deps = managerDeps()
  const task = await deps.getTask(taskId)
  if (!task) throw new WorkspaceError(`Task ${taskId} not found`, 404, 'not-found')
  if (!setupBlocksLaunch(task.workspace)) throw new WorkspaceError('Nothing waits for setup in this task.', 409, 'not-held')
  const written = await deps.write(taskId, (cur) => (cur?.setup && setupBlocksLaunch(cur) ? stamp(cur, { setup: { ...cur.setup, proceed: true } }) : null))
  if (!written) throw new WorkspaceError('This task\'s workspace changed meanwhile; reload and try again.', 409, 'conflict')
  log.web.info('workspace start goes on after a failed setup', { taskId })
  const { launchPending } = await import('./manager.js')
  void launchPending(taskId)
  return written
}

/** Server boot: a setup or teardown the restart interrupted is followed to its end. */
export async function resumeScriptRuns(task: Task): Promise<void> {
  const ws = task.workspace
  if (!ws || !isLaunchReady(ws)) return
  for (const role of ['setup', 'teardown'] as const) {
    const run = ws[role]
    if (run?.state !== 'running' || !run.job_id) continue
    log.web.info(`workspace ${role} script resumed after a restart`, { taskId: task.id, jobId: run.job_id })
    const ended = await awaitRun(task.id, ws, role, run.job_id, MAX_TIMEOUT_S * 1000).catch(() => null)
    if (!ended) continue
    if (role === 'setup') await afterSetup(task.id)
    else {
      const { onTaskCompleted } = await import('./cleanup.js')
      void onTaskCompleted(task.id, { grace: false })
    }
  }
}

/** A run of this role is in flight on the row. */
export function scriptRunning(ws: TaskWorkspace | undefined): Role | null {
  if (ws?.setup?.state === 'running') return 'setup'
  if (ws?.teardown?.state === 'running') return 'teardown'
  return null
}

/** The setup that holds the first session: it runs and was asked to wait (or failed: setupBlocksLaunch). */
export { setupBlocksLaunch, setupHoldsLaunch }

/**
 * The completed task's teardown, once per completion, before the cleanup check.
 * Returns false when the check must stop here (the run could not be recorded:
 * the row changed meanwhile).
 */
export async function teardownBeforeCleanup(task: Task, ws: TaskWorkspace): Promise<boolean> {
  const key = task.completed_at ?? ''
  if (ws.teardown?.for_completion === key && ws.teardown.state !== 'running') return true
  if (ws.teardown?.state === 'running') return false
  const view = await scriptsFor({ project: task.project, host: ws.host, dir: ws.root })
  const script = scriptFor('teardown', view.scripts)
  if (!script) return true
  if (!mayRunUnasked(script, view)) return (await skipUntrusted(task, ws, 'teardown', script, view, { forCompletion: key })) !== null
  const run = await runRole(task, ws, 'teardown', script, { forCompletion: key }).catch((err) => {
    log.web.warn('workspace teardown failed to run', { taskId: task.id, error: errText(err) })
    return null
  })
  // Refused for now (no completion recorded on it): the cleanup waits for a later check.
  return run !== null && run.for_completion === key
}

/** One line for the session's prompt: what setup did in this task's workspace. Empty when nothing ran. */
export function setupPromptLine(ws: TaskWorkspace | undefined): string {
  const run = ws?.setup
  if (!ws || !run || !ws.root || !isLaunchReady(ws)) return ''
  const what = `its setup script "${run.name}" (\`${run.command.length > 200 ? `${run.command.slice(0, 200)}…` : run.command}\`, from ${run.source === 'project' ? 'the project\'s scripts' : run.source})`
  const where = `This task runs in an isolated workspace at ${ws.root} on ${hostLabel(ws.host)}`
  if (run.state === 'done') return `${where}. Walnut ran ${what} when it was made, and it succeeded: what it installs or prepares is already there, so do not run it again.\n\n`
  if (run.state === 'running') {
    return `${where}. Walnut started ${what} beside this session, so it may still be running: before you rely on what it prepares, check its result (\`walnut tools call task_get\`, under workspace.setup).\n\n`
  }
  const out = run.output ? ` Its output ended with:\n\`\`\`\n${run.output.slice(-1200)}\n\`\`\`` : ''
  return `${where}. Walnut ran ${what} when it was made, and it ${run.state === 'skipped' ? `could not run (${run.error ?? 'unknown reason'})` : `failed (${run.error ?? 'unknown reason'})`}.${out}\n\n`
}
