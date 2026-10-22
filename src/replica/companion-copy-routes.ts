/**
 * The cloud companion's memory and skill routes over the Mac's copy (stage 4d of
 * docs/plan/walnut-companion-unified-replica.md; the copy: core/companion-host-replica.ts).
 *
 *   memory  GET /api/memory/{global,user} and /api/v1/memory/{global,user} (memory_read)
 *           answer the copy with the box's pending saves over it once the copy is held;
 *           a PUT is a `memory` record in the journal (core/companion-memory.ts) once the
 *           Mac drains `memory` too. The rest of the memory dir (the browse tree, the
 *           category lists, one file) answers the copy's files (core/companion-memory-files.ts).
 *           A save of another memory file, a daily log compaction and the telemetry view
 *           need the Mac: they are the Mac's files and its write path's evidence.
 *   skills  GET /api/skills[/:dirName] and /api/v1/skills[/:dirName] (skill_read) answer
 *           the copy once it is held, and so do a skill's references. A skill write there
 *           always answers needs-the-Mac: a skill is a folder (its references, its enabled
 *           flag) and the copy holds the skill as one document, so a write here could only
 *           go to the box's own disk, which git sync no longer brings round.
 *
 * The box never reads or writes its own disk for these: until the copy is held (or with
 * an older Mac that sends the two memory docs only), a read answers needs-the-Mac
 * `kind_not_copied`.
 *
 * Mounted first on the routers that own those paths (web/routes/memory.ts,
 * search-memory-v1.ts, skills.ts, console-v1.ts, library-v1.ts). The v1 routers run on
 * the box only when the Mac does not answer (v1-forward carries the rest to the Mac).
 * The answers keep each route's own shape; `x-walnut-copy-as-of` says how old the copy is.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { companionMemoryAsOf, companionMemoryDoc, companionMemorySave, isMemoryDocName, type MemoryDocName } from '../core/companion-memory.js'
import { companionMemoryFiles, copyListMemories, copyMemoryBrowseTree, copyMemoryEntry } from '../core/companion-memory-files.js'
import { isCompanion } from '../core/server-role.js'
import { computeContentHash } from '../utils/file-ops.js'
import { COMPANION_REPLICA_HOME, companionCopyHolds, companionCopySkills, companionHostReplica, parseCopySkill, type CopySkill } from '../core/companion-host-replica.js'
import { LEGACY_SKILL_DIR_ALIASES } from '../core/skill-loader.js'
import { log } from '../logging/index.js'
import { needsLeaderAnswer, refusalAnswer, type PortAnswer } from './write-port.js'

type Flavor = 'web' | 'v1'

function send(res: Response, a: PortAnswer): void {
  if (a.answered || res.headersSent) return
  if (a.status === 503 || a.status === 429) {
    const after = (a.body.error as { retryAfter?: unknown } | undefined)?.retryAfter
    if (typeof after === 'number') res.setHeader('retry-after', String(after))
  }
  res.status(a.status).json(a.body)
}

function notFound(res: Response, flavor: Flavor, message: string): void {
  if (flavor === 'v1') res.status(404).json({ error: { code: 'not_found', message } })
  else res.status(404).json({ error: message })
}

function badRequest(res: Response, flavor: Flavor, message: string): void {
  if (flavor === 'v1') res.status(400).json({ error: { code: 'bad_request', message } })
  else res.status(400).json({ error: message })
}

function asOf(res: Response, at: string | null | undefined): void {
  if (at) res.setHeader('x-walnut-copy-as-of', at)
}

// ── memory ──

/** The path under the memory prefix (web: /api/memory; v1: /api/v1/memory), or null for another route. */
function memoryPathOf(flavor: Flavor, p: string): string | null {
  if (flavor === 'web') return p
  if (p === '/memory' || p === '/memory/') return '/'
  return p.startsWith('/memory/') ? p.slice('/memory'.length) : null
}

function memoryDocOf(p: string): MemoryDocName | null {
  const m = /^\/([^/]+)\/?$/.exec(p)
  return m && isMemoryDocName(m[1]) ? m[1] : null
}

const NO_MEMORY_COPY = 'This box keeps no copy of your memory yet; your Mac answers this.'

export function companionMemoryRoutes(flavor: Flavor): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const p = isCompanion() ? memoryPathOf(flavor, req.path) : null
    if (p === null) { next(); return }
    const read = req.method === 'GET' || req.method === 'HEAD'
    const doc = memoryDocOf(p)
    if (doc && (read || req.method === 'PUT')) { memoryDoc(flavor, doc, read, req, res); return }
    if (!read) {
      if (req.method !== 'PUT' && req.method !== 'POST' && req.method !== 'DELETE') { next(); return }
      log.web.info('companion: a memory change needs the Mac', { method: req.method, path: req.originalUrl })
      send(res, needsLeaderAnswer('memory_file_changes_need_mac', 'This memory file is kept on your Mac, so it is changed there.'))
      return
    }
    if (p === '/telemetry') { send(res, needsLeaderAnswer('memory_telemetry_needs_mac', 'Memory telemetry is your Mac\'s write history; your Mac answers this.')); return }
    if (companionMemoryFiles() !== 'copy') { send(res, needsLeaderAnswer('kind_not_copied', NO_MEMORY_COPY)); return }
    asOf(res, companionMemoryAsOf())
    if (p === '/browse') { res.json({ tree: copyMemoryBrowseTree() }); return }
    if (p === '/' || p === '') {
      res.json({ memories: copyListMemories(typeof req.query.category === 'string' ? req.query.category : undefined) })
      return
    }
    // One file by path: the web router's wildcard read (v1 has none: its other paths go on to a 404).
    if (flavor === 'v1') { next(); return }
    let rel = p.slice(1)
    try { rel = decodeURIComponent(rel) } catch { /* as sent */ }
    if (rel.split('/').some((seg) => seg === '..')) { res.status(403).json({ error: 'Path traversal not allowed' }); return }
    const entry = copyMemoryEntry(rel)
    if (!entry) { res.status(404).json({ error: 'Memory entry not found' }); return }
    res.json({ memory: { ...entry, contentHash: computeContentHash(entry.content) } })
  }
}

function memoryDoc(flavor: Flavor, doc: MemoryDocName, read: boolean, req: Request, res: Response): void {
  const file = doc === 'global' ? 'MEMORY.md' : 'USER.md'
  if (!companionCopyHolds('memory')) { send(res, needsLeaderAnswer('kind_not_copied', NO_MEMORY_COPY)); return }
  if (read) {
    const memory = companionMemoryDoc(doc)
    if (!memory) { notFound(res, flavor, doc === 'global' ? 'Global MEMORY.md not found' : 'USER.md not found'); return }
    asOf(res, companionMemoryAsOf())
    res.json({ memory })
    return
  }
  const b = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>
  if (typeof b.content !== 'string') { badRequest(res, flavor, 'content (string) is required'); return }
  // The v1 PUT takes no lock (search-memory-v1.ts); the web PUT's expectedHash is the editor's.
  const r = companionMemorySave({ doc, content: b.content, ...(flavor === 'web' ? { expectedHash: b.expectedHash } : {}) })
  if (r.ok) {
    log.web.info('companion: memory change kept for the Mac', { doc: file, seq: r.seq })
    res.json({ ok: true, updatedAt: r.updatedAt, contentHash: r.contentHash })
    return
  }
  log.web.info('companion: memory change refused', { doc: file, code: r.code })
  if (r.code === 'conflict') {
    const currentHash = r.detail?.currentHash ?? null
    if (flavor === 'web') res.status(409).json({ error: r.message, code: 'conflict', currentHash })
    else res.status(409).json({ error: { code: 'conflict', message: r.message }, currentHash })
    return
  }
  if (r.code === 'bad_request') { badRequest(res, flavor, r.message); return }
  const why = typeof r.detail?.why === 'string' ? r.detail.why : undefined
  send(res, r.code === 'needs_leader' ? needsLeaderAnswer(why ?? 'needs_mac', r.message) : refusalAnswer(r.code, r.message, r.detail, typeof r.detail?.retryAfterMs === 'number' ? r.detail.retryAfterMs : undefined))
}

// ── skills ──

// The Mac's file path means nothing here, and the copy does not carry it (core/host-replica.ts).
function copySkillKey(dirName: string): string | null {
  const r = companionHostReplica()
  if (r?.read(COMPANION_REPLICA_HOME, 'skills', dirName)) return dirName
  const alias = LEGACY_SKILL_DIR_ALIASES[dirName]
  return alias && r?.read(COMPANION_REPLICA_HOME, 'skills', alias) ? alias : null
}

function copySkill(dirName: string): CopySkill | null {
  const key = copySkillKey(dirName)
  const hit = key ? companionHostReplica()?.read(COMPANION_REPLICA_HOME, 'skills', key) : null
  return hit ? parseCopySkill(hit.body) : null
}

/** The path under the skills prefix (web: /api/skills; v1: /api/v1/skills), or null for another route. */
function skillPathOf(flavor: Flavor, p: string): string | null {
  if (flavor === 'web') return p
  if (p === '/skills' || p === '/skills/') return '/'
  return p.startsWith('/skills/') ? p.slice('/skills'.length) : null
}

/** A skill's reference files from the copy: the list (`file` absent) or one file's text. */
function references(flavor: Flavor, res: Response, dirName: string, file?: string): void {
  const key = copySkillKey(dirName)
  if (!key) { notFound(res, flavor, `Skill not found: ${dirName}`); return }
  const prefix = `${key}/references/`
  if (file === undefined) {
    const entries = companionHostReplica()?.list(COMPANION_REPLICA_HOME, 'skills')?.entries ?? []
    const files = entries.filter((e) => e.k.startsWith(prefix) && !e.k.slice(prefix.length).includes('/'))
      .map((e) => ({ name: e.k.slice(prefix.length), size: typeof e.m?.size === 'number' ? e.m.size : e.n ?? 0 }))
    res.json({ files })
    return
  }
  if (file.includes('..') || file.includes('/') || file.includes('\\')) { badRequest(res, flavor, 'Invalid filename'); return }
  const hit = companionHostReplica()?.read(COMPANION_REPLICA_HOME, 'skills', `${prefix}${file}`)
  if (!hit) { notFound(res, flavor, `Reference not found: ${file}`); return }
  res.json({ content: hit.body })
}

export function companionSkillRoutes(flavor: Flavor): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const p = isCompanion() ? skillPathOf(flavor, req.path) : null
    if (p === null) { next(); return }
    const read = req.method === 'GET' || req.method === 'HEAD'
    if (!read) {
      // Always the Mac's: the box's own skills dir is a copy git sync no longer brings round.
      log.web.info('companion: a skill change needs the Mac', { method: req.method, path: req.originalUrl })
      send(res, needsLeaderAnswer('skill_changes_need_mac', 'Skills here are a copy of the ones on your Mac, so a skill is changed on your Mac.'))
      return
    }
    if (!companionCopyHolds('skills')) { send(res, needsLeaderAnswer('kind_not_copied', 'This box keeps no copy of your skills yet; your Mac answers this.')); return }
    const parts = p.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x) } catch { return x } })
    asOf(res, companionHostReplica()?.status(COMPANION_REPLICA_HOME).skills?.asOf)
    if (parts.length === 0) {
      const skills = companionCopySkills()
      res.json({ skills: flavor === 'v1' ? skills.map(({ content: _content, ...rest }) => rest) : skills })
      return
    }
    const dirName = parts[0]!
    if (flavor === 'v1' && !/^[A-Za-z0-9._-]+$/.test(dirName)) { badRequest(res, flavor, 'Invalid skill name'); return }
    if (parts[1] === 'references' && parts.length <= 3) { references(flavor, res, dirName, parts[2]); return }
    if (parts.length > 1) { next(); return }
    const skill = copySkill(dirName)
    if (!skill) { notFound(res, flavor, `Skill not found: ${dirName}`); return }
    res.json({ skill })
  }
}
