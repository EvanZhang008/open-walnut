/**
 * Run by tests/providers/in-process-daemon-self-end.test.ts with bun: an in-process runtime whose
 * heartbeat sees its dir taken (daemon.pid naming another pid) ends itself. What its exit would
 * give back is given back: a connected client hears close (so its server dials again), the
 * runtime reads as not running, the agent gateway refuses, and nothing keeps this process alive.
 * Prints one JSON line, then returns (never process.exit: the test sees the process end by itself).
 * MACHINE SAFETY: a temp root only; the pid written is this process's parent, never signalled.
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const DIR = process.env.WALNUT_DAEMON_DIR!
const { startInProcessDaemon, inProcessDaemonConnect, inProcessDaemonRunning } = await import('../../../src/providers/in-process-daemon.ts')
const started = await startInProcessDaemon({ dir: DIR, env: { ...process.env } })
let closed = false
const connect = inProcessDaemonConnect()!
const client = connect(() => {}, () => { closed = true })
const hello = await client.request('status', { cmd: 'status' }).then(() => true, () => false)
const sock = path.join(DIR, 'agent-gateway.sock')
const gatewayBefore = fs.existsSync(sock)
// Another daemon "took" the dir: the heartbeat's single-instance check ends this runtime.
fs.writeFileSync(path.join(DIR, 'daemon.pid'), String(process.ppid))
const end = Date.now() + 15_000
while ((!closed || inProcessDaemonRunning()) && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
const gatewayAnswers = await new Promise<boolean>((resolve) => {
  const s = net.connect(sock)
  s.once('connect', () => { s.destroy(); resolve(true) })
  s.once('error', () => resolve(false))
})
console.log(JSON.stringify({ started: started.kind, hello, gatewayBefore, closed, running: inProcessDaemonRunning(), gatewayAnswers }))
