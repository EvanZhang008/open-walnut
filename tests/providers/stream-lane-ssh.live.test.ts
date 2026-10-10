/**
 * The stream lane's SSH forward (sshLaneForward, providers/stream-lane.ts)
 * against REAL OpenSSH: a localhost-only sshd this test starts with its own keys
 * (no ~/.ssh, no real host, -F /dev/null on every client).
 *
 *   1. It is a connection of its own: a ControlPath later in the arguments (or
 *      in a config file) does not put it through the session master, so it
 *      needs a login of its own and outlives the master.
 *   2. It ends with the server that holds it, also one killed with SIGKILL.
 *
 * Run: WALNUT_LIVE_TEST=1 npx vitest run --config vitest.live.config.ts tests/providers/stream-lane-ssh.live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { sshLaneForward, STOPPED } from '../../src/providers/stream-lane.js'
import { controlSocketPath, exitControlMaster, probeControlMaster, startControlMaster } from '../../src/providers/ssh-control-master.js'

const SSHD = '/usr/sbin/sshd'
const ROOT = path.resolve(import.meta.dirname, '../..')
const enabled = process.env.WALNUT_LIVE_TEST === '1' && fs.existsSync(SSHD)

let dir = ''
let port = 0
let sshd: ChildProcess | null = null
let sshArgs: string[] = []
let host = ''
let echo: net.Server | null = null
let echoPort = 0

const freePort = () => new Promise<number>((resolve) => {
  const srv = net.createServer()
  srv.listen(0, '127.0.0.1', () => {
    const p = (srv.address() as net.AddressInfo).port
    srv.close(() => resolve(p))
  })
})
const listening = (p: number) => new Promise<boolean>((resolve) => {
  const c = net.connect(p, '127.0.0.1', () => { c.end(); resolve(true) })
  c.on('error', () => resolve(false))
})
async function until(what: string, probe: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}
const keygen = (file: string) => spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file]).status

/** One round trip through a forward to the echo server. */
function roundTrip(p: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(p, '127.0.0.1', () => c.write(text))
    c.once('data', (b) => { c.end(); resolve(b.toString()) })
    c.on('error', reject)
    setTimeout(() => { c.destroy(); reject(new Error('no echo')) }, 5_000)
  })
}

describe.skipIf(!enabled)('the stream lane\'s own SSH forward, on real OpenSSH', () => {
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-live-'))
    expect(keygen(path.join(dir, 'host_key'))).toBe(0)
    expect(keygen(path.join(dir, 'client_key'))).toBe(0)
    fs.copyFileSync(path.join(dir, 'client_key.pub'), path.join(dir, 'authorized_keys'))
    port = await freePort()
    fs.writeFileSync(path.join(dir, 'sshd_config'), [
      `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${dir}/host_key`, `AuthorizedKeysFile ${dir}/authorized_keys`,
      'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes', 'StrictModes no',
      `PidFile ${dir}/sshd.pid`, 'AllowTcpForwarding yes', 'UsePAM no',
    ].join('\n') + '\n')
    sshd = spawn(SSHD, ['-D', '-f', path.join(dir, 'sshd_config'), '-E', path.join(dir, 'sshd.log')], { stdio: 'ignore' })
    await until('sshd to listen', () => listening(port))
    sshArgs = ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR', '-i', path.join(dir, 'client_key'), '-p', String(port)]
    host = `${os.userInfo().username}@127.0.0.1`
    echo = net.createServer((c) => c.pipe(c))
    echoPort = await new Promise<number>((r) => echo!.listen(0, '127.0.0.1', () => r((echo!.address() as net.AddressInfo).port)))
  })

  afterAll(() => {
    sshd?.kill('SIGTERM')
    echo?.close()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('is a connection of its own: not through the master, alive after it, and a login of its own', async () => {
    const socket = controlSocketPath({ hostKey: 'loopback', target: `${host}:${port}`, home: dir })
    await startControlMaster(socket, sshArgs, host)
    expect(await probeControlMaster(socket, sshArgs, host)).toBe('live')
    // A config file that muxes everything through the master and runs a command of its own, and
    // a ControlPath in the arguments: the lane's own options come first and win over both.
    const cfg = path.join(dir, 'ssh_config')
    fs.writeFileSync(cfg, `Host *\n  ControlMaster auto\n  ControlPath ${socket}\n  RemoteCommand echo hijacked\n`)
    const muxed = ['-F', cfg, ...sshArgs.slice(2), '-o', `ControlPath=${socket}`]

    const fwd = await sshLaneForward(muxed, host, echoPort)
    expect(await roundTrip(fwd.port, 'lane')).toBe('lane')
    // The master goes (a bad packet on its connection): the lane goes on.
    await exitControlMaster(socket, sshArgs, host)
    expect(await probeControlMaster(socket, sshArgs, host)).not.toBe('live')
    expect(await roundTrip(fwd.port, 'still')).toBe('still')
    let exited = ''
    fwd.onExit((why) => { exited = why })
    fwd.stop()
    await until('the forward to end', async () => exited !== '' && !(await listening(fwd.port)))
    // A stop of ours is no news.
    expect(exited).toBe(STOPPED)

    // The far end drops the connection (what sshd does on a bad MAC): ssh's last word is the reason.
    const cut = await sshLaneForward(muxed, host, echoPort)
    expect(await roundTrip(cut.port, 'x')).toBe('x')
    let why = ''
    cut.onExit((w) => { why = w })
    // Every process under this test's sshd (a session is a monitor and its child; both hold the socket).
    const table = spawnSync('ps', ['-axo', 'pid=,ppid=']).stdout.toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number))
    const sessions: number[] = []
    for (let grew = true; grew;) {
      grew = false
      for (const [pid, ppid] of table) {
        if ((ppid === sshd!.pid || sessions.includes(ppid!)) && !sessions.includes(pid!)) { sessions.push(pid!); grew = true }
      }
    }
    expect(sessions.length).toBeGreaterThan(0)
    for (const pid of sessions) if (pid > 1) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    await until('the cut forward to end', async () => why !== '', 15_000)
    expect(why).not.toBe(STOPPED)
    expect(why).toMatch(/closed|reset|broken|code 255/i)

    // With the credential gone, the master would still serve; the lane needs its own login and says so.
    await startControlMaster(socket, sshArgs, host)
    const saved = fs.readFileSync(path.join(dir, 'authorized_keys'))
    fs.writeFileSync(path.join(dir, 'authorized_keys'), '')
    try {
      await expect(sshLaneForward(muxed, host, echoPort)).rejects.toThrow(/its SSH forward did not open.*Permission denied/s)
    } finally {
      fs.writeFileSync(path.join(dir, 'authorized_keys'), saved)
      await exitControlMaster(socket, sshArgs, host)
    }
  }, 60_000)

  it('ends with the server that holds it, also one killed with SIGKILL', async () => {
    const out = path.join(dir, 'holder.port')
    const script = path.join(dir, 'holder.mts')
    fs.writeFileSync(script, [
      `import fs from 'node:fs'`,
      `import { sshLaneForward } from ${JSON.stringify(path.join(ROOT, 'src/providers/stream-lane.ts'))}`,
      `const fwd = await sshLaneForward(${JSON.stringify(sshArgs)}, ${JSON.stringify(host)}, ${echoPort})`,
      `fs.writeFileSync(${JSON.stringify(out)}, String(fwd.port))`,
      `setInterval(() => {}, 1 << 30)`,
    ].join('\n'))
    // One process (the tsx wrapper would leave its child alive): the SIGKILL hits the holder itself.
    const holder = spawn(process.execPath, ['--import', 'tsx', script], { stdio: 'ignore', cwd: ROOT })
    await until('the holder\'s forward', async () => fs.existsSync(out), 30_000)
    const fwdPort = Number(fs.readFileSync(out, 'utf8'))
    expect(await roundTrip(fwdPort, 'held')).toBe('held')
    holder.kill('SIGKILL')
    await until('the orphaned forward to end', async () => !(await listening(fwdPort)), 15_000)
  }, 60_000)
})
