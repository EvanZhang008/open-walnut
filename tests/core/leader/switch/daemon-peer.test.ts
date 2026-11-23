/**
 * The copy link of kind `daemon` (peer.ts DaemonPeer): what the old leader's server asks of the new
 * leader's machine over its link to that machine's daemon, with only existing capability-gated
 * commands. Against a fake link: the hello's missing capabilities are named, the files are atomic
 * writes under <standby_dir>/switch/, a read of a file not there is "none", a job start sent again is
 * taken as started, a dropped link is dialled again. Against a REAL daemon (the standalone twin): the
 * ticket's round trip, a batch of a real home through the real `walnut standby receive`, and the
 * target job started detached there with the other machine's home in its environment.
 *
 * MACHINE SAFETY: temp dirs only; the daemon is SIGKILLed at the end; no network beyond loopback.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DAEMON_PEER_CAPABILITIES, DaemonPeer, peerFor, targetJobId } from '../../../../src/core/leader/switch/peer.js'
import { RemoteStandbyTarget, type DaemonLink } from '../../../../src/core/standby/remote-transport.js'
import { markLinkFailure } from '../../../../src/providers/link-failure.js'
import { finalMarkName, readSwitchFile, ticketName } from '../../../../src/core/leader/switch/ticket.js'
import { standbyStatus } from '../../../../src/core/standby/index.js'
import { testBun } from '../../../helpers/bun-runtime.js'
import { bootStandbyTwin, type StandbyTwin } from '../../standby/twin-link.js'

const BUN = testBun()
const ROOT = path.resolve(__dirname, '../../../..')
const CLI = [BUN ?? 'bun', path.join(ROOT, 'src/cli.ts')]

const tmp: string[] = []
let twin: StandbyTwin | null = null
afterEach(async () => {
  await twin?.stop()
  twin = null
  for (const d of tmp.splice(0)) {
    const open = (p: string) => { try { fs.chmodSync(p, 0o700); for (const e of fs.readdirSync(p, { withFileTypes: true })) if (e.isDirectory()) open(path.join(p, e.name)) } catch { /* gone */ } }
    open(d)
    fs.rmSync(d, { recursive: true, force: true })
  }
})
const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-peer-')); tmp.push(d); return d }

const machine = (root: string) => ({ id: 'machine-b', home: path.join(root, 'b', 'home'), standbyDir: path.join(root, 'b', 'standby'), port: 1, env: { HOME: path.join(root, 'b') }, hostKey: 'dev-b' })

/** A fake daemon link: records every command, answers from `answer`. */
function fakeLink(caps: readonly string[], answer: (cmd: string, p: Record<string, unknown>) => Record<string, unknown> | Error): DaemonLink & { sent: Array<{ cmd: string; p: Record<string, unknown> }> } {
  const sent: Array<{ cmd: string; p: Record<string, unknown> }> = []
  return {
    sent,
    hasCapability: (n) => caps.includes(n),
    async send(cmd, p = {}) {
      sent.push({ cmd, p })
      const a = answer(cmd, p)
      if (a instanceof Error) throw a
      return a
    },
  }
}

function peerOver(link: () => Promise<DaemonLink>, root: string): DaemonPeer {
  const m = machine(root)
  const target = new RemoteStandbyTarget({ connect: link, dir: m.standbyDir, spoolDir: path.join(root, 'spool') })
  return new DaemonPeer(m, m.standbyDir, { host: 'dev-b', connect: link, home: path.join(root, 'a'), walnut: ['/opt/walnut'], linkWaitMs: 5_000, target })
}

describe('the copy link over a daemon, against a fake link', () => {
  it('names every capability the daemon\'s hello lacks, and is ready with all of them', async () => {
    const root = dir()
    const some = fakeLink(['fs-write-part-v1', 'host-exec-v1'], () => ({ ok: true }))
    const r = await peerOver(async () => some, root).ready()
    expect(r).toMatch(/lacks host-script-v1, host-exec-group-v1, host-exec-detach-v1, fs-write-atomic-v1/)
    expect(await peerOver(async () => fakeLink(DAEMON_PEER_CAPABILITIES, () => ({ ok: true })), root).ready()).toBeNull()
    expect(await peerOver(async () => { throw new Error('no route') }, root).ready()).toMatch(/does not answer: no route/)
  })

  it('writes a switch file atomically under the standby folder there, and reads one back (none: null)', async () => {
    const root = dir()
    const files = new Map<string, string>()
    const link = fakeLink(DAEMON_PEER_CAPABILITIES, (cmd, p) => {
      if (cmd === 'fs.write') { files.set(String(p.path), Buffer.from(String(p.data), 'base64').toString('utf8')); return { ok: true, written: true } }
      if (cmd === 'fs.read') return files.has(String(p.path)) ? { ok: true, data: files.get(String(p.path)), encoding: 'utf-8' } : { ok: false, error: 'fs.read failed: no such file (ENOENT)' }
      return { ok: false, error: 'unknown' }
    })
    const peer = peerOver(async () => link, root)
    await peer.writeFile(ticketName('S1'), { v: 1, switchId: 'S1' })
    const w = link.sent.find((x) => x.cmd === 'fs.write')!
    expect(w.p).toMatchObject({ path: path.join(machine(root).standbyDir, 'switch', 'S1.json'), atomic: true, encoding: 'base64' })
    expect(await peer.readFile(ticketName('S1'))).toEqual({ v: 1, switchId: 'S1' })
    expect(await peer.readFile(finalMarkName('S1'))).toBeNull()
    // A cleared check report reads as none.
    await peer.writeFile('S1.check.json', null)
    expect(await peer.readFile('S1.check.json')).toBeNull()
  })

  it('starts the target job detached, with the other machine\'s env and home in front, once (a start sent again is taken)', async () => {
    const root = dir()
    let n = 0
    const link = fakeLink(DAEMON_PEER_CAPABILITIES, (cmd) => (cmd === 'exec.run' ? (n++ === 0 ? { ok: true, jobId: 'x' } : { ok: false, code: 'job_exists', error: 'job exists' }) : { ok: true }))
    const peer = peerOver(async () => link, root)
    expect(await peer.startTargetJob('20261123T010203-abc123', { check: false })).toEqual({ ok: true })
    expect(await peer.startTargetJob('20261123T010203-abc123', { check: false })).toEqual({ ok: true })
    const run = link.sent.find((x) => x.cmd === 'exec.run')!.p
    expect(run).toMatchObject({ jobId: 'hx-leader-switch-20261123T010203-abc123', background: true, endGroup: true, detach: true, caller: { task: 'leader-switch' } })
    const m = machine(root)
    expect(run.argv).toEqual(['env', `HOME=${m.env.HOME}`, `OPEN_WALNUT_HOME=${m.home}`, '/opt/walnut', 'leader', 'switch', '--job', 'target', '--switch', '20261123T010203-abc123', '--standby-dir', m.standbyDir])
    // A check gets an id of its own each time (a check asked again runs again).
    expect(targetJobId('S', true)).toMatch(/^hx-leader-switch-S-check-[0-9a-f]{6}$/)
    expect(targetJobId('S', true)).not.toBe(targetJobId('S', true))
    const refused = fakeLink(DAEMON_PEER_CAPABILITIES, () => ({ ok: false, code: 'bad_cwd', error: 'no such dir' }))
    expect(await peerOver(async () => refused, root).startTargetJob('S2', { check: true })).toEqual({ ok: false, why: expect.stringMatching(/exec.run on dev-b: no such dir/) })
  })

  it('dials again when the link drops under a command, and stops once closed', async () => {
    const root = dir()
    let dials = 0
    const good = fakeLink(DAEMON_PEER_CAPABILITIES, () => ({ ok: true }))
    const peer = peerOver(async () => {
      dials++
      if (dials === 1) return { hasCapability: () => true, send: async () => { throw markLinkFailure(new Error('socket closed'), 'lost') } }
      return good
    }, root)
    await peer.writeFile('S3.final.json', { v: 1 })
    expect(dials).toBe(2)
    expect(good.sent.map((x) => x.cmd)).toEqual(['fs.write'])
    peer.close()
    await expect(peer.writeFile('S3.final.json', { v: 1 })).rejects.toThrow(/closed/)
  })
})

describe.skipIf(!BUN)('the copy link over a REAL daemon (the standalone twin)', () => {
  it('carries a batch, the ticket and its read back, and starts the target job there with the other machine\'s home', async () => {
    const root = dir()
    twin = await bootStandbyTwin(path.join(root, 'twin'), BUN!)
    const m = machine(root)
    fs.mkdirSync(m.standbyDir, { recursive: true })
    const home = path.join(root, 'a')
    fs.mkdirSync(path.join(home, 'tasks'), { recursive: true })
    fs.writeFileSync(path.join(home, 'config.yaml'), 'experimental:\n  switchable_leader: true\n')
    fs.writeFileSync(path.join(home, 'tasks', 'note.md'), '# hello from A\n')
    const t = twin
    const peer = await peerFor({ to: m, standby: { dir: m.standbyDir, host: 'dev-b', walnut: CLI }, home, connect: async () => t.connect(), linkWaitMs: 30_000 })
    if ('refused' in peer) throw new Error(peer.refused)
    expect(peer.kind).toBe('daemon')
    expect(await peer.ready()).toBeNull()
    const b = await peer.batch(home)
    expect(b.ok, b.ok ? '' : b.reason).toBe(true)
    expect(fs.readFileSync(path.join(m.standbyDir, 'copy', 'tasks', 'note.md'), 'utf8')).toBe('# hello from A\n')
    expect((await standbyStatus(m.standbyDir)).batch).toBe(1)
    expect(await peer.verify()).toEqual({ drift: 0 })
    await peer.writeFile(ticketName('S9'), { v: 1, switchId: 'S9' })
    expect(readSwitchFile(m.standbyDir, ticketName('S9'))).toEqual({ v: 1, switchId: 'S9' })
    expect(fs.statSync(path.join(m.standbyDir, 'switch', 'S9.json')).isFile()).toBe(true)
    expect(await peer.readFile(ticketName('S9'))).toEqual({ v: 1, switchId: 'S9' })
    expect(await peer.readFile(finalMarkName('S9'))).toBeNull()
    peer.close()
    // The job: a stand-in program that records what it was run with (the real one is the rehearsal's).
    const out = path.join(root, 'job.out')
    const job = await peerFor({ to: m, standby: { dir: m.standbyDir, host: 'dev-b', walnut: ['/bin/sh', '-c', `printf '%s|%s' "$OPEN_WALNUT_HOME" "$*" > ${out}`, 'walnut'] }, home, connect: async () => t.connect() })
    if ('refused' in job) throw new Error(job.refused)
    expect(await job.startTargetJob('S9', { check: false })).toMatchObject({ ok: true })
    const deadline = Date.now() + 30_000
    while (!fs.existsSync(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
    expect(fs.readFileSync(out, 'utf8')).toBe(`${m.home}|leader switch --job target --switch S9 --standby-dir ${m.standbyDir}`)
    // Asked again (a resumed source job): the daemon knows the id, nothing runs twice.
    fs.rmSync(out)
    expect(await job.startTargetJob('S9', { check: false })).toEqual({ ok: true })
    await new Promise((r) => setTimeout(r, 1_500))
    expect(fs.existsSync(out)).toBe(false)
    job.close()
  }, 180_000)
})
