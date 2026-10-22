/**
 * The primary's side of each host's read copy (docs/plan/walnut-control-plane.md,
 * "What a host keeps"; the daemon side is
 * src/providers/host-replica-core.ts).
 *
 * A host keeps a copy of the note text (never attachments), MEMORY.md and
 * USER.md, and the skills, so a session there reads them while the leader cannot
 * answer. What a host keeps is the user's choice (config `hosts.<alias>.keep`,
 * Settings > Remote Hosts); each kind is on unless turned off, and a kind turned
 * off is removed from that host on the next round.
 *
 * One round per kind: `replica.sync` sends the manifest (key, sha256-12 of the
 * body, small metadata); the daemon answers the keys it lacks; `replica.put`
 * sends those bodies in batches. An unchanged manifest is not sent again on the
 * same connection. Every read here is async: a first round reads ~13 MB of notes
 * (the measured vault), later rounds only stat, and hash what changed.
 *
 * The cloud companion gets the same rounds over HTTPS (syncCompanionHostReplica,
 * host key `companion`; its side is core/companion-host-replica.ts).
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { NOTES_DIR, WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'
import type { Config } from './types.js'
import { forgetCompanionAttachments, syncCompanionAttachments } from './attachment-replica.js'
import { companionReplicaExtras, type Extras } from './host-replica-extras.js'

export type ReplicaKind = 'notes' | 'memory' | 'skills'
export const REPLICA_KINDS: readonly ReplicaKind[] = ['notes', 'memory', 'skills']

export interface HostKeep {
  notes: boolean
  /** Vault folders never copied to this host. */
  notesExclude: string[]
  memory: boolean
  skills: boolean
}

/** Bigger notes stay on the primary (none of the measured vault comes close). */
const MAX_NOTE_BYTES = 1024 * 1024
/** One replica.put frame's bodies. */
const PUT_BATCH_BYTES = 512 * 1024
const PUT_TIMEOUT_MS = 60_000

export function sha12(body: string): string {
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 12)
}

function cleanFolders(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.map((e) => String(e).trim().split('\\').join('/').replace(/^\/+|\/+$/g, '')).filter(Boolean)
}

/** What `hostKey` keeps. A host with no settings keeps everything. */
export function hostKeepFor(config: Config, hostKey: string): HostKeep {
  const keep = config.hosts?.[hostKey]?.keep
  return {
    notes: keep?.notes !== false,
    notesExclude: cleanFolders(keep?.notes_exclude),
    memory: keep?.memory !== false,
    skills: keep?.skills !== false,
  }
}

export interface ReplicaEntry { k: string; h: string; n: number; m?: Record<string, unknown> }

interface NoteCacheRow { mtimeMs: number; size: number; h: string; m: Record<string, unknown> }
const noteCache = new Map<string, NoteCacheRow>()
/** Notes the last walk of a root left out for their size (WP11: a host refuses away writes to them). */
const tooBigByRoot = new Map<string, string[]>()

/** The notes too large to copy, as the last walk of `root` found them (capped). */
export function notesTooBig(root = NOTES_DIR): string[] {
  return tooBigByRoot.get(root) ?? []
}

function inFolder(rel: string, folders: string[]): boolean {
  return folders.some((f) => rel === f || rel.startsWith(`${f}/`))
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

/** Every note this host may keep: `.md` files, no dot folders, no attachment folder, none excluded. */
export function noteEntries(exclude: string[], root = NOTES_DIR): Promise<ReplicaEntry[]> {
  const key = JSON.stringify([root, exclude])
  const running = walking.get(key)
  if (running) return running
  const p = walkNotes(exclude, root).finally(() => walking.delete(key))
  walking.set(key, p)
  return p
}

async function walkNotes(exclude: string[], root: string): Promise<ReplicaEntry[]> {
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
        if (d.name === '_attachment' || inFolder(rel, exclude)) continue
        await walk(path.join(dir, d.name), rel)
        continue
      }
      if (!d.isFile() || !/\.md$/i.test(d.name) || inFolder(rel, exclude)) continue
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

async function noteBody(key: string, root = NOTES_DIR): Promise<string | null> {
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
}

export interface ReplicaRoundResult { kind: ReplicaKind; action: 'synced' | 'unchanged' | 'dropped' | 'failed'; entries?: number; sent?: number; held?: number; error?: string }

/**
 * The half rule's leader side for a host copy (section 4): a refused manifest counts
 * toward the Settings row while it holds still; a confirm the user gave rides along only
 * for that count and key set.
 */
async function removalGuard(hostKey: string, kind: ReplicaKind, entries: ReplicaEntry[]): Promise<{
  params: Record<string, unknown>; refused: (reply: Record<string, unknown>) => Promise<void>; accepted: () => void
}> {
  const status = await import('./replication/replica-status.js')
  const { manifestKeysHashOf } = await import('./replication/kind.js')
  const kindName = `host-${kind}`
  const st = status.peekKindState(`host:${hostKey}`, kindName)
  const keys = manifestKeysHashOf(entries)
  const now = Date.now()
  const c = st?.confirmNext ? st.confirmFor : undefined
  const confirm = c && c.expiresAt > now && c.entries === entries.length && c.keys === keys ? { entries: c.entries, keys: c.keys } : null
  return {
    params: confirm ? { confirm: true, confirmFor: confirm } : {},
    refused: async (reply) => {
      const s = status.kindState(statusTarget(hostKey), kindName)
      if (confirm) { s.confirmNext = false; s.confirmFor = undefined }
      s.refusals = s.lastRefusal && s.lastRefusal.entries === entries.length && s.lastRefusal.keys === keys ? s.refusals + 1 : 1
      const d = (reply.detail && typeof reply.detail === 'object' ? reply.detail : {}) as { local?: unknown; removing?: unknown }
      s.lastRefusal = {
        error: 'manifest_removes_most_rows', at: now, entries: entries.length, keys,
        ...(typeof d.local === 'number' ? { local: d.local } : {}), ...(typeof d.removing === 'number' ? { removing: d.removing } : {}),
      }
      s.action = 'failed'
      log.session.warn('host replica: the host refused a manifest that removes most of its copy', { host: hostKey, kind, entries: entries.length, refusals: s.refusals })
    },
    accepted: () => {
      if (!st) return
      st.refusals = 0
      st.lastRefusal = undefined
      if (confirm) { st.confirmNext = false; st.confirmFor = undefined }
      st.action = 'synced'
    },
  }
}

/** The manifest last sent per host and kind on its current connection. */
const lastManifest = new Map<string, string>()

/** A host's connection changed: its next round sends every manifest again. */
export function forgetHostReplica(hostKey: string): void {
  for (const key of [...lastManifest.keys()]) if (key.startsWith(`${hostKey}\u0000`)) lastManifest.delete(key)
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
  companionMemoAt = 0
  forgetCompanionAttachments()
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

async function searchExclude(config: Config): Promise<string[]> {
  return cleanFolders((config as { search?: { excluded_folders?: unknown } }).search?.excluded_folders)
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
    return { kind, action: 'dropped' }
  }
  let entries: ReplicaEntry[]
  let bodies: Map<string, string> | null = null
  let extras: Extras | null = null
  if (kind === 'notes') {
    entries = await noteEntries(keep.notesExclude)
  } else {
    bodies = await jsonBodies(kind)
    entries = [...bodies].map(([k, body]) => ({ k, h: sha12(body), n: Buffer.byteLength(body) }))
    // The companion's copy also carries the rest of the memory dir and the skills' references (4d).
    if (target.hostKey === COMPANION_REPLICA_HOST) {
      const skills = kind === 'skills' ? await (await import('./skill-store.js')).listAllSkills() : []
      extras = await companionReplicaExtras(kind, skills)
      entries.push(...extras.entries)
    }
  }
  const opts = kind === 'notes'
    ? { searchExclude: await searchExclude(config), keepExclude: keep.notesExclude, tooBig: notesTooBig() }
    : undefined
  const manifestHash = sha12(JSON.stringify([entries, opts ?? null]))
  if (lastManifest.get(memoKey) === manifestHash) return { kind, action: 'unchanged', entries: entries.length }
  const guard = await removalGuard(target.hostKey, kind, entries)
  const reply = await target.send('replica.sync', { home, kind, entries, asOf: Date.now(), ...(opts ? { opts } : {}), ...guard.params })
  if (reply.ok !== true) {
    if (reply.errorKind === 'manifest_removes_most_rows') await guard.refused(reply)
    throw new Error(typeof reply.error === 'string' ? reply.error : 'replica.sync refused')
  }
  guard.accepted()
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
  return { kind, action: 'synced', entries: entries.length, sent, ...(held ? { held } : {}) }
}

const inFlight = new Map<string, { rerun: boolean }>()

// ── The cloud companion as a host (stage 4 of docs/plan/walnut-companion-unified-replica.md) ──

/** The companion's host key: its copy's Settings row (`host:companion`), its keep settings. */
export const COMPANION_REPLICA_HOST = 'companion'
/** How long an unchanged manifest is trusted for the companion before it goes again. */
const COMPANION_MEMO_MS = 30 * 60_000
let companionMemoAt = 0

const companionTarget: ReplicaTarget = {
  hostKey: COMPANION_REPLICA_HOST,
  send: async (cmd, params, timeoutMs) => (await import('./cloud-ingest.js')).postToCloudHostReplica(cmd, params, timeoutMs ? { timeoutMs } : {}),
}

/**
 * One round of the companion's notes, memory and skills copy over HTTPS
 * (`/bridge/host-replica`), the round a daemon gets. A daemon's memo ends with its
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
  const kinds = (st.kinds ?? {}) as Record<string, { asOf?: unknown }>
  if (Date.now() - companionMemoAt > COMPANION_MEMO_MS || REPLICA_KINDS.some((k) => kinds[k]?.asOf == null)) {
    forgetHostReplica(COMPANION_REPLICA_HOST)
    companionMemoAt = Date.now()
  }
  const results = await syncHostReplica(companionTarget)
  // Then the pictures and files of the notes, which only the companion keeps (core/attachment-replica.ts).
  try {
    const { getConfig } = await import('./config-manager.js')
    const config = await getConfig()
    const keep = hostKeepFor(config, COMPANION_REPLICA_HOST)
    const on = keep.notes && config.hosts?.[COMPANION_REPLICA_HOST]?.keep?.attachments !== false
    const r = await syncCompanionAttachments(companionTarget.send, { on, exclude: keep.notesExclude })
    if (r.action !== 'unchanged' && r.action !== 'skipped') log.session.info('host replica: companion attachments round', { ...r })
  } catch (err) {
    log.session.warn('host replica: companion attachments round failed', { error: err instanceof Error ? err.message : String(err) })
  }
  return results
}

/** The companion changed build: its copy rounds go again at once. */
export function forgetCompanionHostReplica(): void {
  companionMemoAt = 0
  forgetHostReplica(COMPANION_REPLICA_HOST)
  forgetCompanionAttachments()
}

/**
 * Bring `target`'s copy up to date, every kind. One round per host at a time;
 * a request during a round runs one more round after it. Never throws.
 */
export async function syncHostReplica(target: ReplicaTarget): Promise<ReplicaRoundResult[]> {
  const running = inFlight.get(target.hostKey)
  if (running) { running.rerun = true; return [] }
  const state = { rerun: false }
  inFlight.set(target.hostKey, state)
  const results: ReplicaRoundResult[] = []
  try {
    do {
      state.rerun = false
      const { getConfig } = await import('./config-manager.js')
      const config = await getConfig()
      const keep = hostKeepFor(config, target.hostKey)
      for (const kind of REPLICA_KINDS) {
        const startedAt = Date.now()
        try {
          const r = await syncKind(target, kind, keep, config)
          results.push(r)
          if (r.action !== 'unchanged') {
            log.session.info('host replica: round', { host: target.hostKey, kind, action: r.action, entries: r.entries, sent: r.sent, ms: Date.now() - startedAt })
          }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          results.push({ kind, action: 'failed', error })
          log.session.warn('host replica: round failed', { host: target.hostKey, kind, error })
        }
      }
    } while (state.rerun)
  } finally {
    inFlight.delete(target.hostKey)
  }
  return results
}
