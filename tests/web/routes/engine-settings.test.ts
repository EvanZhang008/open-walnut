/**
 * GET/PATCH /api/engines/:id/settings through the real HTTP edge, with the daemon
 * transport replaced by an in-memory host: pins the wire shape, the host and
 * body validation, the status each failure class maps to (400 / 404 / 409 /
 * 501 daemon_needs_upgrade / 502) and the `outcome` every failure body carries.
 * The 504 deadline is not exercised here (20s is not a unit-test budget); the
 * real daemon path is covered by the daemon tests and the Playwright spec
 * against the fixture server.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createHash } from 'node:crypto'

const files = new Map<string, string>()
const writes: Array<{ path: string; expectSha256: string }> = []
let readImpl: ((p: string) => Promise<Buffer | null>) | null = null
let writeImpl: ((p: string, text: string, sha: string) => Promise<void>) | null = null

const sha = (t: string) => createHash('sha256').update(t, 'utf-8').digest('hex')

vi.mock('../../../src/core/daemon-file-reader.js', () => {
  class DaemonNeedsUpgradeError extends Error {
    constructor(public host: string, public capability = 'x') {
      super(`The Walnut daemon on ${host} needs an upgrade (missing '${capability}')`)
      this.name = 'DaemonNeedsUpgradeError'
    }
  }
  class DaemonFileReader {
    constructor(public host: string) {}
    async readFileBytes(p: string, maxBytes: number): Promise<Buffer | null> {
      if (readImpl) return readImpl(p)
      if (!files.has(p)) return null
      const bytes = Buffer.from(files.get(p)!, 'utf-8')
      if (bytes.length > maxBytes) throw new Error(`file is ${bytes.length} bytes, larger than the ${maxBytes}-byte limit for this read (EFBIG)`)
      return bytes
    }
    async writeFileAtomic(p: string, text: string, expectSha256: string): Promise<void> {
      if (writeImpl) return writeImpl(p, text, expectSha256)
      const current = files.has(p) ? sha(files.get(p)!) : 'absent'
      if (current !== expectSha256) throw new Error('fs.write refused: file changed since it was read (EMODIFIED)')
      writes.push({ path: p, expectSha256 })
      files.set(p, text)
    }
    async ensureGitExcluded(cwd: string, p: string): Promise<'added' | 'already' | 'not-a-repo' | 'unavailable'> {
      excluded.push({ cwd, path: p })
      return 'added'
    }
  }
  return { DaemonFileReader, DaemonNeedsUpgradeError }
})

const excluded: Array<{ cwd: string; path: string }> = []

vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: async (id: string) => (id === 'sess-1'
    ? { claude_session_id: 'sess-1', host: 'devbox', cwd: '/work/repo' }
    : id === 'sess-local' ? { claude_session_id: 'sess-local', host: null, cwd: '/Users/me/app' } : null),
}))

vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ hosts: { devbox: { hostname: 'devbox.example', enabled: true } } }),
}))

vi.mock('../../../src/core/agents/engine-probe.js', () => ({
  probeEngines: async () => new Map(),
}))

const { enginesRouter } = await import('../../../src/web/routes/engines.js')
const { DaemonNeedsUpgradeError } = await import('../../../src/core/daemon-file-reader.js')

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/engines', enginesRouter)
  return app
}

const USER = '~/.claude/settings.json'
let app: express.Express
const envBefore = process.env.DISABLE_AUTOUPDATER

beforeEach(() => {
  files.clear()
  writes.length = 0
  excluded.length = 0
  readImpl = null
  writeImpl = null
  delete process.env.DISABLE_AUTOUPDATER
  app = createApp()
})

afterEach(() => {
  // The route reads process.env for the local host; leave it as this file found it.
  if (envBefore === undefined) delete process.env.DISABLE_AUTOUPDATER
  else process.env.DISABLE_AUTOUPDATER = envBefore
})

describe('GET /api/engines (catalog)', () => {
  it('advertises which engines have a settings surface', async () => {
    const res = await request(app).get('/api/engines')
    expect(res.status).toBe(200)
    const byId = Object.fromEntries((res.body.engines as Array<{ id: string; capabilities: { settings: boolean } }>).map((e) => [e.id, e.capabilities.settings]))
    expect(byId.claude).toBe(true)
    expect(byId.codex).toBe(true)
    expect(byId.gemini).toBe(false)
  })
})

describe('GET /api/engines/:id/settings', () => {
  it('returns the view for the local host by default, with env overrides evaluated', async () => {
    files.set(USER, JSON.stringify({ permissions: { defaultMode: 'plan', allow: ['Read'] }, hooks: { PreToolUse: [] } }))
    process.env.DISABLE_AUTOUPDATER = '1'
    const res = await request(app).get('/api/engines/claude/settings')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ engine: 'claude', displayName: 'Claude', host: '__local__', envChecked: true })
    expect(res.body.files).toEqual([
      expect.objectContaining({ id: 'user', path: USER, exists: true }),
      expect.objectContaining({ id: 'global', path: '~/.claude.json', exists: false }),
    ])
    const items = (res.body.groups as Array<{ items: Array<Record<string, unknown>> }>).flatMap((g) => g.items)
    expect(items.find((i) => i.key === 'permissions.defaultMode')).toMatchObject({ value: 'plan', source: 'file' })
    expect(items.find((i) => i.key === 'autoUpdates')).toMatchObject({ envOverride: { name: 'DISABLE_AUTOUPDATER', value: '1' } })
    expect(items.find((i) => i.key === 'alwaysThinkingEnabled')).toMatchObject({ value: true, source: 'default' })
  })

  it('accepts a configured remote host (env not evaluated there) and refuses an unknown one', async () => {
    const ok = await request(app).get('/api/engines/claude/settings?host=devbox')
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ host: 'devbox', envChecked: false })
    const bad = await request(app).get('/api/engines/claude/settings?host=nope')
    expect(bad.status).toBe(400)
    expect(bad.body.error).toContain("unknown host 'nope'")
    // Keys every object has are not configured hosts.
    for (const ghost of ['__proto__', 'toString', 'constructor']) {
      expect((await request(app).get(`/api/engines/claude/settings?host=${ghost}`)).status, ghost).toBe(400)
    }
  })

  it('is 404 for an engine without a settings surface and for an unknown engine', async () => {
    expect((await request(app).get('/api/engines/gemini/settings')).status).toBe(404)
    expect((await request(app).get('/api/engines/zzz/settings')).status).toBe(404)
  })

  it('maps a daemon-upgrade failure to 501 and a transport failure to 502', async () => {
    readImpl = async () => { throw new DaemonNeedsUpgradeError('devbox', 'fs-write-atomic-v1') }
    const upgrade = await request(app).get('/api/engines/claude/settings?host=devbox')
    expect(upgrade.status).toBe(501)
    expect(upgrade.body).toMatchObject({ code: 'daemon_needs_upgrade' })
    expect(upgrade.body.error).toMatch(/needs an upgrade/)

    readImpl = async () => { throw new Error('fs.read transport failure: socket closed') }
    const transport = await request(app).get('/api/engines/claude/settings')
    expect(transport.status).toBe(502)
    expect(transport.body.error).toMatch(/could not read ~\/.claude\/settings.json: fs.read transport failure/)
  })
})

describe('PATCH /api/engines/:id/settings', () => {
  it('writes the addressed keys, answers with a fresh view and the changed list', async () => {
    files.set(USER, JSON.stringify({ permissions: { defaultMode: 'plan', allow: ['Read'] } }, null, 2))
    const res = await request(app).patch('/api/engines/claude/settings').send({ set: { alwaysThinkingEnabled: false }, unset: ['permissions.defaultMode'] })
    expect(res.status).toBe(200)
    expect(res.body.changed.sort()).toEqual(['alwaysThinkingEnabled', 'permissions.defaultMode'])
    expect(JSON.parse(files.get(USER)!)).toEqual({ permissions: { allow: ['Read'] }, alwaysThinkingEnabled: false })
    expect(writes).toHaveLength(1)
    const items = (res.body.groups as Array<{ items: Array<Record<string, unknown>> }>).flatMap((g) => g.items)
    expect(items.find((i) => i.key === 'alwaysThinkingEnabled')).toMatchObject({ value: false, source: 'file' })
    expect(items.find((i) => i.key === 'permissions.defaultMode')).toMatchObject({ value: 'default', source: 'default' })
  })

  it('rejects bad bodies with 400 before any write', async () => {
    files.set(USER, '{}')
    for (const body of [{}, { set: { verbose: 'yes' } }, { set: { nope: true } }, { unset: 'verbose' }, { set: { 'permissions.defaultMode': 'yolo' } }]) {
      const res = await request(app).patch('/api/engines/claude/settings').send(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(typeof res.body.error).toBe('string')
    }
    expect(writes).toHaveLength(0)
  })

  it('answers 409 when the file keeps changing underneath, and when it is unreadable', async () => {
    files.set(USER, '{}')
    writeImpl = async () => { throw new Error('fs.write refused: file changed since it was read (EMODIFIED)') }
    const conflict = await request(app).patch('/api/engines/claude/settings').send({ set: { verbose: true } })
    expect(conflict.status).toBe(409)
    expect(conflict.body.error).toMatch(/changed by another program/)
    expect(conflict.body.outcome).toBe('not-written')

    writeImpl = null
    files.set(USER, '{ nope')
    const unreadable = await request(app).patch('/api/engines/claude/settings').send({ set: { verbose: true } })
    expect(unreadable.status).toBe(409)
    expect(unreadable.body.error).toMatch(/refusing to write/)
    expect(unreadable.body.outcome).toBe('not-written')
    expect(files.get(USER)).toBe('{ nope')
  })

  it("carries outcome 'unknown' on a transport failure and 'written' when only the read-back failed", async () => {
    files.set(USER, '{}')
    writeImpl = async () => { throw new Error('fs.write failed: socket closed') }
    const lost = await request(app).patch('/api/engines/claude/settings').send({ set: { verbose: true } })
    expect(lost.status).toBe(502)
    expect(lost.body.outcome).toBe('unknown')

    writeImpl = null
    let reads = 0
    readImpl = async (p) => {
      // The first two reads serve the read-modify-write; the read-back after the write fails.
      if (++reads > 2) throw new Error('fs.read transport failure: socket closed')
      return files.has(p) ? Buffer.from(files.get(p)!, 'utf-8') : null
    }
    const readBack = await request(app).patch('/api/engines/claude/settings').send({ set: { verbose: true } })
    expect(readBack.status).toBe(502)
    expect(readBack.body.outcome).toBe('written')
    expect(readBack.body.error).toMatch(/^saved, but/)
    expect(JSON.parse(files.get(USER)!)).toEqual({ verbose: true })
  })

  it('answers 501 daemon_needs_upgrade when the host daemon lacks the atomic write', async () => {
    files.set(USER, '{}')
    writeImpl = async () => { throw new DaemonNeedsUpgradeError('devbox', 'fs-write-atomic-v1') }
    const res = await request(app).patch('/api/engines/claude/settings?host=devbox').send({ set: { verbose: true } })
    expect(res.status).toBe(501)
    expect(res.body).toMatchObject({ code: 'daemon_needs_upgrade', outcome: 'not-written' })
  })

  it('takes host and cwd from a session, lets explicit params win, and refuses an unknown session or a bad cwd', async () => {
    const bySession = await request(app).get('/api/engines/claude/settings?sessionId=sess-1')
    expect(bySession.status).toBe(200)
    expect(bySession.body).toMatchObject({ host: 'devbox', cwd: '/work/repo', scope: 'default', projectScopeAvailable: true, envChecked: false })
    expect((bySession.body.files as Array<{ id: string; path: string }>).map((f) => [f.id, f.path])).toEqual([
      ['user', USER], ['global', '~/.claude.json'],
      ['project', '/work/repo/.claude/settings.json'], ['project-local', '/work/repo/.claude/settings.local.json'],
    ])
    const local = await request(app).get('/api/engines/claude/settings?sessionId=sess-local')
    expect(local.body).toMatchObject({ host: '__local__', cwd: '/Users/me/app', envChecked: true })
    const overridden = await request(app).get('/api/engines/claude/settings?sessionId=sess-1&host=__local__&cwd=/elsewhere')
    expect(overridden.body).toMatchObject({ host: '__local__', cwd: '/elsewhere' })
    expect((await request(app).get('/api/engines/claude/settings?sessionId=nope')).status).toBe(400)
    expect((await request(app).get('/api/engines/claude/settings?cwd=relative/dir')).status).toBe(400)
    expect((await request(app).get('/api/engines/claude/settings?cwd=/a/../b')).status).toBe(400)
    expect((await request(app).get('/api/engines/claude/settings?cwd=/a&scope=global')).status).toBe(400)
    expect((await request(app).get('/api/engines/claude/settings?scope=project')).status).toBe(400)
  })

  it("scope=project writes the session's local project file, creates it, and keeps it out of git", async () => {
    files.set(USER, JSON.stringify({ verbose: false }))
    const res = await request(app).patch('/api/engines/claude/settings?sessionId=sess-1&scope=project').send({ set: { verbose: true } })
    expect(res.status).toBe(200)
    expect(JSON.parse(files.get('/work/repo/.claude/settings.local.json')!)).toEqual({ verbose: true })
    expect(JSON.parse(files.get(USER)!)).toEqual({ verbose: false })
    expect(excluded).toEqual([{ cwd: '/work/repo', path: '/work/repo/.claude/settings.local.json' }])
    expect(res.body.gitExclude).toEqual({ path: '/work/repo/.claude/settings.local.json', outcome: 'added' })
    const items = (res.body.groups as Array<{ items: Array<Record<string, unknown>> }>).flatMap((g) => g.items)
    expect(items.find((i) => i.key === 'verbose')).toMatchObject({
      value: true, source: 'overlay', overlay: { file: 'project-local' },
      writeTarget: { file: 'project-local', path: '/work/repo/.claude/settings.local.json', holds: true },
    })
  })

  it('default scope with a cwd follows the CLI: output style lands in the local project file, thinking in the user file', async () => {
    files.set(USER, JSON.stringify({ alwaysThinkingEnabled: true }))
    const res = await request(app).patch('/api/engines/claude/settings?cwd=/work/repo').send({ set: { outputStyle: 'Learning', alwaysThinkingEnabled: false } })
    expect(res.status).toBe(200)
    expect(JSON.parse(files.get('/work/repo/.claude/settings.local.json')!)).toEqual({ outputStyle: 'Learning' })
    expect(JSON.parse(files.get(USER)!)).toEqual({ alwaysThinkingEnabled: false })
    expect(res.body.gitExclude).toMatchObject({ outcome: 'added' })
    // Without a cwd the same key stays user-wide and no git question is asked.
    excluded.length = 0
    const noCwd = await request(app).patch('/api/engines/claude/settings').send({ set: { outputStyle: 'Explanatory' } })
    expect(noCwd.status).toBe(200)
    expect(JSON.parse(files.get(USER)!)).toEqual({ alwaysThinkingEnabled: false, outputStyle: 'Explanatory' })
    expect(noCwd.body.gitExclude).toBeUndefined()
    expect(excluded).toEqual([])
  })

  it('edits codex config.toml top-level keys through the same route', async () => {
    files.set('~/.codex/config.toml', 'model = "x"\n\n[projects."/p"]\ntrust_level = "trusted"\n')
    const res = await request(app).patch('/api/engines/codex/settings').send({ set: { sandbox_mode: 'workspace-write' } })
    expect(res.status).toBe(200)
    expect(files.get('~/.codex/config.toml')).toBe('model = "x"\nsandbox_mode = "workspace-write"\n\n[projects."/p"]\ntrust_level = "trusted"\n')
  })
})
