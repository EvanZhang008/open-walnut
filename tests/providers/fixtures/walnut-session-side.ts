/**
 * One Walnut server's session side in a process of its own, run with bun and driven one JSON line
 * at a time on stdin (tests/helpers/walnut-session-side.ts): the server's own RemoteSessionManager
 * and LocalDaemon, never a stand-in. Each answer is one stdout line `OUT <json>`.
 *
 *   start   {url?}         a session with a fake CLI (fakeRoundCli), its first turn ROUND-one. With
 *                          `url`: a host's daemon reached at that door; without: this computer's own
 *                          daemon, followed as the server follows it (followsLocalDaemon).
 *   round   {word}         one more turn on the session's manager as it is (its link may have dropped).
 *   attach  {url?, word, sid?}  the session again on a new manager (what the server's recovery does after
 *                          its link to the daemon dropped), then one turn. `sid`: a session another
 *                          side started (a server that restarted: its session record names it).
 *   ensure  {}             localDaemon.ensureRunning(): this server's own daemon, in process or a program.
 *   exit    {}             lets go (a runtime in this process stops with the keep switch the env sets).
 *
 * Every turn answers with the result's text and num_turns: the CLI counts the turns it answered, so
 * a count that goes on is a conversation that went on in the same CLI.
 *
 * The test sets the env (HOME, OPEN_WALNUT_HOME, WALNUT_DAEMON_DIR, WALNUT_IN_PROCESS_DAEMON, ...)
 * before this process starts: src/constants.ts reads it at import.
 * MACHINE SAFETY: argv[2] is a temp root the test made and removes; nothing is signalled here.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const root = process.argv[2]!
const { RemoteSessionManager } = await import('../../../src/providers/remote-session-manager.ts')
const { disconnectAllDaemons } = await import('../../../src/providers/daemon-connection.ts')
const { localDaemon } = await import('../../../src/providers/local-daemon.ts')
const { inProcessDaemonRunning, stopInProcessDaemon } = await import('../../../src/providers/in-process-daemon.ts')
const { fakeRoundCli } = await import('../../helpers/fake-round-cli.ts')
type OutputEvent = import('../../../src/providers/session-manager.ts').OutputEvent
type Manager = InstanceType<typeof RemoteSessionManager>

fs.mkdirSync(root, { recursive: true })
const CLI = fakeRoundCli(root)
const WORK = path.join(root, 'work')
fs.mkdirSync(WORK, { recursive: true })
const cliArgs = (sid: string) => ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--session-id', sid]

type Turn = { result: string; turns: number }
let sid = crypto.randomUUID()
const turns: Turn[] = []
let rsm: Manager | null = null

const onOutput = (e: OutputEvent) => {
  const p = e.parsed as { type?: string; result?: unknown; num_turns?: unknown } | undefined
  if (p?.type === 'result') turns.push({ result: String(p.result), turns: Number(p.num_turns) })
}
const onExit = () => {}

function manager(url: string | undefined): Manager {
  const m = new RemoteSessionManager(sid, url ? 'shared-host' : '__local__', null, url, CLI)
  if (!url) m.followsLocalDaemon = true
  return m
}

async function nextTurn(before: number, ms = 30_000): Promise<Turn> {
  const end = Date.now() + ms
  while (turns.length <= before) {
    if (Date.now() > end) throw new Error('no answer in time')
    await new Promise((r) => setTimeout(r, 25))
  }
  return turns[before]!
}

async function round(m: Manager, word: string): Promise<{ written: boolean } & Turn> {
  const before = turns.length
  const written = await m.writeMessage(`ROUND-${word}`)
  return { written, ...(await nextTurn(before)) }
}

async function run(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = typeof cmd.url === 'string' ? cmd.url : undefined
  switch (cmd.op) {
    case 'start': {
      sid = crypto.randomUUID()
      rsm = manager(url)
      const started = await rsm.start({ args: cliArgs(sid), cwd: WORK, message: 'ROUND-one', mode: 'bypass', onOutput, onExit })
      return { sid, pid: started.pid, ...(await nextTurn(0)) }
    }
    case 'round':
      return round(rsm!, String(cmd.word))
    case 'attach': {
      if (typeof cmd.sid === 'string') sid = cmd.sid
      const m = manager(url)
      const attached = await m.attach({ sessionId: sid, onOutput, onExit, mode: 'bypass' })
      rsm = m
      return { alive: attached.alive, pid: attached.pid, ...(await round(m, String(cmd.word))) }
    }
    case 'ensure': {
      await localDaemon.ensureRunning()
      return { wsUrl: localDaemon.wsUrl, inProcess: inProcessDaemonRunning() }
    }
    case 'exit': {
      try { await rsm?.cleanup() } catch { /* gone */ }
      disconnectAllDaemons()
      const code = await stopInProcessDaemon('test side exit').catch(() => null)
      return { stopped: code }
    }
    default:
      throw new Error(`unknown op ${String(cmd.op)}`)
  }
}

const say = (v: Record<string, unknown>) => process.stdout.write(`OUT ${JSON.stringify(v)}\n`)
const lines = readline.createInterface({ input: process.stdin })
say({ ready: true, pid: process.pid })
for await (const line of lines) {
  let cmd: Record<string, unknown>
  try { cmd = JSON.parse(line) } catch { continue }
  try {
    say({ id: cmd.id, ok: true, ...(await run(cmd)) })
  } catch (err) {
    say({ id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
  if (cmd.op === 'exit') break
}
process.exit(0)
