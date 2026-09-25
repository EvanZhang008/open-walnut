/**
 * Remote-host onboarding: the SECOND machine, end to end, zero mocks on the wire.
 *
 * The fresh-machine harness (scripts/onboarding-test/) proves the server installs.
 * Nothing proved that Walnut can take a brand-new Linux dev box and provision it.
 * A new user hit three failures at once on exactly such a box (no gcc, no node on
 * the non-interactive ssh PATH, an npm-built `claude`, ~/workplace a symlink):
 * the terminal was blocked, ~/workplace was never offered, and spawn died on node.
 * This file runs the REAL DaemonConnection over REAL ssh against a container that
 * looks like that box (scripts/onboarding-test/remote-host/Dockerfile):
 *
 *   a. connect(): ssh, probe, install-runtime (Bun from bun.sh), upload, start,
 *      tunnel, handshake; the daemon runs under Bun and answers a ping
 *   b. the folder picker lists ~/workplace (flagged as a symlink) and ~/workspace,
 *      and ~/workplace/ lists proj-a and proj-b (pins f0799ff8 on a Linux daemon)
 *   c. the terminal probe reaches the host (never an ssh failure) and, by branch,
 *      runs persistent on the shipped prebuilt dtach or reports "no compiler"
 *   d. host.preflight (capability preflight-v1) sees no compiler, the npm build
 *      without node, and dtach exactly where step c installed the prebuilt
 *   e. a session start names Node.js and the native installer
 *   f. (only with WALNUT_REMOTE_ONBOARDING_AUTOFIX=1, set by the CI job) reconnect
 *      with autofix on: host.fix installs the native claude, and (no-compiler
 *      branch only) reports that the gcc install needs a sudo password; a fresh
 *      preflight sees claude 'native'
 *
 * TWO BRANCHES, logged as `branch: prebuilt` or `branch: no_compiler`. The server
 * ships a prebuilt dtach for the box's `uname -m` when dist/daemon-binaries has
 * one: `npm run build:daemon` on a Linux machine with gcc writes it, so the amd64
 * CI runner takes the prebuilt branch, while an arm64 container on a Mac has none
 * and takes the no-compiler branch. Once dtach runs, a compiler is pointless, so
 * the prebuilt branch never sees a gcc fix (or a sudo prompt) in step f.
 *
 * a to e assert pure DIAGNOSIS, so this process runs with WALNUT_HOST_AUTOFIX=0
 * until f turns it on: an automatic fix during a to e would install the native
 * claude and change the very answers those steps pin.
 *
 * Moving contracts (terminal fallback, spawn gate, host.fix) are read through
 * ./remote-host-onboarding-adapters.ts; each carries a TODO naming its final shape.
 *
 * RUN: scripts/onboarding-test/remote-host/run.sh (builds and starts the container,
 * sets the two env vars below, tears the container down). CI job: `remote-host`.
 * Skips cleanly when WALNUT_REMOTE_ONBOARDING_HOST is unset.
 *
 * HOW THE HOST REACHES WALNUT. Walnut's host config (config.yaml `hosts:`) holds
 * only hostname/user/port/label/shell_setup, and every ssh it runs is a bare `ssh`
 * from PATH with `-o BatchMode=yes -o StrictHostKeyChecking=no [-p port]
 * [user@]hostname`: no `-F`, no identity option, no known-hosts option. So:
 *   1. the isolated config.yaml registers `hosts.devbox.hostname` as the ssh alias
 *      (walnut-onboarding-devbox), with no user or port;
 *   2. a PATH shim named `ssh` execs the real ssh with `-F <runner's ssh config>`,
 *      which maps the alias to 127.0.0.1:<port>, user alice, the throwaway key,
 *      and known hosts /dev/null. The user's ~/.ssh/config is never read by ssh.
 *   3. TMPDIR points at this file's own short temp dir, so every ControlMaster
 *      socket Walnut opens lands there, never in a shared temp dir.
 * Two guards refuse anything that is not the fixture: the alias must resolve to
 * loopback, and the host must carry /etc/walnut-onboarding-fixture.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { DaemonConnection, DaemonConnectState } from '../../src/providers/daemon-connection.js'
import type { SshTarget } from '../../src/providers/session-io.js'
import { createMockConstants } from '../helpers/mock-constants.js'
import {
  expectSpawnNamesNodeAndNativeInstall, expectTerminalOnHost, probeTerminal, readFixes, serverPrebuiltDtach, wantedFixes,
  type FixView, type SpawnOutcome,
} from './remote-host-onboarding-adapters.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-remote-onboarding'))

const SSH_ALIAS = process.env.WALNUT_REMOTE_ONBOARDING_HOST ?? ''
const SSH_CONFIG = process.env.WALNUT_REMOTE_ONBOARDING_SSH_CONFIG ?? ''
const describeIf = SSH_ALIAS ? describe : describe.skip
/** Walnut's name for the host (the config.yaml key); SSH_ALIAS is ssh's name for it. */
const HOST_KEY = 'devbox'
const SSH_TARGET: SshTarget = { hostname: SSH_ALIAS }
const CONNECT_STEPS = ['ssh', 'probe', 'install-runtime', 'upload', 'start', 'tunnel', 'handshake', 'connected']
const AUTOFIX_STEP = process.env.WALNUT_REMOTE_ONBOARDING_AUTOFIX === '1'
const FIX_WAIT_MS = 6 * 60_000
// Diagnosis first: no automatic host fix may run before step f (see the header).
// Set before any product module is imported; every src import below is dynamic.
if (SSH_ALIAS) process.env.WALNUT_HOST_AUTOFIX = '0'

// ── Shared state and helpers ───────────────────────────────────────────────────

let sockDir = ''
let realSsh = ''
let remoteHome = ''
/** The prebuilt dtach the server ships for the box's arch, or null: picks the branch. */
let prebuilt: string | null = null
let conn: DaemonConnection | null = null
const saved = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }
const failures: string[] = []

function log(msg: string): void { console.log(`[remote-onboarding] ${msg}`) }

async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now()
  try {
    return await fn()
  } finally {
    log(`${name}: ${Date.now() - t0}ms`)
  }
}

/** Test-side probe of the container, through the runner's ssh config (never the shim). */
function remote(cmd: string, timeout = 20_000): string {
  return execFileSync(realSsh, ['-F', SSH_CONFIG, '-o', 'BatchMode=yes', SSH_ALIAS, cmd], { encoding: 'utf-8', timeout }).trim()
}

/** True when some ControlMaster socket named `prefix*` in `dir` answers `-O check`. */
function controlMasterUp(dir: string, prefix: string): boolean {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (!name.startsWith(prefix) || !fs.statSync(p).isSocket()) continue
    try {
      execFileSync(realSsh, ['-F', SSH_CONFIG, '-o', `ControlPath=${p}`, '-O', 'check', SSH_ALIAS], { stdio: 'ignore', timeout: 5_000 })
      return true
    } catch { /* not this one */ }
  }
  return false
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Download failures as curl, the installers and ssh print them (no bare URL: a
 *  command line that merely names a host is not evidence of a download error). */
const DOWNLOAD_ERROR = /Could not resolve host|Temporary failure in name resolution|curl: \(\d+\)|Failed to connect to|Connection timed out|Operation timed out|SSL_|Failed to download/i

/** This run's own Walnut log lines about the host (its log dir is the mocked temp one). */
async function hostLogLines(): Promise<string[]> {
  const { LOG_DIR } = await import('../../src/constants.js')
  if (!fs.existsSync(LOG_DIR)) return []
  return fs.readdirSync(LOG_DIR).filter((n) => n.endsWith('.log'))
    .flatMap((n) => fs.readFileSync(path.join(LOG_DIR, n), 'utf-8').split('\n'))
    .filter((l) => l.includes(`"${HOST_KEY}"`))
}

/**
 * Ask the BOX (not Walnut) whether it can reach each URL at all. Any HTTP answer
 * counts as reachable (no `curl -f`: a 400 from a bucket root is a live network);
 * only a curl transport failure (resolve, connect, TLS, timeout) is not.
 * Returns the first unreachable line, or null.
 */
function unreachableFromBox(urls: string[]): string | null {
  let out = ''
  try {
    out = remote(`for u in ${urls.join(' ')}; do out=$(curl -sS -o /dev/null --max-time 20 "$u" 2>&1); echo "curl_exit=$? $u $out"; done; true`, 90_000)
  } catch (e) {
    return `probe failed: ${errText(e)}`
  }
  return out.split('\n').find((l) => /^curl_exit=[1-9]/.test(l))?.trim() ?? null
}

/**
 * Step a failed: was it the network at install-runtime? Only when Bun never got
 * installed on the box AND there is download evidence: the box itself cannot
 * reach the installer or GitHub (where the installer downloads Bun from), or the
 * connect error, Walnut's log for the host, or the daemon start log names a
 * download failure. A reachable network with a failed install is a Walnut bug
 * and stays a plain failure. (Walnut's own evidence is thin: its install runs
 * `curl | bash`, whose exit code is bash's, so a failed curl reads as "success".)
 */
async function networkCauseAtInstallRuntime(phases: string[], err: unknown): Promise<string | null> {
  if (!phases.includes('install-runtime')) return null
  let facts = ''
  try {
    facts = remote('[ -x "$HOME/.bun/bin/bun" ] && echo BUN_OK; tail -n 20 /tmp/open-walnut/daemon-start.log 2>/dev/null; true', 30_000)
  } catch (e) {
    facts = `probe failed: ${errText(e)}`
  }
  if (/^BUN_OK$/m.test(facts)) return null
  const unreachable = unreachableFromBox(['https://bun.sh/install', 'https://github.com'])
  if (unreachable) return `the box cannot reach the Bun installer (${unreachable})`
  const evidence = [errText(err), ...facts.split('\n'), ...(await hostLogLines())]
    .find((l) => DOWNLOAD_ERROR.test(l) || /bun\.sh/i.test(l))
  return evidence ? `Bun was never installed and a download failed: ${evidence.trim().slice(0, 300)}` : null
}

function requireConn(): DaemonConnection {
  if (!conn?.connected) throw new Error('step a did not leave a connected daemon; read its failure first')
  return conn
}

/** Start one session with the real RemoteSessionManager; settle on refusal or first exit. */
async function spawnOnce(): Promise<SpawnOutcome> {
  const { RemoteSessionManager } = await import('../../src/providers/remote-session-manager.js')
  const rsm = new RemoteSessionManager(`remote-onboarding-${Date.now()}`, HOST_KEY, SSH_TARGET)
  const outcome = await new Promise<SpawnOutcome>((resolve) => {
    let settled = false
    const finish = (o: SpawnOutcome) => { if (!settled) { settled = true; clearTimeout(timer); resolve(o) } }
    const timer = setTimeout(() => finish({ kind: 'running' }), 60_000)
    rsm.start({
      args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
      cwd: `${remoteHome}/workspace`,
      message: 'hello from the remote-host onboarding test',
      resume: false,
      onOutput: () => {},
      onExit: (code, stderr) => finish({ kind: 'exited', code, text: stderr ?? '' }),
    }).catch((err: unknown) => finish({ kind: 'refused', text: err instanceof Error ? err.message : String(err) }))
  })
  rsm.detach()
  return outcome
}

/**
 * Reconnect with autofix ON, wired exactly as src/web/server.ts wires it (readiness,
 * and with it host.fix, after each handshake), wait for the wanted fix outcomes,
 * then for the round to end, so a fix that must NOT run would be seen too.
 */
async function reconnectWithAutofix(wanted: string[]): Promise<{ fixes: FixView[]; roundEnded: boolean }> {
  const dc = await import('../../src/providers/daemon-connection.js')
  const hr = await import('../../src/core/hosts/host-readiness.js')
  process.env.WALNUT_HOST_AUTOFIX = '1'
  dc.disconnectAllDaemons()
  // The old ControlMaster must be gone first: a new one on the same socket path
  // would otherwise ride (and then lose) the dying connection.
  for (let i = 0; i < 20 && fs.readdirSync(sockDir).some((n) => n.startsWith('walnut-ssh-')); i++) {
    await new Promise((r) => setTimeout(r, 500))
  }
  hr.clearHostReadiness(HOST_KEY)
  const unwire = hr.wireHostReadiness({ onConnected: dc.addOnDaemonHostConnected, isKnownHost: (h) => h === HOST_KEY, emit: () => {} })
  try {
    conn = await dc.getDaemonConnection(HOST_KEY, SSH_TARGET)
    const deadline = Date.now() + FIX_WAIT_MS
    const allIn = () => wanted.every((id) => readFixes(hr.getHostReadiness(HOST_KEY)).some((f) => f.id === id))
    while (Date.now() < deadline && !allIn()) await new Promise((r) => setTimeout(r, 5_000))
    const round = hr.hostAutofixRound(HOST_KEY)
    if (round && allIn()) await Promise.race([round, new Promise((r) => setTimeout(r, 60_000))])
    return { fixes: readFixes(hr.getHostReadiness(HOST_KEY)), roundEnded: hr.hostAutofixRound(HOST_KEY) === undefined }
  } finally {
    unwire()
  }
}

// ── The journey ────────────────────────────────────────────────────────────────

describeIf(`remote-host onboarding (ssh alias: ${SSH_ALIAS})`, () => {
  beforeAll(async () => {
    expect(SSH_CONFIG, 'WALNUT_REMOTE_ONBOARDING_SSH_CONFIG must name the runner\'s ssh config').not.toBe('')
    expect(fs.existsSync(SSH_CONFIG), `ssh config not found: ${SSH_CONFIG}`).toBe(true)
    const runtimeDir = process.env.WALNUT_DAEMON_DIR ?? ''
    // Exactly the production dir or inside it; /tmp/open-walnut-test-runtime-<pid> is fine.
    const prodRuntime = runtimeDir === '/tmp/open-walnut' || runtimeDir.startsWith('/tmp/open-walnut/')
    expect(runtimeDir !== '' && !prodRuntime, `WALNUT_DAEMON_DIR must be isolated, got '${runtimeDir}'`).toBe(true)

    realSsh = execFileSync('/bin/sh', ['-c', 'command -v ssh'], { encoding: 'utf-8' }).trim()
    expect(realSsh, 'no ssh on PATH').not.toBe('')

    // Guard 1: the alias must point at a local container, never a real machine.
    const resolved = execFileSync(realSsh, ['-F', SSH_CONFIG, '-G', SSH_ALIAS], { encoding: 'utf-8' })
    const hostname = /^hostname (\S+)$/m.exec(resolved)?.[1] ?? ''
    expect(['127.0.0.1', 'localhost', '::1'], `refusing: ${SSH_ALIAS} resolves to '${hostname}', not a local container`).toContain(hostname)

    // Short dir: ControlMaster sockets live here, and unix socket paths cap near 104 bytes.
    sockDir = fs.mkdtempSync(path.join(fs.existsSync('/tmp') ? '/tmp' : '.', 'wrh-'))
    const binDir = path.join(sockDir, 'bin')
    fs.mkdirSync(binDir)
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
    fs.writeFileSync(path.join(binDir, 'ssh'), `#!/bin/sh\nexec ${q(realSsh)} -F ${q(SSH_CONFIG)} "$@"\n`, { mode: 0o755 })
    process.env.PATH = `${binDir}${path.delimiter}${saved.PATH ?? ''}`
    process.env.TMPDIR = sockDir

    // Guard 2 + freshness: the fixture marker, and nothing provisioned yet.
    const facts = remote([
      'cat /etc/walnut-onboarding-fixture 2>/dev/null || echo NO_MARKER',
      'echo "home=$HOME"',
      'echo "arch=$(uname -m)"',
      'for t in gcc cc clang node npm dtach; do command -v "$t" >/dev/null 2>&1 && echo "has=$t"; done',
      '[ -e "$HOME/.bun" ] && echo has=bun-dir',
      '[ -e "$HOME/.local/bin/walnut-dtach" ] && echo has=walnut-dtach',
      '[ -e /tmp/open-walnut/daemon.pid ] && echo has=daemon',
      'true',
    ].join('; '))
    log(`fixture facts:\n${facts}`)
    expect(facts, 'refusing: the host is not the onboarding fixture').toContain('walnut-onboarding-remote-host')
    expect(facts.match(/^has=.*$/gm) ?? [], 'the container is not fresh or grew a tool the dev box lacks; restart it').toEqual([])
    remoteHome = /^home=(\S+)$/m.exec(facts)?.[1] ?? ''
    expect(remoteHome).toMatch(/^\/home\/alice$/)
    const arch = /^arch=(\S+)$/m.exec(facts)?.[1] ?? ''
    expect(arch, 'uname -m printed nothing on the box').not.toBe('')

    const { CONFIG_FILE, WALNUT_HOME, DAEMON_BINARIES_DIR } = await import('../../src/constants.js')
    prebuilt = await serverPrebuiltDtach(arch)
    log(prebuilt
      ? `branch: prebuilt (${prebuilt} for the box's ${arch}); expect a persistent terminal and dtach at ~/.local/bin/walnut-dtach`
      : `branch: no_compiler (no prebuilt dtach for Linux ${arch} in ${DAEMON_BINARIES_DIR}); expect the no-compiler plain shell`)
    fs.mkdirSync(WALNUT_HOME, { recursive: true })
    fs.writeFileSync(CONFIG_FILE, `hosts:\n  ${HOST_KEY}:\n    hostname: ${SSH_ALIAS}\n    label: ${HOST_KEY}\n`)
  }, 120_000)

  afterEach((ctx) => {
    if (ctx.task.result?.state === 'fail') failures.push(ctx.task.name)
  })

  afterAll(async () => {
    if (!SSH_ALIAS) return
    try {
      if (failures.length) await dumpLocalLog()
      const { disconnectAllDaemons } = await import('../../src/providers/daemon-connection.js')
      disconnectAllDaemons()
    } finally {
      if (sockDir) {
        // Close every ControlMaster this file opened (they are all in sockDir).
        for (const name of fs.readdirSync(sockDir)) {
          const p = path.join(sockDir, name)
          if (!fs.statSync(p).isSocket()) continue
          try { execFileSync(realSsh, ['-F', SSH_CONFIG, '-o', `ControlPath=${p}`, '-O', 'exit', SSH_ALIAS], { stdio: 'ignore', timeout: 5_000 }) } catch { /* gone */ }
        }
        fs.rmSync(sockDir, { recursive: true, force: true })
      }
      process.env.PATH = saved.PATH
      if (saved.TMPDIR === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = saved.TMPDIR
    }
  }, 60_000)

  it('a. connect() provisions the host: every step runs, the daemon runs under Bun and answers', async () => {
    const { getDaemonConnection, addOnDaemonPhaseChange } = await import('../../src/providers/daemon-connection.js')
    const phases: Array<{ phase: string; at: number }> = []
    const off = addOnDaemonPhaseChange((s: DaemonConnectState) => {
      if (s.host === HOST_KEY) phases.push({ phase: s.phase, at: Date.now() })
    })
    const t0 = Date.now()
    try {
      try {
        conn = await timed('a. connect (ssh ... handshake)', () => getDaemonConnection(HOST_KEY, SSH_TARGET))
      } finally {
        off()
        log(`a. phases: ${phases.map((p, i) => `${p.phase} +${p.at - (i ? phases[i - 1].at : t0)}ms`).join(', ')}`)
      }
      const seen = phases.map((p) => p.phase)
      expect(seen).not.toContain('failed')
      const firsts = CONNECT_STEPS.map((step) => seen.indexOf(step))
      expect(firsts.every((i) => i >= 0), `missing connect steps, saw: ${seen.join(' > ')}`).toBe(true)
      expect([...firsts].sort((x, y) => x - y), `connect steps out of order: ${seen.join(' > ')}`).toEqual(firsts)
      expect(seen.at(-1)).toBe('connected')
      expect(conn.connected).toBe(true)

      const pong = await timed('a. ping', () => conn!.send('ping', {}, 10_000))
      expect(pong).toMatchObject({ ok: true, pong: true })

      const proc = remote('pid=$(cat /tmp/open-walnut/daemon.pid) && ps -o args= -p "$pid"; [ -x "$HOME/.bun/bin/bun" ] && echo bun-installed; true')
      log(`a. daemon process: ${proc}`)
      expect(proc, 'the daemon should run as `<home>/.bun/bin/bun .../daemon.cjs`').toMatch(/\/\.bun\/bin\/bun \S*daemon\.cjs/)
      expect(proc).toContain('bun-installed')
    } catch (err) {
      const cause = await networkCauseAtInstallRuntime(phases.map((p) => p.phase), err)
      if (cause) {
        throw new Error(`NETWORK: ${cause}. The box could not download the daemon runtime, so this is not a Walnut regression; rerun the job. Original failure: ${errText(err).slice(0, 400)}`)
      }
      throw err
    }
  }, 300_000)

  it('b. the folder picker offers ~/workplace (a symlink) and ~/workspace, and lists inside the link', async () => {
    const c = requireConn()
    const { listSessionDirs } = await import('../../src/core/sessions/session-extras.js')
    const home = await timed('b. listSessionDirs ~/', () => listSessionDirs('~/', HOST_KEY, 1))
    const names = home.dirs.map((d) => path.posix.basename(d))
    log(`b. ~/ -> parent=${home.parent} dirs=${names.join(',')}`)
    expect(home.exists).toBe(true)
    expect(names).toEqual(expect.arrayContaining(['workplace', 'workspace']))

    const raw = await timed('b. fs.ls ~/', () => c.send('fs.ls', { path: '~/' }, 15_000))
    const entries = (raw.entries ?? []) as Array<{ name: string; type: string; symlink?: boolean }>
    expect(entries.find((e) => e.name === 'workplace'), 'fs.ls must follow the link and flag it').toMatchObject({ type: 'dir', symlink: true })
    const workspace = entries.find((e) => e.name === 'workspace')
    expect(workspace).toMatchObject({ type: 'dir' })
    expect(workspace?.symlink).toBeFalsy()

    const inside = await timed('b. listSessionDirs ~/workplace/', () => listSessionDirs('~/workplace/', HOST_KEY, 1))
    expect(inside.exists).toBe(true)
    expect(inside.dirs.map((d) => path.posix.basename(d))).toEqual(expect.arrayContaining(['proj-a', 'proj-b']))
  }, 90_000)

  it('c. the terminal reaches the host: persistent on the shipped prebuilt, else it names the missing compiler', async () => {
    requireConn()
    log(`c. branch: ${prebuilt ? 'prebuilt' : 'no_compiler'}`)
    const view = await timed('c. terminal probe', () => probeTerminal(HOST_KEY, () => controlMasterUp(sockDir, 'walnut-term-ssh-')))
    log(`c. terminal: ${JSON.stringify(view)}`)
    expectTerminalOnHost(view, prebuilt)
    if (!prebuilt) return
    // The box has no compiler, so a dtach there can only be the one the server shipped.
    const local = createHash('sha256').update(fs.readFileSync(prebuilt)).digest('hex')
    const onBox = remote('sha256sum "$HOME/.local/bin/walnut-dtach" 2>&1; true').split(/\s+/)[0]
    expect(onBox, `~/.local/bin/walnut-dtach on the box should be byte-identical to ${prebuilt}`).toBe(local)
  }, 120_000)

  it('d. host.preflight sees no compiler, an npm-built claude without node, and the dtach step c installed', async (ctx) => {
    const c = requireConn()
    if (!c.hasCapability('preflight-v1')) {
      console.warn('[remote-onboarding] SKIPPED d: this daemon does not advertise preflight-v1 yet')
      ctx.skip()
      return
    }
    const res = await timed('d. host.preflight', () => c.send('host.preflight', {}, 30_000))
    log(`d. preflight: ${JSON.stringify(res)}`)
    expect(res.ok).toBe(true)
    expect(res.compiler).toMatchObject({ found: false })
    expect(res.claude).toMatchObject({ found: true, kind: 'npm', needsNode: true, nodeFound: false })
    log(`d. branch: ${prebuilt ? 'prebuilt' : 'no_compiler'}`)
    if (prebuilt) expect(res.dtach, 'step c installed the prebuilt').toMatchObject({ found: true, path: `${remoteHome}/.local/bin/walnut-dtach` })
    else expect(res.dtach, 'no prebuilt and no compiler, so no dtach').toMatchObject({ found: false })
  }, 60_000)

  it('e. starting a session names Node.js and the native installer', async () => {
    const c = requireConn()
    const outcome = await timed('e. session start', () => spawnOnce())
    log(`e. outcome: ${JSON.stringify(outcome)}`)
    expectSpawnNamesNodeAndNativeInstall(outcome, c.hasCapability('preflight-v1'))
  }, 120_000)

  it('f. (opt-in) autofix installs the native claude, and without a prebuilt reports that gcc needs a sudo password', async (ctx) => {
    if (!AUTOFIX_STEP) {
      console.warn('[remote-onboarding] SKIPPED f: set WALNUT_REMOTE_ONBOARDING_AUTOFIX=1 to run it (the CI job does)')
      ctx.skip()
      return
    }
    if (!requireConn().hasCapability('hostfix-v1')) {
      console.warn('[remote-onboarding] SKIPPED f: this daemon does not advertise hostfix-v1 yet')
      ctx.skip()
      return
    }
    log(`f. branch: ${prebuilt ? 'prebuilt' : 'no_compiler'}`)
    const wanted = wantedFixes(Boolean(prebuilt))
    const { fixes, roundEnded } = await timed('f. reconnect + autofix', () => reconnectWithAutofix(wanted))
    log(`f. fixes: ${fixes.map((f) => f.raw).join(' | ') || '(none)'}; round ended: ${roundEnded}`)
    const claudeFix = fixes.find((f) => f.id === 'install-claude-native')
    if (!claudeFix?.ok) {
      const unreachable = unreachableFromBox(['https://claude.ai/install.sh', 'https://storage.googleapis.com'])
      const said = claudeFix && DOWNLOAD_ERROR.test(claudeFix.raw) ? claudeFix.raw : null
      if (unreachable || said) {
        throw new Error(`NETWORK: the native Claude Code installer could not download (${unreachable ?? said}). Not a Walnut regression; rerun the job.`)
      }
    }
    expect(claudeFix, `no successful install-claude-native within ${FIX_WAIT_MS / 60_000} min: ${JSON.stringify(fixes)}`).toMatchObject({ ok: true })
    const compilerFix = fixes.find((f) => f.id === 'install-compiler')
    if (prebuilt) {
      expect(compilerFix, 'dtach already runs (step c), so gcc is pointless and sudo must not be asked for').toBeUndefined()
    } else {
      expect(compilerFix, 'gcc needs root, and alice cannot sudo without a password').toMatchObject({ ok: false, needsPassword: true })
    }
    expect(roundEnded, 'the autofix round should end after its last fix').toBe(true)
    // Exactly these, in order. With the prebuilt, step c already put dtach in place,
    // so neither gcc nor a dtach install (build-dtach) may run.
    expect(fixes.map((f) => f.id), JSON.stringify(fixes)).toEqual(wanted)

    const res = await timed('f. host.preflight after the fixes', () => requireConn().send('host.preflight', {}, 30_000))
    log(`f. preflight: ${JSON.stringify(res)}`)
    expect(res.claude).toMatchObject({ found: true, kind: 'native' })
    expect(res.compiler).toMatchObject({ found: false })
    expect(res.dtach).toMatchObject({ found: Boolean(prebuilt) })
  }, FIX_WAIT_MS + 120_000)
})

/** On failure: the tail of this run's own Walnut log for the host, so CI shows the cause. */
async function dumpLocalLog(): Promise<void> {
  try {
    const lines = await hostLogLines()
    log(`failed: ${failures.join('; ')}\n== local Walnut log, last 60 lines for host ${HOST_KEY}\n${lines.slice(-60).join('\n')}`)
  } catch (err) {
    log(`could not read the local log: ${err instanceof Error ? err.message : String(err)}`)
  }
}
