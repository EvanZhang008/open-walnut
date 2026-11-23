#!/usr/bin/env bun
/**
 * A stand-in for walnut-net (native/walnut-net, docs/reference/host-network.md) on one machine:
 * the network layer only, so a released Walnut's own host-network path runs unchanged in a
 * rehearsal. A leader reaches a `transport: net` host by asking its local daemon `net.forward`;
 * the daemon asks walnut-net on its control socket, and walnut-net answers a loopback port that
 * carries each connection to that machine's daemon. This file answers the same calls, and its
 * port pipes each connection to a daemon on this machine instead of over iroh.
 *
 *   walnut-net id --key <file>                       {"id": <64 hex>}, the key made on first use
 *   walnut-net run --config <file> --exit-on-stdin-eof
 *       says {"event":"ready","id",...,"protocol":2} on stdout, then answers one JSON line per
 *       connection on the control socket (the config's `control`, else <config dir>/ctl.sock):
 *       status (every peer linked, path direct), forward {to} (a 127.0.0.1 port), probe, reload,
 *       invites, join (accepted, nothing done)
 *
 * The peers: `standin-peers.json` beside the config, `{ "<endpoint id>": "<port file>" }`. The
 * port is read from that file at each connection (a host's service moves its door's port at each
 * start), so the forward follows the daemon as walnut-net follows the machine. An id it does not
 * list is refused, as walnut-net refuses a machine that is not a member.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const argv = process.argv.slice(2)
const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null }

/** The id of a key file, made when missing: the sha256 of its bytes (walnut-net's is the public key). */
function idOf(keyFile) {
  if (!fs.existsSync(keyFile)) {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 })
  }
  return crypto.createHash('sha256').update(fs.readFileSync(keyFile)).digest('hex')
}

if (argv[0] === 'id') {
  process.stdout.write(JSON.stringify({ id: idOf(flag('--key')) }) + '\n')
  process.exit(0)
}
if (argv[0] !== 'run') {
  process.stderr.write(`net-standin: unknown command ${argv[0]}\n`)
  process.exit(64)
}

const configFile = flag('--config')
const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'))
const dir = path.dirname(configFile)
const control = typeof cfg.control === 'string' ? cfg.control : path.join(dir, 'ctl.sock')
const me = idOf(typeof cfg.key === 'string' ? cfg.key : path.join(dir, 'net.key'))
const peersFile = path.join(dir, 'standin-peers.json')
const peers = () => { try { return JSON.parse(fs.readFileSync(peersFile, 'utf8')) } catch { return {} } }
const log = (msg, data = {}) => process.stderr.write(JSON.stringify({ at: new Date().toISOString(), msg, ...data }) + '\n')

/** One listener per peer, kept: each connection to it is piped to the peer's daemon port now. */
const forwards = new Map()
/** One listener per peer even for two asks at once: the first ask's promise is kept before it listens. */
function forward(to) {
  const portFile = peers()[to]
  if (!portFile) return Promise.reject(new Error(`${to} is not a member`))
  if (forwards.has(to)) return forwards.get(to)
  const listening = listen(to, portFile)
  forwards.set(to, listening)
  listening.catch(() => forwards.delete(to))
  return listening
}
async function listen(to, portFile) {
  const srv = net.createServer((sock) => {
    let port = 0
    try { port = Number(fs.readFileSync(portFile, 'utf8').trim()) } catch { /* between starts */ }
    if (!port) { log('forward: no daemon port now', { to }); sock.destroy(); return }
    const out = net.connect(port, '127.0.0.1')
    sock.pipe(out).pipe(sock)
    const end = () => { sock.destroy(); out.destroy() }
    sock.on('error', end)
    out.on('error', end)
    sock.on('close', end)
    out.on('close', end)
  })
  const port = await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)) })
  log('forward: listening', { to, port })
  return port
}

async function answer(req) {
  switch (req.op) {
    case 'status':
      return { ok: true, id: me, relays: [], peers: Object.keys(peers()).map((id) => ({ id, link: { path: 'direct' } })) }
    case 'forward':
      return { ok: true, port: await forward(String(req.to ?? '').toLowerCase()) }
    case 'probe':
      if (!peers()[String(req.to ?? '').toLowerCase()]) throw new Error('not a member')
      return { ok: true, link: { path: 'direct' } }
    default:
      return { ok: true }
  }
}

try { fs.rmSync(control, { force: true }) } catch { /* none */ }
const ctl = net.createServer((sock) => {
  let buf = ''
  sock.setEncoding('utf8')
  sock.on('data', async (d) => {
    buf += d
    const nl = buf.indexOf('\n')
    if (nl < 0) return
    const line = buf.slice(0, nl)
    buf = ''
    let res
    try { res = await answer(JSON.parse(line)) } catch (err) { res = { ok: false, error: err instanceof Error ? err.message : String(err) } }
    sock.end(JSON.stringify(res) + '\n')
  })
  sock.on('error', () => {})
})
ctl.listen(control, () => {
  log('ready', { id: me, control, peers: Object.keys(peers()) })
  process.stdout.write(JSON.stringify({ event: 'ready', id: me, protocol: 2 }) + '\n')
})
const quit = () => { try { ctl.close() } catch { /* closing */ } try { fs.rmSync(control, { force: true }) } catch { /* gone */ } process.exit(0) }
if (argv.includes('--exit-on-stdin-eof')) { process.stdin.on('end', quit); process.stdin.on('error', quit); process.stdin.resume() }
process.on('SIGTERM', quit)
process.on('SIGINT', quit)
