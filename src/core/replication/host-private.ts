/**
 * What a host's copies never hold: a task Walnut keeps local (Task.sync_hold: made local,
 * created Local, found private by the user's words or the model, or still being judged), every
 * task under it (its subtasks at any depth, held or not), and everything copied for them (their
 * sessions, requests, board, letters and their bodies and cards, routines, notifications, search
 * docs; MEMORY.md and notes ride on the row).
 *
 * ONE place on the sending side. Every copy round (task-replica.ts, kinds/copy-kind.ts,
 * search-replica.ts) builds what a host target receives through `hostManifest` /
 * `searchKeyKeptFromHosts`, and so does every copy the host's daemon takes (host-slice.ts,
 * routines/trigger-push.ts, host-replica.ts: providers/daemon-twin-state.ts lists them, each with
 * where it is filtered), so a follower of any build, an older one included, never receives
 * such a row; a row it already holds goes at the next round by the protocol's own removal (the
 * manifest no longer names it). The host learns only the ids it lacks (kinds/local-tasks.ts),
 * so its own answers can say why instead of "not found".
 *
 * Each copy kind names whose its rows are (`owners`): refs `task:<id>`, `session:<sid>`, or
 * `<kind>:<key>` for a row that belongs to a row of another kind (a letter body to its letter,
 * named in `derivedFrom`). A kind of no one's rows says why (`taskFree`).
 * tests/core/replication/host-private-guard.test.ts holds every kind and every daemon copy to it.
 * A change of the kept set reaches every copy within seconds (onHostPrivacyChange), not at its sweep.
 *
 * The cloud companion is not filtered: it is the user's own server that answers his phone while
 * the Mac is away, it creates Local tasks itself (task-manager.ts, the companion's create path),
 * and the phone shows them there. The rule is about a host, a machine the user works on that
 * may be shared.
 */

import type { SessionRecord, Task } from '../types.js'
import { keptLocal } from '../private-tasks/visibility.js'
import { matchIdRef } from '../../lib/id-ref.js'
import { keptManifestHash, manifestHashOf, sha12, type ManifestEntry } from './kind.js'
import type { KindManifest } from './kind-leader.js'

/** A kind of no one's rows, and why (the guard test reads the reason). */
export interface TaskFree { taskFree: string }
/** Whose a row is: `task:<id>`, `session:<sid>`, `<kind>:<key>` (absent ids are skipped). */
export type RowOwners<Row> = ((row: Row) => ReadonlyArray<string | undefined | null | false>) | TaskFree

export function taskFree(why: string): TaskFree {
  return { taskFree: why }
}

export function isTaskFree(o: unknown): o is TaskFree {
  return !!o && typeof o === 'object' && typeof (o as TaskFree).taskFree === 'string'
}

/** What a copy kind tells this module: its name, its key, whose its rows are. */
export interface OwnedKind<Row> {
  kind: string
  key(row: Row): string
  owners?: RowOwners<Row>
  /** The kind whose rows this kind's `<kind>:<key>` refs name (inbox bodies: 'inbox'). */
  derivedFrom?: string
}

/** A task kept off every host's copies by its own hold. One rule, the one that keeps it from outside services. */
export function keptFromHosts(task: { sync_hold?: unknown }): boolean {
  return keptLocal(task)
}

/** The tasks kept off hosts this round, and their sessions. */
export interface HostPrivacy {
  /** Every task kept: held itself, or under a held task (its subtasks, at any depth). */
  readonly tasks: ReadonlySet<string>
  readonly sessions: ReadonlySet<string>
  /** Changes whenever either set does ('' when nothing is kept). */
  readonly sig: string
  /** Keys of another kind's rows left out this round, by kind (filled as kinds are filtered). */
  readonly derived: Map<string, ReadonlySet<string>>
}

type PrivacyTask = Pick<Task, 'id'> & { sync_hold?: unknown; parent_task_id?: string | null }

/**
 * The tasks kept: each held task and everything under it. A subtask restates its lead's work,
 * so it is kept with it whether or not it carries a hold of its own. Parents are resolved as
 * every reader does (lib/id-ref.ts: the exact id, else a legacy prefix); a loop in the parent
 * chain ends the walk there.
 */
function keptTasksOf(tasks: ReadonlyArray<PrivacyTask>): Set<string> {
  const kept = new Set<string>()
  if (!tasks.some((t) => keptFromHosts(t))) return kept
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const memo = new Map<string, boolean>()
  // A legacy prefix ref: its candidates are read once per ref, and never name the child itself.
  const byPrefix = new Map<string, PrivacyTask[]>()
  const parentOf = (t: PrivacyTask): PrivacyTask | undefined => {
    const ref = t.parent_task_id
    if (!ref || ref === t.id) return undefined
    const exact = byId.get(ref)
    if (exact) return exact
    let hits = byPrefix.get(ref)
    if (!hits) byPrefix.set(ref, hits = matchIdRef(tasks, ref))
    return hits.find((x) => x.id !== t.id)
  }
  for (const t of tasks) {
    const path: string[] = []
    const seen = new Set<string>()
    let cur: PrivacyTask | undefined = t
    let result = false
    while (cur) {
      const known = memo.get(cur.id)
      if (known !== undefined) { result = known; break }
      if (keptFromHosts(cur)) { result = true; path.push(cur.id); break }
      if (seen.has(cur.id)) break
      seen.add(cur.id)
      path.push(cur.id)
      cur = parentOf(cur)
    }
    for (const id of path) memo.set(id, result)
    if (result) kept.add(t.id)
  }
  return kept
}

export function hostPrivacyOf(
  tasks: ReadonlyArray<PrivacyTask>,
  sessions: ReadonlyArray<Pick<SessionRecord, 'claudeSessionId' | 'taskId'> & { legacyTaskId?: string }>,
): HostPrivacy {
  const kept = keptTasksOf(tasks)
  const sids = new Set<string>()
  if (kept.size > 0) {
    for (const s of sessions) {
      if (kept.has(s.taskId) || (s.legacyTaskId !== undefined && kept.has(s.legacyTaskId))) sids.add(s.claudeSessionId)
    }
  }
  const sig = kept.size === 0 ? '' : sha12(`${[...kept].sort().join('\n')}\n--\n${[...sids].sort().join('\n')}`)
  return { tasks: kept, sessions: sids, sig, derived: new Map() }
}

/**
 * Whether one host's own copy for its daemon (host-slice.ts, routines/trigger-push.ts) leaves
 * out task `id`: kept, unless a session of its own runs on that host (`ownHere`: tasksRunningOn),
 * whose CLI and transcript are there anyway.
 */
export function keptOffHost(id: string | undefined | null, p: HostPrivacy, ownHere: { has(id: string): boolean }): boolean {
  return !!id && p.tasks.has(id) && !ownHere.has(id)
}

/**
 * The tasks with a session of their own on the host reached by `hostKeys` (one alias, or every
 * alias of one daemon): the sessions that host's daemon copy lists (host-slice.ts inHostCopy).
 * The one rule of "a session of this task runs on this host". `sessions`: the rows already read.
 */
export async function tasksRunningOn(hostKeys: readonly string[], sessions?: readonly SessionRecord[], now = Date.now()): Promise<Set<string>> {
  const [{ normalizeHostKey, inHostCopy }, rows] = await Promise.all([
    import('../host-slice.js'),
    sessions ?? import('../session-tracker.js').then((m) => m.sessionRowsForReplica()),
  ])
  const keys = new Set(hostKeys.map(normalizeHostKey))
  const out = new Set<string>()
  for (const s of rows) if (s.taskId && keys.has(normalizeHostKey(s.host)) && inHostCopy(s, now)) out.add(s.taskId)
  return out
}

/** What a host's daemon copy leaves out now: the privacy, and `keptOff` for the host reached by `hostKeys`. */
export async function keptOffHostNow(
  hostKeys: readonly string[], opts: { sessions?: readonly SessionRecord[]; now?: number } = {},
): Promise<{ privacy: HostPrivacy; keptOff: (id: string | undefined | null) => boolean }> {
  const privacy = await hostPrivacyNow()
  if (privacy.tasks.size === 0) return { privacy, keptOff: () => false }
  const ownHere = await tasksRunningOn(hostKeys, opts.sessions, opts.now)
  return { privacy, keptOff: (id) => keptOffHost(id, privacy, ownHere) }
}

/** Ids in a text: the runs of letters, digits and hyphens a task or session id is made of. */
const ID_TOKEN = /[A-Za-z0-9][A-Za-z0-9-]{5,}/g

/**
 * Whether a free text of the memory copy (a session summary's `Task: <id>` line, a compaction
 * snapshot, a daily log) names a kept task or one of its sessions: such a file is that task's
 * and leaves a host's copy whole (host-replica.ts).
 */
export function textKeptFromHosts(text: string, p: HostPrivacy): boolean {
  if (p.tasks.size === 0) return false
  for (const m of text.matchAll(ID_TOKEN)) if (p.tasks.has(m[0]) || p.sessions.has(m[0])) return true
  return false
}

/** Whether a row of `kind` is kept off hosts, by the kind's own `owners` (a row of no one's never is). */
export function ownedRowKept<Row>(kind: Pick<OwnedKind<Row>, 'owners'>, row: Row, p: HostPrivacy): boolean {
  const owners = kind.owners
  if (p.tasks.size === 0 || !owners || isTaskFree(owners)) return false
  return rowKept(owners, row, p)
}

/** Nothing kept: what a target that is not a host gets, and a round with no host target. */
export function nothingKept(): HostPrivacy {
  return { tasks: new Set(), sessions: new Set(), sig: '', derived: new Map() }
}

/** The leader's privacy now: its task store (or the rows the caller already read) and its sessions. */
export async function hostPrivacyNow(tasks?: ReadonlyArray<PrivacyTask>): Promise<HostPrivacy> {
  const rows = tasks ?? (await (await import('../task-manager.js')).taskStoreForReplica()).tasks
  // Sessions are read only when a task is kept: the common case reads nothing more.
  if (!rows.some((t) => keptFromHosts(t))) return nothingKept()
  const sessions = await (await import('../session-tracker.js')).sessionRowsForReplica()
  return hostPrivacyOf(rows, sessions)
}

/** A task change is read for a new kept set this long after it (a burst is one read). */
export const PRIVACY_WATCH_MS = 2_000
const privacyListeners = new Set<() => void>()
let privacyWatch: { timer: ReturnType<typeof setTimeout> | null; sig: string | null; name: string } | null = null

/**
 * `fn` runs when the kept set changes (a task made local or created Local, a hold cleared, a
 * subtask moved under a kept lead), so every copy drops or regains those rows within seconds
 * instead of at its next sweep. One subscription for every listener, read a little after each
 * task change. `read`: tests only.
 */
export function onHostPrivacyChange(fn: () => void, read: () => Promise<HostPrivacy> = () => hostPrivacyNow()): () => void {
  privacyListeners.add(fn)
  if (!privacyWatch) {
    const w = { timer: null as ReturnType<typeof setTimeout> | null, sig: null as string | null, name: `host-privacy-${Math.random().toString(36).slice(2, 10)}` }
    privacyWatch = w
    const check = async (): Promise<void> => {
      const sig = (await read()).sig
      const changed = w.sig !== null && sig !== w.sig
      w.sig = sig
      if (changed && privacyWatch === w) for (const l of [...privacyListeners]) { try { l() } catch { /* a listener's own failure */ } }
    }
    void check().catch(() => {})
    void import('../event-bus.js').then(({ bus }) => {
      if (privacyWatch !== w) return
      bus.subscribe(w.name, (event) => {
        if (!event.name.startsWith('task:') || w.timer) return
        w.timer = setTimeout(() => { w.timer = null; void check().catch(() => {}) }, PRIVACY_WATCH_MS)
        w.timer.unref?.()
      }, { global: true, interest: ['task:'] })
    }).catch(() => {})
  }
  return () => {
    privacyListeners.delete(fn)
    if (privacyListeners.size > 0 || !privacyWatch) return
    const w = privacyWatch
    privacyWatch = null
    if (w.timer) clearTimeout(w.timer)
    void import('../event-bus.js').then(({ bus }) => bus.unsubscribe(w.name)).catch(() => {})
  }
}

/** The targets the rule applies to: a host's replica, never the companion. */
export function leavesOutPrivate(target: { kind: string }): boolean {
  return target.kind === 'host'
}

/** Whether `ref` names something kept off hosts. */
export function refKept(ref: string, p: HostPrivacy): boolean {
  const at = ref.indexOf(':')
  if (at <= 0) return false
  const kind = ref.slice(0, at)
  const id = ref.slice(at + 1)
  if (!id) return false
  if (kind === 'task') return p.tasks.has(id)
  if (kind === 'session') return p.sessions.has(id)
  return p.derived.get(kind)?.has(id) === true
}

function rowKept<Row>(owners: Exclude<RowOwners<Row>, TaskFree>, row: Row, p: HostPrivacy): boolean {
  for (const ref of owners(row)) if (typeof ref === 'string' && ref && refKept(ref, p)) return true
  return false
}

/** A kind's own rows' keys kept off hosts, worked out once per round (for the kinds derived from it). */
async function derivedKeys(name: string, p: HostPrivacy, resolve: (name: string) => Promise<ParentKind | undefined>): Promise<void> {
  if (p.derived.has(name)) return
  const parent = await resolve(name)
  const owners = parent?.owners
  if (!parent || !owners || isTaskFree(owners)) { p.derived.set(name, new Set()); return }
  if (parent.derivedFrom) await derivedKeys(parent.derivedFrom, p, resolve)
  const out = new Set<string>()
  for (const row of await parent.rows()) if (rowKept(owners, row, p)) out.add(parent.key(row))
  p.derived.set(name, out)
}

/** A kind another kind's refs name: its rows are read when no round of it ran first. */
export interface ParentKind extends OwnedKind<any> { rows(): Promise<readonly any[]> }

async function defaultResolve(name: string): Promise<ParentKind | undefined> {
  return (await import('./kinds/index.js')).copyKinds().find((k) => k.kind === name)
}

const derivedManifests = new WeakMap<object, { sig: string; out: KindManifest<unknown>; left: ReadonlySet<string> }>()

/**
 * The manifest a host target takes of `kind`: `manifest` without the rows kept off hosts (and
 * without their keys in `keep`). The same object when nothing is left out, so every memo of the
 * round holds as before; else one derived manifest per (manifest, privacy), shared by the hosts.
 */
export async function hostManifest<Row>(
  kind: OwnedKind<Row>, manifest: KindManifest<Row>, p: HostPrivacy,
  resolve: (name: string) => Promise<ParentKind | undefined> = defaultResolve,
): Promise<KindManifest<Row>> {
  const owners = kind.owners
  if (p.tasks.size === 0 || !owners || isTaskFree(owners)) {
    if (!p.derived.has(kind.kind)) p.derived.set(kind.kind, new Set())
    return manifest
  }
  const hit = derivedManifests.get(manifest)
  if (hit && hit.sig === p.sig && !kind.derivedFrom) {
    p.derived.set(kind.kind, hit.left)
    return hit.out as KindManifest<Row>
  }
  if (kind.derivedFrom) await derivedKeys(kind.derivedFrom, p, resolve)
  const entries: ManifestEntry[] = []
  const byKey = new Map<string, Row>()
  const left = new Set<string>()
  for (const e of manifest.entries) {
    const row = manifest.byKey.get(e.k)
    if (row !== undefined && rowKept(owners, row, p)) { left.add(e.k); continue }
    entries.push(e)
    if (row !== undefined) byKey.set(e.k, row)
  }
  p.derived.set(kind.kind, left)
  const keep = manifest.keep?.filter((k) => !p.tasks.has(k) && !p.sessions.has(k) && !left.has(k))
  let out: KindManifest<Row>
  if (left.size === 0 && (keep?.length ?? 0) === (manifest.keep?.length ?? 0)) out = manifest
  else {
    const hash = manifestHashOf(entries)
    out = {
      entries, byKey, hash: keep && keep.length > 0 ? keptManifestHash(hash, keep) : hash,
      ...(keep && keep.length > 0 ? { keep } : {}),
      ...(manifest.window ? { window: manifest.window } : {}),
    }
  }
  if (!kind.derivedFrom) derivedManifests.set(manifest, { sig: p.sig, out: out as KindManifest<unknown>, left })
  return out
}

/**
 * Whether a host's search copy leaves out the doc `key` (search/replica-refs.ts keys): a kept
 * task's or session's doc, and a file doc under a kept task's own folder (its MEMORY.md,
 * `artifacts/nodes/<id>/`).
 */
export function searchKeyKeptFromHosts(key: string, p: HostPrivacy): boolean {
  if (p.tasks.size === 0) return false
  const at = key.indexOf(':')
  if (at <= 0) return false
  const kind = key.slice(0, at)
  const ref = key.slice(at + 1)
  if (kind === 'task') return p.tasks.has(ref)
  if (kind === 'session') return p.sessions.has(ref)
  if (p.tasks.has(ref) || p.sessions.has(ref)) return true
  return ref.split('/').some((seg) => p.tasks.has(seg))
}

/**
 * The vault folders a host's notes copy leaves out (host-replica.ts): each kept task's own
 * artifacts folder (`nodes/<id>`: its MEMORY.md, its notes, guidance and reflections), relative
 * to the vault `root`, where the vault holds it (the one tree, whose vault is the artifacts
 * folder). In the by-project layout a task's folder is its project's, shared with the project's
 * other tasks: nothing is left out there. The privacy is read only when the vault holds the
 * task folders at all.
 */
export async function keptVaultFolders(root: string, privacy: () => Promise<HostPrivacy> = () => hostPrivacyNow()): Promise<string[]> {
  const { artifactsByProject, artifactsDir, nodeArtifactsDir, TASK_ID_RE } = await import('../artifacts/paths.js')
  if (artifactsByProject()) return []
  const path = await import('node:path')
  const under = (abs: string): string | null => {
    const rel = path.relative(root, abs)
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : null
  }
  if (under(path.join(artifactsDir(), 'nodes')) === null) return []
  const p = await privacy()
  const out: string[] = []
  for (const id of p.tasks) {
    const rel = TASK_ID_RE.test(id) ? under(nodeArtifactsDir(id)) : null
    if (rel) out.push(rel)
  }
  return out.sort()
}
