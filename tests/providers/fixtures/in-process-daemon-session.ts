/**
 * Run by tests/providers/in-process-daemon-e2e.test.ts with bun: the session daemon runtime in
 * this process (in-process-daemon.ts), driven by the server's own RemoteSessionManager through
 * the in-process link (IN_PROCESS_DAEMON_URL), with a fake CLI (a shell script that answers every
 * stdin user line with one assistant line and one result line). Prints one JSON line of what it
 * saw, then exits.
 *
 * The test sets the env (HOME, OPEN_WALNUT_HOME, WALNUT_DAEMON_DIR, ...) to a temp root before
 * this process starts: src/constants.ts reads it at import. Every Walnut module is imported
 * dynamically, after JSON.parse is wrapped, so the parse count sees every call.
 *
 * MACHINE SAFETY: only pids this process spawned (the daemon program) or its runtime spawned
 * (the fake CLIs, whose parent is this process) are ever signalled, and only when pid > 1.
 *
 * argv[2]: the temp root (the test removes it).
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'

const root = process.argv[2]!
const DIR = process.env.WALNUT_DAEMON_DIR!
if (!DIR || !DIR.startsWith(root)) throw new Error('WALNUT_DAEMON_DIR must sit in the temp root')
const STREAMS = `${DIR}-streams`
const STANDALONE = path.resolve(import.meta.dirname, '../../../src/providers/daemon-standalone.ts')

// ── Parse counter: every JSON.parse of a string in this process, by its text ──
const realParse = JSON.parse
const parseCounts = new Map<string, number>()
let counting = false
JSON.parse = function countedParse(text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) {
  if (counting && typeof text === 'string') parseCounts.set(text, (parseCounts.get(text) ?? 0) + 1)
  return realParse.call(JSON, text, reviver)
} as typeof JSON.parse

const { startInProcessDaemon, stopInProcessDaemon, IN_PROCESS_DAEMON_URL } = await import('../../../src/providers/in-process-daemon.ts')
const { RemoteSessionManager } = await import('../../../src/providers/remote-session-manager.ts')
const { disconnectAllDaemons } = await import('../../../src/providers/daemon-connection.ts')
const { WALNUT_HOME, LOG_DIR } = await import('../../../src/constants.ts')
type OutputEvent = import('../../../src/providers/session-manager.ts').OutputEvent

/** A fake CLI: an init line, then for every stdin user line an assistant line and a result line naming its ROUND-<word>. */
function fakeCli(): string {
  const file = path.join(root, 'fake-cli.sh')
  fs.writeFileSync(file, [
    '#!/bin/sh',
    'sid=fake',
    'while [ $# -gt 0 ]; do',
    '  if [ "$1" = "--session-id" ]; then sid="$2"; fi',
    '  shift',
    'done',
    'echo "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"$sid\\",\\"model\\":\\"fake\\",\\"tools\\":[]}"',
    'n=0',
    'while IFS= read -r line; do',
    '  case "$line" in',
    '    *\'"type":"user"\'*)',
    '      n=$((n+1))',
    '      word=$(printf \'%s\\n\' "$line" | sed -n \'s/.*ROUND-\\([A-Za-z0-9]*\\).*/\\1/p\')',
    '      echo "{\\"type\\":\\"assistant\\",\\"session_id\\":\\"$sid\\",\\"message\\":{\\"id\\":\\"msg_fake_${n}_$word\\",\\"type\\":\\"message\\",\\"role\\":\\"assistant\\",\\"model\\":\\"fake\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"answer $word\\"}],\\"stop_reason\\":\\"end_turn\\",\\"usage\\":{\\"input_tokens\\":1,\\"output_tokens\\":1}}}"',
    '      echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"session_id\\":\\"$sid\\",\\"num_turns\\":$n,\\"result\\":\\"answer $word\\"}"',
    '      ;;',
    '  esac',
    'done',
    '',
  ].join('\n'), { mode: 0o755 })
  return file
}

const FAKE_CLI = fakeCli()
const WORK = path.join(root, 'work')
fs.mkdirSync(WORK, { recursive: true })
const cliArgs = (sid: string) => ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--session-id', sid]
const baseEnv: NodeJS.ProcessEnv = { ...process.env }
const keepEnv: NodeJS.ProcessEnv = { ...process.env, WALNUT_DAEMON_KEEP_SESSIONS: '1' }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(what: string, ok: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

/** /proc/<pid>/stat: [state, ppid], or null when the pid is gone. */
function procStat(pid: number): { state: string; ppid: number } | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return { state: rest[0]!, ppid: Number(rest[1]) }
  } catch { return null }
}
const alive = (pid: number) => { const s = procStat(pid); return !!s && s.state !== 'Z' && s.state !== 'X' }
async function gone(pid: number, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms
  while (alive(pid)) { if (Date.now() > end) return false; await sleep(50) }
  return true
}
function childrenOfSelf(): Array<{ pid: number; cmd: string }> {
  const out: Array<{ pid: number; cmd: string }> = []
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const s = procStat(Number(name))
    if (!s || s.ppid !== process.pid || s.state === 'Z') continue
    let cmd = ''
    try { cmd = fs.readFileSync(`/proc/${name}/cmdline`).toString().split('\0').filter(Boolean).join(' ') } catch { continue }
    out.push({ pid: Number(name), cmd })
  }
  return out
}

/** One server-side session on the daemon at `url`, recording what reaches onOutput. */
function session(sid: string, url: string) {
  const outputs: OutputEvent[] = []
  const exits: number[] = []
  const rsm = new RemoteSessionManager(sid, '__local__', null, url, FAKE_CLI)
  const results = () => outputs
    .filter((e) => e.parsed?.type === 'result')
    .map((e) => String((e.parsed as { result?: unknown }).result))
  const onOutput = (e: OutputEvent) => { outputs.push(e) }
  const onExit = (code: number) => { exits.push(code) }
  return { sid, rsm, outputs, exits, results, onOutput, onExit }
}
type Session = ReturnType<typeof session>

async function round(s: Session, word: string): Promise<{ written: boolean; result: string | null }> {
  const before = s.results().length
  const written = await s.rsm.writeMessage(`ROUND-${word}`)
  await waitFor(`the answer of ROUND-${word}`, () => s.results().length > before)
  return { written, result: s.results()[before] ?? null }
}

async function attachAndAnswer(s: Session, word: string) {
  const attached = await s.rsm.attach({ sessionId: s.sid, onOutput: s.onOutput, onExit: s.onExit, mode: 'bypass' })
  const state = await s.rsm.getState()
  const r = await round(s, word)
  return { alive: attached.alive, pid: attached.pid, hasState: state !== null, ...r }
}

/** Lets the server side go: its link to the daemon closes (the pool's own reconnect ends with it). */
async function release(s: Session): Promise<void> {
  await s.rsm.cleanup()
  disconnectAllDaemons()
  await sleep(50)
}

const out: Record<string, unknown> = { selfPid: process.pid, walnutHome: WALNUT_HOME, logDir: LOG_DIR }
const cliPids = new Set<number>()
let program: ChildProcess | null = null
const t0 = Date.now()
const mark = (name: string) => { (out.timings as Record<string, number>)[name] = Date.now() - t0 }
out.timings = {}

try {
  // ── 1. A session in process, two rounds ──────────────────────────────────
  // A stale daemon.pid (a pid that has exited) left in the dir: the in-process runtime removes it.
  const dead = spawn('/bin/true')
  await new Promise((r) => dead.once('exit', r))
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(DIR, 'daemon.pid'), String(dead.pid))
  counting = true
  const started1 = await startInProcessDaemon({ dir: DIR, env: baseEnv })
  const s1 = session(crypto.randomUUID(), IN_PROCESS_DAEMON_URL)
  const start1 = await s1.rsm.start({ args: cliArgs(s1.sid), cwd: WORK, message: 'ROUND-one', mode: 'bypass', onOutput: s1.onOutput, onExit: s1.onExit })
  cliPids.add(start1.pid)
  await waitFor('the answer of ROUND-one', () => s1.results().length >= 1)
  const second = await round(s1, 'two')
  // Children of this process: the fake CLI only. A transient helper (a `ps` the runtime runs) may
  // show for a moment, so the sample is taken again until it settles.
  let children = childrenOfSelf()
  const seenOthers = new Set<string>()
  for (let i = 0; i < 40 && !(children.length === 1 && children[0]!.pid === start1.pid); i++) {
    for (const c of children) if (c.pid !== start1.pid) seenOthers.add(c.cmd)
    await sleep(50)
    children = childrenOfSelf()
  }
  // The door (daemon-door.ts) is open in process too: a client that is not this server (walnut-net,
  // a host's follower, a leader's tunnel) says hello over daemon.port and asks for this session.
  const { askOwnPort } = await import('../../../src/providers/service-launcher-beat.ts')
  const doorPort = Number(fs.readFileSync(path.join(DIR, 'daemon.port'), 'utf8').trim())
  const ask = askOwnPort(doorPort, WebSocket as never)
  const doorHello = await ask({ cmd: 'hello' }) as { capabilities?: string[] }
  const doorStatus = await ask({ cmd: 'status', sid: s1.sid }) as { exists?: boolean; ok?: boolean }
  out.s1 = {
    started: started1,
    door: { port: doorPort, capabilities: doorHello.capabilities ?? null, statusExists: doorStatus.exists ?? null },
    portFile: fs.existsSync(path.join(DIR, 'daemon.port')),
    pidFile: fs.existsSync(path.join(DIR, 'daemon.pid')),
    cliPid: start1.pid,
    cliParent: procStat(start1.pid)?.ppid ?? null,
    results: s1.results(),
    secondWritten: second.written,
    everyOutputParsed: s1.outputs.length > 0 && s1.outputs.every((e) => !!e.parsed && typeof e.parsed === 'object' && !Array.isArray(e.parsed)),
    outputCount: s1.outputs.length,
    children: children.map((c) => ({ isCli: c.pid === start1.pid, cmd: c.cmd })),
    transientOthers: [...seenOthers],
  }
  mark('s1')

  // ── 2. Every line of the session's output parsed at most once in the whole process ──
  await sleep(300) // let anything still reading the last lines run
  counting = false
  const lines = fs.readFileSync(path.join(STREAMS, `${s1.sid}.jsonl`), 'utf8').split('\n').filter((l) => l.length > 0)
  const perLine = lines.map((l) => parseCounts.get(l) ?? 0)
  out.s2 = {
    lines: lines.length,
    counts: perLine,
    max: Math.max(0, ...perLine),
    min: Math.min(...perLine),
    // Which kinds of line were parsed more than once (for the report).
    over: lines.filter((_, i) => perLine[i]! > 1).map((l) => (realParse(l) as { type?: string }).type),
  }

  // ── 3. Stop: the dir's lock is given back and an isolated dir's CLI is reaped ──
  await release(s1)
  const stop1 = await stopInProcessDaemon('test')
  const cliGone1 = await gone(start1.pid)
  const again = await startInProcessDaemon({ dir: DIR, env: baseEnv })
  const stopAgain = await stopInProcessDaemon('test')
  out.s3 = { stopCode: stop1, cliGone: cliGone1, againKind: again.kind, stopAgain, portFile: fs.existsSync(path.join(DIR, 'daemon.port')) }
  mark('s3')

  // ── 4. Adopted across a restart and across the switch ──────────────────────
  const s4: Record<string, unknown> = {}
  out.s4 = s4
  s4.startKeep = (await startInProcessDaemon({ dir: DIR, env: keepEnv })).kind
  const a = session(crypto.randomUUID(), IN_PROCESS_DAEMON_URL)
  const startA = await a.rsm.start({ args: cliArgs(a.sid), cwd: WORK, message: 'ROUND-k1', mode: 'bypass', onOutput: a.onOutput, onExit: a.onExit })
  cliPids.add(startA.pid)
  await waitFor('the answer of ROUND-k1', () => a.results().length >= 1)
  s4.first = a.results()[0]
  s4.cliPid = startA.pid
  await release(a)

  // a. In process → in process.
  s4.stopKeep1 = await stopInProcessDaemon('test')
  s4.cliAliveAfterStop1 = alive(startA.pid)
  s4.restartKind = (await startInProcessDaemon({ dir: DIR, env: keepEnv })).kind
  const b = session(a.sid, IN_PROCESS_DAEMON_URL)
  s4.afterRestart = await attachAndAnswer(b, 'k2')
  await release(b)
  s4.stopKeep2 = await stopInProcessDaemon('test')
  s4.cliAliveAfterStop2 = alive(startA.pid)
  mark('s4-restart')

  // b. In process → the daemon as a program of its own.
  program = spawn(process.execPath, [STANDALONE, '--start'], {
    env: { ...keepEnv, WALNUT_DAEMON_PARENT_PID: String(process.pid) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let programErr = ''
  program.stderr!.on('data', (c: Buffer) => { programErr = (programErr + c.toString()).slice(-4000) })
  const port = await new Promise<number>((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error(`the daemon program printed no port in 30 s: ${programErr}`)), 30_000)
    program!.stdout!.on('data', (c: Buffer) => {
      text += c.toString()
      const m = text.match(/^(\d+)$/m)
      if (m) { clearTimeout(timer); resolve(Number(m[1])) }
    })
    program!.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the daemon program exited early (${code}): ${programErr}`)) })
  })
  s4.programPortFile = fs.existsSync(path.join(DIR, 'daemon.port'))
  s4.programPidFile = fs.existsSync(path.join(DIR, 'daemon.pid')) ? Number(fs.readFileSync(path.join(DIR, 'daemon.pid'), 'utf8').trim()) : null
  s4.programPid = program.pid ?? null
  const c = session(a.sid, `ws://127.0.0.1:${port}`)
  s4.onProgram = await attachAndAnswer(c, 'k3')
  await release(c)
  const programExit = new Promise<number | null>((resolve) => program!.once('exit', (code) => resolve(code)))
  if (program.pid && program.pid > 1) program.kill('SIGTERM')
  s4.programExit = await Promise.race([programExit, sleep(20_000).then(() => 'timeout')])
  program = null
  s4.cliAliveAfterProgram = alive(startA.pid)
  mark('s4-program')

  // c. The program → in process again, this time without the keep switch.
  s4.backKind = (await startInProcessDaemon({ dir: DIR, env: baseEnv })).kind
  s4.backFiles = { port: fs.existsSync(path.join(DIR, 'daemon.port')), pid: fs.existsSync(path.join(DIR, 'daemon.pid')) }
  const d = session(a.sid, IN_PROCESS_DAEMON_URL)
  s4.backInProcess = await attachAndAnswer(d, 'k4')
  await release(d)
  s4.finalStop = await stopInProcessDaemon('test')
  s4.cliGoneAtEnd = await gone(startA.pid)
  s4.results = [a, b, c, d].map((s) => s.results())
  mark('s4')
} catch (err) {
  out.error = err instanceof Error ? (err.stack ?? err.message) : String(err)
} finally {
  try { disconnectAllDaemons() } catch { /* nothing pooled */ }
  try { await stopInProcessDaemon('fixture cleanup') } catch { /* none ran */ }
  if (program && program.pid && program.pid > 1 && program.exitCode === null) {
    try { program.kill('SIGTERM') } catch { /* gone */ }
  }
  // A fake CLI left behind (a failed step): ended only when it is still this process's child.
  const leftovers: number[] = []
  for (const pid of cliPids) {
    if (pid > 1 && alive(pid) && procStat(pid)?.ppid === process.pid) {
      leftovers.push(pid)
      try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
    }
  }
  out.leftoverClis = leftovers
}
process.stdout.write(JSON.stringify(out) + '\n')
process.exit(0)
