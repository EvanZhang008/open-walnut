/**
 * What a replica's notes copy does not keep is never answered from it
 * (docs/plan/walnut-companion-unified-replica.md, 4f; src/replica/notes-routes.ts).
 *
 * A real express app with the copy reads mounted as the servers mount them, over the
 * REAL host-replica core (the daemon's copy) read through the replica's own reader
 * (notes-source.ts notesCopyReaderOver), so the off mark and the left-out lists ride the
 * same `replica.list` answer a follower frame carries. Two flavors of replica:
 *   - a host replica (no forward): its dispatcher already forwarded while the Mac
 *     answered, so here the Mac is away and a left-out note answers 503 not_kept_here;
 *   - the companion (a forward installed): a read of what it does not keep goes to the
 *     Mac first; the stand-in Mac answers or is away.
 * And a copy that keeps every note answers exactly as before: no `partial`, no forward.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import express from 'express'
import fs from 'node:fs'
import http from 'node:http'
import type net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createHostReplica } from '../../src/providers/host-replica-core.js'
import { createCopyNotesSource, installReplicaNotesSource, notesCopyReaderOver } from '../../src/replica/notes-source.js'
import { replicaNotesReads } from '../../src/replica/notes-routes.js'

const HOME = '/fixture/marina-home'
const sha12 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)
const NOTES: Record<string, string> = {
  'Projects/Plan.md': '# Plan\nShip the build on Friday.\n',
  'Projects/Retro.md': '# Retro\nThe build broke twice.\n',
  'Garden/Lantern.md': '# Lantern\nA build of paper and light.\n',
}

let dir = ''
let replica: ReturnType<typeof createHostReplica>
let port = 0
let server: http.Server
/** The companion's forward: what reached the stand-in Mac, and whether it answers. */
const mac = { installed: false, answers: true, calls: [] as string[] }

function push(keepExclude: string[] = []): void {
  const src = Object.fromEntries(Object.entries(NOTES).filter(([k]) => !keepExclude.some((e) => k.toLowerCase().startsWith(e.toLowerCase()))))
  const entries = Object.entries(src).map(([k, body]) => ({ k, h: sha12(body), n: Buffer.byteLength(body), m: { title: path.posix.basename(k, '.md') } }))
  const { need } = replica.sync(HOME, 'notes', entries, Date.now(), { keepExclude })
  replica.put(HOME, 'notes', need.map((k) => ({ k, body: src[k]! })))
}

/** A fresh source (its manifest memo) over the copy, as each test's server has. */
function install(): void {
  const request = async (cmd: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (cmd === 'replica.list') return { ok: true, ...(replica.list(HOME, 'notes') ?? {}) }
    if (cmd === 'replica.read') { const r = replica.read(HOME, 'notes', params.key); return r ? { ok: true, ...r } : { ok: false, errorKind: 'not_found' } }
    return { ok: true, ...(replica.readMany(HOME, 'notes', params.keys, 4 * 1024 * 1024) ?? {}) }
  }
  const forward = (req: express.Request, res: express.Response, here: () => void) => {
    mac.calls.push(req.originalUrl)
    if (mac.answers) res.json({ from: 'mac' })
    else here()
  }
  installReplicaNotesSource(createCopyNotesSource(notesCopyReaderOver(request), { listTtlMs: 0 }), mac.installed ? { forward } : {})
}

beforeAll(async () => {
  const app = express()
  app.use('/api/notes-v2', replicaNotesReads('v2'))
  app.use('/api/v1', replicaNotesReads('v1'))
  app.use('/api', (req, res) => { res.json({ disk: req.originalUrl }) })
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as net.AddressInfo).port
})
afterAll(async () => { installReplicaNotesSource(null); await new Promise((r) => server.close(r)) })
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wnk-'))
  replica = createHostReplica({ fs, path, dir, now: () => Date.now(), keyOf: (v) => sha12(v), hash: sha12, log: () => {} })
  mac.installed = false
  mac.answers = true
  mac.calls = []
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

async function get(p: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`)
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

describe('a host replica (the Mac away)', () => {
  it('a copy that keeps every note answers as before: no partial field anywhere, misses are 404', async () => {
    push()
    install()
    const tree = await get('/api/notes-v2/')
    expect(tree.status).toBe(200)
    expect(tree.json).not.toHaveProperty('partial')
    const search = await get('/api/notes-v2/search?q=build')
    expect(search.status).toBe(200)
    expect(search.json).not.toHaveProperty('partial')
    expect(search.json.results.length).toBe(3)
    const v1search = await get('/api/v1/notes/search?q=build')
    expect(v1search.json).not.toHaveProperty('partial')
    expect((await get('/api/notes-v2/list')).json).not.toHaveProperty('partial')
    expect((await get('/api/notes-v2/content/Projects/Retro')).status).toBe(200)
    expect((await get('/api/notes-v2/content/Projects/Nope')).status).toBe(404)
    expect((await get('/api/v1/notes/resolve?ref=Nope')).status).toBe(404)
  })

  it('one note left out: its reads answer not_kept_here, lists and searches say they are partial', async () => {
    push(['Projects/Retro'])
    install()
    const v2 = await get('/api/notes-v2/content/Projects/Retro')
    expect(v2).toMatchObject({ status: 503, json: { error: { code: 'needs_leader', why: 'not_kept_here' } } })
    const v1 = await get('/api/v1/notes/content/projects/retro.md')
    expect(v1).toMatchObject({ status: 503, json: { error: { code: 'needs_leader', why: 'not_kept_here', message: expect.stringMatching(/kept only on your Mac/) } } })
    // By title: it may be the left-out note. By a path that is not left out: a plain 404.
    expect(await get('/api/v1/notes/resolve?ref=Retro')).toMatchObject({ status: 503, json: { error: { why: 'not_kept_here' } } })
    expect((await get('/api/v1/notes/resolve?ref=Projects/Nope')).status).toBe(404)
    expect((await get('/api/notes-v2/content/Projects/Nope')).status).toBe(404)
    // The rest reads as before.
    expect((await get('/api/notes-v2/content/Projects/Plan')).status).toBe(200)
    const tree = await get('/api/notes-v2/')
    expect(tree.json.partial).toEqual({ why: 'not_kept_here', message: 'Some notes are kept only on your Mac, so they are not shown here.' })
    const search = await get('/api/notes-v2/search?q=build')
    expect(search.json.partial).toEqual({ why: 'not_kept_here', message: 'Some notes are kept only on your Mac, so they are not in these results.' })
    expect(search.json.results.map((r: { path: string }) => r.path).sort()).toEqual(['Garden/Lantern.md', 'Projects/Plan.md'])
    expect((await get('/api/v1/notes/search?q=build')).json.partial).toMatchObject({ why: 'not_kept_here' })
    expect((await get('/api/notes-v2/list')).json.partial).toMatchObject({ why: 'not_kept_here' })
  })

  it('a folder left out answers the same for every note in it', async () => {
    push(['garden'])
    install()
    expect(await get('/api/notes-v2/content/Garden/Lantern')).toMatchObject({ status: 503, json: { error: { why: 'not_kept_here' } } })
    expect(await get('/api/notes-v2/content/garden/new-note')).toMatchObject({ status: 503, json: { error: { why: 'not_kept_here' } } })
  })

  it('notes turned off: every read needs the Mac (not_kept_here); never copied yet: kind_not_copied, as before', async () => {
    install()
    expect(await get('/api/notes-v2/')).toMatchObject({ status: 503, json: { error: { why: 'kind_not_copied' } } })
    push()
    replica.drop(HOME, 'notes')
    install()
    expect(await get('/api/notes-v2/')).toMatchObject({ status: 503, json: { error: { why: 'not_kept_here' } } })
    expect(await get('/api/v1/notes/search?q=build')).toMatchObject({ status: 503, json: { error: { why: 'not_kept_here' } } })
    expect(await get('/api/notes-v2/content/Projects/Plan')).toMatchObject({ status: 503, json: { error: { why: 'not_kept_here' } } })
  })
})

describe('the companion (its notes reads run here whoever answers)', () => {
  beforeEach(() => { mac.installed = true })

  it('a copy that keeps every note never asks the Mac', async () => {
    push()
    install()
    expect((await get('/api/notes-v2/')).status).toBe(200)
    expect((await get('/api/notes-v2/content/Projects/Retro')).status).toBe(200)
    expect((await get('/api/notes-v2/content/Projects/Nope')).status).toBe(404)
    expect(mac.calls).toEqual([])
  })

  it('a left-out note and a partial list go to the Mac while it answers, and need it while it is away', async () => {
    push(['Projects/Retro'])
    install()
    expect(await get('/api/notes-v2/content/Projects/Retro')).toEqual({ status: 200, json: { from: 'mac' } })
    expect(await get('/api/notes-v2/search?q=build')).toEqual({ status: 200, json: { from: 'mac' } })
    // A note it keeps is still read here.
    expect((await get('/api/notes-v2/content/Projects/Plan')).json).toMatchObject({ content: NOTES['Projects/Plan.md'] })
    expect(mac.calls).toEqual(['/api/notes-v2/content/Projects/Retro', '/api/notes-v2/search?q=build'])
    mac.answers = false
    expect(await get('/api/notes-v2/content/Projects/Retro')).toMatchObject({ status: 503, json: { error: { why: 'not_kept_here' } } })
    const away = await get('/api/notes-v2/search?q=build')
    expect(away.status).toBe(200)
    expect(away.json.partial).toMatchObject({ why: 'not_kept_here' })
  })

  it('a copy not here yet: the Mac answers while it answers; away, kind_not_copied as before', async () => {
    install()
    expect(await get('/api/notes-v2/content/Projects/Plan')).toEqual({ status: 200, json: { from: 'mac' } })
    mac.answers = false
    expect(await get('/api/notes-v2/content/Projects/Plan')).toMatchObject({ status: 503, json: { error: { why: 'kind_not_copied' } } })
  })

  it('notes turned off for the box: the Mac answers; away, not_kept_here', async () => {
    push()
    replica.drop(HOME, 'notes')
    install()
    expect(await get('/api/notes-v2/')).toEqual({ status: 200, json: { from: 'mac' } })
    mac.answers = false
    expect(await get('/api/notes-v2/')).toMatchObject({ status: 503, json: { error: { why: 'not_kept_here' } } })
  })
})
