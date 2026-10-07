/**
 * The OpenSSH behaviour ssh-control-master.ts relies on, against REAL OpenSSH:
 * a localhost-only sshd this test starts with its own keys (no ~/.ssh, no real
 * host, -F /dev/null on every client).
 *
 *   1. A master keeps working after its credential stops being accepted, while
 *      a fresh login fails: the expired-certificate case of 2026-10-07, where
 *      keeping the master across a server restart is the whole fix.
 *   2. A process with no memory of the master (the next server) finds it at the
 *      same path and may use it (probeControlMaster says live).
 *   3. A `-L` forward asked for through the master is held by the master after
 *      its client is gone, and cancelRecordedForwards removes it.
 *
 * Run: WALNUT_LIVE_TEST=1 npx vitest run --config vitest.live.config.ts tests/providers/ssh-control-master.live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  cancelRecordedForwards, controlSocketPath, exitControlMaster, probeControlMaster, recordForward, startControlMaster,
} from '../../src/providers/ssh-control-master.js'
import { runSshBounded } from '../../src/providers/remote-sh.js'

const SSHD = '/usr/sbin/sshd'
const enabled = process.env.WALNUT_LIVE_TEST === '1' && fs.existsSync(SSHD)

let dir = ''
let port = 0
let sshd: ChildProcess | null = null
let sshArgs: string[] = []
let host = ''
let socket = ''

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

describe.skipIf(!enabled)('a real OpenSSH ControlMaster', () => {
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wscm-live-'))
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
    socket = controlSocketPath({ hostKey: 'loopback', target: `${host}:${port}`, home: dir })
  })

  afterAll(async () => {
    if (socket && fs.existsSync(socket)) await exitControlMaster(socket, sshArgs, host)
    sshd?.kill('SIGTERM')
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('a master survives its credential, is found by a process that never knew it, and drops its forwards on request', async () => {
    await startControlMaster(socket, sshArgs, host)
    expect(await probeControlMaster(socket, sshArgs, host)).toBe('live')

    // A tunnel as DaemonConnection makes one: a mux client with stdin held open.
    const fwdPort = await freePort()
    const spec = `${fwdPort}:127.0.0.1:${port}`
    const client = spawn('ssh', [...sshArgs, '-o', `ControlPath=${socket}`, '-L', spec, '-N', '-o', 'ExitOnForwardFailure=yes', host], { stdio: ['pipe', 'ignore', 'ignore'] })
    recordForward(socket, spec)
    await until('the forward to listen', () => listening(fwdPort))
    client.kill('SIGTERM')
    await new Promise((r) => client.once('exit', r))
    // The master holds it, not the client that asked.
    expect(await listening(fwdPort)).toBe(true)

    // The credential stops being accepted: a fresh login now fails.
    fs.writeFileSync(path.join(dir, 'authorized_keys'), '')
    const fresh = await runSshBounded([...sshArgs, '-o', 'ControlPath=none', host, 'true'], { timeoutMs: 15_000 })
    expect(fresh.code).toBe(255)
    expect(fresh.stderr).toMatch(/Permission denied/)

    // The next server process: nothing in memory, the same path, the master usable.
    expect(await probeControlMaster(socket, sshArgs, host)).toBe('live')
    expect(await cancelRecordedForwards(socket, sshArgs, host)).toEqual([spec])
    await until('the stale forward to go', async () => !(await listening(fwdPort)))
    const through = await runSshBounded([...sshArgs, '-o', `ControlPath=${socket}`, host, 'echo', 'still-here'], { timeoutMs: 15_000 })
    expect(through.code).toBe(0)
    expect(through.stdout.trim()).toBe('still-here')

    await exitControlMaster(socket, sshArgs, host)
    expect(await probeControlMaster(socket, sshArgs, host)).toBe('absent')
  })
})
