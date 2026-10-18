/**
 * Fixture for the host replica's browser specs (replica.config.ts,
 * docs/plan/walnut-replica-servers-impl.md WP7): a real Mac, a real host daemon
 * and the replica it supervises (tests/helpers/replica-cluster.ts), and in front
 * of the replica a fake `ssh -R` tunnel on PW_TEST_PORT (default 3472), with no
 * proxy header added (the shape of the real tunnel, as in
 * browser-access-tunnel.spec.ts). A page opened there is a phone on another
 * network: nothing about it is trusted.
 *
 *   REPLICA_APP unset    /api and /ws go to the replica's public port, every
 *                        other path to a Vite page server (the SPA in dev mode)
 *   REPLICA_APP=built    EVERY path goes to the replica, which runs a real build
 *                        of this tree dev:false (the Mac serves the same build):
 *                        the page and its assets are the replica's own while the
 *                        Mac is away. Build first: npm run build, then the web build.
 *
 * Control port PW_TEST_PORT + 1 (default 3473), loopback only:
 *   GET  /control/ready    the cluster is up, its ids and its seed (a note, a letter, a routine, the favorites, a theme)
 *   GET  /control/code     a browser sign-in code minted on the Mac
 *   POST /control/pair     {name}: a device token made on the Mac, once its copy is on the replica
 *   POST /control/sleep    SIGSTOP the Mac and its daemon; answers once the replica answers away
 *   POST /control/wake     SIGCONT; answers once the replica forwards to the Mac again
 *   POST /control/drain    waits for the Mac's return to settle: it forwards again and has
 *                          drained the host's journal (every record acked, WP10)
 *   GET  /control/stores   read-only summary of the copies (the replica's task rows, its config, prefs and routines copies among them)
 *   GET  /control/devices  how many devices the replica's copy holds
 *   POST /control/mac-edit {taskId, title}: an edit made on the Mac itself (live data)
 *   POST /control/mac-task {title, project, pinned?}: a task made on the Mac itself (unpinned unless asked), once its copy is on the replica
 *   POST /control/mac-board {taskId, html}: a Board page set on the Mac itself, once its copy is on the replica
 *   GET  /control/mac-tasks the Mac's task rows (id, title, phase) read from its store on disk (read only)
 *   GET  /control/mac-board?taskId the Mac's Board file of a task, read from disk
 *   GET  /control/journal  the host daemon's journal: each record's seq, kind, op id, task and field
 *                          names (a task's records), and whether it is acked
 *   POST /control/mac-note {path, content} or {path, find, replace, sleep?}: a note written on the
 *                          Mac through its own API. The first waits for the host's copy to hold it;
 *                          the second edits what the Mac holds and, with `sleep`, puts the Mac to
 *                          sleep at once, before its 3 s debounced round tells the host (WP11)
 *   GET  /control/mac-note?path  the Mac's note file and the notes beside it, read from disk
 *   GET  /control/mac-letters    the Mac's inbox letters (id, subject, time), read from disk
 *
 * Never :3456 or :3457, never the developer's data: everything lives under the
 * cluster's temp base, removed on shutdown. REPLICA_TWIN=standalone runs the bun twin.
 *
 * The SIGTERM/SIGINT handlers come FIRST: a signal that lands while the cluster
 * is still starting waits for it, then stops it (an early signal used to end the
 * fixture with the default action, leaving the cluster's processes behind).
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import { HOST_TURN, MAC_FAVORITES, MAC_LETTER, MAC_NOTE, MAC_ROUTINE, MAC_THEME, MAC_USER_NAME, startReplicaCluster, type ReplicaCluster, type Twin } from '../../helpers/replica-cluster.js'
import { startFakeTunnel, type FakeTunnel } from './replica-tunnel.js'

const port = Number(process.env.PW_TEST_PORT ?? 3472)
if (port === 3456 || port === 3457) throw new Error(`port ${port} is not this fixture's`)
const twin: Twin = process.env.REPLICA_TWIN === 'standalone' ? 'standalone' : 'source'
const built = process.env.REPLICA_APP === 'built'

let starting: Promise<ReplicaCluster> | null = null
let cluster: ReplicaCluster | null = null
let tunnel: FakeTunnel | null = null
let vite: { close(): Promise<void> } | null = null
let control: http.Server | null = null
let stopping = false

async function shutdown(): Promise<void> {
  if (stopping) return
  stopping = true
  const t0 = Date.now()
  const step = (what: string) => process.stderr.write(`REPLICA_FIXTURE_SHUTDOWN ${what} +${Date.now() - t0}ms\n`)
  control?.close()
  await tunnel?.close().catch(() => undefined)
  step('tunnel closed')
  await vite?.close().catch(() => undefined)
  step('vite closed')
  // Still starting: the cluster reaps itself when its start fails, else it is stopped here once up.
  const c = cluster ?? (starting ? await starting.catch(() => null) : null)
  // A process of the cluster still running is a leak: say so, and exit non-zero.
  const failed = c ? await c.stop().then(() => false, (err: unknown) => { process.stderr.write(`REPLICA_FIXTURE_STOP_FAILED ${err instanceof Error ? err.message : String(err)}\n`); return true }) : false
  step(failed ? 'cluster stop failed' : c ? 'cluster stopped' : 'no cluster')
  process.exit(failed ? 1 : 0)
}
process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })

starting = startReplicaCluster({ twin, app: built ? 'built' : 'source' })
cluster = await starting
if (stopping) await new Promise(() => { /* shutdown() stops it and exits */ })
const c = cluster
// The fixture's own probe device: it polls the replica to know when it answers away or forwards again.
const probeToken = await c.pairDevice('fixture-probe')

/** The host daemon's journal (its own dir in the cluster's base): records and the seqs acked. */
function journalOf(cl: ReplicaCluster): Array<{ seq: number; kind: string; opId: string; taskId?: string; fields?: string[]; acked: boolean }> {
  const dir = path.join(cl.base, 'hd', 'offline-host')
  const records: Array<{ seq: number; kind: string; opId: string; taskId?: string; fields?: string[] }> = []
  const acked = new Set<number>()
  let names: string[] = []
  try { names = fs.readdirSync(dir).filter((n) => /^journal-.*\.ndjson$/.test(n)) } catch { /* none yet */ }
  for (const n of names) {
    for (const line of fs.readFileSync(path.join(dir, n), 'utf8').split('\n')) {
      let o: Record<string, unknown>
      try { o = JSON.parse(line) } catch { continue }
      if (typeof o.seq === 'number') {
        records.push({
          seq: o.seq, kind: String(o.kind), opId: String(o.opId ?? ''),
          ...(typeof o.taskId === 'string' ? { taskId: o.taskId } : {}),
          ...(o.fields && typeof o.fields === 'object' ? { fields: Object.keys(o.fields as Record<string, unknown>).sort() } : {}),
        })
      }
      if (Array.isArray(o.ack)) for (const q of o.ack) acked.add(Number(q))
    }
  }
  return records.map((r) => ({ ...r, acked: acked.has(r.seq) }))
}

/** The Mac's task rows, read only from its store on disk. */
function macTaskRows(cl: ReplicaCluster): Array<{ id: string; title: string; phase: string }> {
  const Database = createRequire(import.meta.url)('better-sqlite3') as new (file: string, o: { readonly: boolean; fileMustExist: boolean }) => { prepare(q: string): { all(): unknown[] }; close(): void }
  const db = new Database(path.join(cl.macData, 'tasks', 'tasks.sqlite'), { readonly: true, fileMustExist: true })
  try { return db.prepare('SELECT id, title, phase FROM tasks').all() as Array<{ id: string; title: string; phase: string }> } finally { db.close() }
}

const waitUntil = async (fn: () => boolean, ms: number, what: string): Promise<void> => {
  const until = Date.now() + ms
  while (!fn()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
})

let pagePort: number | undefined
if (!built) {
  // The page server (the SPA in dev mode). Its HMR socket comes back through the tunnel.
  pagePort = await freePort()
  const { createServer: createViteServer } = await import('vite')
  const server = await createViteServer({
    root: path.resolve(import.meta.dirname, '../../../web'),
    server: {
      host: '127.0.0.1', port: pagePort, strictPort: true, hmr: { clientPort: port },
      // web/vite.config.ts proxies /api and /ws to :3456. The tunnel sends both to
      // the replica before Vite sees them; these keys replace that proxy anyway, so
      // nothing this fixture serves can ever reach the developer's Walnut.
      proxy: {
        '/api': { target: `http://127.0.0.1:${c.replicaPort}` },
        '/ws': { target: `ws://127.0.0.1:${c.replicaPort}`, ws: true },
      },
    },
    logLevel: 'warn',
  })
  await server.listen()
  vite = server
  // Vite's dev server closes itself and calls process.exit() on SIGTERM (and on
  // stdin 'end'), which ended this fixture before `shutdown` stopped the cluster:
  // every run left its temp base, and once a replica, behind. Unhooked by name, as
  // test-server.ts does (Vite has no option for it); `shutdown` closes Vite itself.
  for (const l of process.listeners('SIGTERM')) if (l.name === 'parentSigtermCallback') process.off('SIGTERM', l)
  for (const l of process.stdin.listeners('end')) if (l.name === 'parentSigtermCallback') process.stdin.off('end', l as (...args: unknown[]) => void)
}

tunnel = await startFakeTunnel({ port, replicaPort: c.replicaPort, ...(pagePort !== undefined ? { pagePort } : {}) })

control = http.createServer((req, res) => {
  const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://control')
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      if (req.method === 'GET' && url.pathname === '/control/ready') {
        return reply(200, {
          ids: c.ids, hostTurn: HOST_TURN, note: MAC_NOTE, letter: MAC_LETTER,
          routine: MAC_ROUTINE, favorites: MAC_FAVORITES, theme: MAC_THEME, userName: MAC_USER_NAME,
          twin, app: c.app, replicaPort: c.replicaPort, asleep: c.asleep(),
        })
      }
      if (req.method === 'GET' && url.pathname === '/control/code') return reply(200, { code: await c.browserCode() })
      // A device token made on the Mac, its copy on the replica (the iOS stub flows pair with it).
      if (req.method === 'POST' && url.pathname === '/control/pair') return reply(200, { token: await c.pairDevice(String(body.name ?? 'ios-sim')) })
      if (req.method === 'POST' && url.pathname === '/control/sleep') { c.sleepMac(); return reply(200, { ms: await c.waitAway(probeToken) }) }
      if (req.method === 'POST' && url.pathname === '/control/wake') { c.wakeMac(); return reply(200, { ms: await c.waitBack(probeToken) }) }
      if (req.method === 'POST' && url.pathname === '/control/drain') {
        const t0 = Date.now()
        await c.waitBack(probeToken)
        await waitUntil(() => journalOf(c).every((r) => r.acked), 120_000, 'the Mac to drain the host journal')
        return reply(200, { ms: Date.now() - t0 })
      }
      if (req.method === 'GET' && url.pathname === '/control/journal') return reply(200, { records: journalOf(c) })
      if (req.method === 'GET' && url.pathname === '/control/mac-tasks') return reply(200, { tasks: macTaskRows(c) })
      if (req.method === 'GET' && url.pathname === '/control/mac-board') {
        const id = url.searchParams.get('taskId') ?? ''
        if (!/^[A-Za-z0-9-]+$/.test(id)) return reply(400, { error: 'bad taskId' })
        try { return reply(200, JSON.parse(fs.readFileSync(path.join(c.macData, 'boards', `${id}.json`), 'utf8'))) } catch { return reply(404, { error: 'no board' }) }
      }
      if (req.method === 'POST' && url.pathname === '/control/mac-task') {
        // In the project's own list (not pinned), as the read spec's tasks are, unless the spec asks.
        const r = await c.mac('POST', '/api/tasks', { title: String(body.title), project: String(body.project ?? 'Acme'), pinned: body.pinned === true })
        if (r.status !== 201) return reply(r.status, r.json)
        const id = String(r.json.task.id)
        await waitUntil(() => (c.stores().taskRows as Array<{ id: string }>).some((t) => t.id === id), 60_000, 'the task copy to hold the new task')
        return reply(201, { id })
      }
      if (req.method === 'POST' && url.pathname === '/control/mac-board') {
        const id = String(body.taskId)
        const r = await c.mac('PUT', `/api/v1/tasks/${id}/board`, { html: String(body.html) })
        if (r.status >= 300) return reply(r.status, r.json)
        const file = path.join(c.replicaData, 'boards', `${id}.json`)
        await waitUntil(() => { try { return (JSON.parse(fs.readFileSync(file, 'utf8')) as { html?: string }).html === String(body.html) } catch { return false } }, 60_000, 'the Board copy to hold the page')
        return reply(200, r.json)
      }
      if (req.method === 'GET' && url.pathname === '/control/stores') return reply(200, c.stores())
      if (req.method === 'GET' && url.pathname === '/control/devices') {
        const copy = c.deviceCopy() as { devices?: unknown[] } | null
        return reply(200, { count: Array.isArray(copy?.devices) ? copy!.devices.length : 0 })
      }
      // WP12: what a new ask on the host needs from the Mac (its personas copy on the
      // replica, its spawn template on the host daemon), and the Mac's record of a session.
      if (req.method === 'GET' && url.pathname === '/control/ask-ready') {
        let personas = false
        try { personas = fs.readFileSync(path.join(c.replicaData, 'cache', 'replica', 'personas.json'), 'utf8').includes('"general"') } catch { /* not yet */ }
        let template = false
        try { template = fs.readdirSync(path.join(c.base, 'hd', 'offline-host')).some((n) => /^spawn-template-[0-9a-f]+\.json$/.test(n)) } catch { /* not yet */ }
        return reply(200, { personas, template })
      }
      if (req.method === 'GET' && url.pathname === '/control/mac-session') {
        const sid = url.searchParams.get('sid') ?? ''
        if (!/^[0-9a-f-]{36}$/.test(sid)) return reply(400, { error: 'bad sid' })
        const r = await c.mac('GET', `/api/v1/sessions/${sid}`)
        return reply(200, { status: r.status, session: r.json })
      }
      // The Mac's and the replica's log tails, for a failed test's report.
      if (req.method === 'GET' && url.pathname === '/control/logs') return reply(200, c.logs())
      if (req.method === 'POST' && url.pathname === '/control/mac-edit') {
        const r = await c.mac('PATCH', `/api/tasks/${String(body.taskId)}`, { title: String(body.title) })
        return reply(r.status, r.json)
      }
      // -- WP11: notes written while the Mac is away (replica-away-notes.spec.ts) --
      if (url.pathname === '/control/mac-note' || url.pathname === '/control/mac-letters') return reply(...await noteControl(req.method ?? 'GET', url, body))
      reply(404, { error: 'not_found' })
    })().catch((err) => reply(500, { error: err instanceof Error ? err.message : String(err) }))
  })
})
// -- WP11: notes written while the Mac is away --

const sha12 = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 12)
const noteRel = (p: string) => (/\.md$/i.test(p) ? p : `${p}.md`)
const notesApi = (rel: string) => `/api/notes-v2/content/${rel.split('/').map(encodeURIComponent).join('/')}`

/** The hash the host daemon's copy holds for a note (its index), or null. */
function hostCopyHash(rel: string): string | null {
  const root = path.join(c.base, 'hd', 'host-replica')
  let homes: string[] = []
  try { homes = fs.readdirSync(root) } catch { return null }
  for (const h of homes) {
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(root, h, 'notes', 'index.json'), 'utf8')) as { index?: Record<string, { h?: string }> }
      const row = idx.index?.[rel]
      if (row?.h) return row.h
    } catch { /* not this home */ }
  }
  return null
}

async function noteControl(method: string, url: URL, body: Record<string, unknown>): Promise<[number, unknown]> {
  if (method === 'GET' && url.pathname === '/control/mac-letters') {
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(c.macData, 'human-inbox', 'index.json'), 'utf8')) as { letters?: Array<{ id: string; subject: string; createdAt: number }> }
      return [200, { letters: (idx.letters ?? []).map((l) => ({ id: l.id, subject: l.subject, createdAt: l.createdAt })) }]
    } catch { return [200, { letters: [] }] }
  }
  if (method === 'GET') {
    const rel = noteRel(url.searchParams.get('path') ?? '')
    if (!rel || rel.split('/').includes('..')) return [400, { error: 'bad path' }]
    const abs = path.join(c.macData, 'notes', rel)
    let content: string | null = null
    try { content = fs.readFileSync(abs, 'utf8') } catch { /* none */ }
    let beside: string[] = []
    try { beside = fs.readdirSync(path.dirname(abs)).filter((n) => n.endsWith('.md')).sort() } catch { /* none */ }
    return [200, { content, beside, hostCopyHash: hostCopyHash(rel) }]
  }
  const rel = noteRel(String(body.path ?? ''))
  if (!rel || rel.split('/').includes('..')) return [400, { error: 'bad path' }]
  if (typeof body.content === 'string') {
    const r = await c.mac('PUT', notesApi(rel), { content: body.content })
    if (r.status >= 300) return [r.status, r.json]
    const written = fs.readFileSync(path.join(c.macData, 'notes', rel), 'utf8')
    await waitUntil(() => hostCopyHash(rel) === sha12(written), 60_000, 'the host copy to hold the note')
    return [200, { contentHash: sha12(written), content: written }]
  }
  // An edit of what the Mac holds now, once the host's copy holds that too.
  const now = fs.readFileSync(path.join(c.macData, 'notes', rel), 'utf8')
  await waitUntil(() => hostCopyHash(rel) === sha12(now), 60_000, 'the host copy to hold the Mac\'s note')
  const find = String(body.find)
  if (!now.includes(find)) return [409, { error: `"${find}" is not in the note`, content: now }]
  const r = await c.mac('PUT', notesApi(rel), { content: now.replace(find, String(body.replace)), expectedHash: sha12(now) })
  if (r.status >= 300) return [r.status, r.json]
  if (body.sleep === true) { c.sleepMac(); return [200, { ...r.json, ms: await c.waitAway(probeToken) }] }
  return [200, r.json]
}

await new Promise<void>((r) => control!.listen(port + 1, '127.0.0.1', () => r()))
process.stdout.write(`REPLICA_FIXTURE_READY ${JSON.stringify({ port, control: port + 1, twin, app: c.app, base: c.base })}\n`)
