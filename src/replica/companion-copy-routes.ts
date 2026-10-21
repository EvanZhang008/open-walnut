/**
 * The cloud companion's memory and skill routes over the Mac's copy (stage 4d of
 * docs/plan/walnut-companion-unified-replica.md; the copy: core/companion-host-replica.ts).
 *
 *   memory  GET /api/memory/{global,user} and /api/v1/memory/{global,user} (memory_read)
 *           answer the copy with the box's pending saves over it; a PUT is a `memory`
 *           record in the journal (core/companion-memory.ts). Both once the copy is
 *           held and the Mac drains `memory`; before, the routes run as before.
 *   skills  GET /api/skills[/:dirName] and /api/v1/skills[/:dirName] (skill_read) answer
 *           the copy once it is held. A skill write there answers needs-the-Mac: a skill
 *           is a folder (its references, its enabled flag) and the copy holds the skill
 *           as one document, so a write here could only go to the box's own disk, and the
 *           copy would show it reverted until git sync brought it round. References stay
 *           the box's own files.
 *
 * Mounted first on the routers that own those paths (web/routes/memory.ts,
 * search-memory-v1.ts, skills.ts, console-v1.ts, library-v1.ts). The v1 routers run on
 * the box only when the Mac does not answer (v1-forward carries the rest to the Mac).
 * The answers keep each route's own shape; `x-walnut-copy-as-of` says how old the copy is.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { companionMemoryActive, companionMemoryAsOf, companionMemoryDoc, companionMemorySave, isMemoryDocName, type MemoryDocName } from '../core/companion-memory.js'
import { COMPANION_REPLICA_HOME, companionCopyHolds, companionHostReplica } from '../core/companion-host-replica.js'
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

/** `/global` or `/user` under the router's own prefix (web: /api/memory; v1: /api/v1/memory). */
function memoryDocOf(flavor: Flavor, p: string): MemoryDocName | null {
  const m = (flavor === 'v1' ? /^\/memory\/([^/]+)\/?$/ : /^\/([^/]+)\/?$/).exec(p)
  return m && isMemoryDocName(m[1]) ? m[1] : null
}

export function companionMemoryRoutes(flavor: Flavor): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const doc = memoryDocOf(flavor, req.path)
    const read = req.method === 'GET' || req.method === 'HEAD'
    if (!doc || (!read && req.method !== 'PUT') || !companionMemoryActive()) { next(); return }
    const file = doc === 'global' ? 'MEMORY.md' : 'USER.md'
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
}

// ── skills ──

type CopySkill = Record<string, unknown> & { dirName: string }

function parseSkill(body: string): CopySkill | null {
  try {
    const s = JSON.parse(body) as CopySkill
    // The Mac's file path means nothing here, and the copy does not carry it (core/host-replica.ts).
    return s && typeof s.dirName === 'string' ? { ...s, location: '' } : null
  } catch {
    return null
  }
}

/** Every skill of the copy, in the copy's key order. */
function copySkills(): CopySkill[] {
  const r = companionHostReplica()
  const list = r?.list(COMPANION_REPLICA_HOME, 'skills')
  if (!r || !list) return []
  const out: CopySkill[] = []
  let want = list.entries.map((e) => e.k)
  while (want.length > 0) {
    const got = r.readMany(COMPANION_REPLICA_HOME, 'skills', want, 8 * 1024 * 1024)
    if (!got) break
    for (const f of got.files) { const s = parseSkill(f.body); if (s) out.push(s) }
    if (got.more.length >= want.length) break
    want = got.more
  }
  return out
}

function copySkill(dirName: string): CopySkill | null {
  const r = companionHostReplica()
  const hit = r?.read(COMPANION_REPLICA_HOME, 'skills', dirName)
    ?? (LEGACY_SKILL_DIR_ALIASES[dirName] ? r?.read(COMPANION_REPLICA_HOME, 'skills', LEGACY_SKILL_DIR_ALIASES[dirName]) : null)
  return hit ? parseSkill(hit.body) : null
}

/** The path under the skills prefix (web: /api/skills; v1: /api/v1/skills), or null for another route. */
function skillPathOf(flavor: Flavor, p: string): string | null {
  if (flavor === 'web') return p
  if (p === '/skills' || p === '/skills/') return '/'
  return p.startsWith('/skills/') ? p.slice('/skills'.length) : null
}

export function companionSkillRoutes(flavor: Flavor): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const p = skillPathOf(flavor, req.path)
    if (p === null || !companionCopyHolds('skills')) { next(); return }
    const parts = p.split('/').filter(Boolean)
    const read = req.method === 'GET' || req.method === 'HEAD'
    // A skill's references are its folder's other files: the box's own (the copy holds SKILL.md).
    if (parts.length > 1) { next(); return }
    if (!read) {
      log.web.info('companion: a skill change needs the Mac', { method: req.method, path: req.originalUrl })
      send(res, needsLeaderAnswer('skill_changes_need_mac', 'Skills here are a copy of the ones on your Mac, so a skill is changed on your Mac.'))
      return
    }
    asOf(res, companionHostReplica()?.status(COMPANION_REPLICA_HOME).skills?.asOf)
    if (parts.length === 0) {
      const skills = copySkills()
      res.json({ skills: flavor === 'v1' ? skills.map(({ content: _content, ...rest }) => rest) : skills })
      return
    }
    let dirName = parts[0]!
    try { dirName = decodeURIComponent(dirName) } catch { /* as sent */ }
    if (flavor === 'v1' && !/^[A-Za-z0-9._-]+$/.test(dirName)) { badRequest(res, flavor, 'Invalid skill name'); return }
    const skill = copySkill(dirName)
    if (!skill) { notFound(res, flavor, `Skill not found: ${dirName}`); return }
    res.json({ skill })
  }
}
