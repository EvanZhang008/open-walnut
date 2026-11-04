/**
 * The SSH host's trial run of a staged daemon, and its kept previous daemon
 * (src/providers/daemon-trial-cmd.ts), executed for real in /bin/sh: a stand-in daemon that
 * listens passes and is stopped afterwards, one that dies, never listens, or dies after it
 * listened fails with why, nothing of the account's env reaches it, and the kept files go
 * back into place.
 *
 * MACHINE SAFETY: the stand-ins are shell scripts in this file's temp dir; the trial makes its
 * own /tmp/walnut-proof.* dir and removes it; the only processes are /bin/sh and the stand-ins.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { guardedPath } from '../setup/exec-guard.js'
import { buildDaemonTrialCmd, filesCarryBuild, keepPreviousDaemon, parseDaemonTrial, restorePreviousDaemon, trialStagedDaemon, type HostExec } from '../../src/providers/daemon-trial-cmd.js'
import { previousKeyOf } from '../../src/providers/daemon-previous-key.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-trial-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

function sh(script: string): string {
  const out = spawnSync('/bin/sh', ['-c', script], { env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: root, SECRET_TOKEN: 'from-the-account' }, encoding: 'utf8', timeout: 60_000 })
  return out.stdout
}
const exec: HostExec = async (command) => sh(command)

function stand(name: string, body: string[]): string {
  const file = path.join(root, name)
  fs.writeFileSync(file, ['#!/bin/sh', ...body, ''].join('\n'), { mode: 0o755 })
  return file
}

const trial = (execPath: string, o: { waitSeconds?: number; aliveSeconds?: number } = {}) =>
  parseDaemonTrial(sh(buildDaemonTrialCmd({ runtime: 'binary', execPath, dir: root, waitSeconds: 3, aliveSeconds: 1, ...o })))

describe('the trial run of a staged daemon on the host', () => {
  it('passes one that listens and stays up, in a throwaway dir with none of the account env, and stops it afterwards', () => {
    const seen = path.join(root, 'seen-env')
    const pid = path.join(root, 'seen-pid')
    const good = stand('daemon-good', [`env > '${seen}'`, `echo $$ > '${pid}'`, 'mkdir -p "$WALNUT_DAEMON_DIR"', 'echo 41000 > "$WALNUT_DAEMON_DIR/daemon.port"', 'exec sleep 30'])
    expect(trial(good)).toBeNull()
    const env = fs.readFileSync(seen, 'utf8')
    expect(env).toMatch(/^HOME=\/tmp\/walnut-proof\.[A-Za-z0-9]+\/h$/m)
    expect(env).toMatch(/^WALNUT_DAEMON_DIR=\/tmp\/walnut-proof\.[A-Za-z0-9]+\/d$/m)
    expect(env).not.toContain('SECRET_TOKEN')
    const dir = /^WALNUT_DAEMON_DIR=(.*)\/d$/m.exec(env)![1]
    expect(fs.existsSync(dir)).toBe(false)
    const alive = (() => { try { return process.kill(Number(fs.readFileSync(pid, 'utf8')), 0) } catch { return false } })()
    expect(alive).toBe(false)
  }, 30_000)

  it.each([
    ['dies in its startup', ['echo "Error: Cannot find module ./net-core.cjs" >&2', 'exit 3'], /^it exited with 3 before it listened: Error: Cannot find module/],
    ['never listens', ['exec sleep 30'], /^it did not listen within 3 s/],
    ['dies after it listened', ['mkdir -p "$WALNUT_DAEMON_DIR"', 'echo 41000 > "$WALNUT_DAEMON_DIR/daemon.port"', 'sleep 0.2', 'exit 1'], /^it listened, then exited/],
  ])('fails one that %s, saying so', (_what, body, why) => {
    expect(trial(stand(`daemon-${body.length}`, body))).toMatch(why)
  }, 30_000)

  // 2026-11-04 review: on busybox (ps has no -p) a trial daemon that listened and exited is a
  // zombie of the trial's shell, kill -0 answers for it, and ps could not say: the build passed.
  it.runIf(process.platform === 'linux').each([
    ['a busybox ps (no -p)', ['for a in "$@"; do [ "$a" = -p ] && { echo "ps: invalid option -- \'p\'" >&2; exit 1; }; done', 'echo "PID   USER     TIME  COMMAND"']],
    ['no ps at all', ['echo "sh: ps: not found" >&2', 'exit 127']],
  ])('with %s, one that listened and then exited still fails', (what, body) => {
    const bin = path.join(root, `ps-${what.length}`)
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'ps'), ['#!/bin/sh', ...body, ''].join('\n'), { mode: 0o755 })
    const quits = stand('daemon-quits', ['mkdir -p "$WALNUT_DAEMON_DIR"', 'echo 41000 > "$WALNUT_DAEMON_DIR/daemon.port"', 'sleep 0.2', 'exit 1'])
    const out = spawnSync('/bin/sh', ['-c', buildDaemonTrialCmd({ runtime: 'binary', execPath: quits, dir: root, waitSeconds: 3, aliveSeconds: 1 })], {
      env: { PATH: guardedPath([bin], '/usr/bin:/bin'), HOME: root }, encoding: 'utf8', timeout: 60_000,
    })
    expect(parseDaemonTrial(out.stdout)).toMatch(/^it listened, then exited/)
  }, 30_000)

  // The same rule against a real zombie. The trial's own shell reaps one at its next wait; a
  // busybox ash whose sleep runs in-process does not, and HEAD's ps question (no -p there) read it
  // as alive. Here the zombie's parent never waits (it exec'd sleep after starting it).
  it.runIf(process.platform === 'linux')('a zombie reads as gone, with a ps that cannot say', async () => {
    const lines = buildDaemonTrialCmd({ runtime: 'binary', execPath: '/x/daemon-linux-x64', dir: root }).split('\n')
    const from = lines.findIndex((l) => l.startsWith('t_gone() {'))
    const to = lines.findIndex((l, i) => i >= from && l.trimEnd().endsWith('}'))
    expect(from).toBeGreaterThanOrEqual(0)
    const tGone = lines.slice(from, to + 1).join('\n')
    const bin = path.join(root, 'ps-zombie')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'ps'), ['#!/bin/sh', 'echo "ps: invalid option -- p" >&2', 'exit 1', ''].join('\n'), { mode: 0o755 })
    const parent = spawn('/bin/sh', ['-c', 'sleep 0.1 & echo $!; exec sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'] })
    try {
      const zombie = await new Promise<number>((resolve) => parent.stdout!.once('data', (d) => resolve(Number(String(d).trim()))))
      await vi.waitFor(() => expect(fs.readFileSync(`/proc/${zombie}/stat`, 'utf8')).toMatch(/\) Z /), { timeout: 5_000 })
      const out = spawnSync('/bin/sh', ['-c', `p=${zombie}\n${tGone}\nif t_gone; then echo gone; else echo alive; fi`], {
        env: { PATH: guardedPath([bin], '/usr/bin:/bin') }, encoding: 'utf8', timeout: 10_000,
      })
      expect(out.stdout.trim()).toBe('gone')
    } finally { parent.kill('SIGKILL') }
  })

  // 2026-11-04 review 4: no WALNUT_RUNTIME_DIR reached the trial, so the compiled walnut file in
  // the daemon slot unpacked its whole runtime into the throwaway HOME on every update.
  it('gives the trial the runtime dir the account\'s daemon uses, read with the real HOME', () => {
    const seen = path.join(root, 'seen-env-runtime')
    const good = stand('daemon-runtime', [`env > '${seen}'`, 'mkdir -p "$WALNUT_DAEMON_DIR"', 'echo 41000 > "$WALNUT_DAEMON_DIR/daemon.port"', 'exec sleep 30'])
    expect(trial(good)).toBeNull()
    expect(fs.readFileSync(seen, 'utf8')).toMatch(new RegExp(`^WALNUT_RUNTIME_DIR=${root}/\\.open-walnut/local/runtime$`, 'm'))
    const out = spawnSync('/bin/sh', ['-c', buildDaemonTrialCmd({ runtime: 'binary', execPath: good, dir: root, waitSeconds: 3, aliveSeconds: 1 })], {
      env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: root, OPEN_WALNUT_HOME: '/data/walnut-home' }, encoding: 'utf8', timeout: 60_000,
    })
    expect(parseDaemonTrial(out.stdout)).toBeNull()
    expect(fs.readFileSync(seen, 'utf8')).toMatch(/^WALNUT_RUNTIME_DIR=\/data\/walnut-home\/local\/runtime$/m)
  }, 30_000)

  // 2026-11-04 review: an SSH session that died mid-trial left the trial daemon running for good.
  it('gives the trial daemon a hard lifetime a little past its window', () => {
    const cmd = buildDaemonTrialCmd({ runtime: 'binary', execPath: '/x/daemon-linux-x64', dir: '/tmp/open-walnut', waitSeconds: 60, aliveSeconds: 3 })
    expect(cmd).toContain('WALNUT_DAEMON_LIFETIME_SECONDS=93')
    const seen = path.join(root, 'seen-env-lifetime')
    const good = stand('daemon-lifetime', [`env > '${seen}'`, 'mkdir -p "$WALNUT_DAEMON_DIR"', 'echo 41000 > "$WALNUT_DAEMON_DIR/daemon.port"', 'exec sleep 30'])
    expect(trial(good)).toBeNull()
    expect(fs.readFileSync(seen, 'utf8')).toMatch(/^WALNUT_DAEMON_LIFETIME_SECONDS=34$/m)
  }, 30_000)

  it('sweeps proof dirs a dead trial left, older than 15 min, and keeps fresh ones and ones whose daemon lives', () => {
    const made = (age: 'old' | 'fresh', pid?: number) => {
      const dir = fs.mkdtempSync('/tmp/walnut-proof.test')
      fs.mkdirSync(path.join(dir, 'd'))
      if (pid) fs.writeFileSync(path.join(dir, 'd', 'daemon.pid'), String(pid))
      if (age === 'old') { const t = new Date(Date.now() - 20 * 60_000); fs.utimesSync(dir, t, t) }
      return dir
    }
    const stale = made('old', 2 ** 22 + 12345)
    const fresh = made('fresh')
    const live = made('old', process.pid)
    try {
      const good = stand('daemon-sweep', ['mkdir -p "$WALNUT_DAEMON_DIR"', 'echo 41000 > "$WALNUT_DAEMON_DIR/daemon.port"', 'exec sleep 30'])
      expect(trial(good)).toBeNull()
      expect(fs.existsSync(stale)).toBe(false)
      expect(fs.existsSync(fresh)).toBe(true)
      expect(fs.existsSync(live)).toBe(true)
    } finally {
      for (const dir of [stale, fresh, live]) fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('no answer at all is a failure (the old daemon keeps serving)', async () => {
    expect(parseDaemonTrial('')).toBe('the trial gave no answer')
    const down: HostExec = async () => { throw new Error('ssh: connect to host devbox port 22: Connection refused') }
    expect(await trialStagedDaemon(down, { runtime: 'binary', execPath: '/x/daemon-linux-x64', dir: '/tmp/open-walnut' })).toMatch(/^the trial could not run \(ssh: connect/)
  })
})

describe('the old daemon files kept to go back to', () => {
  const OLD = 'walnut-daemon-old000000000'
  const NEW = 'walnut-daemon-new000000000'
  /** Where the host keeps them: its state dir (HOME is `root` here), one dir per daemon dir. */
  const kept = (dir: string) => path.join(root, '.local', 'state', 'open-walnut', 'daemon-previous', previousKeyOf(dir))
  /** A daemon dir whose files carry `build` (the version is a literal in daemon.cjs and the binary). */
  function daemonDir(build: string, tag: string): string {
    const dir = fs.mkdtempSync(path.join(root, 'dir-'))
    for (const [name, text] of [['daemon.cjs', `${tag} daemon const DAEMON_VERSION = '${build}'`], ['net-core.cjs', `${tag} sidecar`], ['acp-worker.mjs', `${tag} acp`], ['daemon-linux-x64', `${tag} binary ${build}`], ['daemon-start.log', 'log']]) {
      fs.writeFileSync(path.join(dir, name), text)
    }
    return dir
  }

  it('copies them aside, stamped with the build that runs, and puts them back over a staged build', async () => {
    const dir = daemonDir(OLD, 'old')
    expect(await keepPreviousDaemon(exec, dir, OLD, 'script')).toBe('kept')
    expect(fs.readdirSync(kept(dir)).sort()).toEqual(['.version', 'acp-worker.mjs', 'daemon-linux-x64', 'daemon.cjs', 'net-core.cjs'])
    expect(fs.readFileSync(path.join(kept(dir), '.version'), 'utf8')).toBe(`${OLD}\n`)
    expect(fs.existsSync(path.join(dir, 'previous'))).toBe(false)
    for (const name of ['daemon.cjs', 'net-core.cjs', 'daemon-linux-x64']) fs.writeFileSync(path.join(dir, name), 'new')
    expect(await restorePreviousDaemon(exec, dir)).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'daemon.cjs'), 'utf8')).toBe(`old daemon const DAEMON_VERSION = '${OLD}'`)
    expect(fs.readFileSync(path.join(dir, 'net-core.cjs'), 'utf8')).toBe('old sidecar')
    expect(fs.readFileSync(path.join(dir, 'daemon-linux-x64'), 'utf8')).toBe(`old binary ${OLD}`)
    // The stamp stays in the kept dir: it is not a daemon file.
    expect(fs.existsSync(path.join(dir, '.version'))).toBe(false)
    expect(fs.readdirSync(dir).filter((n) => n.includes('walnut-prev'))).toEqual([])
  })

  // 2026-11-04 review: an upload that stopped short leaves the new build on the disk; the next
  // attempt copied that over the kept old one, and a rollback then put the new build back.
  it('a previous/ of the build that runs is kept as it is, whatever the disk holds now', async () => {
    const dir = daemonDir(OLD, 'old')
    expect(await keepPreviousDaemon(exec, dir, OLD, 'script')).toBe('kept')
    for (const name of ['daemon.cjs', 'daemon-linux-x64']) fs.writeFileSync(path.join(dir, name), `half-staged ${NEW}`)
    expect(await keepPreviousDaemon(exec, dir, OLD, 'script')).toBe('kept')
    expect(fs.readFileSync(path.join(kept(dir), 'daemon.cjs'), 'utf8')).toBe(`old daemon const DAEMON_VERSION = '${OLD}'`)
  })

  it.each([['script', 'daemon.cjs'], ['binary', 'daemon-linux-x64']] as const)('files on disk whose %s does not carry the running build are not kept at all', async (runtime, program) => {
    const dir = daemonDir(OLD, 'old')
    fs.writeFileSync(path.join(dir, program), `staged ${NEW}`)
    expect(await keepPreviousDaemon(exec, dir, OLD, runtime)).toBe('not-running')
    expect(fs.existsSync(kept(dir))).toBe(false)
    // An older copy with no stamp is not trusted either, here or an older build's beside the files.
    for (const keep of [kept(dir), path.join(dir, 'previous')]) {
      fs.mkdirSync(keep, { recursive: true })
      fs.writeFileSync(path.join(keep, 'daemon.cjs'), 'unknown build')
      expect(await keepPreviousDaemon(exec, dir, OLD, runtime)).toBe('not-running')
      fs.rmSync(keep, { recursive: true })
    }
  })

  it('a running build that is not a plain version word keeps nothing', async () => {
    const dir = daemonDir(OLD, 'old')
    expect(await keepPreviousDaemon(exec, dir, '', 'script')).toBe('not-running')
    expect(await keepPreviousDaemon(exec, dir, "x'; rm -rf /", 'script')).toBe('failed')
    expect(fs.existsSync(kept(dir))).toBe(false)
  })

  // 2026-11-04 review: an SSH error or the 120 s timeout read as "nothing to keep", and the update went on to stop the daemon.
  it('a keep that fails or gives no answer is "failed", never "not running"', async () => {
    const dir = daemonDir(OLD, 'old')
    expect(await keepPreviousDaemon(async () => { throw new Error('ssh: connection reset') }, dir, OLD, 'script')).toBe('failed')
    expect(await keepPreviousDaemon(async () => '', dir, OLD, 'script')).toBe('failed')
  })

  // 2026-11-04 review 4: <dir>/previous lived in /tmp, so a host that rebooted inside the build's
  // day off had nothing to start again, and the next connect deployed the refused build.
  it('the kept copy survives a reboot that cleared the daemon dir, and is put back into a dir made again', async () => {
    const dir = daemonDir(OLD, 'old')
    expect(await keepPreviousDaemon(exec, dir, OLD, 'binary')).toBe('kept')
    fs.rmSync(dir, { recursive: true })
    expect(await restorePreviousDaemon(exec, dir)).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'daemon-linux-x64'), 'utf8')).toBe(`old binary ${OLD}`)
    expect(fs.readFileSync(path.join(dir, 'net-core.cjs'), 'utf8')).toBe('old sidecar')
    expect((fs.statSync(dir).mode & 0o777).toString(8)).toBe('700')
    // A kept copy of the build held back there is never put back.
    expect(await restorePreviousDaemon(exec, dir, OLD)).toBe(false)
  })

  it('a copy an older build kept in <dir>/previous is still put back, and moved to the kept dir as it is', async () => {
    const dir = daemonDir(OLD, 'old')
    fs.mkdirSync(path.join(dir, 'previous'))
    for (const name of ['daemon.cjs', 'daemon-linux-x64']) fs.copyFileSync(path.join(dir, name), path.join(dir, 'previous', name))
    fs.writeFileSync(path.join(dir, 'previous', '.version'), `${OLD}\n`)
    for (const name of ['daemon.cjs', 'daemon-linux-x64']) fs.writeFileSync(path.join(dir, name), `half-staged ${NEW}`)
    expect(await restorePreviousDaemon(exec, dir)).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'daemon.cjs'), 'utf8')).toBe(`old daemon const DAEMON_VERSION = '${OLD}'`)
    // The disk holds another build again: the older copy is the one kept, not the disk's files.
    for (const name of ['daemon.cjs', 'daemon-linux-x64']) fs.writeFileSync(path.join(dir, name), `half-staged ${NEW}`)
    expect(await keepPreviousDaemon(exec, dir, OLD, 'script')).toBe('kept')
    expect(fs.readFileSync(path.join(kept(dir), 'daemon.cjs'), 'utf8')).toBe(`old daemon const DAEMON_VERSION = '${OLD}'`)
  })

  // 2026-11-04 review 5: an isolated daemon dir (a replica check's) left a copy in the host's home.
  it('an isolated daemon dir keeps its copy beside its files, never in the home', async () => {
    const dir = daemonDir(OLD, 'old')
    expect(await keepPreviousDaemon(exec, dir, OLD, 'script', false)).toBe('kept')
    expect(fs.existsSync(kept(dir))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'previous', '.version'), 'utf8')).toBe(`${OLD}\n`)
    expect(await keepPreviousDaemon(exec, dir, OLD, 'script', false)).toBe('kept')
    fs.writeFileSync(path.join(dir, 'daemon.cjs'), 'new')
    expect(await restorePreviousDaemon(exec, dir, undefined, false)).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'daemon.cjs'), 'utf8')).toBe(`old daemon const DAEMON_VERSION = '${OLD}'`)
    expect(fs.existsSync(kept(dir))).toBe(false)
  })

  // 2026-11-04 review 5: a home that could not take the copy (a quota, a full disk) failed the keep
  // every time, and the update was put off for good; and an older build's copy left in the kept dir
  // must not be the one put back over a newer one beside the files.
  it('a home that cannot take the copy keeps it beside the files, and the restore takes the copy stamped last', async () => {
    const dir = daemonDir(OLD, 'old')
    fs.mkdirSync(kept(dir), { recursive: true })
    fs.writeFileSync(path.join(kept(dir), 'daemon.cjs'), 'an older build\'s daemon')
    fs.writeFileSync(path.join(kept(dir), '.version'), 'walnut-daemon-older0000000\n')
    const earlier = new Date(Date.now() - 3600_000)
    fs.utimesSync(path.join(kept(dir), '.version'), earlier, earlier)
    const blocked = path.join(root, `blocked-${path.basename(dir)}`)
    fs.writeFileSync(blocked, 'a file where the kept root would be')
    const full: HostExec = async (command) => spawnSync('/bin/sh', ['-c', command], {
      env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: root, WALNUT_DAEMON_PREVIOUS_ROOT: path.join(blocked, 'daemon-previous') }, encoding: 'utf8', timeout: 60_000,
    }).stdout
    expect(await keepPreviousDaemon(full, dir, OLD, 'script')).toBe('kept')
    expect(fs.readFileSync(path.join(dir, 'previous', '.version'), 'utf8')).toBe(`${OLD}\n`)
    fs.writeFileSync(path.join(dir, 'daemon.cjs'), `half-staged ${NEW}`)
    expect(await restorePreviousDaemon(exec, dir)).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'daemon.cjs'), 'utf8')).toBe(`old daemon const DAEMON_VERSION = '${OLD}'`)
  })

  // 2026-11-04 review 5: the files went back one by one, so a copy that failed halfway (a full
  // disk) left the daemon dir a mix of the two builds.
  it('a restore whose copy fails halfway changes nothing: never a mix of two builds\' files', async () => {
    const dir = daemonDir(OLD, 'old')
    expect(await keepPreviousDaemon(exec, dir, OLD, 'script')).toBe('kept')
    for (const [name, text] of [['daemon.cjs', `new daemon ${NEW}`], ['net-core.cjs', 'new sidecar']]) fs.writeFileSync(path.join(dir, name), text)
    // A cp that fails on the sidecar, after the daemon's own file went through.
    const bin = fs.mkdtempSync(path.join(root, 'cp-'))
    fs.writeFileSync(path.join(bin, 'cp'), '#!/bin/sh\ncase "$*" in *net-core.cjs*) echo "cp: No space left on device" >&2; exit 1;; esac\nexec /bin/cp "$@"\n', { mode: 0o755 })
    const fails: HostExec = async (command) => spawnSync('/bin/sh', ['-c', command], { env: { PATH: guardedPath([bin], '/usr/bin:/bin'), HOME: root }, encoding: 'utf8', timeout: 60_000 }).stdout
    expect(await restorePreviousDaemon(fails, dir)).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'daemon.cjs'), 'utf8')).toBe(`new daemon ${NEW}`)
    expect(fs.readFileSync(path.join(dir, 'net-core.cjs'), 'utf8')).toBe('new sidecar')
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.walnut-prev'))).toEqual([])
    // With room again, all of it goes back.
    expect(await restorePreviousDaemon(exec, dir)).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'daemon.cjs'), 'utf8')).toBe(`old daemon const DAEMON_VERSION = '${OLD}'`)
    expect(fs.readFileSync(path.join(dir, 'net-core.cjs'), 'utf8')).toBe('old sidecar')
  })

  it('tells whether the daemon files there carry a build', async () => {
    const dir = daemonDir(OLD, 'old')
    expect(await filesCarryBuild(exec, dir, OLD, 'script')).toBe(true)
    expect(await filesCarryBuild(exec, dir, OLD, 'binary')).toBe(true)
    expect(await filesCarryBuild(exec, dir, NEW, 'script')).toBe(false)
    expect(await filesCarryBuild(exec, dir, "x'; rm -rf /", 'script')).toBe(false)
    expect(await filesCarryBuild(async () => { throw new Error('ssh: connection reset') }, dir, OLD, 'script')).toBe(false)
  })

  it('restores nothing when nothing was kept', async () => {
    expect(await restorePreviousDaemon(exec, fs.mkdtempSync(path.join(root, 'none-')))).toBe(false)
  })
})
