/**
 * Run by tests/core/leader/switch/switch-stop-sessions.test.ts with bun, once per process of a
 * machine around a leader switch, each a process of its own as on a real machine:
 *
 *   leader        the old leader's server: this machine's daemon in its own process (localDaemon.ensureRunning
 *                 with in_process_daemon on), a session with a fake CLI answering one round, then the
 *                 switch stop's daemon step exactly as stopServer runs it (server.ts: stopInProcessDaemon with
 *                 the reason 'leader-switch', its budget, for good). argv[4] 'start' starts the session;
 *                 'adopt' attaches to the session the registry names (a leader again after a rollback or a
 *                 switch back) and answers one round first.
 *   standby       the handed-over standby the home boots into after it (server.ts serveHandedOverHome):
 *                 holdServiceRuntimeInStandby, then what the new leader sees through this machine's door
 *                 (daemon.port: hello, the session's status), one round through the runtime, and the
 *                 standby's own stop (releaseServiceRuntimeInStandby, as a switch back or a rollback's
 *                 leader start stops it). The data home is hashed before the hold and a second after it: the
 *                 standby writes nothing there.
 *
 * Prints one JSON line. argv[2]: the temp root; argv[3]: the phase; argv[5]: the session id (adopt, standby).
 * MACHINE SAFETY: everything in the temp root; only the runtime signals, and only the CLI groups it started.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const root = process.argv[2]!
const phase = process.argv[3]!
const DIR = process.env.WALNUT_DAEMON_DIR!
if (!DIR || !DIR.startsWith(root) || !process.env.OPEN_WALNUT_HOME?.startsWith(root)) throw new Error('WALNUT_DAEMON_DIR and OPEN_WALNUT_HOME must sit in the temp root')

const { IN_PROCESS_DAEMON_URL, inProcessDaemonRunning, stopInProcessDaemon } = await import('../../../../../src/providers/in-process-daemon.ts')
const { RemoteSessionManager } = await import('../../../../../src/providers/remote-session-manager.ts')
const { disconnectAllDaemons } = await import('../../../../../src/providers/daemon-connection.ts')
const { fakeRoundCli } = await import('../../../../helpers/fake-round-cli.ts')
type OutputEvent = import('../../../../../src/providers/session-manager.ts').OutputEvent

const FAKE_CLI = fakeRoundCli(root)
const WORK = path.join(root, 'work')
fs.mkdirSync(WORK, { recursive: true })
const cliArgs = (sid: string) => ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--session-id', sid]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(what: string, ok: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}
const alive = (pid: number | null | undefined) => {
  if (!pid || pid <= 1) return false
  try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const st = s.slice(s.lastIndexOf(')') + 2)[0]; return st !== 'Z' && st !== 'X' } catch { return false }
}

function session(sid: string) {
  const outputs: OutputEvent[] = []
  const rsm = new RemoteSessionManager(sid, '__local__', null, IN_PROCESS_DAEMON_URL, FAKE_CLI)
  const results = () => outputs.filter((e) => e.parsed?.type === 'result').map((e) => String((e.parsed as { result?: unknown }).result))
  return { sid, rsm, results, onOutput: (e: OutputEvent) => { outputs.push(e) }, onExit: () => {} }
}
type Session = ReturnType<typeof session>
async function round(s: Session, word: string): Promise<string | null> {
  const before = s.results().length
  await s.rsm.writeMessage(`ROUND-${word}`)
  await waitFor(`the answer of ROUND-${word}`, () => s.results().length > before)
  return s.results()[before] ?? null
}
async function attachAndAnswer(s: Session, word: string) {
  const attached = await s.rsm.attach({ sessionId: s.sid, onOutput: s.onOutput, onExit: s.onExit, mode: 'bypass' })
  return { alive: attached.alive, pid: attached.pid, result: await round(s, word) }
}
async function release(s: Session): Promise<void> {
  await s.rsm.cleanup()
  disconnectAllDaemons()
  await sleep(50)
}

/** Every file of the data home with its bytes' hash (the standby must leave it as it was). */
function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    let names: string[] = []
    try { names = fs.readdirSync(d) } catch { return }
    for (const n of names.sort()) {
      const f = path.join(d, n)
      const st = fs.lstatSync(f)
      if (st.isDirectory()) walk(f)
      else out[path.relative(dir, f)] = st.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : 'other'
    }
  }
  walk(dir)
  return out
}

/** What a process that is not this one (the new leader, over its tunnel) gets from this machine's door. */
async function doorView(sid: string): Promise<{ port: number | null; hello: boolean; exists: boolean | null; alive: boolean | null; pid: number | null }> {
  let port: number | null = null
  try { port = Number(fs.readFileSync(path.join(DIR, 'daemon.port'), 'utf8').trim()) || null } catch { return { port: null, hello: false, exists: null, alive: null, pid: null } }
  const { askOwnPort } = await import('../../../../../src/providers/service-launcher-beat.ts')
  const ask = askOwnPort(port!, WebSocket as never)
  try {
    const hello = await ask({ cmd: 'hello' }) as { capabilities?: unknown }
    const status = await ask({ cmd: 'status', sid }) as { exists?: boolean; alive?: boolean; pid?: number }
    return { port, hello: !!hello?.capabilities, exists: status?.exists ?? null, alive: status?.alive ?? null, pid: status?.pid ?? null }
  } catch { return { port, hello: false, exists: null, alive: null, pid: null } }
}

const out: Record<string, unknown> = { phase }
try {
  if (phase === 'leader') {
    const { localDaemon } = await import('../../../../../src/providers/local-daemon.ts')
    await localDaemon.ensureRunning()
    out.inProcess = inProcessDaemonRunning()
    const mode = process.argv[4]
    if (mode === 'start') {
      const s = session(crypto.randomUUID())
      const started = await s.rsm.start({ args: cliArgs(s.sid), cwd: WORK, message: 'ROUND-one', mode: 'bypass', onOutput: s.onOutput, onExit: s.onExit })
      await waitFor('the answer of ROUND-one', () => s.results().length >= 1)
      out.sid = s.sid
      out.cliPid = started.pid
      out.result = s.results()[0]
      await release(s)
    } else {
      const s = session(process.argv[5]!)
      out.adopted = await attachAndAnswer(s, 'again')
      out.sid = s.sid
      await release(s)
    }
    // The switch stop's daemon step (server.ts stopServer, reason 'leader-switch' from commands/web.ts).
    out.stopCode = await stopInProcessDaemon('leader-switch', 4_000, { forGood: true })
    out.inProcessAfterStop = inProcessDaemonRunning()
  } else if (phase === 'standby') {
    const sid = process.argv[5]!
    const home = process.env.OPEN_WALNUT_HOME!
    const before = hashTree(home)
    const standby = await import('../../../../../src/web/standby-service.ts')
    out.held = await standby.holdServiceRuntimeInStandby(0)
    // Optional: a build before the plain-server hold has no state to report (the current-state run on the base).
    out.state = (standby as { standbyRuntimeState?: () => unknown }).standbyRuntimeState?.() ?? null
    out.inProcess = inProcessDaemonRunning()
    out.door = await doorView(sid)
    // The standby's own doing, a second after the hold: nothing in the data home. (The round below is this
    // fixture standing in for the new leader: its RemoteSessionManager is a server's and writes that server's
    // session store, which here is this home; on a machine it is the new leader's, on its own machine.)
    await sleep(1_000)
    const after = hashTree(home)
    // Every path added, removed or changed in the data home (none when the standby wrote nothing there).
    out.homeChanged = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k])
    out.homeUnchanged = (out.homeChanged as string[]).length === 0
    if ((out.door as { alive: boolean | null }).alive) {
      const s = session(sid)
      out.attached = await attachAndAnswer(s, 'standby')
      await release(s)
    }
    await standby.releaseServiceRuntimeInStandby('leader-switch back', 4_000)
    out.inProcessAfterRelease = inProcessDaemonRunning()
  } else throw new Error(`unknown phase ${phase}`)
} catch (err) {
  out.error = err instanceof Error ? (err.stack ?? err.message) : String(err)
} finally {
  try { disconnectAllDaemons() } catch { /* nothing pooled */ }
  try { await stopInProcessDaemon('fixture cleanup') } catch { /* none ran */ }
}
// What the registry says of the session after this process's stop, read from the dir (no runtime runs now).
try {
  const sid = (out.sid as string | undefined) ?? process.argv[5]
  const reg = JSON.parse(fs.readFileSync(path.join(DIR, 'sessions.json'), 'utf8')) as unknown
  out.registryHasSession = !!sid && JSON.stringify(reg).includes(sid)
} catch { out.registryHasSession = false }
out.cliAliveAtExit = alive((out.cliPid as number | undefined) ?? Number(process.env.SWITCH_STOP_CLI_PID ?? 0))
process.stdout.write(JSON.stringify(out) + '\n')
process.exit(0)
