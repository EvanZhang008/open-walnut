/**
 * Run by tests/providers/daemon-runtime-in-process.test.ts with bun: two daemon runtimes
 * (createDaemonRuntime) in this one process, each in its own temp dir, each running a
 * session of a mock CLI. Prints one JSON line of what it saw and then ends by itself: a
 * runtime that left a socket or a timer behind keeps the process alive, which the test sees.
 *
 * argv[2]: a temp root this script may fill (the test removes it).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createDaemonRuntime, type DaemonFrame } from '../../../src/providers/daemon-standalone.ts'

const root = process.argv[2]!
fs.mkdirSync(root, { recursive: true })

const processState = () => ({
  cwd: process.cwd(),
  umask: process.umask(),
  env: JSON.stringify(Object.entries(process.env).sort()),
  listeners: Object.fromEntries(['SIGTERM', 'SIGINT', 'SIGHUP', 'uncaughtException', 'unhandledRejection', 'exit', 'beforeExit']
    .map((e) => [e, process.listenerCount(e as never)])),
})

/** A mock CLI: one init line, then a line naming the umask, cwd and env marker it started with. */
function mockCli(dir: string): string {
  const file = path.join(dir, 'mock-cli.sh')
  fs.writeFileSync(file, [
    '#!/bin/sh',
    'cat > /dev/null &',
    `echo '{"type":"system","subtype":"init","session_id":"mock","model":"mock"}'`,
    `echo "{\\"type\\":\\"assistant\\",\\"probe\\":{\\"umask\\":\\"$(umask)\\",\\"marker\\":\\"$RUNTIME_MARKER\\"}}"`,
    `echo '{"type":"result","subtype":"success","stop_reason":"end_turn"}'`,
    'sleep 0.3',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 })
  return file
}

const before = processState()
const out: Record<string, unknown> = { before }

function runtimeIn(name: string, exitCalls: Array<number | null>) {
  const dir = path.join(root, name)
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  return createDaemonRuntime({
    env: {
      ...process.env, HOME: home, SHELL: '/bin/sh',
      WALNUT_DAEMON_DIR: path.join(dir, 'daemon'), WALNUT_LEGACY_STREAMS_DIR: path.join(dir, 'no-legacy'),
      RUNTIME_MARKER: name,
    },
    mode: 'start',
    exit: (code) => { exitCalls.push(code) },
  })
}

async function oneRuntime(name: string) {
  const exitCalls: Array<number | null> = []
  const runtime = await runtimeIn(name, exitCalls)
  const frames: DaemonFrame[] = []
  const started = await runtime.start()
  let closedByDaemon = 0
  const client = runtime.connect((f) => frames.push(f), () => { closedByDaemon++ })
  const hello = await client.request('hello')
  return {
    name, dir: path.join(root, name), runtime, client, frames, started, hello,
    exited: () => exitCalls[0] ?? null, closedByDaemon: () => closedByDaemon,
  }
}

const a = await oneRuntime('a')
const b = await oneRuntime('b')
out.ports = [a.started, b.started]
out.helloDirs = [a.hello.dir, b.hello.dir]
out.instanceIds = [a.hello.instanceId, b.hello.instanceId]
out.pidFiles = [a, b].map((r) => fs.readFileSync(path.join(r.dir, 'daemon', 'daemon.pid'), 'utf8').trim())
out.selfPid = String(process.pid)

// One session in each, the same sid in both: each runtime's stays its own.
const sid = 'two-runtimes-sid'
for (const r of [a, b]) {
  const res = await r.client.request('start', { sid, args: [mockCli(r.dir)], cwd: r.dir, message: 'hi', mode: 'default' })
  out[`start_${r.name}`] = { ok: res.ok, error: res.error }
}
const deadline = Date.now() + 15_000
const probes = (r: typeof a) => r.frames
  .filter((f) => f.ev === 'jsonl' && typeof f.line === 'string' && (f.line as string).includes('"probe"'))
  .map((f) => (JSON.parse(f.line as string) as { probe: unknown }).probe)
while (Date.now() < deadline && (probes(a).length === 0 || probes(b).length === 0)) await new Promise((r) => setTimeout(r, 50))
out.probes = { a: probes(a), b: probes(b) }

// start() runs once: a second call gets the first one's result.
out.startAgain = (await a.runtime.start()) === a.started

// A start() that took the lock and stopped short of serving (a live legacy daemon named in the
// dir's daemon.pid: b's port answers) gives the lock back on stop(): the next runtime of the dir starts.
const cDaemon = path.join(root, 'c', 'daemon')
fs.mkdirSync(cDaemon, { recursive: true })
fs.writeFileSync(path.join(cDaemon, 'daemon.pid'), String(process.ppid))
fs.writeFileSync(path.join(cDaemon, 'daemon.port'), String((b.started as { port: number }).port))
const cExits: Array<number | null> = []
const c = await runtimeIn('c', cExits)
out.cStart = await c.start()
out.cStop = await c.stop()
fs.rmSync(path.join(cDaemon, 'daemon.pid'))
fs.rmSync(path.join(cDaemon, 'daemon.port'))
const c2 = await runtimeIn('c', cExits)
out.c2Start = (await c2.start()).kind
out.c2Stop = await c2.stop()
out.cExits = cExits

// A client that closes itself is not told; one the daemon closes (stop()) is, once.
const ownClose = { told: 0 }
const own = b.runtime.connect(() => {}, () => { ownClose.told++ })
own.close()
out.ownCloseTold = ownClose.told

// Stopping one leaves the other serving.
out.stopA = await a.runtime.stop()
out.afterStopA = {
  aPortFile: fs.existsSync(path.join(a.dir, 'daemon', 'daemon.port')),
  bHello: (await b.client.request('hello')).dir,
  aClosedByDaemon: a.closedByDaemon(),
  aRequestAfterStop: await a.client.request('hello'),
}
out.stopB = await b.runtime.stop()
out.bClosedByDaemon = b.closedByDaemon()
out.exitCalls = [a.exited(), b.exited()]
out.after = processState()
process.stdout.write(JSON.stringify(out) + '\n')
// No process.exit: the process ends once nothing of the runtimes is left.
