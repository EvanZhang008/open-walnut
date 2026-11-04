/**
 * The host network update io (src/providers/daemon-net-update-io.ts) through the shared
 * update flow (daemon-service-update.ts), against a small stand-in for the host's daemon:
 * fs.writePart is the daemons' own transfer core on a temp dir, exec.run runs the line
 * with /bin/sh in a process group of its own and, like the daemon, signals that whole
 * group when the shell is gone and something still holds its pipes 2 s later (or always,
 * for the cases that prove the script outlives the group). The `walnut daemon update` it
 * reaches is a fake script.
 *
 * Proven here: the chunks land in order and the host checks each one; a chunk the host
 * finds corrupt is sent again, and one that never arrives whole fails the update before
 * the service is touched; the final update runs detached (it outlives the group signal),
 * is retried while the old daemon says it has active operations, and not for any other
 * refusal; a launch that could not detach stops the script before it changed anything;
 * what the login profile prints never reaches the answer; a script a later launch took
 * over stops before its next try; a hold before the launch is waited out; a compiled
 * server's walnut file goes up as its own gz, and one whose daemon version differs is
 * refused before the service is touched.
 *
 * MACHINE SAFETY: every file is under a temp dir or a /tmp/open-walnut-update.* dir this
 * file made and removes; the only processes are /bin/sh, the fake script and sleep; the
 * group signal goes only to the shell this test spawned (pid > 1 checked).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { spawn, spawnSync } from 'node:child_process'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createTransferCore, type TransferCoreDeps } from '../../src/providers/transfer-core.js'
import { createNetUpdateIo, launcherScript, runnerScript, RUNNER_PAUSE_SECONDS, RUNNER_TRIES, UPDATE_WAIT_MS, type NetUpdateConn, type NetUpdateIoOptions } from '../../src/providers/daemon-net-update-io.js'
import { UPDATE_BUSY_WAIT_MS } from '../../src/providers/daemon-service-cli.js'
import { updateRemoteDaemonService } from '../../src/providers/daemon-service-update.js'
import { permissionRisk } from '../../src/providers/host-exec-guards.js'
import { guardedPath } from '../setup/exec-guard.js'

const VERSION = 'walnut-daemon-288f4bee1ea6'
const STAGING = /\/tmp\/open-walnut-update\.[a-zA-Z0-9]+/
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-net-update-io-')))
const made = new Set<string>()
afterAll(() => {
  for (const dir of made) if (STAGING.test(dir)) fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(root, { recursive: true, force: true })
})

let work: string
let state: string
beforeEach(() => {
  work = fs.mkdtempSync(path.join(root, 'case-'))
  state = path.join(work, 'state')
  fs.mkdirSync(state)
})

/** The fake daemon file: its version, and `walnut daemon update` refusing `refusals` times first. */
function fakeDaemon(o: { refusals?: number; refusal?: string; supersede?: string; sleep?: number; version?: string; pad?: number } = {}): string {
  const file = path.join(work, 'daemon-src')
  const refusal = JSON.stringify({ ok: false, failure: { code: 'updateRefused', message: o.refusal ?? 'Daemon has active operations; retry after they finish' } })
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `s='${state}'`,
    `if [ "$1 $2" = "__daemon --version" ]; then echo ${o.version ?? VERSION}; exit 0; fi`,
    'if [ "$1 $2 $3" = "walnut daemon update" ]; then',
    '  n=$(cat "$s/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$s/count"',
    '  echo "update pgid=$(ps -o pgid= -p $$ | tr -d " ") args=$*" >> "$s/calls"',
    // A later launch (another server's) names itself the latest while this one is refused.
    ...(o.supersede ? [`  [ "$n" -eq 1 ] && printf '%s\\n' /tmp/open-walnut-update.Later1 > '${o.supersede}'`] : []),
    ...(o.sleep ? [`  sleep ${o.sleep}`] : []),
    `  if [ "$n" -le ${o.refusals ?? 0} ]; then printf '%s\\n' '${refusal}'; exit 1; fi`,
    `  printf '%s\\n' '{"ok":true,"status":{"scope":"user"}}'; exit 0`,
    'fi',
    'exit 2',
    // Bytes that do not compress, so the gz spans several chunks.
    ...(o.pad ? [`# ${crypto.randomBytes(o.pad).toString('base64')}`] : []),
    '',
  ].join('\n'), { mode: 0o755 })
  return file
}

interface Host extends NetUpdateConn { lines: string[]; writes: string[]; jobGroups: number[] }

/** The daemon's side of the three commands; `corrupt(path)` damages a write in transit. */
function miniHost(o: { path?: string; corrupt?: (p: string) => boolean; readFails?: () => boolean; signalGroup?: 'always' | 'drain'; noise?: string } = {}): Host {
  const env = { ...process.env, PATH: o.path ?? guardedPath() }
  const core = createTransferCore({ fs, path, crypto, spawn: spawn as unknown as TransferCoreDeps['spawn'], env, home: work })
  const host: Host = {
    lines: [], writes: [], jobGroups: [],
    async send(cmd, params = {}) {
      if (cmd === 'fs.writePart') {
        const p = String(params.path)
        host.writes.push(p)
        let data = String(params.data)
        if (o.corrupt?.(p)) { const b = Buffer.from(data, 'base64'); b[0] ^= 0xff; data = b.toString('base64') }
        try { return { ok: true, ...(await core.writePart({ ...params, data })) } } catch (e) { return { ok: false, error: (e as Error).message, code: (e as { code?: string }).code } }
      }
      if (cmd === 'fs.read') {
        if (o.readFails?.()) throw new Error('DaemonConnection not connected to studio-mac')
        try { return { ok: true, data: fs.readFileSync(String(params.path), 'utf8') } } catch (e) { return { ok: false, error: (e as Error).message } }
      }
      if (cmd === 'exec.run') {
        const argv = params.argv as string[] | undefined
        const line = argv ? argv[2] : String(params.command)
        host.lines.push(line)
        const child = argv ? spawn(argv[0], argv.slice(1), { env, cwd: '/', detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
          : spawn('/bin/sh', ['-c', line], { env, cwd: '/', detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
        // What a login profile prints lands in the same output, before the line runs.
        let output = o.noise ?? ''
        child.stdout!.on('data', (d) => { output += d })
        child.stderr!.on('data', (d) => { output += d })
        const signal = () => {
          if (typeof child.pid === 'number' && child.pid > 1) {
            host.jobGroups.push(child.pid)
            try { process.kill(-child.pid, 'SIGTERM') } catch { /* the group is gone */ }
          }
        }
        // Like the daemon (host-exec-core.ts EXIT_DRAIN_MS): pipes still held 2 s after the
        // shell exited get the group signalled and closed.
        let closed = false
        child.on('exit', () => { setTimeout(() => { if (!closed) { signal(); child.stdout!.destroy(); child.stderr!.destroy() } }, 2_000).unref() })
        const exitCode = await new Promise<number | null>((r) => child.on('close', (code) => { closed = true; r(code ?? child.exitCode) }))
        if (o.signalGroup === 'always') signal()
        for (const m of output.matchAll(new RegExp(STAGING.source, 'g'))) made.add(m[0])
        return { ok: true, exitCode, output, timedOut: false, killed: false, blocked: null }
      }
      return { ok: false, error: `unknown command: ${cmd}` }
    },
  }
  return host
}

/** Quick clocks, and the latest marker in this case's own dir. */
const fast = (over: NetUpdateIoOptions = {}): NetUpdateIoOptions => ({ pauseSeconds: 0.2, settleSeconds: 0, pollMs: 100, waitMs: 30_000, holdWaitMs: 0, latestMarker: path.join(work, 'latest'), ...over })
/** A process that still runs (a zombie nobody reaped yet counts as gone). */
function alive(pid: number): boolean {
  try { process.kill(pid, 0) } catch { return false }
  try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return true }
}
const calls = () => (fs.existsSync(path.join(state, 'calls')) ? fs.readFileSync(path.join(state, 'calls'), 'utf8').trim().split('\n') : [])

describe('the host network update io', () => {
  it('lands the chunks in order, checks them on the host, and runs the update detached', async () => {
    const binary = fakeDaemon()
    const host = miniHost({ signalGroup: 'always' })
    await updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast()), 'user')
    const chunks = host.writes.filter((p) => /\/chunk_\d{4}$/.test(p))
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks).toEqual([...chunks].sort())
    expect(host.writes.at(-1)).toMatch(/\/update\.sh$/)
    const [update] = calls()
    expect(update).toMatch(/--scope user --executable \/tmp\/open-walnut-update\.\w+\/daemon$/)
    // It ran outside every exec job's group, so the group signal did not reach it.
    const pgid = Number(/pgid=(\d+)/.exec(update)![1])
    expect(host.jobGroups).not.toContain(pgid)
    // The staging dir is gone afterwards.
    const dir = STAGING.exec(update)![0]
    expect(fs.existsSync(dir)).toBe(false)
    // No line it ran is one the macOS guard would refuse, and none carries the bytes.
    for (const line of host.lines) {
      expect(permissionRisk(line, '/', '/Users/someone')).toBeNull()
      expect(line.length).toBeLessThan(8 * 1024)
    }
  }, 60_000)

  it('sends a chunk the host found corrupt again, under a new name', async () => {
    const binary = fakeDaemon()
    let damaged = 0
    const host = miniHost({ corrupt: (p) => /chunk_0000$/.test(p) && damaged++ === 0 })
    await updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast()), 'user')
    expect(host.writes.filter((p) => /chunk_\d{4}$/.test(p)).slice(0, 2).map((p) => p.slice(-4))).toEqual(['0000', '0001'])
    expect(calls()).toHaveLength(1)
  }, 60_000)

  it('a chunk that never arrives whole fails the update before the service is touched', async () => {
    const binary = fakeDaemon()
    const host = miniHost({ corrupt: () => true })
    await expect(updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast()), 'user'))
      .rejects.toThrow('the installed service was not changed')
    expect(host.writes.filter((p) => /chunk_\d{4}$/.test(p))).toHaveLength(3)
    expect(calls()).toEqual([])
    expect(host.lines.some((l) => l.includes('daemon update') || l.includes('update.sh'))).toBe(false)
    for (const dir of made) expect(fs.existsSync(dir)).toBe(false)
  }, 60_000)

  it('asks again while the old daemon has active operations, and reads the answer after the link comes back', async () => {
    const binary = fakeDaemon({ refusals: 2 })
    // The old daemon exits during the handover: reads fail for a while.
    let reads = 0
    const host = miniHost({ readFails: () => { reads += 1; return reads >= 2 && reads <= 4 } })
    await updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast()), 'user')
    expect(calls()).toHaveLength(3)
    expect(reads).toBeGreaterThan(4)
  }, 60_000)

  it('does not ask again after any other refusal', async () => {
    const binary = fakeDaemon({ refusals: 5, refusal: 'Only a managed daemon can prepare a service update' })
    await expect(updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(miniHost(), fast()), 'user'))
      .rejects.toThrow('Only a managed daemon')
    expect(calls()).toHaveLength(1)
  }, 60_000)

  it('every try, each asking a busy daemon again for its own while, fits in the time the server waits', () => {
    // Half of it: each try also probes, checks and writes, and the last one swaps the daemon.
    expect(RUNNER_TRIES * (UPDATE_BUSY_WAIT_MS + RUNNER_PAUSE_SECONDS * 1000)).toBeLessThan(UPDATE_WAIT_MS / 2)
    expect(RUNNER_TRIES).toBeGreaterThan(1)
  })

  it('stops after the last allowed busy refusal and says the update failed', async () => {
    const binary = fakeDaemon({ refusals: 10 })
    await expect(updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(miniHost(), fast({ tries: 3 })), 'user'))
      .rejects.toThrow('has active operations')
    expect(calls()).toHaveLength(3)
  }, 60_000)

  it('sends a compiled server\'s walnut file as its own gz, checked by sha256 and its daemon version', async () => {
    const gz = zlib.gzipSync(fs.readFileSync(fakeDaemon({ pad: 600_000 })))
    const host = miniHost()
    await updateRemoteDaemonService({ binary: null, gz }, VERSION, createNetUpdateIo(host, fast()), 'user')
    const chunks = host.writes.filter((p) => /\/chunk_\d{4}$/.test(p))
    expect(chunks.length).toBe(Math.ceil(gz.length / 262_144))
    expect(chunks.length).toBeGreaterThan(1)
    expect(calls()).toHaveLength(1)
    for (const dir of made) expect(fs.existsSync(dir)).toBe(false)
  }, 60_000)

  it('a walnut file whose daemon version differs is refused before the service is touched', async () => {
    const gz = zlib.gzipSync(fs.readFileSync(fakeDaemon({ version: 'walnut-daemon-000000000000' })))
    const host = miniHost()
    await expect(updateRemoteDaemonService({ binary: null, gz }, VERSION, createNetUpdateIo(host, fast()), 'user'))
      .rejects.toThrow('Uploaded daemon version differs; the installed service was not changed')
    expect(calls()).toEqual([])
    expect(host.writes.some((p) => p.endsWith('/update.sh'))).toBe(false)
    expect(host.lines.some((l) => l.includes('walnut daemon update'))).toBe(false)
    for (const dir of made) expect(fs.existsSync(dir)).toBe(false)
  }, 60_000)

  it('what the login profile prints never reaches the answers it reads', async () => {
    const binary = fakeDaemon()
    const host = miniHost({ noise: 'Last login: Mon Nov  3 09:00 on ttys001\n{"motd":true}\n/tmp/open-walnut-update.Noise1\n' })
    await updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast()), 'user')
    expect(calls()).toHaveLength(1)
  }, 60_000)

  it('a script a later launch took over stops before its next try', async () => {
    const latestMarker = path.join(work, 'latest')
    const binary = fakeDaemon({ refusals: 5, supersede: latestMarker })
    await expect(updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(miniHost(), fast({ latestMarker })), 'user'))
      .rejects.toThrow('a later update on the host took over')
    expect(calls()).toHaveLength(1)
  }, 60_000)

  it('a hold met right before the launch is waited out, the upload already on the host', async () => {
    const binary = fakeDaemon()
    const host = miniHost()
    let asked = 0
    await updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast({ holdWaitMs: 5_000, beforeLaunch: () => (++asked < 3 ? '1 write in flight' : null) })), 'user')
    expect(asked).toBe(3)
    expect(calls()).toHaveLength(1)
    expect(host.writes.filter((p) => /\/update\.sh$/.test(p))).toHaveLength(1)
  }, 60_000)

  it('a hold asked of the host right before the launch (a host_exec run there) is awaited and waited out the same way', async () => {
    const binary = fakeDaemon()
    const host = miniHost()
    let asked = 0
    const beforeLaunch = async () => { await new Promise((r) => setTimeout(r, 5)); return ++asked < 2 ? '1 host_exec run on the host would end with the daemon' : null }
    await updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast({ holdWaitMs: 5_000, beforeLaunch })), 'user')
    expect(asked).toBe(2)
    expect(calls()).toHaveLength(1)
    await expect(updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(miniHost(), fast({ holdWaitMs: 300, beforeLaunch: async () => '1 host_exec run on the host would end with the daemon' })), 'user'))
      .rejects.toThrow('1 host_exec run on the host would end with the daemon')
    expect(calls()).toHaveLength(1)
  }, 60_000)

  it('stops reading after its wait, or once nobody waits, and says the update may still finish', async () => {
    await expect(updateRemoteDaemonService({ binary: fakeDaemon({ sleep: 3 }) }, VERSION, createNetUpdateIo(miniHost(), fast({ waitMs: 500 })), 'user'))
      .rejects.toThrow(/did not report back within 1 s; it may still finish there/)
    await expect(updateRemoteDaemonService({ binary: fakeDaemon({ sleep: 3 }) }, VERSION, createNetUpdateIo(miniHost(), fast({ cancelled: () => true })), 'user'))
      .rejects.toThrow('nobody waits for the update any more')
    for (const dir of made) expect(fs.existsSync(dir)).toBe(false)
  }, 60_000)

  it('a hold that outlasts its wait starts nothing and removes the upload', async () => {
    const binary = fakeDaemon()
    const host = miniHost()
    await expect(updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast({ beforeLaunch: () => '1 send in flight', holdWaitMs: 300 })), 'user'))
      .rejects.toThrow('1 send in flight')
    expect(calls()).toEqual([])
    expect(host.lines.some((l) => l.includes('update.sh'))).toBe(false)
    for (const dir of made) expect(fs.existsSync(dir)).toBe(false)
  }, 60_000)
})

/** A bin dir with only these tools of the system (no setsid, perl or bash unless named), plus any fakes. */
function toolsDir(fakes: Record<string, string> = {}, extra: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(work, 'bin-'))
  for (const tool of ['ps', 'cat', 'tr', 'sleep', 'grep', 'rm', 'mv', 'mktemp', 'gzip', 'chmod', 'sha256sum', ...extra]) {
    const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
    if (found.startsWith('/')) fs.symlinkSync(found, path.join(dir, tool))
  }
  for (const [name, body] of Object.entries(fakes)) fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 })
  return dir
}

describe('the detached start', () => {
  it('without setsid or perl, bash job control still leaves the job\'s group', async () => {
    const tools = toolsDir({}, ['bash'])
    const binary = fakeDaemon({ refusals: 1 })
    const host = miniHost({ path: guardedPath([tools], tools), signalGroup: 'always' })
    await updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast()), 'user')
    const updates = calls()
    expect(updates).toHaveLength(2)
    expect(host.jobGroups).not.toContain(Number(/pgid=(\d+)/.exec(updates[1])![1]))
  }, 60_000)

  it('with only sh, it runs detached or not at all, never inside the job\'s group', async () => {
    // dash (Debian's sh) refuses `set -m` without a terminal; bash as sh allows it.
    const tools = toolsDir()
    const binary = fakeDaemon()
    const host = miniHost({ path: guardedPath([tools], tools), signalGroup: 'always' })
    const done = await updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast()), 'user').then(() => true, (err: Error) => {
      expect(err.message).toContain('did not start detached')
      return false
    })
    await new Promise((r) => setTimeout(r, 300))
    const updates = calls()
    expect(updates).toHaveLength(done ? 1 : 0)
    for (const u of updates) expect(host.jobGroups).not.toContain(Number(/pgid=(\d+)/.exec(u)![1]))
  }, 60_000)

  it('a host with no sha256sum (a Mac) checks the upload with shasum', async () => {
    const real = spawnSync('/bin/sh', ['-c', 'command -v sha256sum'], { encoding: 'utf8' }).stdout.trim()
    const used = path.join(state, 'shasum-used')
    const tools = toolsDir({ shasum: `#!/bin/sh\n[ "$1 $2" = "-a 256" ] || exit 9\nshift 2\necho "$*" >> '${used}'\nexec '${real}' "$@"\n` }, ['bash'])
    fs.rmSync(path.join(tools, 'sha256sum'))
    const binary = fakeDaemon()
    await updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(miniHost({ path: guardedPath([tools], tools) }), fast()), 'user')
    expect(fs.readFileSync(used, 'utf8').trim()).toBe('-c -')
    expect(calls()).toHaveLength(1)
  }, 60_000)

  it('a launch that stayed in the job\'s group stops the script before it changed anything', async () => {
    // A setsid that does not detach: the script would share the job's group.
    const tools = toolsDir({ setsid: '#!/bin/sh\nexec "$@"\n' })
    const binary = fakeDaemon()
    const host = miniHost({ path: guardedPath([tools], tools) })
    const err = await updateRemoteDaemonService({ binary }, VERSION, createNetUpdateIo(host, fast()), 'user').then(() => null, (e: Error) => e)
    expect(err?.message).toContain('did not start detached')
    // Nothing signals it (its pipes were closed): told no go, the script itself exits at once.
    const pid = Number(/pid=(\d+)/.exec(err!.message)?.[1])
    expect(pid).toBeGreaterThan(1)
    for (let i = 0; i < 30 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50))
    expect(alive(pid)).toBe(false)
    expect(host.jobGroups).toEqual([])
    expect(calls()).toEqual([])
  }, 60_000)

  it('the scripts are plain sh and name the paths quoted', () => {
    const dir = '/tmp/open-walnut-update.Abc123'
    const runner = runnerScript({ directory: dir, command: `${dir}/daemon walnut daemon update --yes --scope user --executable ${dir}/daemon`, executable: `${dir}/daemon` })
    expect(spawnSync('/bin/sh', ['-n', '-c', runner]).status).toBe(0)
    expect(spawnSync('/bin/sh', ['-n', '-c', launcherScript(dir)]).status).toBe(0)
    expect(runner).toContain(`rm -f ${dir}/daemon`)
    expect(runner).toContain('L="/tmp/open-walnut-update-latest-$(id -u)"')
    expect(launcherScript(dir)).toContain('mv -f "$d/latest.tmp" "$L"')
    expect(runnerScript({ directory: dir, command: 'true', executable: '/elsewhere/daemon' })).not.toContain('rm -f /elsewhere')
    expect(launcherScript("/tmp/open-walnut-update.a'b")).toContain(`d='/tmp/open-walnut-update.a'\\''b'`)
  })
})
