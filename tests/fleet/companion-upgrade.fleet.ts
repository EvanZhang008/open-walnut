/**
 * The cloud companion while its Mac moves from a Node release to the compiled
 * walnut file, and back (tests/fleet/README.md, "Upgrades"). The companion stays on
 * the old release the whole time: nothing updates it but the Mac's companion-build
 * flow, so for a while (or for good) the two run different versions.
 *
 * Both are real servers of the given releases on this machine, each in a home of
 * its own: the companion is the old release in cloud mode (WALNUT_CLOUD_MODE=1,
 * paired as a box is: a phone device, the Mac's machine credential), the Mac a
 * non-ephemeral server whose own daemon dials the companion's /bridge. No
 * container: the companion's request path is the same code on Linux, and the
 * real one is never touched.
 *
 *   K1  old Mac, old companion: the companion hears the Mac, a phone call is answered
 *       by the Mac through the bridge
 *   K2  the Mac becomes the compiled file (its own daemon with it): the companion hears
 *       it again, a phone read and a phone write are the Mac's (the write lands once,
 *       on the Mac); the Mac's companion-build flow says what it does with the box
 *   K3  the compiled Mac sleeps (SIGSTOP of the server and its daemon): the companion
 *       answers by itself, and the Mac again once it wakes
 *   K4  rollback: the old Mac again, and the companion hears it and forwards to it
 *
 * Inputs: FLEET_OLD_MAC and FLEET_NEW_MAC, as for upgrade.fleet.ts.
 */
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { waitFor } from '../helpers/replica-cluster.js'
import { FAST_WINDOWS } from './fleet.js'
import { macDirs, saveMacLogs, startMac, type MacNode, type MacProgram } from './mac-node.js'
import { makeSshIdentity, type SshIdentity } from './ssh-identity.js'

const OLD = process.env.FLEET_OLD_MAC?.trim() || ''
const NEW = process.env.FLEET_NEW_MAC?.trim() || ''
const missing = !OLD || !fs.existsSync(OLD) ? 'FLEET_OLD_MAC (an old release\'s bin/walnut)' : !NEW || !fs.existsSync(NEW) ? 'FLEET_NEW_MAC (the compiled walnut file for this Mac)' : null
if (missing) process.stdout.write(`\n[fleet] companion upgrade SKIPPED: no ${missing}.\n\n`)

const sha256 = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const token = () => crypto.randomBytes(16).toString('hex')
// What the phone reads and writes across versions: USER.md through /api/v1/memory/user, which every
// release in the fleet serves (the heartbeat checklist it used before is gone from the new Walnut).
const MAC_PROFILE = '# About me (Mac)\n- the build is green\n'
const COMPANION_PROFILE = '# About me (companion)\n- an old copy\n'
const NEXT_PROFILE = '# About me (Mac)\n- written from the phone through an old companion\n'
const userMd = (data: string) => path.join(data, 'memory', 'USER.md')
const writeUserMd = (data: string, content: string) => { fs.mkdirSync(path.dirname(userMd(data)), { recursive: true }); fs.writeFileSync(userMd(data), content) }

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: os.tmpdir() }
  return env
}

describe.skipIf(!!missing)('the fleet: the companion stays old while its Mac moves to the compiled file', () => {
  let base = ''
  let ssh: SshIdentity
  let companion: MacNode
  let boxWatch: ReturnType<typeof setInterval> | undefined
  let boxStopping = false
  let reviving = false
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  /** Starts the box again when its server ended by itself (a restart into the Mac's build). */
  async function reviveBox(): Promise<void> {
    if (boxStopping || reviving || !companion || alive(companion.pid)) return
    reviving = true
    try {
      const last = companion.logLines(/restarting into the trial|SERVER EXIT/).slice(-2).map((l) => l.slice(0, 160)).join(' | ')
      note(`the box's server ended by itself (${last || 'no reason logged'}); starting it again as the old release on :${companion.port}`)
      companion = await startMac(path.join(base, 'box'), ssh, windows, {}, companionProgram)
    } catch (e) {
      note(`the box did not start again: ${String(e).slice(0, 300)}`)
    } finally {
      reviving = false
    }
  }
  let mac: MacNode
  const tokens = { phone: token(), local: token() }
  const notes: string[] = []
  const note = (line: string) => { notes.push(line); process.stdout.write(`[fleet] ${line}\n`) }
  // The Mac reports to the companion often (the e2e's heartbeat), and the companion's windows are short.
  const windows = { ...FAST_WINDOWS, WALNUT_LEADER_HEARTBEAT_MS: '500', WALNUT_LEADER_TICK_MS: '300' }
  const program = (command: string, label: string): MacProgram => ({ kind: 'release', label, command })
  const companionProgram: MacProgram = {
    kind: 'release', label: 'companion', command: OLD,
    // The box takes the Mac's builds (as setup.sh's launcher sets it), so the Mac's flow goes as far as it can.
    env: { WALNUT_CLOUD_MODE: '1', WALNUT_COMPANION_LAUNCHER: '1', WALNUT_COMPANION_MAC_BUILDS: '1' },
  }

  async function phone(p: string, init: RequestInit = {}) {
    const started = Date.now()
    const res = await fetch(`http://127.0.0.1:${companion.port}${p}`, {
      ...init, headers: { Authorization: `Bearer ${tokens.phone}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
    })
    return { status: res.status, by: res.headers.get('x-walnut-answered-by'), json: await res.json().catch(() => ({})) as Record<string, any>, ms: Date.now() - started }
  }
  const leader = async () => (await phone('/api/leader')).json
  const heard = () => waitFor(async () => { const v = await leader(); return v.primaryHeard === true ? v : null }, 240_000, 'the companion to hear the Mac', 1_000)
  const answeredByMac = () => waitFor(async () => { const r = await phone('/api/v1/usage/overview'); return r.by === 'primary' && r.status === 200 ? r : null }, 120_000, 'a phone call answered by the Mac', 1_000)
    .catch(async (e: Error) => { throw new Error(`${e.message}\n${await whyNotTheMac()}`) })
  /** What a failed wait for the Mac leaves to read: the companion's view, its reasons, both daemons. */
  async function whyNotTheMac(): Promise<string> {
    const lines: string[] = []
    try { lines.push(`companion's leader view: ${JSON.stringify(await leader())}`) } catch (e) { lines.push(`leader view: ${String(e)}`) }
    lines.push(...companion.logLines(/answers itself|bridge|primary|suspect/i).slice(-25).map((l) => `box: ${l.slice(0, 400)}`))
    lines.push(...mac.logLines(/daemon|bridge|mismatch|prewarm/i).slice(-40).map((l) => `mac: ${l.slice(0, 400)}`))
    try {
      const ps = execFileSync('ps', ['-eo', 'pid,ppid,command'], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n')
      lines.push(...ps.filter((l) => l.includes(base) || l.includes(NEW) || l.includes(OLD)).map((l) => `ps: ${l.slice(0, 300)}`))
    } catch { /* evidence only */ }
    return lines.join('\n')
  }
  /** The Mac's companion-build view once the flow settled (Retry, as the person presses it, then a look). */
  async function companionBuild(): Promise<Record<string, any>> {
    const retry = await mac.call('POST', '/api/cloud/companion-build/retry')
    note(`companion-build retry: ${retry.status}`)
    return waitFor(async () => {
      const v = (await mac.call('GET', '/api/cloud/companion-build')).json
      return v && v.state !== 'checking' && !(v.state === 'updating' && v.step === 'uploading' && !v.progress) ? v : null
    }, 180_000, 'the companion-build flow to settle', 1_000)
  }
  /** The Mac's own daemon: what its pid file names, and what that process runs. */
  function macDaemon(): string {
    const dir = macDirs(path.join(base, 'mac')).daemon
    const pid = Number(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim().split(/\s+/)[0])
    try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim() } catch { return '(gone)' }
  }

  beforeAll(async () => {
    base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wfc-'))
    // No host is reachable: the Mac's ssh is this run's, with no hosts in its config.
    ssh = makeSshIdentity(base)
    const box = macDirs(path.join(base, 'box'))
    fs.mkdirSync(box.data, { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.join(base, 'hub'), { recursive: true })
    const now = new Date().toISOString()
    fs.writeFileSync(path.join(box.data, 'auth.json'), JSON.stringify({ devices: [
      { name: 'phone', tokenHash: sha256(tokens.phone), createdAt: now },
      { name: 'bridge-local', tokenHash: sha256(tokens.local), createdAt: now, kind: 'machine' },
    ] }), { mode: 0o600 })
    writeUserMd(box.data, COMPANION_PROFILE)
    companionProgram.env!.WALNUT_GIT_HUB_DIR = path.join(base, 'hub')
    companion = await startMac(path.join(base, 'box'), ssh, windows, {}, companionProgram)
    note(`companion (old release, cloud mode) on :${companion.port}`)
    // Its own restart: companion-build's last step ends the box's server so its launcher starts the
    // build the Mac sent. A real box comes back under systemd (Restart=always, setup.sh) and its
    // launcher picks that build; here nothing would start it at all, so it starts again as the old
    // release on its port (the Mac's link names it), and the companion stays old as this file says.
    companionProgram.port = companion.port
    boxWatch = setInterval(() => { void reviveBox() }, 1_000)
    // The Mac's pairing, as `walnut cloud` leaves it: the `cloud` remote with the phone's token, the machine credential.
    const m = macDirs(path.join(base, 'mac'))
    fs.mkdirSync(m.data, { recursive: true, mode: 0o700 })
    execFileSync('git', ['init', '-q', m.data], { env: gitEnv() })
    execFileSync('git', ['-C', m.data, 'remote', 'add', 'cloud', `http://mac:${tokens.phone}@127.0.0.1:${companion.port}/git/data.git`], { env: gitEnv() })
    fs.mkdirSync(path.join(m.data, 'sync'), { recursive: true })
    fs.writeFileSync(path.join(m.data, 'sync', 'bridge-tokens.json'), JSON.stringify({ 'bridge-local': tokens.local }), { mode: 0o600 })
    writeUserMd(m.data, MAC_PROFILE)
    mac = await startMac(path.join(base, 'mac'), ssh, windows, {}, program(OLD, 'old'))
    note(`old Mac on :${mac.port}, its daemon: ${macDaemon().slice(0, 140)}`)
  }, 900_000)

  afterAll(async () => {
    process.stdout.write(`[fleet] notes:\n  ${notes.join('\n  ')}\n`)
    await mac?.stop()
    boxStopping = true
    if (boxWatch) clearInterval(boxWatch)
    await companion?.stop()
    if (base) { saveMacLogs(macDirs(path.join(base, 'mac')).daemon, `companion-${path.basename(base)}/mac`); saveMacLogs(macDirs(path.join(base, 'box')).daemon, `companion-${path.basename(base)}/box`) }
    if (base && !process.env.KEEP_FLEET) fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }, 180_000)

  it('K1: old Mac, old companion: the companion hears the Mac and forwards a phone call to it', async () => {
    await heard()
    await answeredByMac()
    const v = await companionBuild()
    note(`old Mac, companion-build: ${v.state} mine=${v.mine} theirs=${v.theirs} ${String(v.message ?? '').slice(0, 240)}`)
  }, 600_000)

  it('K2: the Mac becomes the compiled file: the bridge works across the two versions', async () => {
    await mac.stopServer()
    mac = await startMac(path.join(base, 'mac'), ssh, windows, {}, program(NEW, 'new'))
    note(`new Mac on :${mac.port}`)
    // Its own daemon is the compiled file's now (the bridge rides it).
    const daemon = await waitFor(() => { const c = macDaemon(); return c.includes(NEW) && c.includes('__daemon') ? c : null }, 120_000, 'the new Mac to run its own daemon', 1_000)
    note(`new Mac's daemon: ${daemon.slice(0, 160)}`)
    const view = await heard()
    note(`companion's view of the new Mac: ${JSON.stringify({ role: view.role, primaryHeard: view.primaryHeard, backupAllowed: view.backupAllowed })}`)
    await answeredByMac()
    const read = await phone('/api/v1/memory/user')
    expect(read).toMatchObject({ status: 200, by: 'primary' })
    expect(read.json.memory?.content).toBe(MAC_PROFILE)
    const w = await phone('/api/v1/memory/user', { method: 'PUT', body: JSON.stringify({ content: NEXT_PROFILE }) })
    expect(w).toMatchObject({ status: 200, by: 'primary' })
    expect(fs.readFileSync(userMd(mac.data), 'utf8')).toBe(NEXT_PROFILE)
    // The companion's own copy may follow later through the data hub; the write itself was the Mac's.
    note(`companion's copy of USER.md right after the write: ${JSON.stringify((fs.existsSync(userMd(companion.data)) ? fs.readFileSync(userMd(companion.data), 'utf8') : '(none)').slice(0, 80))}`)
    // A task the phone makes is the Mac's, made once.
    const made = await phone('/api/v1/tasks', { method: 'POST', body: JSON.stringify({ title: 'Made from the phone across versions' }) })
    expect(made).toMatchObject({ status: 201, by: 'primary' })
    const list = await mac.call('GET', '/api/tasks')
    expect((list.json?.tasks ?? []).filter((t: { title: string }) => t.title === 'Made from the phone across versions')).toHaveLength(1)
    // What the compiled Mac does about the companion's build.
    const v = await companionBuild()
    note(`compiled Mac, companion-build: ${v.state} mine=${v.mine} theirs=${v.theirs} ${String(v.message ?? '').slice(0, 300)}`)
  }, 900_000)

  it('K3: the compiled Mac sleeps: the companion answers by itself, then the Mac again', async () => {
    mac.sleep({ ssh: false })
    try {
      const first = await phone('/api/v1/memory/user')
      note(`Mac asleep: first call ${first.status} by ${first.by} in ${first.ms} ms`)
      expect(first).toMatchObject({ status: 200, by: 'companion' })
      const second = await phone('/api/v1/memory/user')
      expect(second).toMatchObject({ status: 200, by: 'companion' })
    } finally {
      mac.wake()
    }
    await answeredByMac()
  }, 300_000)

  it('K4: rollback: the old Mac again, and the companion hears it and forwards to it', async () => {
    await mac.stopServer()
    mac = await startMac(path.join(base, 'mac'), ssh, windows, {}, program(OLD, 'old'))
    await waitFor(() => !macDaemon().includes(NEW) ? true : null, 120_000, 'the old Mac to run its own daemon again', 1_000)
    note(`rolled-back Mac's daemon: ${macDaemon().slice(0, 160)}`)
    await heard()
    await answeredByMac()
    const r = await phone('/api/v1/memory/user')
    expect(r).toMatchObject({ status: 200, by: 'primary' })
    expect(r.json.memory?.content).toBe(NEXT_PROFILE)
  }, 600_000)
})
