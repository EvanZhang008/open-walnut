/**
 * A host with nothing on it for Walnut (tests/fleet/README.md, "Upgrades"): no
 * Node, no bun, and no way to download one (no curl or wget), reached by a Mac that
 * runs the compiled walnut file. The Mac must bring everything the host runs:
 *
 *   B1  the compiled Mac adds the host: a session daemon starts there, and a
 *       session on the host answers
 *   B2  its Walnut server is switched on: the compiled walnut file runs there, its
 *       gz taken from the daemon's slot (one upload serves both)
 *   B3  a second bare host behind a link that cuts large transfers and then drops
 *       mid-upload until that deploy gives up: the next connect resumes the upload
 *       from the chunks on the host, and the host ends up with the Mac's file
 *   B4  the daemon is stopped (the stop the Mac runs before it replaces one) and its
 *       pid file left naming another live process, as after a container restart:
 *       the stop works without ps, the next start ignores that pid, the CLI lives on
 *   B5  the walnut file in the slot, run by hand exactly as the Mac runs it (the
 *       start command with its `nohup env ...`, then `--status` and `--stop`), over
 *       a dead daemon's files whose pid another process holds: the start waits for
 *       the new daemon's own files, `--status` answers for it, and `--stop` signals
 *       neither that process nor a pid file of -1 or garbage
 *
 * The hosts have no ps either (no procps, as on a slim image): nothing Walnut runs
 * there may need it, and no "ps: not found" may reach the daemon's logs.
 *
 * The host's `claude` is the fleet's mock, which itself needs a JavaScript runtime:
 * it gets the image's node under a name no PATH search finds, so nothing of
 * Walnut's can run on it.
 *
 * Input: FLEET_NEW_MAC, the compiled walnut file for this Mac with
 * `walnut-linux-<arch>` beside it (as for upgrade.fleet.ts).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { waitFor } from '../helpers/replica-cluster.js'
import { dockerArch, dockerUnavailable } from './docker.js'
import { HOST_HOME, startFleet, type Fleet } from './fleet.js'
import { results, startHostSession, type HostSession } from './steps.js'
import { buildDaemonStartCmd, buildDaemonStopCmd } from '../../src/providers/daemon-start-cmd.js'

const NEW = process.env.FLEET_NEW_MAC?.trim() || ''
const unavailable = await dockerUnavailable()
const arch = unavailable ? 'arm64' : await dockerArch()
const linuxSibling = NEW ? path.join(path.dirname(NEW), `walnut-linux-${arch === 'arm64' ? 'arm64' : 'x64'}`) : ''
const missing = !NEW || !fs.existsSync(NEW) ? 'FLEET_NEW_MAC (the compiled walnut file for this Mac)' : !fs.existsSync(linuxSibling) ? `${linuxSibling}` : null
const skip = unavailable ?? missing
if (skip) process.stdout.write(`\n[fleet] bare host SKIPPED: ${unavailable ? `Docker is not available (${unavailable})` : `no ${missing}`}.\n\n`)

const HOST = 'barebox'
/** A second bare host, behind a link that cuts large transfers and then drops mid-upload (B3). */
const CUT = 'cutbox'
const linuxSha = linuxSibling && fs.existsSync(linuxSibling) ? crypto.createHash('sha256').update(fs.readFileSync(linuxSibling)).digest('hex') : ''
/** The image's node, kept for the mock claude only, where nothing looks for a node. */
const HIDDEN_NODE = '/usr/local/lib/fleet/mock-runtime'
/** `<pid> <command line>` per process on the host, from /proc (the hosts have no ps). */
const PROCS = 'for d in /proc/[0-9]*; do c=$(tr "\\000" " " < "$d/cmdline" 2>/dev/null); [ -n "$c" ] && printf "%s %s\\n" "${d#/proc/}" "$c"; done; true'

describe.skipIf(!!skip)('the fleet: a compiled Mac and a host with no Node and no bun', () => {
  let f: Fleet
  const notes: string[] = []
  const note = (line: string) => { notes.push(line); process.stdout.write(`[fleet] ${line}\n`) }
  const procs = (host: string) => f.hostExec(host, PROCS)
  /** The daemon's start log on a host: no "ps: not found" may be in it (a host without procps). */
  const noPsNoise = async (host: string) => {
    const text = await f.hostExec(host, 'cat /tmp/open-walnut/daemon-start.log /tmp/open-walnut/*.log 2>/dev/null; true')
    expect(text.split('\n').filter((l) => /ps: (command )?not found|ps: No such file/.test(l))).toEqual([])
  }
  let session: HostSession

  beforeAll(async () => {
    f = await startFleet({ hosts: [HOST, CUT], mac: { kind: 'release', label: 'new', command: NEW }, hostMemory: '2g' })
    for (const h of [HOST, CUT]) {
      await f.hostExec(h, [
        `mv /usr/local/bin/node ${HIDDEN_NODE}`,
        `printf '#!/bin/sh\\nexec ${HIDDEN_NODE} /usr/local/lib/fleet/mock-claude.cjs "$@"\\n' > /usr/local/bin/claude`,
        'chmod 755 /usr/local/bin/claude',
        // No procps either, as on a slim image: nothing may need ps.
        'rm -f /usr/bin/ps /bin/ps',
      ].join(' && '), 30_000, 'root')
      // Nothing a login shell finds runs JavaScript, and there is no ps.
      expect((await f.hostExec(h, 'bash -lc "command -v node nodejs bun curl wget ps || true"')).trim()).toBe('')
    }
    note(`run ${f.run}: compiled Mac on :${f.mac.port}`)
  }, 900_000)

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && f) process.stdout.write(`[fleet] diagnostics for "${task.name}":\n${await f.diagnostics()}\n`)
  })
  afterAll(async () => {
    process.stdout.write(`[fleet] notes:\n  ${notes.join('\n  ')}\n`)
    await f?.stop()
  }, 180_000)

  it('B1: the compiled Mac starts a daemon on the bare host, and a session there answers', async () => {
    await f.addHost(HOST, {}, 600_000).catch(async (err) => {
      const said = f.mac.logLines(/DaemonConnection/).filter((l) => l.includes(`"${HOST}"`)).slice(-12).map((l) => { const j = JSON.parse(l); return `${j.message} ${String(j.error ?? '').slice(0, 300)}` })
      throw new Error(`${(err as Error).message}\n${said.join('\n')}`)
    })
    // The daemon is the host's walnut file, in the daemon binary's slot: the Linux sibling of the Mac's file.
    const ps = await procs(HOST)
    const daemonLine = ps.split('\n').map((l) => l.trim()).find((l) => /^\d+ \/tmp\/open-walnut\/daemon-linux-\w+ --start/.test(l))
    note(`barebox daemon: ${daemonLine}`)
    expect(daemonLine, ps).toBeTruthy()
    const exe = (await f.hostExec(HOST, `readlink /proc/${daemonLine!.split(' ')[0]}/exe`)).trim()
    expect((await f.hostExec(HOST, `sha256sum '${exe}' | cut -d' ' -f1`)).trim()).toBe(linuxSha)
    const said = f.mac.logLines(/walnut file deployed as the daemon|could not be deployed as the daemon/).filter((l) => l.includes(`"${HOST}"`)).map((l) => { const j = JSON.parse(l); return `${j.message} ${j.how ?? ''} ${j.deployMs ?? ''}ms` })
    note(`barebox deploy: ${said.join(' | ')}`)
    const s = await startHostSession(f, HOST, 'Work on the bare host', 'hello bare host')
    session = s
    await f.mac.call('POST', `/api/v1/sessions/${s.sid}/messages`, { text: 'a second turn on the bare host' })
    await waitFor(async () => (await results(f, s, 'echo: a second turn on the bare host')) > 0, 120_000, 'the bare host\'s session to answer again')
    await noPsNoise(HOST)
  }, 900_000)

  it('B2: its Walnut server runs the compiled walnut file', async () => {
    const cur = await f.mac.call('GET', '/api/config')
    const hosts = cur.json?.config?.hosts ?? {}
    const put = await f.mac.call('PUT', '/api/config', { hosts: { ...hosts, [HOST]: { ...hosts[HOST], server: { enabled: true } } } })
    expect(put.status, put.text).toBe(200)
    const v = await waitFor(async () => {
      const r = await f.mac.call('GET', '/api/host-servers')
      const x = (r.json?.hosts as Array<{ hostKey: string; view: Record<string, any> | null }>)?.find((h) => h.hostKey === HOST)?.view
      return x?.phase === 'running' ? x : null
    }, 900_000, 'the bare host\'s server to run', 2_000)
    note(`barebox server: ${v.phase} build ${v.build} program ${v.program}`)
    const ps = await procs(HOST)
    const line = ps.split('\n').find((l) => l.includes(`${HOST_HOME}/.open-walnut-host/app/`))
    expect(line).toBeTruthy()
    // One upload served both: the server's file came from the daemon's slot.
    expect(f.mac.logLines(/host server file taken from the daemon slot/).filter((l) => l.includes(`"${HOST}"`)).length).toBeGreaterThan(0)
    const df = await f.hostExec(HOST, `du -sh /tmp/open-walnut ${HOST_HOME}/.open-walnut ${HOST_HOME}/.open-walnut-host 2>/dev/null || true`)
    note(`barebox disk: ${df.replace(/\n/g, '; ')}`)
  }, 900_000)

  it('B3: a bare host whose link drops mid-upload until the deploy gives up: the next connect resumes the upload, and the host ends up right', async () => {
    const proxy = f.hosts[CUT]!.proxy
    // Cuts the one-stream upload (so the file goes in chunks); the session link lives on.
    proxy.capUpBytes(24 * 1024 * 1024)
    const from = f.mac.logLines(/./).length
    const lines = (re: RegExp) => f.mac.logLines(/./).slice(from).filter((l) => re.test(l) && l.includes(`"${CUT}"`))
    const added = f.addHost(CUT, {}, 2_400_000).then(() => 'connected', (err: Error) => `addHost: ${err.message.slice(0, 200)}`)
    await waitFor(() => lines(/chunked upload progress/).some((l) => (JSON.parse(l).chunk as number) >= 33), 900_000, `${CUT}'s upload to go in chunks`, 500)
    f.cutLink(CUT, 'drop')
    const at = Math.max(...lines(/chunked upload progress/).map((l) => JSON.parse(l).chunk as number))
    // Down until this attempt gives up: its chunk retries run out, or the connection is torn down.
    await waitFor(() => lines(/could not be deployed as the daemon/).length > 0, 1_200_000, `${CUT}'s first upload to give up`, 1_000)
    const gaveUp = lines(/could not be deployed as the daemon/).map((l) => String(JSON.parse(l).error ?? '').slice(0, 200))
    const retries = lines(/chunk transfer killed by proxy, retrying/).length
    f.healLink(CUT)
    note(`${CUT}: dropped at chunk ${at}, ${retries} chunk retries, then gave up: ${gaveUp[0]}`)
    // The Mac dials again by itself; a person would press Connect after a while.
    const auto = await waitFor(() => f.hostConnected(CUT), 240_000, `the Mac to connect to ${CUT} again`, 2_000).then(() => true, () => false)
    if (!auto) {
      const r = await f.mac.call('POST', `/api/hosts/${CUT}/connect`)
      note(`${CUT}: no connect by itself in 4 min (${await Promise.race([added, Promise.resolve('addHost still waiting')])}); Connect pressed: ${r.status}`)
      await waitFor(() => f.hostConnected(CUT), 1_200_000, `the Mac to connect to ${CUT} after Connect`, 2_000)
    }
    const resumed = lines(/resuming a chunked upload/).map((l) => JSON.parse(l))
    const joined = lines(/chunked upload joined/).map((l) => JSON.parse(l))
    note(`${CUT}: resumed ${JSON.stringify(resumed.map((r) => ({ onHost: r.onHost, totalChunks: r.totalChunks })))}; joined ${JSON.stringify(joined.map((j) => ({ sent: j.sent, kept: j.keptFromEarlier, failures: j.totalFailures, sha: j.shaChecked })))}`)
    expect(resumed.some((r) => r.onHost >= 32), 'the next upload did not resume from the chunks on the host').toBe(true)
    expect(joined.some((j) => j.keptFromEarlier >= 32 && j.shaChecked === true)).toBe(true)
    proxy.capUpBytes(null)
    // The host ended up right: the daemon is the Mac's Linux file, nothing of the upload is left.
    const ps = await procs(CUT)
    const daemonLine = ps.split('\n').map((l) => l.trim()).find((l) => /^\d+ \/tmp\/open-walnut\/daemon-linux-\w+ --start/.test(l))
    expect(daemonLine, ps).toBeTruthy()
    const exe = (await f.hostExec(CUT, `readlink /proc/${daemonLine!.split(' ')[0]}/exe`)).trim()
    expect((await f.hostExec(CUT, `sha256sum '${exe}' | cut -d' ' -f1`)).trim()).toBe(linuxSha)
    expect((await f.hostExec(CUT, 'ls -a /tmp/open-walnut')).split('\n').filter((n) => /chunks-|\.part$|\.gz$/.test(n))).toEqual([])
    const s = await startHostSession(f, CUT, 'Work on the cut host', 'hello cut host')
    expect(s.sid).toBeTruthy()
    await noPsNoise(CUT)
  }, 3_000_000)

  it('B4: the daemon is stopped and its pid file left naming another live process (a restarted container): it is stopped without ps, the next start ignores that pid, and the CLI lives on', async () => {
    const line = (await procs(HOST)).split('\n').find((l) => /^\d+ \/tmp\/open-walnut\/daemon-linux-\w+ --start/.test(l.trim()))
    expect(line).toBeTruthy()
    const oldDaemon = Number(line!.trim().split(' ')[0])
    const cliOf = async () => (await procs(HOST)).split('\n').filter((l) => l.includes('mock-claude') && l.includes(session.sid)).map((l) => l.trim().split(' ')[0]).sort()
    const cli = await cliOf()
    expect(cli.length).toBe(1)
    // The Mac must not restart the daemon before the stale files are in place.
    f.cutLink(HOST, 'drop')
    let other = ''
    try {
      // The stop the Mac runs before it replaces a daemon, here by hand: with no ps on the host.
      const stopped = await f.hostExec(HOST, buildDaemonStopCmd('/tmp/open-walnut'), 60_000)
      expect(stopped.split('\n')).toContain('walnut-daemon-stop-confirmed')
      expect((await procs(HOST)).split('\n').some((l) => l.trim().startsWith(`${oldDaemon} `))).toBe(false)
      expect(await cliOf()).toEqual(cli)
      // A process of the same user now has a pid the dead daemon's pid file names, and its port is dead.
      other = (await f.hostExec(HOST, 'nohup sleep 900 >/dev/null 2>&1 & echo $!')).trim()
      await f.hostExec(HOST, `printf %s ${other} > /tmp/open-walnut/daemon.pid && printf %s 1 > /tmp/open-walnut/daemon.port`)
    } finally {
      f.healLink(HOST)
    }
    const auto = await waitFor(async () => (await f.hostConnected(HOST)) && (await procs(HOST)).split('\n').some((l) => /^\d+ \/tmp\/open-walnut\/daemon-linux-\w+ --start/.test(l.trim())), 240_000, 'the Mac to start the daemon again', 2_000).then(() => true, () => false)
    if (!auto) {
      const r = await f.mac.call('POST', `/api/hosts/${HOST}/connect`)
      note(`${HOST}: not back by itself in 4 min; Connect pressed: ${r.status}`)
      await waitFor(() => f.hostConnected(HOST), 600_000, `the Mac to connect to ${HOST} after Connect`, 2_000)
    }
    const now = (await procs(HOST)).split('\n').find((l) => /^\d+ \/tmp\/open-walnut\/daemon-linux-\w+ --start/.test(l.trim()))
    note(`${HOST}: daemon ${oldDaemon} stopped, the pid file named ${other}; now ${now?.trim()}`)
    expect(now).toBeTruthy()
    const newDaemon = Number(now!.trim().split(' ')[0])
    expect(newDaemon).not.toBe(oldDaemon)
    expect(String(newDaemon)).not.toBe(other)
    expect((await f.hostExec(HOST, 'cat /tmp/open-walnut/daemon.pid')).trim()).toBe(String(newDaemon))
    // The process that held the pid was left alone, and the session's CLI is the same one.
    expect((await procs(HOST)).split('\n').some((l) => l.trim().startsWith(`${other} sleep`))).toBe(true)
    expect(await cliOf()).toEqual(cli)
    await f.mac.call('POST', `/api/v1/sessions/${session.sid}/messages`, { text: 'after the daemon came back' })
    await waitFor(async () => (await results(f, session, 'echo: after the daemon came back')) > 0, 180_000, 'the session to answer after the daemon came back')
    expect(await cliOf()).toEqual(cli)
    await noPsNoise(HOST)
    await f.hostExec(HOST, `kill ${other}`)
  }, 1_200_000)

  it('B5: the walnut file in the slot, started, checked and stopped the way the Mac does it, over a dead daemon\'s files whose pid another process holds', async () => {
    const slot = `/tmp/open-walnut/daemon-linux-${arch === 'arm64' ? 'arm64' : 'x64'}`
    const daemonPid = async () => Number((await f.hostExec(HOST, 'cat /tmp/open-walnut/daemon.pid')).trim())
    const cliOf = async () => (await procs(HOST)).split('\n').filter((l) => l.includes('mock-claude') && l.includes(session.sid)).map((l) => l.trim().split(' ')[0]).sort()
    const cli = await cliOf()
    expect(cli.length).toBe(1)
    // The environment an SSH session gets there (the fleet's daemon windows), then the command as given.
    const asSsh = (cmd: string, timeoutMs = 60_000) => f.hostExec(HOST, `export HOME='${HOST_HOME}'; set -a; . "$HOME/.ssh/environment"; set +a; cd "$HOME"; ${cmd}`, timeoutMs)
    f.cutLink(HOST, 'drop')
    let other = ''
    try {
      expect((await f.hostExec(HOST, buildDaemonStopCmd('/tmp/open-walnut'), 60_000)).split('\n')).toContain('walnut-daemon-stop-confirmed')
      other = (await f.hostExec(HOST, 'nohup sleep 900 >/dev/null 2>&1 & echo $!')).trim()
      await f.hostExec(HOST, `printf %s ${other} > /tmp/open-walnut/daemon.pid && printf %s 1 > /tmp/open-walnut/daemon.port`)
      // The file's own --stop: that pid is no daemon of this dir, so nothing is signalled.
      const refused = await asSsh(`${slot} --stop`)
      note(`${HOST}: --stop with daemon.pid naming ${other}: ${refused.trim()}`)
      expect(refused).toContain('which is not this daemon')
      expect((await procs(HOST)).split('\n').some((l) => l.trim().startsWith(`${other} sleep`))).toBe(true)
      // The start the Mac sends for the binary runtime, env prefix and all.
      const started = await asSsh(buildDaemonStartCmd({ runtime: 'binary', execPath: slot, env: { WALNUT_FLEET_PROBE: 'b5' }, dir: '/tmp/open-walnut' }), 120_000)
      note(`${HOST}: start over the stale files: ${started.trim().replace(/\n/g, ' | ')}`)
      const port = Number(started.trim().split('\n')[0])
      expect(port).toBeGreaterThan(1)
      expect(started).toContain('"running":true')
      const pid = await daemonPid()
      expect(String(pid)).not.toBe(other)
      expect((await f.hostExec(HOST, `tr '\\000' ' ' < /proc/${pid}/cmdline`)).trim()).toBe(`${slot} --start`)
      expect(await f.hostExec(HOST, `tr '\\000' '\\n' < /proc/${pid}/environ`)).toContain('WALNUT_FLEET_PROBE=b5')
      expect((await f.hostExec(HOST, 'cat /tmp/open-walnut/daemon.port')).trim()).toBe(String(port))
      // --status answers for that daemon: its pid, and the port it answers on.
      expect(JSON.parse((await asSsh(`${slot} --status`)).trim())).toMatchObject({ running: true, pid, port })
      // A pid file of -1 or garbage is never signalled (kill(-1) is every process of the user).
      for (const bad of ['-1', 'garbage']) {
        await f.hostExec(HOST, `printf %s '${bad}' > /tmp/open-walnut/daemon.pid`)
        expect(await asSsh(`${slot} --stop`)).toContain('daemon not running')
        expect(JSON.parse((await asSsh(`${slot} --status`)).trim())).toEqual({ running: false })
      }
      await f.hostExec(HOST, `printf %s ${pid} > /tmp/open-walnut/daemon.pid`)
      expect((await procs(HOST)).split('\n').some((l) => l.trim().startsWith(`${pid} `))).toBe(true)
      expect((await procs(HOST)).split('\n').some((l) => l.trim().startsWith(`${other} sleep`))).toBe(true)
      expect(await cliOf()).toEqual(cli)
    } finally {
      f.healLink(HOST)
    }
    // The Mac takes the daemon started by hand as its own (same build), and the session answers.
    const pid = await daemonPid()
    const auto = await waitFor(() => f.hostConnected(HOST), 240_000, `the Mac to reach ${HOST} again`, 2_000).then(() => true, () => false)
    if (!auto) {
      const r = await f.mac.call('POST', `/api/hosts/${HOST}/connect`)
      note(`${HOST}: not back by itself in 4 min; Connect pressed: ${r.status}`)
      await waitFor(() => f.hostConnected(HOST), 600_000, `the Mac to connect to ${HOST} after Connect`, 2_000)
    }
    expect(await daemonPid()).toBe(pid)
    await f.mac.call('POST', `/api/v1/sessions/${session.sid}/messages`, { text: 'after the hand-started daemon' })
    await waitFor(async () => (await results(f, session, 'echo: after the hand-started daemon')) > 0, 180_000, 'the session to answer on the hand-started daemon')
    expect(await cliOf()).toEqual(cli)
    await noPsNoise(HOST)
    await f.hostExec(HOST, `kill ${other}`)
  }, 1_200_000)
})
