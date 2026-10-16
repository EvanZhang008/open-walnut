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
 *   GET  /control/ready    the cluster is up, its ids
 *   GET  /control/code     a browser sign-in code minted on the Mac
 *   POST /control/pair     {name}: a device token made on the Mac, once its copy is on the replica
 *   POST /control/sleep    SIGSTOP the Mac and its daemon; answers once the replica answers away
 *   POST /control/wake     SIGCONT; answers once the replica forwards to the Mac again
 *   POST /control/drain    waits for the Mac's return to settle (WP10 adds the journal drain)
 *   GET  /control/stores   read-only summary of the copies (the replica's task rows among them)
 *   GET  /control/devices  how many devices the replica's copy holds
 *   POST /control/mac-edit {taskId, title}: an edit made on the Mac itself (live data)
 *
 * Never :3456 or :3457, never the developer's data: everything lives under the
 * cluster's temp base, removed on shutdown. REPLICA_TWIN=standalone runs the bun twin.
 *
 * The SIGTERM/SIGINT handlers come FIRST: a signal that lands while the cluster
 * is still starting waits for it, then stops it (an early signal used to end the
 * fixture with the default action, leaving the cluster's processes behind).
 */
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { HOST_TURN, MAC_LETTER, MAC_NOTE, startReplicaCluster, type ReplicaCluster, type Twin } from '../../helpers/replica-cluster.js'
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
        return reply(200, { ids: c.ids, hostTurn: HOST_TURN, note: MAC_NOTE, letter: MAC_LETTER, twin, app: c.app, replicaPort: c.replicaPort, asleep: c.asleep() })
      }
      if (req.method === 'GET' && url.pathname === '/control/code') return reply(200, { code: await c.browserCode() })
      // A device token made on the Mac, its copy on the replica (the iOS stub flows pair with it).
      if (req.method === 'POST' && url.pathname === '/control/pair') return reply(200, { token: await c.pairDevice(String(body.name ?? 'ios-sim')) })
      if (req.method === 'POST' && url.pathname === '/control/sleep') { c.sleepMac(); return reply(200, { ms: await c.waitAway(probeToken) }) }
      if (req.method === 'POST' && url.pathname === '/control/wake') { c.wakeMac(); return reply(200, { ms: await c.waitBack(probeToken) }) }
      if (req.method === 'POST' && url.pathname === '/control/drain') return reply(200, { ms: await c.waitBack(probeToken) })
      if (req.method === 'GET' && url.pathname === '/control/stores') return reply(200, c.stores())
      if (req.method === 'GET' && url.pathname === '/control/devices') {
        const copy = c.deviceCopy() as { devices?: unknown[] } | null
        return reply(200, { count: Array.isArray(copy?.devices) ? copy!.devices.length : 0 })
      }
      if (req.method === 'POST' && url.pathname === '/control/mac-edit') {
        const r = await c.mac('PATCH', `/api/tasks/${String(body.taskId)}`, { title: String(body.title) })
        return reply(r.status, r.json)
      }
      reply(404, { error: 'not_found' })
    })().catch((err) => reply(500, { error: err instanceof Error ? err.message : String(err) }))
  })
})
await new Promise<void>((r) => control!.listen(port + 1, '127.0.0.1', () => r()))
process.stdout.write(`REPLICA_FIXTURE_READY ${JSON.stringify({ port, control: port + 1, twin, app: c.app, base: c.base })}\n`)
