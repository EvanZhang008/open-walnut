/**
 * The primary's side of each host's read copy (docs/plan/walnut-control-plane.md,
 * "What a host keeps"; the daemon side is
 * src/providers/host-replica-core.ts).
 *
 * Every replica keeps the same copy, whatever it is (a host's daemon or the cloud
 * companion): the note text, the memory (MEMORY.md, USER.md and the rest of the
 * memory dir), the skills with their references (host-replica-extras.ts), and the
 * pictures and files of the notes (attachment-replica.ts, where the target's daemon
 * has 'attachment-copy-v1'), so its sessions and pages read them while the leader
 * cannot answer. What a replica keeps is the user's choice (config `hosts.<alias>.keep`,
 * Settings > Remote Hosts; the companion's `cloud_bridge.keep`, Settings > Phones &
 * Cloud); each kind is on unless turned off, and a kind turned off, or a folder or a
 * note left out (replication/keep-rule.ts), is removed from that replica on the next
 * round. What a replica does not keep is never answered from its copy: its reads go
 * to this Mac while it answers, and answer needs-the-Mac (`not_kept_here`) while it
 * is away (docs/plan/walnut-companion-unified-replica.md, 4f).
 *
 * One round per kind: `replica.sync` sends the manifest (key, sha256-12 of the
 * body, small metadata); the daemon answers the keys it lacks; `replica.put`
 * sends those bodies in batches. An unchanged manifest is not sent again on the
 * same connection, and a changed one goes as its changes since the one the host
 * took last (sentManifest): an edit of one note was the whole list of 2,000 to
 * 6,600 notes to each of nine hosts, about 280 times an hour (2026-11-16). Every read here is async: a first round reads ~13 MB of notes
 * (the measured vault), later rounds only stat, and hash what changed.
 *
 * The cloud companion gets the same rounds over HTTPS (syncCompanionHostReplica,
 * host key `companion`; its side is core/companion-host-replica.ts). Only the
 * transport differs.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { WALNUT_HOME } from '../constants.js'
import { notesRoot } from './notes/note-paths.js'
import { log } from '../logging/index.js'
import type { Config } from './types.js'
import { _resetAttachmentReplicaForTesting, forgetAttachments, syncAttachments } from './attachment-replica.js'
import { memoryEntriesForHost, replicaExtras, type Extras } from './host-replica-extras.js'
import { peekKindState } from './replication/replica-status.js'
import { cleanKeepEntries, leftOut } from './replication/keep-rule.js'
import { companionKeepOf } from './replication/companion-keep.js'
import { noteRefusalEnded, noteRoundFailure, noteRoundReached } from './replication/round-outage.js'
import { CLOUD_BOX_HOST_ALIAS } from './hosts/cloud-box-host.js'
import { daemonKeeperAlias, daemonTwinGroups, type NetSwitch, type TwinRows } from './hosts/daemon-twins.js'
import { HOST_REPLICA_MOVES, mergeMoves, pairMoves, recordMoves, vaultMoveLookups, type MovePair } from './replication/manifest-moves.js'
import { noteMoves } from './notes/note-path-moves.js'
import { walnutOwnedNote } from './notes/vault-files.js'
import { artifactsByProject, artifactsDir } from './artifacts/paths.js'

export type ReplicaKind = 'notes' | 'memory' | 'skills'
export const REPLICA_KINDS: readonly ReplicaKind[] = ['notes', 'memory', 'skills']

export interface HostKeep {
  notes: boolean
  /** Vault folders and single notes never copied to this host (replication/keep-rule.ts). */
  notesExclude: string[]
  memory: boolean
  skills: boolean
  /** The pictures and files of the notes: only while the notes are kept. */
  attachments: boolean
}

/** Bigger notes stay on the primary (none of the measured vault comes close). */
const MAX_NOTE_BYTES = 1024 * 1024
/** One replica.put frame's bodies. */
const PUT_BATCH_BYTES = 512 * 1024
const PUT_TIMEOUT_MS = 60_000

export function sha12(body: string): string {
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 12)
}

/**
 * The companion's host key: its copy's Settings row (`host:companion`), its memo. No host
 * takes the alias (replication/companion-keep.ts companionAliasRefusal).
 */
export const COMPANION_REPLICA_HOST = 'companion'

/**
 * Where a replica's keep settings live: a host's `hosts.<key>.keep`; the companion's
 * `cloud_bridge.keep` (replication/companion-keep.ts companionKeepOf). The cloud box's
 * daemon (`__cloudbox__`, the Mac's sessions on the companion's machine) keeps what the
 * companion keeps: one choice for the box, "What the cloud companion keeps".
 */
export function keepSettingsOf(config: Config, hostKey: string, opts: { companion?: boolean } = {}): NonNullable<Config['cloud_bridge']>['keep'] {
  if (opts.companion || hostKey === CLOUD_BOX_HOST_ALIAS) return companionKeepOf(config)
  // Another alias of a daemon keeps what the name it goes by keeps: the daemon holds ONE copy per
  // Walnut, and a row with no settings would put back what that name's settings leave out.
  // The same name the daemon's bridge goes by (daemon-connection.ts daemonNames).
  const rows = (config.hosts ?? {}) as TwinRows
  const group = daemonTwinGroups(rows).find((g) => g.includes(hostKey))
  const name = group ? daemonKeeperAlias(group, rows, (config.net ?? null) as NetSwitch) : hostKey
  return config.hosts?.[name]?.keep
}

/** What `hostKey` keeps (`companion`: the cloud companion's own copy). A replica with no settings keeps everything. */
export function hostKeepFor(config: Config, hostKey: string, opts: { companion?: boolean } = {}): HostKeep {
  const keep = keepSettingsOf(config, hostKey, opts)
  return {
    notes: keep?.notes !== false,
    notesExclude: cleanKeepEntries(keep?.notes_exclude),
    memory: keep?.memory !== false,
    skills: keep?.skills !== false,
    attachments: keep?.notes !== false && keep?.attachments !== false,
  }
}

export interface ReplicaEntry { k: string; h: string; n: number; m?: Record<string, unknown> }

interface NoteCacheRow { mtimeMs: number; size: number; h: string; m: Record<string, unknown> }
const noteCache = new Map<string, NoteCacheRow>()
/** Notes the last walk of a root left out for their size (WP11: a host refuses away writes to them). */
const tooBigByRoot = new Map<string, string[]>()

/** The notes too large to copy, as the last walk of `root` found them (capped). */
export function notesTooBig(root = notesRoot()): string[] {
  return tooBigByRoot.get(root) ?? []
}

function noteTitle(rel: string, content: string, data: Record<string, unknown>): string {
  if (typeof data.title === 'string' && data.title.trim()) return data.title.trim()
  const heading = /^#\s+(.+)$/m.exec(content)
  if (heading) return heading[1].trim()
  return path.posix.basename(rel).replace(/\.md$/i, '')
}

async function noteMeta(rel: string, content: string, mtimeMs: number): Promise<Record<string, unknown>> {
  const { parseFrontmatter, readId } = await import('./parse-frontmatter.js')
  const { data } = parseFrontmatter(content)
  const id = readId(data)
  return { title: noteTitle(rel, content, data), updatedAt: new Date(mtimeMs).toISOString(), ...(id ? { id } : {}) }
}

/** Walks in progress: the hosts' rounds a note edit starts together share one walk of the vault. */
const walking = new Map<string, Promise<ReplicaEntry[]>>()

/**
 * Every note this host may keep: `.md` files, no dot folders, no attachment folder, none left out.
 * In the one tree (notes_unified) the vault is the whole artifacts folder: Walnut's own memory and
 * skills there (memory/, skills/, projects/<p>/memory|skills/) are their own kinds, never notes.
 */
export function noteEntries(exclude: string[], root = notesRoot()): Promise<ReplicaEntry[]> {
  const tree = noteMoves() !== null
  const key = JSON.stringify([root, exclude, tree])
  const running = walking.get(key)
  if (running) return running
  const p = walkNotes(exclude, root, tree).finally(() => walking.delete(key))
  walking.set(key, p)
  return p
}

async function walkNotes(exclude: string[], root: string, tree: boolean): Promise<ReplicaEntry[]> {
  const out: ReplicaEntry[] = []
  const seen = new Set<string>()
  const tooBig: string[] = []
  const walk = async (dir: string, relDir: string): Promise<void> => {
    let names: import('node:fs').Dirent[]
    try { names = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const d of names) {
      if (d.name.startsWith('.')) continue
      const rel = relDir ? `${relDir}/${d.name}` : d.name
      if (d.isDirectory()) {
        if (d.name === '_attachment' || leftOut(rel, exclude) || (tree && walnutOwnedNote(`${rel}/`))) continue
        await walk(path.join(dir, d.name), rel)
        continue
      }
      if (!d.isFile() || !/\.md$/i.test(d.name) || leftOut(rel, exclude)) continue
      const abs = path.join(dir, d.name)
      let st: import('node:fs').Stats
      try { st = await fsp.stat(abs) } catch { continue }
      if (st.size > MAX_NOTE_BYTES) { if (tooBig.length < 5_000) tooBig.push(rel); continue }
      seen.add(abs)
      let row = noteCache.get(abs)
      if (!row || row.mtimeMs !== st.mtimeMs || row.size !== st.size) {
        let content: string
        try { content = await fsp.readFile(abs, 'utf8') } catch { continue }
        row = { mtimeMs: st.mtimeMs, size: st.size, h: sha12(content), m: await noteMeta(rel, content, st.mtimeMs) }
        noteCache.set(abs, row)
      }
      out.push({ k: rel, h: row.h, n: row.size, m: row.m })
    }
  }
  await walk(root, '')
  tooBigByRoot.set(root, tooBig.sort())
  // A note deleted since the last round leaves the cache with it.
  for (const abs of noteCache.keys()) if (abs.startsWith(root + path.sep) && !seen.has(abs)) noteCache.delete(abs)
  return out
}

async function noteBody(key: string, root = notesRoot()): Promise<string | null> {
  const abs = path.resolve(root, key)
  if (!abs.startsWith(root + path.sep)) return null
  try { return await fsp.readFile(abs, 'utf8') } catch { return null }
}

/** Bodies of the JSON kinds, keyed: the exact objects the server's own routes answer with. */
async function jsonBodies(kind: 'memory' | 'skills'): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (kind === 'memory') {
    const { readGlobalMemoryDoc, readUserMemoryDoc } = await import('../web/routes/memory.js')
    const [global, user] = await Promise.all([readGlobalMemoryDoc().catch(() => null), readUserMemoryDoc().catch(() => null)])
    if (global) out.set('global', JSON.stringify(global))
    if (user) out.set('user', JSON.stringify(user))
    return out
  }
  const { listAllSkills } = await import('./skill-store.js')
  // `location` is this machine's file path, which means nothing on the host, and
  // the shipped skills' changes with every deploy (they are served from its
  // stage dir): kept, it resent those skills to every host after each deploy.
  for (const { location: _here, ...skill } of await listAllSkills()) out.set(skill.dirName, JSON.stringify(skill))
  return out
}

export interface ReplicaTarget {
  hostKey: string
  send: (cmd: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>
  /** The target keeps the pictures and files too (a daemon with 'attachment-copy-v1', the companion). */
  attachments?: boolean
  /** The cloud companion's own copy: its keep is `cloud_bridge.keep`, never a host's. */
  companion?: true
  /**
   * The target takes `renamed` beside a manifest (HOST_REPLICA_MOVES: the daemon's capability,
   * the companion's `replica.status` feature). Without it a move goes as removals and additions,
   * as before: the half rule refuses most of a copy moving, and the user confirms it.
   */
  moves?: boolean
}

export interface ReplicaRoundResult {
  kind: ReplicaKind; action: 'synced' | 'unchanged' | 'dropped' | 'failed'; entries?: number; sent?: number; held?: number; error?: string
  /** Manifest lines the round sent: its changes, or every entry when it went whole. */
  listed?: number
  /** Rows the host moved to their new keys (renamed) instead of removing and fetching them. */
  moved?: number
  /** `unchanged` because the leader holds back a manifest the host refused, not because the host holds it. */
  refusedHeld?: true
}

/** A manifest a host refused and holds back is tried again this often, so a host that changed on its own is seen. */
const REFUSED_RECHECK_MS = 6 * 60 * 60 * 1000

/**
 * The half rule's leader side for a host copy (section 4): a refused manifest counts
 * toward the Settings row while it holds still; a confirm the user gave rides along only
 * for that count and key set.
 */
async function removalGuard(hostKey: string, kind: ReplicaKind, entries: ReplicaEntry[], answerBy: unknown): Promise<{
  params: Record<string, unknown>; held: boolean; refused: (reply: Record<string, unknown>) => Promise<void>; accepted: () => void
}> {
  const status = await import('./replication/replica-status.js')
  const { CONFIRM_AFTER_REFUSALS, manifestKeysHashOf, refusalWarnsNow } = await import('./replication/kind.js')
  const kindName = `host-${kind}`
  const st = status.peekKindState(`host:${hostKey}`, kindName)
  const keys = manifestKeysHashOf(entries)
  const now = Date.now()
  const c = st?.confirmNext ? st.confirmFor : undefined
  const confirm = c && c.expiresAt > now && c.entries === entries.length && c.keys === keys ? { entries: c.entries, keys: c.keys } : null
  // What the host's answer depends on besides the keys: whether it takes moves, what is left out.
  const holdHash = sha12(JSON.stringify([keys, answerBy]))
  return {
    params: confirm ? { confirm: true, confirmFor: confirm } : {},
    // Refused as it is three rounds in a row and nothing changed since: the round leaves it
    // unsent (2026-11-20: hosts from before moves refused the one tree's move every round, over
    // a hundred warnings an hour, though nothing could change before they updated).
    held: !confirm && st?.holdFor?.manifest === holdHash && now < st.holdFor.until,
    refused: async (reply) => {
      const s = status.kindState(statusTarget(hostKey), kindName)
      if (confirm) { s.confirmNext = false; s.confirmFor = undefined }
      const hadRefusal = !!s.lastRefusal
      s.refusals = s.lastRefusal && s.lastRefusal.entries === entries.length && s.lastRefusal.keys === keys ? s.refusals + 1 : 1
      const d = (reply.detail && typeof reply.detail === 'object' ? reply.detail : {}) as { local?: unknown; removing?: unknown }
      s.lastRefusal = {
        error: 'manifest_removes_most_rows', at: now, entries: entries.length, keys,
        ...(typeof d.local === 'number' ? { local: d.local } : {}), ...(typeof d.removing === 'number' ? { removing: d.removing } : {}),
      }
      s.action = 'failed'
      const hold = s.refusals >= CONFIRM_AFTER_REFUSALS
      s.holdFor = hold ? { manifest: holdHash, until: now + REFUSED_RECHECK_MS } : undefined
      const data = {
        host: hostKey, kind, entries: entries.length, refusals: s.refusals,
        ...(hold ? { held: 'not sent again until it changes, the host takes moves or is replaced, the user confirms, or 6 h pass' } : {}),
      }
      // A warn when the refusal starts and when it is held; a refusal that stands (the list
      // changed by a note or two, the host still without moves) is info until a round is taken.
      if (refusalWarnsNow(hadRefusal, s.refusals)) log.session.warn('host replica: the host refused a manifest that removes most of its copy', data)
      else log.session.info('host replica: the host still refuses a manifest that removes most of its copy', data)
    },
    accepted: () => {
      if (!st) return
      st.refusals = 0
      st.lastRefusal = undefined
      st.holdFor = undefined
      if (confirm) { st.confirmNext = false; st.confirmFor = undefined }
      st.action = 'synced'
    },
  }
}

/** The host holds `kind`'s current manifest: a refusal the Settings row shows for it is over. */
async function endRefusal(hostKey: string, kind: ReplicaKind): Promise<void> {
  const st = (await import('./replication/replica-status.js')).peekKindState(`host:${hostKey}`, `host-${kind}`)
  if (!st?.lastRefusal) return
  st.refusals = 0
  st.lastRefusal = undefined
  st.holdFor = undefined
}

/** The manifest last sent per host and kind on its current connection. */
const lastManifest = new Map<string, string>()

/**
 * The manifest each host and kind took last (its id, the hash the memo uses, and its
 * entries by key): the next one goes as the changes since it. The host keeps it under
 * the same id (host-replica-core.ts ReplicaManifestRef) and says when it does not.
 */
const sentManifest = new Map<string, { id: string; entries: Map<string, ReplicaEntry> }>()

// ── The manifests the hosts took, across this server's restarts ──
// A deploy restarts the server about every quarter hour on a busy day, and each restart
// sent every host its whole notes list again (2026-11-17: 6,646 entries to nine hosts at
// 09:27, 09:41 and 09:54, 97 s a round to newdev). The hosts' daemons keep the manifest they
// took while they run, so the leader keeps it too: one file per manifest id (hosts with the
// same list share it) and an index of which id each host and kind took.
const takenDir = (): string => path.join(WALNUT_HOME, 'cache', 'host-replica')
const TAKEN_INDEX = 'taken.json'
const takenOnDisk = new Map<string, string>()
let takenLoaded: Promise<void> | null = null
let takenSaving: Promise<void> = Promise.resolve()

function loadTaken(): Promise<void> {
  takenLoaded ??= (async () => {
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(takenDir(), TAKEN_INDEX), 'utf8')) as Record<string, unknown>
      for (const [k, id] of Object.entries(raw)) if (typeof id === 'string' && /^[0-9a-f]{12}$/.test(id)) takenOnDisk.set(k, id)
    } catch { /* none kept yet */ }
  })()
  return takenLoaded
}

/** The manifest `memoKey`'s host took last: in memory, else as this server kept it before a restart. */
async function lastTaken(memoKey: string): Promise<{ id: string; entries: Map<string, ReplicaEntry> } | undefined> {
  const held = sentManifest.get(memoKey)
  if (held) return held
  await loadTaken()
  const id = takenOnDisk.get(memoKey)
  if (!id) return undefined
  try {
    const list = JSON.parse(await fsp.readFile(path.join(takenDir(), `${id}.json`), 'utf8')) as ReplicaEntry[]
    const entries = new Map<string, ReplicaEntry>()
    for (const e of list) if (e && typeof e.k === 'string' && !entries.has(e.k)) entries.set(e.k, e)
    const got = { id, entries }
    sentManifest.set(memoKey, got)
    return got
  } catch {
    forgetTaken(memoKey)
    return undefined
  }
}

async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, data)
  await fsp.rename(tmp, file)
}

/** Keep the index (and a new manifest's file) on disk; drop the files no host took. */
function saveTaken(manifest?: { id: string; entries: Map<string, ReplicaEntry> }): void {
  const index = JSON.stringify(Object.fromEntries(takenOnDisk))
  const keep = new Set([...takenOnDisk.values()].map((id) => `${id}.json`))
  takenSaving = takenSaving.then(async () => {
    const dir = takenDir()
    await fsp.mkdir(dir, { recursive: true })
    if (manifest) {
      const file = path.join(dir, `${manifest.id}.json`)
      const there = await fsp.access(file).then(() => true, () => false)
      if (!there) await writeAtomic(file, JSON.stringify([...manifest.entries.values()]))
    }
    await writeAtomic(path.join(dir, TAKEN_INDEX), index)
    for (const name of await fsp.readdir(dir)) {
      if (name.endsWith('.json') && name !== TAKEN_INDEX && !keep.has(name)) await fsp.rm(path.join(dir, name), { force: true })
    }
  }).catch((err) => {
    log.session.warn('host replica: the manifests the hosts took could not be kept on disk', { error: err instanceof Error ? err.message : String(err) })
  })
}

function rememberTaken(memoKey: string, manifest: { id: string; entries: Map<string, ReplicaEntry> }): void {
  sentManifest.set(memoKey, manifest)
  if (takenOnDisk.get(memoKey) === manifest.id) return
  takenOnDisk.set(memoKey, manifest.id)
  saveTaken(manifest)
}

function forgetTaken(memoKey: string): void {
  sentManifest.delete(memoKey)
  if (takenOnDisk.delete(memoKey)) saveTaken()
}

/** Tests: what this server kept on disk is written. */
export function _hostReplicaSavedForTesting(): Promise<void> {
  return takenSaving
}
/** Hosts and kinds whose copy refused a changes-only manifest on this connection (a daemon from before it). */
const wholeOnly = new Set<string>()

/**
 * A host's connection changed: its next round sends every manifest again. As the changes
 * since the one it took, still: a daemon that kept running holds that base, and one that
 * restarted says it does not (manifest_base_unknown), and gets the whole list that round.
 */
export function forgetHostReplica(hostKey: string): void {
  const prefix = `${hostKey}\u0000`
  for (const key of [...lastManifest.keys()]) if (key.startsWith(prefix)) lastManifest.delete(key)
  for (const key of [...wholeOnly]) if (key.startsWith(prefix)) wholeOnly.delete(key)
  // A new process or box may answer otherwise (an empty copy takes anything): a held manifest goes
  // once more. The refusal count stays, so another refusal holds it again at once.
  for (const kind of REPLICA_KINDS) {
    const st = peekKindState(`host:${hostKey}`, `host-${kind}`)
    if (st?.holdFor) st.holdFor.until = 0
  }
  forgetAttachments(hostKey)
}

function sameMeta(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => a[k] === b[k])
}

/** What changed from `before` to `entries`: the entries added or changed, the keys gone. */
export function manifestChanges(before: ReadonlyMap<string, ReplicaEntry>, entries: readonly ReplicaEntry[]): { changed: ReplicaEntry[]; removed: string[] } {
  const changed: ReplicaEntry[] = []
  const now = new Set<string>()
  for (const e of entries) {
    // A key named twice counts once, its first line, as the host takes it.
    if (now.has(e.k)) continue
    now.add(e.k)
    const was = before.get(e.k)
    if (!was || was.h !== e.h || was.n !== e.n || !sameMeta(was.m, e.m)) changed.push(e)
  }
  const removed: string[] = []
  for (const k of before.keys()) if (!now.has(k)) removed.push(k)
  return { changed, removed }
}

// ── WP11: notes written on the host while away (section 4 "held", section 6) ──

/** A round the host answered with held keys runs again after this long. */
export const HELD_RERUN_MS = 35_000
const heldReruns = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * A drain acked note records of this host (or, from the companion, memory records): its
 * next round sends that manifest again (the copy holds those keys until a manifest from
 * after the ack stored them).
 */
export function noteRecordsAcked(hostKey: string, kind: ReplicaKind = 'notes'): void {
  lastManifest.delete(`${hostKey}\u0000${kind}`)
}

function scheduleHeldRerun(target: ReplicaTarget, kind: ReplicaKind, held: number): void {
  if (heldReruns.has(target.hostKey)) return
  log.session.info('host replica: the host holds keys an away write made; the round runs again', { host: target.hostKey, kind, held, inMs: HELD_RERUN_MS })
  const timer = setTimeout(() => {
    heldReruns.delete(target.hostKey)
    void syncHostReplica(target)
  }, HELD_RERUN_MS)
  timer.unref?.()
  heldReruns.set(target.hostKey, timer)
}

/** Tests: no rerun left armed. */
export function _resetHostReplicaForTesting(): void {
  for (const t of heldReruns.values()) clearTimeout(t)
  heldReruns.clear()
  lastManifest.clear()
  sentManifest.clear()
  wholeOnly.clear()
  // As a restart leaves it: what is on disk stays (a test removes the dir for a clean slate).
  takenOnDisk.clear()
  takenLoaded = null
  companionMemoAt = 0
  _resetAttachmentReplicaForTesting()
}

/** The Settings row's target for a host's copy (replica-status.ts), the half rule's refusals. */
function statusTarget(hostKey: string): { id: string; kind: 'host'; label: string } {
  return { id: `host:${hostKey}`, kind: 'host', label: hostKey }
}

/**
 * The user confirmed a removal the half rule refused three rounds in a row (the Settings
 * row, POST /api/replicas/confirm-removal kind `host-<kind>`): the next round sends
 * `confirm:true` bound to that manifest's count and keys.
 */
export async function confirmHostReplicaRemoval(hostKey: string, kind: ReplicaKind, seen: { entries?: number; keys?: string } = {}): Promise<boolean> {
  const status = await import('./replication/replica-status.js')
  if (!status.peekKindState(`host:${hostKey}`, `host-${kind}`)) return false
  const { confirmKindRemoval } = await import('./replication/kind-leader.js')
  if (!confirmKindRemoval(statusTarget(hostKey), `host-${kind}`, seen)) return false
  lastManifest.delete(`${hostKey}\u0000${kind}`)
  log.session.warn('host replica: the user confirmed a removal of most of a host copy', { host: hostKey, kind })
  return true
}

/** The vault holds the tasks' own folders (the one tree by task id, whose vault is the artifacts folder). */
function vaultHoldsTaskFolders(): boolean {
  if (artifactsByProject()) return false
  const rel = path.relative(notesRoot(), path.join(artifactsDir(), 'nodes'))
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * The folders of the tasks kept local, which a host's notes copy leaves out as it leaves out the
 * user's own choices (replication/host-private.ts): their notes, their pictures, and what the host
 * is told it lacks. None for the companion, which holds every task.
 */
async function keptFoldersFor(target: ReplicaTarget): Promise<string[]> {
  if (target.companion || !vaultHoldsTaskFolders()) return []
  return (await import('./replication/host-private.js')).keptVaultFolders(notesRoot())
}

async function searchExclude(config: Config): Promise<string[]> {
  return cleanKeepEntries((config as { search?: { excluded_folders?: unknown } }).search?.excluded_folders)
}

async function syncKind(target: ReplicaTarget, kind: ReplicaKind, keep: HostKeep, config: Config): Promise<ReplicaRoundResult> {
  const home = WALNUT_HOME
  const memoKey = `${target.hostKey}\u0000${kind}`
  const on = kind === 'notes' ? keep.notes : kind === 'memory' ? keep.memory : keep.skills
  if (!on) {
    if (lastManifest.get(memoKey) === 'dropped') return { kind, action: 'unchanged' }
    const r = await target.send('replica.drop', { home, kind })
    if (r.ok !== true) throw new Error(typeof r.error === 'string' ? r.error : 'replica.drop refused')
    lastManifest.set(memoKey, 'dropped')
    forgetTaken(memoKey)
    return { kind, action: 'dropped' }
  }
  let entries: ReplicaEntry[]
  let bodies: Map<string, string> | null = null
  let extras: Extras | null = null
  let kept: string[] = []
  if (kind === 'notes') {
    // The walk first: hosts that start a round together share it.
    entries = await noteEntries(keep.notesExclude)
    kept = await keptFoldersFor(target)
    if (kept.length > 0) entries = entries.filter((e) => !leftOut(e.k, kept))
  } else {
    bodies = await jsonBodies(kind)
    entries = [...bodies].map(([k, body]) => ({ k, h: sha12(body), n: Buffer.byteLength(body) }))
    // The rest of the memory dir and the skills' references, for every target alike.
    const skills = kind === 'skills' ? await (await import('./skill-store.js')).listAllSkills() : []
    extras = await replicaExtras(kind, skills)
    // A host's memory copy leaves a kept-local task's files out (replication/host-private.ts); the companion keeps them.
    entries.push(...(kind === 'memory' && !target.companion ? await memoryEntriesForHost(extras) : extras.entries))
  }
  const opts = kind === 'notes'
    ? { searchExclude: await searchExclude(config), keepExclude: [...keep.notesExclude, ...kept], tooBig: notesTooBig() }
    : undefined
  const manifestHash = sha12(JSON.stringify([entries, opts ?? null]))
  if (lastManifest.get(memoKey) === manifestHash) {
    // The host took this very manifest: a refusal of a later one (since undone) no longer stands.
    await endRefusal(target.hostKey, kind)
    return { kind, action: 'unchanged', entries: entries.length }
  }
  const guard = await removalGuard(target.hostKey, kind, entries, [target.moves === true, opts ?? null])
  if (guard.held) return { kind, action: 'unchanged', entries: entries.length, refusedHeld: true }
  const asOf = Date.now()
  const base = { home, kind, asOf, manifestId: manifestHash, ...(opts ? { opts } : {}), ...guard.params }
  const taken = await lastTaken(memoKey)
  const last = wholeOnly.has(memoKey) ? undefined : taken
  // The moves are worked out only for a manifest that goes with them (the changes remove keys, or the list goes whole).
  let pairs: MovePair[] | undefined
  const changeMoves = (): MovePair[] => (pairs ??= taken ? pairMoves(taken.entries, entries, kind === 'notes' ? vaultMoveLookups() : {}) : [])
  let reply: Record<string, unknown> | null = null
  let listed = entries.length
  if (last) {
    // The changes only: the host applies them to the manifest it took last and checks the
    // whole list it gets exactly as before (the half rule, held keys, what it lacks).
    const { changed, removed } = manifestChanges(last.entries, entries)
    listed = changed.length + removed.length
    reply = await target.send('replica.sync', { ...base, base: last.id, changed, removed, ...(target.moves && removed.length && changeMoves().length ? { renamed: changeMoves() } : {}) })
    if (reply.ok !== true && reply.errorKind !== 'manifest_removes_most_rows') {
      // A host without that base (restarted), a failed request, or one from before
      // changes-only manifests ("bad entries": it found no `entries`, so it changed
      // nothing; only that one gets whole lists for the rest of the connection).
      if (/bad entries/.test(String(reply.error ?? ''))) wholeOnly.add(memoKey)
      forgetTaken(memoKey)
      reply = null
      listed = entries.length
    }
  }
  const whole = reply ? [] : target.moves ? wholeMoves(kind, taken, entries, changeMoves) : []
  reply ??= await target.send('replica.sync', { ...base, entries, ...(whole.length ? { renamed: whole } : {}) })
  if (reply.ok !== true) {
    if (reply.errorKind === 'manifest_removes_most_rows') await guard.refused(reply)
    throw new Error(typeof reply.error === 'string' ? reply.error : 'replica.sync refused')
  }
  guard.accepted()
  const took = new Map<string, ReplicaEntry>()
  for (const e of entries) if (!took.has(e.k)) took.set(e.k, e)
  rememberTaken(memoKey, { id: manifestHash, entries: took })
  const held = typeof reply.held === 'number' ? reply.held : 0
  const need = Array.isArray(reply.need) ? (reply.need as unknown[]).filter((k): k is string => typeof k === 'string') : []
  const wanted = new Map(entries.map((e) => [e.k, e.h]))
  let batch: Array<{ k: string; body: string }> = []
  let batchBytes = 0
  let sent = 0
  let skipped = 0
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    const r = await target.send('replica.put', { home, kind, files: batch }, PUT_TIMEOUT_MS)
    if (r.ok !== true) throw new Error(typeof r.error === 'string' ? r.error : 'replica.put refused')
    sent += typeof r.stored === 'number' ? r.stored : 0
    batch = []
    batchBytes = 0
  }
  for (const k of need) {
    const body = bodies ? bodies.get(k) ?? (extras ? await extras.body(k) : null) : await noteBody(k)
    // Changed since the manifest: the next round sends the new one.
    if (body === null || sha12(body) !== wanted.get(k)) { skipped++; continue }
    const bytes = Buffer.byteLength(body)
    if (batch.length > 0 && batchBytes + bytes > PUT_BATCH_BYTES) await flush()
    batch.push({ k, body })
    batchBytes += bytes
  }
  await flush()
  // A body that moved under us leaves the daemon one short: send the manifest again next round.
  // Keys an away write holds there (WP11) are not in the copy yet: the round runs again later.
  if (skipped === 0 && held === 0) lastManifest.set(memoKey, manifestHash)
  else lastManifest.delete(memoKey)
  if (held > 0) scheduleHeldRerun(target, kind, held)
  return { kind, action: 'synced', entries: entries.length, listed, sent, ...(held ? { held } : {}), ...(typeof reply.moved === 'number' && reply.moved > 0 ? { moved: reply.moved } : {}) }
}

/**
 * The moves a whole list of `kind` goes with (manifest-moves.ts): those against the manifest the
 * host took last (`changeMoves`) and, for notes, the one tree's record pairs whose old key the host
 * may still hold: every pair while this server knows no manifest the host took, else only the old
 * keys that manifest still names. A host that took a manifest from after the move gets none, so a
 * whole list in the tree is not twice its size.
 */
function wholeMoves(kind: ReplicaKind, taken: { entries: Map<string, ReplicaEntry> } | undefined, entries: readonly ReplicaEntry[], changeMoves: () => MovePair[]): MovePair[] {
  const changes = changeMoves()
  const look = kind === 'notes' ? vaultMoveLookups() : {}
  if (!look.before) return changes
  const record = recordMoves(entries, look)
  return mergeMoves(changes, taken ? record.filter(([o]) => taken.entries.has(o)) : record)
}

const inFlight = new Map<string, { rerun: boolean }>()

// ── The cloud companion as a host (stage 4 of docs/plan/walnut-companion-unified-replica.md) ──

/** How long an unchanged manifest is trusted for the companion before it goes again. */
const COMPANION_MEMO_MS = 30 * 60_000
let companionMemoAt = 0

const companionTarget: ReplicaTarget = {
  hostKey: COMPANION_REPLICA_HOST,
  attachments: true,
  companion: true,
  send: async (cmd, params, timeoutMs) => (await import('./cloud-ingest.js')).postToCloudHostReplica(cmd, params, timeoutMs ? { timeoutMs } : {}),
}

/**
 * One round of the companion's copy over HTTPS (`/bridge/host-replica`), the round a
 * daemon gets. A daemon's memo ends with its
 * connection; the companion has no connection to end, so its memo ends when the box
 * says a kind never arrived whole (a new box), every 30 minutes, and when its build
 * changes (forgetCompanionHostReplica). Never throws.
 */
export async function syncCompanionHostReplica(): Promise<ReplicaRoundResult[]> {
  const ingest = await import('./cloud-ingest.js')
  if (!(await ingest.cloudHostReplicaAvailable())) return []
  // One small step first: an older build (no door) or a box that is down costs no round.
  const st = await ingest.postToCloudHostReplica('replica.status', {})
  if (st.ok !== true) return []
  const kinds = (st.kinds ?? {}) as Record<string, { asOf?: unknown; off?: unknown }>
  // A box whose build takes moves says so here; an older one gets removals and additions, as before.
  companionTarget.moves = Array.isArray(st.features) && st.features.includes(HOST_REPLICA_MOVES)
  // A kind the user turned off for the box has no asOf by design: that is not a new box.
  if (Date.now() - companionMemoAt > COMPANION_MEMO_MS || REPLICA_KINDS.some((k) => kinds[k]?.asOf == null && kinds[k]?.off !== true)) {
    forgetHostReplica(COMPANION_REPLICA_HOST)
    companionMemoAt = Date.now()
  }
  return syncHostReplica(companionTarget)
}

/** The companion changed build: its copy rounds go again at once. */
export function forgetCompanionHostReplica(): void {
  companionMemoAt = 0
  forgetHostReplica(COMPANION_REPLICA_HOST)
}

/**
 * Bring `target`'s copy up to date, every kind, then its pictures and files. One
 * round per host at a time; a request during a round runs one more round after it.
 * Never throws.
 */
export async function syncHostReplica(target: ReplicaTarget): Promise<ReplicaRoundResult[]> {
  const running = inFlight.get(target.hostKey)
  if (running) { running.rerun = true; return [] }
  const state = { rerun: false }
  inFlight.set(target.hostKey, state)
  const results: ReplicaRoundResult[] = []
  let keep: HostKeep | null = null
  try {
    do {
      state.rerun = false
      const { getConfig } = await import('./config-manager.js')
      const config = await getConfig()
      keep = hostKeepFor(config, target.hostKey, { companion: target.companion })
      /** The host was not reachable this round: its other kinds wait for the next round, untried. */
      let away: string | null = null
      for (const kind of REPLICA_KINDS) {
        if (away !== null) { results.push({ kind, action: 'failed', error: away }); continue }
        const startedAt = Date.now()
        try {
          const r = await syncKind(target, kind, keep, config)
          results.push(r)
          // A memo's `unchanged` asked nothing of the host: only a reply proves it is back. Any
          // round but a held refusal leaves the host holding the kind's manifest.
          if (r.action !== 'unchanged') noteRoundReached(log.session, 'host replica', target.hostKey)
          if (!r.refusedHeld) noteRefusalEnded(log.session, 'host replica', target.hostKey, kind)
          if (r.action !== 'unchanged') {
            log.session.info('host replica: round', { host: target.hostKey, kind, action: r.action, entries: r.entries, listed: r.listed, sent: r.sent, ...(r.moved ? { moved: r.moved } : {}), ms: Date.now() - startedAt })
          }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          results.push({ kind, action: 'failed', error })
          if (noteRoundFailure(log.session, 'host replica', target.hostKey, error, { kind })) away = error
        }
      }
    } while (state.rerun)
  } finally {
    inFlight.delete(target.hostKey)
  }
  // Outside the kinds' round: a first fill of the pictures never holds a note edit back.
  if (keep && target.attachments) await attachmentsRound(target, keep)
  return results
}

async function attachmentsRound(target: ReplicaTarget, keep: HostKeep): Promise<void> {
  const r = await syncAttachments(target, { on: keep.attachments, exclude: [...keep.notesExclude, ...(await keptFoldersFor(target))] })
  if (r.action === 'failed') noteRoundFailure(log.session, 'host replica attachments', target.hostKey, r.error ?? 'failed', { kind: 'attachments' }, { message: 'host replica: attachments round failed' })
  // `skipped` sent nothing (a refusal held back, an older host); anything else leaves the host holding the pictures' list.
  else if (r.action !== 'skipped') noteRefusalEnded(log.session, 'host replica attachments', target.hostKey, 'attachments')
  if (r.action !== 'failed' && r.action !== 'unchanged' && r.action !== 'skipped') {
    noteRoundReached(log.session, 'host replica attachments', target.hostKey)
    log.session.info('host replica: attachments round', { host: target.hostKey, ...r })
  }
}
