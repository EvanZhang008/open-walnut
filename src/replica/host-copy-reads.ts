/**
 * A host replica's memory and skills reads while it answers alone (docs/plan/walnut-control-plane.md,
 * "What a host keeps"; 4f of docs/plan/walnut-companion-unified-replica.md): from the copy the
 * host's daemon keeps (stage 4e: the same memory and skills copy the companion keeps), read
 * through the follower link (`replica.list/read/readMany {kind}`, 'replica-reads-v1'), never
 * from this server's own data dir, which holds neither.
 *
 *   memory  GET /api/memory/{global,user}, the category lists, the browse tree, one file
 *           (web), and /api/v1/memory/{global,user} and its lists (v1): the shapes the Mac's
 *           routes answer, built by the companion's readers over a view of the daemon's copy
 *           (core/companion-memory-files.ts withMemoryCopyView)
 *   skills  GET /api/skills[/:dirName[/references[/:file]]] and the v1 twins
 *
 * Turned off for this host: `not_kept_here`. Not here yet, or a daemon without the reads:
 * needs-the-Mac (`kind_not_copied`, `copy_unreadable`). The writes are not here: they go on
 * to the route table's away answer.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { NEEDS_LEADER_HEADERS } from '../core/replication/needs-leader.js'
import { needsLeaderAnswer, type PortAnswer } from './write-port.js'
import { isHostReplicaProgram } from '../core/server-role.js'
import { computeContentHash } from '../utils/file-ops.js'

type Flavor = 'web' | 'v1'
type Kind = 'memory' | 'skills'
type Request_ = (cmd: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>
interface Entry { k: string; h: string; n?: number; m?: Record<string, unknown> }

let request: Request_ | null = null

/** The host replica's boot: its daemon's copy, through the follower link (null: none). */
export function installHostCopyReads(req: Request_ | null): void {
  request = req
}

const READ_TIMEOUT_MS = 30_000
const KEYS_PER_READ = 5_000

async function ask(cmd: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!request) throw new Error('this host has no copy reader')
  const r = await request(cmd, params, READ_TIMEOUT_MS)
  if (r.ok !== true && r.errorKind !== 'not_found') throw new Error(typeof r.error === 'string' ? r.error : `${cmd} failed`)
  return r
}

/** Every body of `keys` in as few reads as the daemon allows (its answer holds 4 MB; it takes 20,000 keys). */
async function readMany(kind: Kind, keys: string[]): Promise<Map<string, { body: string }>> {
  const out = new Map<string, { body: string }>()
  for (let i = 0; i < keys.length; i += KEYS_PER_READ) {
    let want = keys.slice(i, i + KEYS_PER_READ)
    while (want.length > 0) {
      const r = await ask('replica.readMany', { kind, keys: want })
      for (const f of (r.files as Array<{ k: string; body: string }> | undefined) ?? []) out.set(f.k, { body: f.body })
      const more = ((r.more as unknown[] | undefined) ?? []).filter((k): k is string => typeof k === 'string')
      if (more.length === 0 || more.length >= want.length) break
      want = more
    }
  }
  return out
}

/** A needs-the-Mac answer, in the shape the companion's copy routes give it (companion-copy-routes.ts). */
function needsMac(res: Response, _flavor: Flavor, a: PortAnswer): void {
  if (a.answered || res.headersSent) return
  res.status(a.status).set(NEEDS_LEADER_HEADERS).json(a.body)
}

function notFound(res: Response, flavor: Flavor, message: string): void {
  if (flavor === 'v1') res.status(404).json({ error: { code: 'not_found', message } })
  else res.status(404).json({ error: message })
}

/** The copy's manifest of `kind`, or the answer that says why there is none to read. */
async function manifestOf(kind: Kind, res: Response, flavor: Flavor): Promise<{ entries: Entry[]; asOf: string } | null> {
  let r: Record<string, unknown>
  try {
    r = await ask('replica.list', { kind })
  } catch {
    needsMac(res, flavor, needsLeaderAnswer('copy_unreadable', `This host's copy of your ${kind} could not be read; your Mac answers this when it is back.`))
    return null
  }
  if (r.off === true) {
    needsMac(res, flavor, needsLeaderAnswer('not_kept_here', kind === 'memory' ? 'Your memory is kept only on your Mac.' : 'Your skills are kept only on your Mac.'))
    return null
  }
  if (typeof r.asOf !== 'string' || !r.asOf) {
    needsMac(res, flavor, needsLeaderAnswer('kind_not_copied', `This host keeps no copy of your ${kind} yet; your Mac answers this.`))
    return null
  }
  return { entries: (r.entries as Entry[] | undefined) ?? [], asOf: r.asOf }
}

/** The path under the kind's prefix (web: /api/memory; v1: /api/v1/memory), or null for another route. */
function pathUnder(flavor: Flavor, kind: Kind, p: string): string | null {
  if (flavor === 'web') return p
  if (p === `/${kind}` || p === `/${kind}/`) return '/'
  return p.startsWith(`/${kind}/`) ? p.slice(kind.length + 1) : null
}

const reading = (req: Request): boolean => req.method === 'GET' || req.method === 'HEAD'

async function memoryRead(flavor: Flavor, p: string, req: Request, res: Response, next: NextFunction): Promise<void> {
  const files = await import('../core/companion-memory-files.js')
  const docs = await import('../core/companion-memory.js')
  if (p === '/telemetry') { needsMac(res, flavor, needsLeaderAnswer('memory_telemetry_needs_mac', 'Memory telemetry is your Mac\'s write history; your Mac answers this.')); return }
  const m = await manifestOf('memory', res, flavor)
  if (!m) return
  res.setHeader('x-walnut-copy-as-of', m.asOf)
  const doc = /^\/(global|user)\/?$/.exec(p)?.[1] as 'global' | 'user' | undefined
  if (doc) {
    const got = await readMany('memory', [doc])
    const memory = got.get(doc) ? docs.parseCopyMemoryDoc(doc, got.get(doc)!.body) : null
    if (!memory) { notFound(res, flavor, doc === 'global' ? 'Global MEMORY.md not found' : 'USER.md not found'); return }
    res.json({ memory })
    return
  }
  // The rest of the memory dir: an older Mac sends the two docs only.
  if (!m.entries.some((e) => e.k === files.MEMORY_FILES_MARKER)) {
    needsMac(res, flavor, needsLeaderAnswer('kind_not_copied', 'This host keeps no copy of your memory folder yet; your Mac answers this.'))
    return
  }
  const one = flavor === 'web' && p !== '/' && p !== '' && p !== '/browse' ? (() => { try { return decodeURIComponent(p.slice(1)) } catch { return p.slice(1) } })() : null
  if (one !== null && one.split('/').some((seg) => seg === '..')) { res.status(403).json({ error: 'Path traversal not allowed' }); return }
  if (flavor === 'v1' && p !== '/' && p !== '' && p !== '/browse') { next(); return }
  // The bodies this answer reads: the two docs and the listed files, or the one file.
  const keys = one !== null
    ? [one === 'MEMORY.md' ? 'global' : one === 'USER.md' ? 'user' : `f/${one}`]
    : ['global', 'user', ...m.entries.map((e) => e.k).filter((k) => /^f\/(sessions|projects|knowledge)\/.+\.md$/.test(k))]
  const bodies = await readMany('memory', keys)
  const byKey = new Map(m.entries.map((e) => [e.k, e]))
  const view = {
    entries: () => m.entries,
    read: (key: string) => { const b = bodies.get(key); return b ? { body: b.body, ...(byKey.get(key)?.m ? { m: byKey.get(key)!.m } : {}) } : null },
    doc: (name: 'global' | 'user') => { const b = bodies.get(name); return b ? docs.parseCopyMemoryDoc(name, b.body) : null },
  }
  files.withMemoryCopyView(view, () => {
    if (p === '/browse') { res.json({ tree: files.copyMemoryBrowseTree() }); return }
    if (one === null) {
      res.json({ memories: files.copyListMemories(typeof req.query.category === 'string' ? req.query.category : undefined) })
      return
    }
    const entry = files.copyMemoryEntry(one)
    if (!entry) { res.status(404).json({ error: 'Memory entry not found' }); return }
    res.json({ memory: { ...entry, contentHash: computeContentHash(entry.content) } })
  })
}

async function skillsRead(flavor: Flavor, p: string, res: Response, next: NextFunction): Promise<void> {
  const [{ parseCopySkill }, { LEGACY_SKILL_DIR_ALIASES }] = await Promise.all([
    import('../core/companion-host-replica.js'), import('../core/skill-loader.js'),
  ])
  const m = await manifestOf('skills', res, flavor)
  if (!m) return
  res.setHeader('x-walnut-copy-as-of', m.asOf)
  const parts = p.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x) } catch { return x } })
  const keys = new Set(m.entries.map((e) => e.k))
  if (parts.length === 0) {
    const bodies = await readMany('skills', [...keys].filter((k) => !k.includes('/')))
    const skills = [...bodies.values()].map((b) => parseCopySkill(b.body)).filter((s): s is NonNullable<typeof s> => s !== null)
    res.json({ skills: flavor === 'v1' ? skills.map(({ content: _content, ...rest }) => rest) : skills })
    return
  }
  const dirName = parts[0]!
  if (flavor === 'v1' && !/^[A-Za-z0-9._-]+$/.test(dirName)) { res.status(400).json({ error: { code: 'bad_request', message: 'Invalid skill name' } }); return }
  const alias = LEGACY_SKILL_DIR_ALIASES[dirName]
  const key = keys.has(dirName) ? dirName : alias && keys.has(alias) ? alias : null
  if (parts[1] === 'references' && parts.length <= 3) {
    if (!key) { notFound(res, flavor, `Skill not found: ${dirName}`); return }
    const prefix = `${key}/references/`
    if (parts.length === 2) {
      const files = m.entries.filter((e) => e.k.startsWith(prefix) && !e.k.slice(prefix.length).includes('/'))
        .map((e) => ({ name: e.k.slice(prefix.length), size: typeof e.m?.size === 'number' ? e.m.size : e.n ?? 0 }))
      res.json({ files })
      return
    }
    const file = parts[2]!
    if (file.includes('..') || file.includes('/') || file.includes('\\')) {
      if (flavor === 'v1') res.status(400).json({ error: { code: 'bad_request', message: 'Invalid filename' } })
      else res.status(400).json({ error: 'Invalid filename' })
      return
    }
    const got = (await readMany('skills', [`${prefix}${file}`])).get(`${prefix}${file}`)
    if (!got) { notFound(res, flavor, `Reference not found: ${file}`); return }
    res.json({ content: got.body })
    return
  }
  if (parts.length > 1) { next(); return }
  const got = key ? (await readMany('skills', [key])).get(key) : undefined
  const skill = got ? parseCopySkill(got.body) : null
  if (!skill) { notFound(res, flavor, `Skill not found: ${dirName}`); return }
  res.json({ skill })
}

/**
 * Mounted where the companion's copy routes are (companion-copy-routes.ts): on a host
 * replica, a memory or skills read that reached this server (the Mac does not answer it)
 * reads the daemon's copy. A write goes on (the route table's away answer).
 */
export function hostCopyReads(kind: Kind, flavor: Flavor): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const p = reading(req) && isHostReplicaProgram() ? pathUnder(flavor, kind, req.path) : null
    if (p === null) { next(); return }
    void (async () => {
      if (!request) {
        if (kind === 'memory') needsMac(res, flavor, needsLeaderAnswer('memory_needs_mac', 'This host has no copy of your memory to read; your Mac answers this.'))
        else needsMac(res, flavor, needsLeaderAnswer('skills_need_mac', 'This host has no copy of your skills to read; your Mac answers this.'))
        return
      }
      if (kind === 'memory') await memoryRead(flavor, p, req, res, next)
      else await skillsRead(flavor, p, res, next)
    })().catch((err: unknown) => { if (!res.headersSent) next(err) })
  }
}
