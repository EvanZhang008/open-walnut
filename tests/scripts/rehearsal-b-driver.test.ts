/**
 * Rehearsal (b)'s driver without the other machine (scripts/leader-switch/real-world.ts): its ssh transport's
 * command lines and tunnels (no ssh runs: the ssh program is a stand-in that records its arguments), the agent
 * over the fake transport (a process here, the same channel), the other machine's scripts (real/*.sh) against
 * folders and processes of this computer, and the preflight's limits.
 *
 * The cleanup is the part that signals processes: every case here starts its own `sleep`s and checks by pid
 * which of them it ended; none outside the test's own folders is ever a candidate.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { FakeTransport, SshTransport, shq, startRelay } from '../../scripts/leader-switch/transport.js'
import { AgentIO, LOCAL, ioAt, registerMachineRoot } from '../../scripts/leader-switch/machine-io.js'
import { judgeFacts, parseFacts, servicesOf, watchLocalAccess } from '../../scripts/leader-switch/real-world.js'

const REPO = path.resolve(import.meta.dirname, '../..')
const REAL = path.join(REPO, 'scripts', 'leader-switch', 'real')
const dirs: string[] = []
const procs: ChildProcess[] = []
const tmp = (name: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `rb-${name}-`)); dirs.push(d); return d }
afterEach(() => {
  for (const p of procs.splice(0)) { if (p.pid && p.exitCode === null && p.signalCode === null) try { process.kill(p.pid, 'SIGKILL') } catch { /* gone */ } }
  for (const d of dirs.splice(0)) { try { execFileSync('chmod', ['-R', 'u+w', d]) } catch { /* gone */ } fs.rmSync(d, { recursive: true, force: true }) }
})
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
/** A child of this test ended (a signalled one stays a zombie until it is reaped: kill 0 still finds it). */
const ended = (p: ChildProcess) => p.exitCode !== null || p.signalCode !== null
const sh = (file: string, args: string[]) => {
  try { return { code: 0, out: execFileSync('/bin/sh', [path.join(REAL, file), ...args], { encoding: 'utf8', cwd: '/' }) } } catch (err) { const e = err as { status: number; stdout: string }; return { code: e.status, out: e.stdout } }
}
/** A `sleep` started in `cwd` (its own process, not a child of a shell that stays). */
function sleeper(cwd: string, argv0?: string): ChildProcess {
  const p = spawn(argv0 ?? 'sleep', ['300'], { cwd, stdio: 'ignore', detached: true })
  procs.push(p)
  return p
}
async function until(f: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!f()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)) }
}

describe('the preflight limits (real-world.ts judgeFacts)', () => {
  const ok = { nproc: '8', load1: '2.5', mem_avail_kb: String(8 * 1024 * 1024), disk_avail_kb: String(200 * 1024 * 1024), root_exists: 'no' }
  it('allows a small run and a 20 GB one when every limit is met', () => {
    expect(judgeFacts(ok, 0)).toMatchObject({ refused: null, smallOnly: null })
    expect(judgeFacts(ok, 20)).toMatchObject({ refused: null, smallOnly: null, needGib: 3 * (3 + 40) })
  })
  it('refuses a load at or above the core count, too little memory or disk for the small run, and a root that exists', () => {
    expect(judgeFacts({ ...ok, load1: '8.00' }, 0).refused).toMatch(/load 8.00 is not below its 8 cores/)
    expect(judgeFacts({ ...ok, mem_avail_kb: String(2 * 1024 * 1024) }, 0).refused).toMatch(/memory/)
    expect(judgeFacts({ ...ok, disk_avail_kb: String(8 * 1024 * 1024) }, 0).refused).toMatch(/disk/)
    expect(judgeFacts({ ...ok, root_exists: 'yes' }, 0).refused).toMatch(/root exists/)
    expect(judgeFacts({ ...ok, load1: 'x' }, 0).refused).not.toBeNull()
  })
  it('cuts a 20 GB run to the small-data scenarios when only its disk is short, and says so', () => {
    const j = judgeFacts({ ...ok, disk_avail_kb: String(60 * 1024 * 1024) }, 20)
    expect(j.refused).toBeNull()
    expect(j.smallOnly).toMatch(/no filler, small-data scenarios only/)
  })
  it('reads preflight.sh as key=value lines, and the snapshot\'s services', () => {
    expect(parseFacts('a=1\nb=x=y\n\njunk\n')).toEqual({ a: '1', b: 'x=y' })
    expect(servicesOf('10 99 service bun x.ts\n11 100 turn claude -p\n')).toEqual(['10 99 bun x.ts'])
  })
})

describe('the fake transport\'s guard (real-world.ts watchLocalAccess)', () => {
  it('records each read or write of this process under B\'s root, and none elsewhere, until stopped', async () => {
    const root = tmp('guard')
    fs.mkdirSync(path.join(root, 'b2b-real', 'x'), { recursive: true })
    fs.writeFileSync(path.join(root, 'b2b-real', 'x', 'f'), 'b')
    fs.writeFileSync(path.join(root, 'here'), 'a')
    const g = watchLocalAccess(path.join(root, 'b2b-real'))
    try {
      fs.readFileSync(path.join(root, 'here'), 'utf8')
      fs.existsSync(`${root}/b2b-realx`)
      expect(g.hits()).toEqual([])
      fs.readFileSync(path.join(root, 'b2b-real', 'x', 'f'), 'utf8')
      await fs.promises.readdir(path.join(root, 'b2b-real'))
      fs.renameSync(path.join(root, 'here'), path.join(root, 'b2b-real', 'here'))
      expect(g.hits().map((h) => h.split('(')[0])).toEqual(['fs.readFileSync', 'fs.promises.readdir', 'fs.renameSync'])
    } finally {
      g.stop()
    }
    fs.readFileSync(path.join(root, 'b2b-real', 'x', 'f'), 'utf8')
    expect(g.hits()).toHaveLength(3)
  })
})

describe('the ssh transport: only the master\'s socket, the same port on both machines', () => {
  function recorder(): { calls: string[][]; spawnSsh: (args: string[]) => ChildProcessWithoutNullStreams } {
    const calls: string[][] = []
    return { calls, spawnSsh: (args) => { calls.push(args); return spawn('/bin/sh', ['-c', 'exit 0'], { stdio: ['pipe', 'pipe', 'pipe'] }) } }
  }
  it('never connects on its own, never takes a host key it does not have, never prompts', () => {
    const t = new SshTransport({ host: 'olddev', socket: '/s/m', bridge: { host: '127.0.0.2', container: '127.0.0.3' }, spawnSsh: recorder().spawnSsh })
    const a = t.clientArgs().join(' ')
    expect(a).toContain('-S /s/m')
    expect(a).toContain('ControlMaster=no')
    expect(a).toContain('ProxyCommand=/bin/false')
    expect(a).toContain('BatchMode=yes')
    expect(a).toContain('StrictHostKeyChecking=yes')
    expect(a).not.toMatch(/StrictHostKeyChecking=no|UserKnownHostsFile/)
  })
  it('a remote command keeps its script and arguments whole through the login shell that parses it', () => {
    const t = new SshTransport({ host: 'h', socket: '/s', bridge: { host: '127.0.0.2', container: '127.0.0.3' }, spawnSsh: recorder().spawnSsh })
    const script = `printf '%s|%s|%s\\n' "$1" "$2" "it's"`
    const line = t.remoteCommand(script, ['a b', `c'd"e`])
    // What sshd does with it: the account's shell runs it as one -c string.
    expect(execFileSync('/bin/sh', ['-c', line], { encoding: 'utf8' })).toBe(`a b|c'd"e|it's\n`)
    expect(shq(`x'y`)).toBe(`'x'\\''y'`)
  })
  it('forward(P) asks the master for -L <bridge>:P and relays the container\'s 127.0.0.1:P to it; reverse(P) the other way; close cancels both and ends the master', async () => {
    const r = recorder()
    const t = new SshTransport({ host: 'olddev', socket: '/s/m', bridge: { host: '127.0.0.2', container: '127.0.0.3' }, spawnSsh: r.spawnSsh })
    // The master's -L end, played by an echo server on the "bridge" address.
    const echo = net.createServer((s) => s.pipe(s))
    await new Promise<void>((res) => echo.listen(0, '127.0.0.2', () => res()))
    const P = (echo.address() as net.AddressInfo).port
    await t.forward(P)
    expect(r.calls.at(-1)).toEqual([...t.clientArgs(), '-O', 'forward', '-L', `127.0.0.2:${P}:127.0.0.1:${P}`, 'olddev'])
    const got = await new Promise<string>((res, rej) => { const c = net.connect(P, '127.0.0.1', () => c.end('ping')); let b = ''; c.on('data', (d) => { b += d }); c.on('end', () => res(b)); c.on('error', rej) })
    expect(got).toBe('ping')
    // reverse: a relay on the container's address to its loopback, where the service listens.
    const svc = net.createServer((s) => s.end('pong'))
    await new Promise<void>((res) => svc.listen(0, '127.0.0.1', () => res()))
    const Q = (svc.address() as net.AddressInfo).port
    await t.reverse(Q)
    expect(r.calls.at(-1)).toEqual([...t.clientArgs(), '-O', 'forward', '-R', `127.0.0.1:${Q}:127.0.0.3:${Q}`, 'olddev'])
    const back = await new Promise<string>((res, rej) => { const c = net.connect(Q, '127.0.0.3'); let b = ''; c.on('data', (d) => { b += d }); c.on('end', () => res(b)); c.on('error', rej) })
    expect(back).toBe('pong')
    await t.close({ master: true })
    const tail = r.calls.slice(-3).map((c) => c.slice(t.clientArgs().length).join(' '))
    expect(tail).toEqual([`-O cancel -L 127.0.0.2:${P}:127.0.0.1:${P} olddev`, `-O cancel -R 127.0.0.1:${Q}:127.0.0.3:${Q} olddev`, '-O exit olddev'])
    await new Promise<void>((res) => echo.close(() => res()))
    await new Promise<void>((res) => svc.close(() => res()))
  })
  it('a forward the master refuses is an error naming it', async () => {
    const t = new SshTransport({ host: 'olddev', socket: '/s/m', bridge: { host: '127.0.0.2', container: '127.0.0.3' }, spawnSsh: () => spawn('/bin/sh', ['-c', 'echo "Port forwarding failed" >&2; exit 255'], { stdio: ['pipe', 'pipe', 'pipe'] }) })
    await expect(t.forward(45999)).rejects.toThrow(/ssh -O forward -L 127.0.0.2:45999:127.0.0.1:45999 olddev: Port forwarding failed/)
  })
  it('a relay passes bytes both ways', async () => {
    const svc = net.createServer((s) => s.pipe(s))
    await new Promise<void>((res) => svc.listen(0, '127.0.0.1', () => res()))
    const relay = await startRelay('127.0.0.4', 0 || 46_001, '127.0.0.1', (svc.address() as net.AddressInfo).port)
    const got = await new Promise<string>((res, rej) => { const c = net.connect(46_001, '127.0.0.4', () => c.end('x'.repeat(100_000))); let n = ''; c.on('data', (d) => { n += d }); c.on('end', () => res(n)); c.on('error', rej) })
    expect(got.length).toBe(100_000)
    await relay.close()
    await new Promise<void>((res) => svc.close(() => res()))
  })
})

describe('the agent over the fake transport (machine-agent.ts, machine-io.ts AgentIO)', () => {
  function agentEnv(root: string): Record<string, string> {
    const home = path.join(root, 'machine')
    return {
      HOME: home, USERPROFILE: home, TMPDIR: path.join(root, 'tmp'), XDG_STATE_HOME: `${home}/.local/state`, XDG_DATA_HOME: `${home}/.local/share`,
      XDG_CONFIG_HOME: `${home}/.config`, XDG_CACHE_HOME: `${home}/.cache`, PATH: process.env.PATH ?? '', WALNUT_REHEARSAL_ROOT: root, WALNUT_REHEARSAL_PIDS: path.join(root, 'run', 'pids.jsonl'),
    }
  }
  function startAgent(root: string, env: Record<string, string>): AgentIO {
    for (const d of ['run', 'tmp', 'machine']) fs.mkdirSync(path.join(root, d), { recursive: true })
    const t = new FakeTransport({ PATH: process.env.PATH ?? '' })
    const words = Object.entries(env).map(([k, v]) => shq(`${k}=${v}`)).join(' ')
    const p = t.spawn(`cd ${shq(REPO)} && exec env -i ${words} ${shq(process.execPath)} scripts/leader-switch/machine-agent.ts`)
    procs.push(p)
    return new AgentIO('fake', p)
  }
  it('answers each operation on the other machine, errors as errors, and ends when its stdin ends', async () => {
    const root = tmp('agent')
    const io = startAgent(root, agentEnv(root))
    const hello = await io.hello
    expect(hello.repo).toBe(REPO)
    const f = path.join(root, 'machine', 'x', 'a.txt')
    await io.op('write', f, 'hello é')
    expect(await io.op('text', f)).toBe('hello é')
    expect(await io.op('exists', f)).toBe(true)
    expect(await io.op('ls', path.dirname(f))).toEqual(['a.txt'])
    expect(await io.op('text', path.join(root, 'none'))).toBeNull()
    expect(await io.op('readMayAct', path.join(root, 'machine', 'no-home'))).toEqual([])
    expect(await io.op('runtime')).toEqual({ bun: process.execPath, repo: REPO })
    await expect(io.op('rename', path.join(root, 'none'), path.join(root, 'x'))).rejects.toThrow(/rename on fake: ENOENT/)
    await expect(io.op('stopPid', 1, 100)).rejects.toThrow(/refused to signal pid 1/)
    // Concurrent operations each get their own answer.
    const many = await Promise.all(Array.from({ length: 20 }, (_, i) => io.op('now').then((n) => typeof n === 'number' && i)))
    expect(many).toEqual(Array.from({ length: 20 }, (_, i) => i))
    const pids = fs.readFileSync(path.join(root, 'run', 'pids.jsonl'), 'utf8')
    expect(JSON.parse(pids.split('\n')[0]!)).toMatchObject({ pid: hello.pid, what: 'agent' })
    await io.close(5_000)
    expect(io.endedWhy).toMatch(/exited/)
    await expect(io.op('now')).rejects.toThrow(/exited/)
  })
  it('keeps w-b\'s setup-only link there until it is stopped: a host service\'s leader door over the witness root, on loopback', async () => {
    const root = tmp('agent-setup')
    const io = startAgent(root, agentEnv(root))
    await io.hello
    const connects = (port: number) => new Promise<boolean>((r) => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); r(true) }); s.on('error', () => r(false)) })
    try {
      const s = await io.op('startSetupWitness', { host: 'machine-b', root: path.join(root, 'machine', 'leader-witness') }) as { handle: string; port: number }
      await io.op('setSetupWitnessWalnut', s.handle, 'walnut-x')
      const { requestOver } = await import('../../src/core/host-server/request-over.js')
      // A witness call with no record: the door answers it (any answer is the door's), over one connection.
      const res = await requestOver(net.connect(s.port, '127.0.0.1'), 'POST', '/host-api/witness/request', Buffer.from(JSON.stringify({ v: 1, walnutId: 'walnut-x', witness: 'w-b', op: { kind: 'read' } })), 5_000)
      expect(res.status).toBeGreaterThanOrEqual(200)
      await io.op('stopKept', s.handle)
      expect(await connects(s.port)).toBe(false)
    } finally {
      await io.close(5_000)
    }
  })
  it('refuses to run when a place of its env is outside its root, and the channel says so', async () => {
    const root = tmp('agent-refuse')
    const io = startAgent(root, { ...agentEnv(root), TMPDIR: os.tmpdir() })
    await expect(io.hello).rejects.toThrow(/exited \(2\)/)
  })
  it('a path under a registered root is read through that machine\'s agent, every other one here', async () => {
    const root = tmp('route')
    const io = startAgent(root, agentEnv(root))
    await io.hello
    const off = registerMachineRoot(root, io)
    try {
      expect(ioAt(path.join(root, 'machine', 'a'))).toBe(io)
      expect(ioAt(root)).toBe(io)
      expect(ioAt(`${root}-sibling/a`)).toBe(LOCAL)
      expect(ioAt('/tmp')).toBe(LOCAL)
    } finally {
      off()
      await io.close(5_000)
    }
    expect(ioAt(path.join(root, 'machine'))).toBe(LOCAL)
  })
})

describe('the other machine\'s scripts (real/*.sh) on folders and processes of this computer', () => {
  it('make-root.sh makes a fresh owner-only root with its start tick and the refusing stand-ins, and refuses one that exists', () => {
    const base = tmp('root')
    const R = path.join(base, 'b2b-real')
    const r = sh('make-root.sh', [R, 'run-1'])
    expect(r.code, r.out).toBe(0)
    expect(fs.statSync(R).mode & 0o777).toBe(0o700)
    expect(fs.readFileSync(path.join(R, 'run', 'started'), 'utf8').trim()).toMatch(/^\d+$/)
    expect(fs.readFileSync(path.join(R, 'run', 'id'), 'utf8').trim()).toBe('run-1')
    for (const n of ['crontab', 'systemctl', 'ssh', 'claude']) expect(() => execFileSync(path.join(R, 'bin', n), { stdio: 'pipe' })).toThrow()
    expect(sh('make-root.sh', [R, 'run-2']).code).toBe(2)
    expect(sh('make-root.sh', ['/x', 'r']).code).toBe(2)
  })
  it('cleanup.sh ends by pid only the processes under the root started after it, leaves every other one, and removes the root', async () => {
    const base = tmp('clean')
    const R = path.join(base, 'b2b-real')
    expect(sh('make-root.sh', [R, 'r']).code).toBe(0)
    fs.mkdirSync(path.join(R, 'machine', 'work'), { recursive: true })
    const ours = sleeper(path.join(R, 'machine', 'work'))
    const outside = sleeper(base)
    // A process the agent recorded but whose cwd and program are not under the root: named, left alone.
    const recorded = sleeper(os.tmpdir())
    fs.appendFileSync(path.join(R, 'run', 'pids.jsonl'), `${JSON.stringify({ pid: recorded.pid, what: 'test' })}\n`)
    // A read-only standby copy: the root is made writable before it goes.
    fs.mkdirSync(path.join(R, 'machine', 'standby', 'copy'), { recursive: true })
    fs.writeFileSync(path.join(R, 'machine', 'standby', 'copy', 'f'), 'x')
    fs.chmodSync(path.join(R, 'machine', 'standby', 'copy', 'f'), 0o400)
    fs.chmodSync(path.join(R, 'machine', 'standby', 'copy'), 0o500)
    await until(() => [ours, outside, recorded].every((p) => !!p.pid && alive(p.pid)))
    const r = sh('cleanup.sh', [R])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`TERM pid ${ours.pid} `)
    expect(r.out).toContain(`LEFT ALONE (recorded, but its cwd and program are not under ${R}): pid ${recorded.pid} `)
    expect(r.out).not.toContain(`pid ${outside.pid} `)
    await until(() => ended(ours))
    expect(ended(outside) || !alive(outside.pid!)).toBe(false)
    expect(ended(recorded) || !alive(recorded.pid!)).toBe(false)
    expect(fs.existsSync(R)).toBe(false)
  })
  it('cleanup.sh leaves a process under the root that started before it alone, names it, and keeps the root', async () => {
    const base = tmp('clean-old')
    const R = path.join(base, 'b2b-real')
    expect(sh('make-root.sh', [R, 'r']).code).toBe(0)
    const early = sleeper(R)
    await until(() => !!early.pid && alive(early.pid))
    // The root as if made after it: a start tick far ahead.
    fs.writeFileSync(path.join(R, 'run', 'started'), '999999999999\n')
    const r = sh('cleanup.sh', [R])
    expect(r.code, r.out).toBe(3)
    expect(r.out).toContain(`LEFT ALONE (under ${R} but started before the rehearsal, tick 999999999999): pid ${early.pid} `)
    expect(r.out).toContain(`cleanup: a process of the rehearsal is still there; ${R} kept`)
    expect(ended(early)).toBe(false)
    expect(fs.existsSync(R)).toBe(true)
  })
  it('cleanup.sh refuses a root it did not make, and a shallow one, and does nothing', () => {
    const base = tmp('clean-refuse')
    expect(sh('cleanup.sh', [base]).out).toContain('not a root this rehearsal made; nothing done')
    expect(sh('cleanup.sh', [base]).code).toBe(2)
    expect(sh('cleanup.sh', ['/']).code).toBe(2)
    expect(sh('cleanup.sh', ['/tmp']).code).toBe(2)
    expect(sh('cleanup.sh', ['']).code).toBe(2)
    expect(fs.existsSync(base)).toBe(true)
  })
  it('cleanup.sh --keep-root ends the processes and keeps the root', async () => {
    const base = tmp('clean-keep')
    const R = path.join(base, 'b2b-real')
    expect(sh('make-root.sh', [R, 'r']).code).toBe(0)
    const ours = sleeper(R)
    await until(() => !!ours.pid && alive(ours.pid))
    const r = sh('cleanup.sh', [R, '--keep-root'])
    expect(r.code, r.out).toBe(0)
    await until(() => ended(ours))
    expect(fs.existsSync(path.join(R, 'run', 'started'))).toBe(true)
  })
  it('snapshot.sh lists this account\'s Walnut-shaped processes outside the root, never one under it or under a folder it is told to leave out', async () => {
    const base = tmp('snap')
    const R = path.join(base, 'b2b-real')
    expect(sh('make-root.sh', [R, 'r']).code).toBe(0)
    const bin = path.join(base, 'bin')
    fs.mkdirSync(bin)
    fs.symlinkSync(execFileSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).trim(), path.join(bin, 'walnut-prod-sim'))
    const prod = sleeper(os.tmpdir(), path.join(bin, 'walnut-prod-sim'))
    const ours = sleeper(R, path.join(bin, 'walnut-prod-sim'))
    const left = sleeper(path.join(base, 'bin'), path.join(bin, 'walnut-prod-sim'))
    await until(() => [prod, ours, left].every((p) => !!p.pid && alive(p.pid)))
    const out = sh('snapshot.sh', [R, path.join(base, 'bin')]).out
    const pids = out.split('\n').filter(Boolean).map((l) => Number(l.split(' ')[0]))
    expect(pids).toContain(prod.pid)
    expect(pids).not.toContain(ours.pid)
    expect(pids).not.toContain(left.pid)
    expect(out).toMatch(new RegExp(`^${prod.pid} \\d+ service .*walnut-prod-sim 300`, 'm'))
  })
  it('preflight.sh prints the facts the driver judges', () => {
    const out = sh('preflight.sh', [path.join(tmp('pre'), 'not', 'yet', 'b2b-real')]).out
    const f = parseFacts(out)
    for (const k of ['hostname', 'nproc', 'load1', 'mem_avail_kb', 'disk_avail_kb', 'root_exists', 'now_ms']) expect(f[k], k).toBeTruthy()
    expect(f.root_exists).toBe('no')
    // A root whose parent is not there yet: the disk of the nearest folder that is.
    expect(Number(f.disk_avail_kb)).toBeGreaterThan(0)
  })
})
