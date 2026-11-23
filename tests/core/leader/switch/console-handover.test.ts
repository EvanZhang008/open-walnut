/**
 * The old leader's side of its machine's console (docs/reference/leader-switch.md, "The old
 * leader's console"): the handover mints the console device and writes the console file
 * (console-credential.ts); the standby of the handed-over home gives its port up to the replica
 * that holds that console (handed-over.ts); a switch's start waits for that replica to let the
 * port go (console-port.ts). auth.json in the mocked WALNUT_HOME, everything else in a temp folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../../helpers/mock-constants.js'

vi.mock('../../../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../../../src/constants.js'
import { setMachineIdHomeForTest } from '../../../../src/core/machine-id.js'
import { consoleDir, readConsoleFile, writeConsoleFile, writeHolder, clearHolder } from '../../../../src/core/handed-over-console.js'
import { consoleDeviceName, prepareConsoleForHandover } from '../../../../src/core/leader/switch/console-credential.js'
import { beforeHandover } from '../../../../src/core/leader/switch/before-handover.js'
import { ConsoleServedByReplica, handedOverAtBoot, serveHandedOver, yieldToConsoleAtStart, type StandbyListener } from '../../../../src/core/leader/switch/handed-over.js'
import { waitForConsolePort } from '../../../../src/core/leader/switch/console-port.js'
import { getInstanceId } from '../../../../src/core/device-store.js'
import { writeMarker } from '../../../../src/core/leader/switch/records.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')

let root: string
let standby: StandbyListener | null = null

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-handover-'))
  setMachineIdHomeForTest(root)
  fs.mkdirSync(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  await standby?.close()
  standby = null
  setMachineIdHomeForTest(null)
  fs.rmSync(path.join(WALNUT_HOME, 'local'), { recursive: true, force: true })
  fs.rmSync(root, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const port = (s.address() as net.AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

function devices(): Array<{ name: string; tokenHash: string }> {
  return (JSON.parse(fs.readFileSync(path.join(WALNUT_HOME, 'auth.json'), 'utf8')) as { devices: Array<{ name: string; tokenHash: string }> }).devices
}

describe('the console minted at the handover', () => {
  it('needs a switch under way to that machine (the marker)', async () => {
    const r = await prepareConsoleForHandover({ to: 'machine-b', machine: 'machine-a', home: WALNUT_HOME, address: { port: 4802, host: '127.0.0.1' } })
    expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/no switch to machine-b/) })
    writeMarker(WALNUT_HOME, { switchId: 'sw-1', to: 'machine-c', state: 'switching', at: 'x' })
    expect((await prepareConsoleForHandover({ to: 'machine-b', machine: 'machine-a', home: WALNUT_HOME, address: { port: 4802, host: '127.0.0.1' } })).ok).toBe(false)
    expect(fs.existsSync(consoleDir())).toBe(false)
  })

  it('writes the device into auth.json and its token only into the console file; a second handover replaces both', async () => {
    writeMarker(WALNUT_HOME, { switchId: 'sw-1', to: 'machine-b', state: 'switching', at: 'x' })
    const r = await beforeHandover({ to: 'machine-b', machine: 'machine-a', home: WALNUT_HOME, address: { port: 4802, host: '::' } })
    expect(r).toEqual({ ok: true })
    const id = await getInstanceId()
    const c = readConsoleFile(id)!
    expect(c).toMatchObject({ walnutId: id, home: path.resolve(WALNUT_HOME), port: 4802, host: '::', switchId: 'sw-1', to: 'machine-b', device: 'console-machine-a' })
    const first = devices().filter((d) => d.name === 'console-machine-a')
    expect(first).toHaveLength(1)
    expect(first[0]!.tokenHash).toBe(sha(c.token))
    // The plain token is nowhere in the home.
    expect(fs.readFileSync(path.join(WALNUT_HOME, 'auth.json'), 'utf8')).not.toContain(c.token)
    expect(c.home.startsWith(consoleDir())).toBe(false)

    await prepareConsoleForHandover({ to: 'machine-b', machine: 'machine-a', home: WALNUT_HOME, address: { port: 4802, host: '::' } })
    const again = readConsoleFile(id)!
    expect(again.token).not.toBe(c.token)
    const now = devices().filter((d) => d.name === 'console-machine-a')
    expect(now).toHaveLength(1)
    expect(now[0]!.tokenHash).toBe(sha(again.token))
    const revoked = (JSON.parse(fs.readFileSync(path.join(WALNUT_HOME, 'auth.json'), 'utf8')) as { revokedHashes?: string[] }).revokedHashes ?? []
    expect(revoked).toContain(sha(c.token))
  })

  it('refuses the handover when it cannot say where this server listens', async () => {
    writeMarker(WALNUT_HOME, { switchId: 'sw-1', to: 'machine-b', state: 'switching', at: 'x' })
    expect(await beforeHandover({ to: 'machine-b', machine: 'machine-a', home: WALNUT_HOME, address: null })).toMatchObject({ ok: false })
  })

  it('names the device after the machine, as a valid device name', () => {
    expect(consoleDeviceName('machine-a')).toBe('console-machine-a')
    expect(consoleDeviceName('0123456789abcdef0123456789abcdef')).toBe('console-0123456789abcdef0123456789abcdef')
    expect(consoleDeviceName('a b/c')).toMatch(/^console-[A-Za-z0-9_.-]+$/)
    expect(consoleDeviceName('x'.repeat(100)).length).toBeLessThanOrEqual(64)
  })
})

describe('the standby gives its port up to the console replica', () => {
  const WALNUT = 'd0d1d2d3d4d5d6d7d8d9dadbdcdddedf'
  let home: string
  let port: number

  beforeEach(async () => {
    home = path.join(root, 'home')
    fs.mkdirSync(home)
    writeMarker(home, { switchId: 'sw-1', to: 'machine-b', state: 'handed-over', at: 'x' })
    port = await freePort()
    writeConsoleFile({ v: 1, walnutId: WALNUT, home, port, host: '127.0.0.1', switchId: 'sw-1', to: 'machine-b', device: 'console-machine-a', token: 'e'.repeat(32), at: 'x' })
  })

  afterEach(() => { clearHolder(WALNUT, process.pid) })

  it('a running standby closes its listener once a live replica holds the console', async () => {
    const s = handedOverAtBoot({ home, env: { WALNUT_MACHINE_ID_FILE: path.join(root, 'id') } })!
    fs.writeFileSync(path.join(root, 'id'), 'machine-a\n')
    standby = await serveHandedOver(s, { port, host: '127.0.0.1', env: { WALNUT_MACHINE_ID_FILE: path.join(root, 'id') } })
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200)
    writeHolder(WALNUT, { pid: process.pid, state: 'waiting', port, host: '127.0.0.1', since: 'now' })
    const line = await standby.yielded
    expect(line).toMatch(new RegExp(`listening on http://localhost:${port}`))
    // The port is free for the replica.
    const s2 = net.createServer()
    await new Promise<void>((resolve, reject) => { s2.once('error', reject); s2.listen(port, '127.0.0.1', () => resolve()) })
    await new Promise<void>((r) => s2.close(() => r()))
  })

  it('a start finds the console served already: nothing listens, and it says where the console is', async () => {
    await expect(yieldToConsoleAtStart(home, 1_000)).resolves.toBeUndefined()
    const replica = http.createServer((_req, res) => res.end('ok'))
    await new Promise<void>((r) => replica.listen(port, '127.0.0.1', () => r()))
    try {
      writeHolder(WALNUT, { pid: process.pid, state: 'serving', port, host: '127.0.0.1', since: 'now' })
      const err = await yieldToConsoleAtStart(home, 1_000).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ConsoleServedByReplica)
      expect((err as ConsoleServedByReplica).line).toMatch(new RegExp(`listening on http://localhost:${port}.*replica of machine-b`))
    } finally {
      await new Promise<void>((r) => replica.close(() => r()))
    }
  })

  it('a start fails plainly when the replica holds the console and never answers', async () => {
    writeHolder(WALNUT, { pid: process.pid, state: 'waiting', port, host: '127.0.0.1', since: 'now' })
    const err = await yieldToConsoleAtStart(home, 800).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(ConsoleServedByReplica)
    expect(String(err)).toMatch(/does not answer on port/)
  })

  it('a switch start waits for the console replica to let the port go, bounded', async () => {
    expect(await waitForConsolePort(home, port, 500)).toEqual({ ok: true })
    writeHolder(WALNUT, { pid: process.pid, state: 'serving', port, host: '127.0.0.1', since: 'now' })
    const slow = await waitForConsolePort(home, port, 400)
    expect(slow).toMatchObject({ ok: false, why: expect.stringMatching(/still holds port/) })
    setTimeout(() => clearHolder(WALNUT, process.pid), 300)
    expect(await waitForConsolePort(home, port, 5_000)).toEqual({ ok: true })
    // Another port of the same machine is not this console's.
    writeHolder(WALNUT, { pid: process.pid, state: 'serving', port, host: '127.0.0.1', since: 'now' })
    expect(await waitForConsolePort(home, port + 1, 300)).toEqual({ ok: true })
  })
})
