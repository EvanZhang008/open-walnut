/**
 * A fleet whose Mac moves from a Node release to the compiled walnut file, and
 * back (tests/fleet/README.md, "Upgrades"). The hosts are set up by the old Mac
 * (its daemon, a live session with history), then the Mac's server is replaced on
 * the same data, the way an update replaces it: its own daemon and its ssh keep
 * running for the next server to find.
 *
 *   U1  the old Mac adds devbox and capbox, deploys its daemon to each, and a
 *       session on each runs two turns; devbox has its Walnut server switched on
 *   U2  the Mac becomes the compiled file: it reconnects, redeploys devbox's daemon
 *       (the version changed) as the host's walnut file (a sibling file of the Mac's
 *       own, in the daemon binary's slot) without ending the live CLI, the session's
 *       history is intact and the same CLI answers a further message, and devbox's
 *       Walnut server runs the same file, taken from the daemon's slot, not sent twice
 *   U3  capbox's link cuts large transfers from U2 on and then drops while its
 *       daemon's walnut file goes in chunks: the upload resumes from the chunks
 *       already there, the daemon is the Mac's file, its CLI lives on; its server,
 *       switched on then, runs that file with nothing sent
 *   U4  rollback: the old Mac again, on the same data: it reconnects, the daemon is
 *       its own again, the CLI lives on and answers, the tasks made meanwhile are there
 *   U5  forward again: the compiled file once more, its daemon from the file still in
 *       the slot, and devbox runs its server again, with nothing sent a second time
 *
 * Inputs (the test skips with a message without them):
 *   FLEET_OLD_MAC  the old release's `walnut` for this Mac (bin/walnut of a Node archive)
 *   FLEET_NEW_MAC  the compiled walnut file for this Mac, with `walnut-linux-<arch>`
 *                  of the same build-binary run beside it (a release's assets, gunzipped
 *                  and named like build-binary.mjs names them)
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { waitFor } from '../helpers/replica-cluster.js'
import { dockerArch, dockerUnavailable } from './docker.js'
import { HOST_HOME, startFleet, type Fleet } from './fleet.js'
import type { MacProgram } from './mac-node.js'
import { results, startHostSession, type HostSession } from './steps.js'

const OLD = process.env.FLEET_OLD_MAC?.trim() || ''
const NEW = process.env.FLEET_NEW_MAC?.trim() || ''
const unavailable = await dockerUnavailable()
const arch = unavailable ? 'arm64' : await dockerArch()
const linuxSibling = NEW ? path.join(path.dirname(NEW), `walnut-linux-${arch === 'arm64' ? 'arm64' : 'x64'}`) : ''
const missing = !OLD || !fs.existsSync(OLD) ? 'FLEET_OLD_MAC (an old release\'s bin/walnut)'
  : !NEW || !fs.existsSync(NEW) ? 'FLEET_NEW_MAC (the compiled walnut file for this Mac)'
    : !fs.existsSync(linuxSibling) ? `${linuxSibling} (the Linux file beside FLEET_NEW_MAC)` : null
const skip = unavailable ?? missing
if (skip) process.stdout.write(`\n[fleet] upgrade SKIPPED: ${unavailable ? `Docker is not available (${unavailable})` : `no ${missing}`}.\n\n`)

const OLD_MAC: MacProgram = { kind: 'release', label: 'old', command: OLD }
const NEW_MAC: MacProgram = { kind: 'release', label: 'new', command: NEW }
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
/** Large enough that the session link (the ControlMaster) lives on, small enough that a one-stream upload of the walnut file is cut. */
const CAP_BYTES = 24 * 1024 * 1024

interface Proc { pid: number; started: string; args: string }

/** `ps` rows on a host whose command line passes `keep` (pid, start time, command line). */
async function procs(f: Fleet, host: string, keep: (args: string) => boolean): Promise<Proc[]> {
  const out = await f.hostExec(host, 'ps -eo pid=,lstart=,args=')
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = /^(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/.exec(l)
    return m ? { pid: Number(m[1]), started: m[2]!, args: m[3]! } : null
  }).filter((p): p is Proc => !!p && keep(p.args))
}
/** The session's CLI processes on the host (the mock claude, one per running session). */
const cliOf = (f: Fleet, s: HostSession) => procs(f, s.host, (a) => a.includes('mock-claude') && a.includes(s.sid))
/** The host's session daemon: its process and the version it wrote at start. */
async function daemonOf(f: Fleet, host: string): Promise<{ proc: Proc | null; version: string }> {
  const [proc] = await procs(f, host, (a) => /\/tmp\/open-walnut\/(daemon-linux-\w+|daemon\.cjs)\b.*--start/.test(a))
  return { proc: proc ?? null, version: (await f.hostFile(host, '/tmp/open-walnut/daemon.version'))?.trim() ?? '' }
}
const same = (a: Proc[], b: Proc[]) => JSON.stringify(a.map((p) => [p.pid, p.started])) === JSON.stringify(b.map((p) => [p.pid, p.started]))

/** The Mac's view of a host's Walnut server (GET /api/host-servers). */
async function serverView(f: Fleet, host: string): Promise<Record<string, any> | null> {
  const r = await f.mac.call('GET', '/api/host-servers')
  return (r.json?.hosts as Array<{ hostKey: string; view: Record<string, any> | null }> | undefined)?.find((h) => h.hostKey === host)?.view ?? null
}
/** The host server process on a host: the program the daemon keeps running from ~/.open-walnut-host. */
const hostServerProcs = (f: Fleet, host: string) => procs(f, host, (a) => a.includes(`${HOST_HOME}/.open-walnut-host/app/`) && /( host-server| web --replica)/.test(a))

/** A message to the session; resolves once a turn's reply holds `echo: <text>`. */
async function say(f: Fleet, s: HostSession, text: string, timeoutMs = 120_000): Promise<void> {
  const sent = await f.mac.call('POST', `/api/v1/sessions/${s.sid}/messages`, { text })
  expect(sent.status, sent.text).toBe(202)
  await waitFor(async () => (await results(f, s, `echo: ${text}`)) > 0, timeoutMs, `${s.host}'s session to answer "${text}"`)
}
/** The Mac reads every one of `texts` back in the session's history (from the host, through its daemon). */
async function historyHolds(f: Fleet, s: HostSession, texts: string[]): Promise<void> {
  await waitFor(async () => {
    const h = await f.mac.call('GET', `/api/sessions/${s.sid}/history`)
    return h.status === 200 && texts.every((t) => h.text.includes(t))
  }, 90_000, `the Mac to read ${s.host}'s history back (${texts.join(', ')})`)
}
/** Adds `server: { enabled: true }` to a host in the Mac's config (as Settings > Hosts saves it). */
async function serverOn(f: Fleet, host: string): Promise<void> {
  const cur = await f.mac.call('GET', '/api/config')
  const hosts = cur.json?.config?.hosts ?? {}
  const put = await f.mac.call('PUT', '/api/config', { hosts: { ...hosts, [host]: { ...hosts[host], server: { ...(hosts[host]?.server ?? {}), enabled: true } } } })
  expect(put.status, put.text).toBe(200)
}

describe.skipIf(!!skip)('the fleet: the Mac moves from a Node release to the compiled file, and back', () => {
  let f: Fleet
  let dev: HostSession
  let cap: HostSession
  const notes: string[] = []
  const times: Record<string, number> = {}
  const t0 = () => { const start = Date.now(); return () => Date.now() - start }
  // capbox before the Mac moved (U2 takes it, U3 checks against it).
  let capBefore: { daemon: Awaited<ReturnType<typeof daemonOf>>; cli: Proc[] }
  // The Mac's log index when it moved: what the compiled Mac logged about a host is read from there.
  let logBefore = 0
  // capbox's link drop mid-upload (U2 starts it, U3 waits for it): the chunk it dropped at.
  let capDrop: Promise<number> = Promise.reject(new Error('U2 did not run'))
  capDrop.catch(() => undefined)
  const linesFor = (host: string) => (re: RegExp) => f.mac.logLines(/./).slice(logBefore).filter((l) => re.test(l) && l.includes(`"${host}"`))
  const devLines = linesFor('devbox')
  const capLines = linesFor('capbox')
  const linuxSha = fs.existsSync(linuxSibling) ? crypto.createHash('sha256').update(fs.readFileSync(linuxSibling)).digest('hex') : ''
  const sha256Of = (out: string) => out.trim()
  const note = (line: string) => { notes.push(line); process.stdout.write(`[fleet] ${line}\n`) }
  const version = async (p: string) => (await import('node:child_process')).execFileSync(p, ['--version'], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: f.base, OPEN_WALNUT_HOME: path.join(f.base, 'version-home'), WALNUT_RUNTIME_DIR: path.join(f.base, 'version-runtime') },
  }).split('\n')[0]!.trim()

  beforeAll(async () => {
    const took = t0()
    f = await startFleet({ hosts: ['devbox', 'capbox'], mac: OLD_MAC, hostMemory: '2g' })
    times.boot = took()
    note(`run ${f.run} at ${f.base}: old Mac (${await version(OLD)}) on :${f.mac.port}; new Mac file ${await version(NEW)}`)
  }, 900_000)

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && f) process.stdout.write(`[fleet] diagnostics for "${task.name}":\n${await f.diagnostics()}\n`)
  })
  afterAll(async () => {
    process.stdout.write(`[fleet] times (ms): ${JSON.stringify(times)}\n[fleet] notes:\n  ${notes.join('\n  ')}\n`)
    await f?.stop()
  }, 180_000)

  it('U1: the old Mac sets up two hosts, each with a live session and its history', async () => {
    const took = t0()
    await f.addHost('devbox', { server: { enabled: true } }, 300_000)
    await f.addHost('capbox', {}, 300_000)
    for (const h of ['devbox', 'capbox']) {
      const d = await daemonOf(f, h)
      expect(d.proc, `${h} runs no daemon`).toBeTruthy()
      note(`old Mac, ${h}: daemon ${d.version} as ${d.proc!.args.slice(0, 120)}`)
    }
    dev = await startHostSession(f, 'devbox', 'Fix the build on devbox', 'hello devbox')
    await say(f, dev, 'second turn on devbox')
    cap = await startHostSession(f, 'capbox', 'Watch the queue on capbox', 'hello capbox')
    await say(f, cap, 'second turn on capbox')
    await historyHolds(f, dev, ['echo: hello devbox', 'echo: second turn on devbox'])
    expect(await cliOf(f, dev)).toHaveLength(1)
    expect(await cliOf(f, cap)).toHaveLength(1)
    // What the old Mac made of devbox's server switch (its host server installs with npm on the host).
    await new Promise((r) => setTimeout(r, 5_000))
    const v = await serverView(f, 'devbox')
    note(`old Mac, devbox server: ${v?.phase} ${String(v?.message ?? '').slice(0, 300)}`)
    times.U1 = took()
  }, 600_000)

  it('U2: the Mac becomes the compiled file; devbox keeps its live CLI and runs the compiled walnut file as its daemon and its server', async () => {
    const took = t0()
    const before = { daemon: await daemonOf(f, 'devbox'), cli: await cliOf(f, dev) }
    capBefore = { daemon: await daemonOf(f, 'capbox'), cli: await cliOf(f, cap) }
    // capbox's link cuts large transfers from here on (U3 reads what that did to its daemon's upload).
    f.hosts.capbox!.proxy.capUpBytes(CAP_BYTES)
    logBefore = f.mac.logLines(/./).length
    await f.replaceMac(NEW_MAC)
    note(`new Mac on :${f.mac.port}`)
    // While U2 goes on: once capbox's daemon upload has some chunks on the host, the link drops
    // for 20 s (U3 reads what that did). It runs beside U2, since the upload does too.
    capDrop = (async () => {
      await waitFor(() => capLines(/chunked upload progress/).some((l) => (JSON.parse(l).chunk as number) >= 32), 1_200_000, 'capbox\'s daemon upload to go in chunks', 500)
      f.cutLink('capbox', 'drop')
      const at = Math.max(...capLines(/chunked upload progress/).map((l) => JSON.parse(l).chunk as number))
      await new Promise((r) => setTimeout(r, 20_000))
      f.healLink('capbox')
      return at
    })()
    capDrop.catch(() => undefined)
    // The Mac connects to its hosts again by itself (a host it had connected stays connected across a restart).
    const back = t0()
    await waitFor(() => f.hostConnected('devbox'), 600_000, 'the new Mac to connect to devbox', 1_000)
    times.reconnect = back()
    // The daemon is the new Mac's now: redeployed, since its version changed, and the walnut file
    // in the daemon binary's slot (no bun runs on the host).
    const after = await waitFor(async () => {
      const d = await daemonOf(f, 'devbox')
      return d.proc && d.version && d.version !== before.daemon.version ? d : null
    }, 180_000, 'devbox\'s daemon to be the new Mac\'s')
    note(`new Mac, devbox: daemon ${before.daemon.version} -> ${after.version} as ${after.proc!.args.slice(0, 120)}`)
    expect(after.proc!.pid).not.toBe(before.daemon.proc!.pid)
    expect(after.proc!.args).toMatch(/^\/tmp\/open-walnut\/daemon-linux-\w+ --start/)
    const daemonExe = (await f.hostExec('devbox', `readlink /proc/${after.proc!.pid}/exe`)).trim()
    expect(sha256Of(await f.hostExec('devbox', `sha256sum ${sq(daemonExe)} | cut -d' ' -f1`))).toBe(linuxSha)
    const deployed = devLines(/walnut file deployed|binary deployed|daemon source deployed|daemon start failed|could not be deployed/).map((l) => { const j = JSON.parse(l); return `${j.message}${j.how ? ` (${j.how})` : ''}` })
    note(`new Mac, devbox deploy: ${[...new Set(deployed)].join(' | ')}`)
    // The live CLI was not ended by the daemon's replacement: the same process, the same start.
    const cli = await cliOf(f, dev)
    expect(same(cli, before.cli), `CLI before ${JSON.stringify(before.cli)} after ${JSON.stringify(cli)}`).toBe(true)
    // Its history is intact, and the same process answers a further message.
    await historyHolds(f, dev, ['echo: hello devbox', 'echo: second turn on devbox'])
    await say(f, dev, 'after the upgrade')
    expect(same(await cliOf(f, dev), before.cli), 'a further message started another CLI').toBe(true)
    await historyHolds(f, dev, ['echo: hello devbox', 'echo: after the upgrade'])

    // devbox's Walnut server: the same compiled walnut file, taken from the daemon's slot (not sent twice).
    const ran = t0()
    const v = await waitFor(async () => {
      const x = await serverView(f, 'devbox')
      return x?.phase === 'running' ? x : null
    }, 600_000, 'devbox\'s server to run', 2_000).catch(async (err) => { throw new Error(`${(err as Error).message}; view ${JSON.stringify(await serverView(f, 'devbox'))}`) })
    times.hostServer = ran()
    note(`new Mac, devbox server: ${v.phase} build ${v.build} program ${v.program} version ${v.server?.version} ${v.server?.commit}`)
    const [server] = await hostServerProcs(f, 'devbox')
    expect(server, 'no host server process on devbox').toBeTruthy()
    const exe = (await f.hostExec('devbox', `readlink /proc/${server!.pid}/exe`)).trim()
    note(`devbox host server: pid ${server!.pid} exe ${exe} args ${server!.args.slice(0, 160)}`)
    expect(exe).toMatch(new RegExp(`^${HOST_HOME}/\\.open-walnut-host/app/[^/]+/walnut$`))
    // The file installed is the Linux sibling of the Mac's own file, byte for byte.
    expect(sha256Of(await f.hostExec('devbox', `sha256sum ${sq(exe)} | cut -d' ' -f1`))).toBe(linuxSha)
    const seeded = devLines(/host server file taken from the daemon slot/)
    const uploads = devLines(/chunked upload progress|single-stream upload failed/)
    note(`devbox: server file seeded from the daemon slot ${seeded.length}x; chunked or failed uploads ${uploads.length}`)
    expect(seeded.length, 'the server file was sent again instead of taken from the daemon slot').toBeGreaterThan(0)
    times.U2 = took()
  }, 1_500_000)

  it('U3: capbox\'s daemon through a link that cuts large transfers and then drops mid-upload: the upload resumes, the CLI survives, and its server takes the file from the slot', async () => {
    const took = t0()
    const proxy = f.hosts.capbox!.proxy
    // The chunks went (the one-stream upload was cut at the cap), and the link dropped for 20 s
    // once some of them were on the host (started in U2).
    note(`capbox: link dropped at chunk ${await capDrop}`)
    await waitFor(() => f.hostConnected('capbox'), 1_200_000, 'the new Mac to connect to capbox', 2_000)
    const after = await waitFor(async () => {
      const d = await daemonOf(f, 'capbox')
      return d.proc && d.version && d.version !== capBefore.daemon.version ? d : null
    }, 180_000, 'capbox\'s daemon to be the new Mac\'s')
    proxy.capUpBytes(null)
    expect(after.proc!.args).toMatch(/^\/tmp\/open-walnut\/daemon-linux-\w+ --start/)
    // Two ways through a drop, both without sending the chunks already there again: the
    // chunk the drop hit is retried in place (the upload call lives on), or the call fails
    // and the next one resumes from the chunks on the host.
    const joined = capLines(/chunked upload joined/).map((l) => JSON.parse(l))
    const retried = capLines(/chunk transfer killed by proxy, retrying/).length
    const resumedCall = capLines(/resuming a chunked upload/).length > 0 && joined.some((j) => j.keptFromEarlier > 0)
    const progress = capLines(/chunked upload progress/).map((l) => JSON.parse(l).chunk as number)
    const restarted = progress.some((c, i) => i > 0 && c < progress[i - 1]!)
    note(`capbox: connections cut ${proxy.capped()}; ${retried} chunk retries, resumed call ${resumedCall}, progress ${progress.join(',')}, joined ${JSON.stringify(joined)}`)
    expect(retried > 0 || resumedCall, 'the drop never touched the upload').toBe(true)
    expect(restarted && !resumedCall, 'the upload started over from its first chunk').toBe(false)
    expect(joined.some((j) => j.shaChecked === true), 'the joined file was not checked by sha256').toBe(true)
    const daemonExe = (await f.hostExec('capbox', `readlink /proc/${after.proc!.pid}/exe`)).trim()
    expect(sha256Of(await f.hostExec('capbox', `sha256sum ${sq(daemonExe)} | cut -d' ' -f1`))).toBe(linuxSha)
    // No partial upload is left behind on the host.
    expect((await f.hostExec('capbox', 'ls -a /tmp/open-walnut')).split('\n').filter((n) => /chunks-|\.part$|\.gz$/.test(n))).toEqual([])
    // The live CLI lived through all of it, and answers.
    expect(same(await cliOf(f, cap), capBefore.cli), 'capbox\'s CLI did not survive the upgrade').toBe(true)
    await say(f, cap, 'capbox after the cut upload')
    expect(same(await cliOf(f, cap), capBefore.cli)).toBe(true)

    // Its Walnut server: switched on now, it runs the file the slot holds, with nothing sent.
    const sinceServer = f.mac.logLines(/./).length
    await serverOn(f, 'capbox')
    const v = await waitFor(async () => {
      const x = await serverView(f, 'capbox')
      return x?.phase === 'running' ? x : null
    }, 600_000, 'capbox\'s server to run', 2_000).catch(async (err) => { throw new Error(`${(err as Error).message}; view ${JSON.stringify(await serverView(f, 'capbox'))}`) })
    const later = f.mac.logLines(/./).slice(sinceServer).filter((l) => l.includes('"capbox"'))
    note(`capbox server: ${v.phase} build ${v.build}; after switching it on: ${[...new Set(later.filter((l) => /taken from the daemon slot|chunked upload progress|single-stream upload failed|upload skipped/.test(l)).map((l) => JSON.parse(l).message as string))].join(' | ')}`)
    expect(later.some((l) => /host server file taken from the daemon slot/.test(l))).toBe(true)
    expect(later.filter((l) => /chunked upload progress|single-stream upload failed/.test(l))).toEqual([])
    const [server] = await hostServerProcs(f, 'capbox')
    expect(server).toBeTruthy()
    const exe = (await f.hostExec('capbox', `readlink /proc/${server!.pid}/exe`)).trim()
    expect(sha256Of(await f.hostExec('capbox', `sha256sum ${sq(exe)} | cut -d' ' -f1`))).toBe(linuxSha)
    expect((await f.hostExec('capbox', `ls -a ${HOST_HOME}/.open-walnut-host/incoming 2>/dev/null || true`)).split('\n').filter((n) => /chunk|\.part|\.seed/.test(n))).toEqual([])
    times.U3 = took()
  }, 2_400_000)

  it('U4: rollback to the old Mac on the same data: the hosts and the sessions still work', async () => {
    const took = t0()
    const made = await f.mac.call('POST', '/api/tasks', { title: 'Made while the Mac ran the compiled file', project: 'Acme' })
    expect(made.status, made.text).toBe(201)
    const before = { daemon: await daemonOf(f, 'devbox'), cli: await cliOf(f, dev), server: await hostServerProcs(f, 'devbox'), capCli: await cliOf(f, cap) }
    await f.replaceMac(OLD_MAC)
    await waitFor(() => f.hostConnected('devbox'), 300_000, 'the old Mac to connect to devbox again', 1_000)
    // The old Mac's own daemon again (its version differs from the walnut file's), in place of the file's.
    const after = await waitFor(async () => {
      const d = await daemonOf(f, 'devbox')
      return d.proc && d.version && d.version !== before.daemon.version ? d : null
    }, 180_000, 'devbox\'s daemon to be the old Mac\'s again')
    note(`rollback, devbox: daemon ${before.daemon.version} -> ${after.version} as ${after.proc!.args.slice(0, 100)}`)
    expect(after.proc!.pid).not.toBe(before.daemon.proc!.pid)
    expect(await procs(f, 'devbox', (a) => /daemon-linux-\w+ --start/.test(a)), 'the walnut file\'s daemon still runs beside the old one').toEqual([])
    expect(same(await cliOf(f, dev), before.cli), 'the rollback ended the live CLI').toBe(true)
    await historyHolds(f, dev, ['echo: hello devbox', 'echo: after the upgrade'])
    await say(f, dev, 'after the rollback')
    expect(same(await cliOf(f, dev), before.cli)).toBe(true)
    await waitFor(() => f.hostConnected('capbox'), 300_000, 'the old Mac to connect to capbox again', 1_000)
    await say(f, cap, 'capbox after the rollback')
    expect(same(await cliOf(f, cap), before.capCli), 'the rollback ended capbox\'s CLI').toBe(true)
    // The task made under the compiled file is the old Mac's too.
    const tasks = await f.mac.call('GET', `/api/tasks/${made.json.task.id}`)
    expect(tasks.status, tasks.text).toBe(200)
    // What the old Mac does with the server the compiled file left on devbox (read for the report).
    await new Promise((r) => setTimeout(r, 15_000))
    const v = await serverView(f, 'devbox')
    const nowServer = await hostServerProcs(f, 'devbox')
    note(`rollback, devbox server: ${v?.phase} ${String(v?.message ?? '').slice(0, 300)}; process before ${before.server.map((p) => p.pid)} now ${nowServer.map((p) => `${p.pid} ${p.args.slice(0, 100)}`)}`)
    times.U4 = took()
  }, 900_000)

  it('U5: forward again: the compiled file reconnects, the CLI lives on, and nothing is sent to devbox again', async () => {
    const took = t0()
    const before = { cli: await cliOf(f, dev) }
    const from = f.mac.logLines(/./).length
    await f.replaceMac(NEW_MAC)
    await waitFor(() => f.hostConnected('devbox'), 300_000, 'the new Mac to connect to devbox again', 1_000)
    const d = await waitFor(async () => {
      const x = await daemonOf(f, 'devbox')
      return x.proc && /daemon-linux-/.test(x.proc.args) ? x : null
    }, 180_000, 'devbox\'s daemon to be the walnut file again')
    note(`forward again, devbox: daemon ${d.version} as ${d.proc!.args.slice(0, 100)}`)
    await say(f, dev, 'forward again')
    expect(same(await cliOf(f, dev), before.cli), 'moving forward again ended the live CLI').toBe(true)
    const v = await waitFor(async () => {
      const x = await serverView(f, 'devbox')
      return x?.phase === 'running' ? x : null
    }, 600_000, 'devbox\'s server to run again', 2_000)
    const since = f.mac.logLines(/./).slice(from).filter((l) => l.includes('"devbox"'))
    const sent = since.filter((l) => /single-stream upload|chunked upload progress|upload skipped|walnut file deployed|daemon source deployed|taken from the daemon slot/.test(l)).map((l) => { const j = JSON.parse(l); return `${j.message}${j.how ? ` (${j.how})` : ''}` })
    note(`forward again, devbox server: ${v.phase} build ${v.build}; what went to devbox: ${[...new Set(sent)].join(' | ') || 'nothing'}`)
    expect(since.filter((l) => /chunked upload progress|single-stream upload failed/.test(l))).toEqual([])
    expect(since.filter((l) => /walnut file deployed as the daemon/.test(l) && JSON.parse(l).how === 'uploaded')).toEqual([])
    times.U5 = took()
  }, 900_000)
})
