/**
 * What a host's copies never hold: a task Walnut keeps local (Task.sync_hold: made local,
 * created Local, found private by the user's words or the model, or still being judged), and
 * everything copied for it (its sessions, requests, board, letters and their bodies, routines,
 * notifications, its search docs; its MEMORY.md and notes ride on its row).
 *
 * ONE place on the sending side. Every copy round (task-replica.ts, kinds/copy-kind.ts,
 * search-replica.ts) builds what a host target receives through `hostManifest` /
 * `searchKeyKeptFromHosts`, so a follower of any build, an older one included, never receives
 * such a row; a row it already holds goes at the next round by the protocol's own removal (the
 * manifest no longer names it). The host learns only the ids it lacks (kinds/local-tasks.ts),
 * so its own answers can say why instead of "not found".
 *
 * Each copy kind names whose its rows are (`owners`): refs `task:<id>`, `session:<sid>`, or
 * `<kind>:<key>` for a row that belongs to a row of another kind (a letter body to its letter,
 * named in `derivedFrom`). A kind of no one's rows says why (`taskFree`).
 * tests/core/replication/host-private-guard.test.ts holds every kind to it.
 *
 * The cloud companion is not filtered: it is the user's own server that answers his phone while
 * the Mac is away, it creates Local tasks itself (task-manager.ts, the companion's create path),
 * and the phone shows them there. The rule is about a host, a machine the user works on that
 * may be shared.
 */

import type { SessionRecord, Task } from '../types.js'
import { keptLocal } from '../private-tasks/visibility.js'
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

/** A task kept off every host's copies. One rule, the one that keeps it from outside services. */
export function keptFromHosts(task: { sync_hold?: unknown }): boolean {
  return keptLocal(task)
}

/** The tasks kept off hosts this round, and their sessions. */
export interface HostPrivacy {
  readonly tasks: ReadonlySet<string>
  readonly sessions: ReadonlySet<string>
  /** Changes whenever either set does ('' when nothing is kept). */
  readonly sig: string
  /** Keys of another kind's rows left out this round, by kind (filled as kinds are filtered). */
  readonly derived: Map<string, ReadonlySet<string>>
}

export function hostPrivacyOf(
  tasks: ReadonlyArray<Pick<Task, 'id'> & { sync_hold?: unknown }>,
  sessions: ReadonlyArray<Pick<SessionRecord, 'claudeSessionId' | 'taskId'> & { legacyTaskId?: string }>,
): HostPrivacy {
  const kept = new Set<string>()
  for (const t of tasks) if (keptFromHosts(t)) kept.add(t.id)
  const sids = new Set<string>()
  if (kept.size > 0) {
    for (const s of sessions) {
      if (kept.has(s.taskId) || (s.legacyTaskId !== undefined && kept.has(s.legacyTaskId))) sids.add(s.claudeSessionId)
    }
  }
  const sig = kept.size === 0 ? '' : sha12(`${[...kept].sort().join('\n')}\n--\n${[...sids].sort().join('\n')}`)
  return { tasks: kept, sessions: sids, sig, derived: new Map() }
}

/** Nothing kept: what a target that is not a host gets, and a round with no host target. */
export function nothingKept(): HostPrivacy {
  return { tasks: new Set(), sessions: new Set(), sig: '', derived: new Map() }
}

/** The leader's privacy now: its task store (or the rows the caller already read) and its sessions. */
export async function hostPrivacyNow(tasks?: ReadonlyArray<Pick<Task, 'id'> & { sync_hold?: unknown }>): Promise<HostPrivacy> {
  const rows = tasks ?? (await (await import('../task-manager.js')).taskStoreForReplica()).tasks
  // Sessions are read only when a task is kept: the common case reads nothing more.
  if (!rows.some((t) => keptFromHosts(t))) return nothingKept()
  const sessions = await (await import('../session-tracker.js')).sessionRowsForReplica()
  return hostPrivacyOf(rows, sessions)
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
