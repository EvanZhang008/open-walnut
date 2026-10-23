/**
 * scripts/dev-prod.sh must deploy on Linux, not just macOS (GitHub issue #11:
 * on an x64 Linux box the hardcoded /private/tmp server log made the deploy kill
 * the running server and then fail to start its replacement, leaving prod down).
 *
 * Two invariants pinned here:
 *   1. The log path exists on every platform, and its writability is proven
 *      BEFORE the first destructive step — a failed deploy must leave the old
 *      server serving.
 *   2. Listener detection works without lsof (a minimal Linux box may only have
 *      ss or fuser), and never silently fails open — a guard that sees "no
 *      server" when one is running starts a competitor against the same data dir.
 *
 * The script is only executed in DRY-RUN mode (WALNUT_DEVPROD_DRY_RUN=1), which
 * runs every guard and stops before the build, the server kill and the launch.
 * A plain run would target production :3456. Ordering of the guards is asserted
 * statically; individual shell helpers are exercised by slicing them out.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { execFile, execFileSync } from 'node:child_process'

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'dev-prod.sh')
const script = fs.readFileSync(SCRIPT, 'utf-8')

/** The PORT_PROBE detection + listener_pids() definition, standalone. */
function listenerPidsSnippet(): string {
  const start = script.indexOf('is_busybox() {')
  const fnStart = script.indexOf('listener_pids() {', start)
  const fnEnd = script.indexOf('\n}\n', fnStart)
  expect(start).toBeGreaterThan(-1)
  expect(fnEnd).toBeGreaterThan(fnStart)
  return script.slice(start, fnEnd + 3)
}

/** Async twin of runBash, for cases whose fixture (an HTTP stub) lives in THIS
 *  process and therefore cannot be served while a sync child blocks the loop. */
function runBashAsync(body: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('bash', ['-c', body], { encoding: 'utf-8' }, (err, stdout, stderr) => {
      const status = err ? ((err as { code?: number }).code ?? 1) : 0
      resolve({ status, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

function runBash(body: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bash', ['-c', body], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

describe('dev-prod.sh server log path', () => {
  it('is not pinned to the macOS-only /private/tmp', () => {
    // Comments still explain the old path; only executable lines matter.
    const code = script.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    expect(code).not.toMatch(/\/private\/tmp/)
  })

  it('defaults under /tmp and honours WALNUT_SERVER_LOG', () => {
    expect(script).toMatch(/SERVER_LOG="\$\{WALNUT_SERVER_LOG:-\/tmp\/open-walnut-launchd\.log\}"/)
  })

  it('proves appendability before any destructive step', () => {
    const check = script.indexOf('Cannot append to server log')
    const build = script.indexOf('npm run web:build')
    const launchdRemove = script.indexOf('  if ! remove_launchd_job; then\n', script.indexOf('  use_launchd=1\n'))
    const killExisting = script.indexOf('kill -15 $existing_pids')
    expect(check).toBeGreaterThan(-1)
    for (const destructive of [build, launchdRemove, killExisting]) {
      expect(destructive).toBeGreaterThan(-1)
      expect(check).toBeLessThan(destructive)
    }
  })

  it('rejects an unwritable log and accepts a writable one', () => {
    const guard = script.slice(script.indexOf('if ! ( : >> "$SERVER_LOG" )'), script.indexOf('# ── Portable listener detection'))
    const bad = runBash(`SERVER_LOG=/definitely-not-a-dir-${process.pid}/x.log\n${guard}`)
    expect(bad.status).toBe(1)
    expect(bad.stderr).toMatch(/Cannot append to server log/)

    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devprod-log-')), 'server.log')
    const good = runBash(`SERVER_LOG=${logPath}\n${guard}`)
    expect(good.status).toBe(0)
  })
})

// The script refuses to deploy from a niced shell (a starved server looks like an
// app bug). A background agent session can be niced, and it would then fail these
// runs for a reason that has nothing to do with portability.
const shellNice = Number(runBash('ps -o ni= -p $$').stdout.trim() || '0')

/** The bun version package.json pins (packageManager), which the file build needs. */
const BUN_PIN = /^bun@(\d+\.\d+\.\d+)/.exec(JSON.parse(fs.readFileSync(path.join(path.dirname(SCRIPT), '..', 'package.json'), 'utf-8')).packageManager ?? '')?.[1] ?? '1.0.0'

/**
 * A dir holding stand-ins for bun and node that only answer `--version`: the
 * dry run asks nothing else, so the file path is exercised on any OS whether or
 * not a real bun of the pinned version is installed.
 */
function standIns(bunVersion = BUN_PIN): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devprod-tools-'))
  fs.writeFileSync(path.join(dir, 'bun'), `#!/bin/sh\n[ "$1" = --version ] && echo ${bunVersion}\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\n[ "$1" = --version ] && echo v24.0.0\n', { mode: 0o755 })
  return dir
}
// A host with no port probe at all is a legitimate script refusal, not a failure
// to assert here (the "never falls open" test below covers that path directly).
const hasProbe = runBash('command -v lsof || command -v ss || command -v fuser').status === 0

describe.skipIf(shellNice > 0 || !hasProbe)('dev-prod.sh dry run (whole script, this OS)', () => {
  /** A port nothing is listening on right now. */
  async function freePort(): Promise<number> {
    const srv = net.createServer()
    const port = await new Promise<number>((resolve, reject) => {
      srv.once('error', reject)
      srv.listen(0, '127.0.0.1', () => resolve((srv.address() as net.AddressInfo).port))
    })
    await new Promise<void>((r) => srv.close(() => r()))
    return port
  }

  /**
   * Runs the REAL script through every guard on whatever platform the suite runs
   * on — macOS locally, Linux in CI. Isolated: a free port, its own TMPDIR (so the
   * lock and cooldown stamps never touch a real deploy's) and its own log.
   */
  async function dryRun(env: Record<string, string> = {}): Promise<{
    status: number; stdout: string; stderr: string; tmp: string
  }> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devprod-dry-'))
    const args = Object.entries({
      WALNUT_DEVPROD_DRY_RUN: '1',
      WALNUT_DEVPROD_PORT: String(await freePort()),
      TMPDIR: tmp,
      WALNUT_SERVER_LOG: path.join(tmp, 'server.log'),
      PATH: `${standIns()}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      ...env,
    }).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
    return { ...runBash(`${args} bash ${JSON.stringify(SCRIPT)}`), tmp }
  }

  it('deploys the compiled file by default: this machine\'s target, the Linux files beside it', async () => {
    const r = await dryRun()
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/would run the compiled file walnut-(darwin|linux)-(arm64|x64)(-musl)? \(bun /)
    expect(r.stdout).toMatch(/with linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl beside it/)
    expect(r.stdout).toMatch(/helper scripts \(type-check, render checks, publish\) run on \S+\/bun;/)
    const none = await dryRun({ WALNUT_DEVPROD_FILE_TARGETS: '' })
    expect(none.stdout).not.toMatch(/beside it/)
    const bad = await dryRun({ WALNUT_DEVPROD_FILE_TARGETS: 'linux-x64 plan9-mips' })
    expect(bad.status).toBe(1)
    expect(bad.stderr).toMatch(/unknown target 'plan9-mips'/)
  })

  it('WALNUT_DEVPROD_RUNTIME=node is the way back to the Node build, and nothing else is accepted', async () => {
    const node = await dryRun({ WALNUT_DEVPROD_RUNTIME: 'node' })
    expect(node.status, node.stderr).toBe(0)
    expect(node.stdout).toMatch(/would run node .* with dist\/cli\.js \(WALNUT_DEVPROD_RUNTIME=node\)\./)
    // The way back from a bun problem runs its helpers on node, bun or not.
    expect(node.stdout).toMatch(/helper scripts \(type-check, render checks, publish\) run on \S+\/node;/)
    const other = await dryRun({ WALNUT_DEVPROD_RUNTIME: 'deno' })
    expect(other.status).toBe(1)
    expect(other.stderr).toMatch(/WALNUT_DEVPROD_RUNTIME='deno' is neither file/)
    expect(other.stdout).not.toMatch(/every guard passed/)
  })

  // Every place find_bun looks besides PATH; a real bun there of the pinned
  // version would (rightly) be picked, so the refusal case skips on such a box.
  const fixedBunPlaces = ['/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  it.skipIf(fixedBunPlaces.some((p) => fs.existsSync(p)))('refuses, before any step, a machine whose bun is older than the pin', async () => {
    const tools = standIns('0.0.1')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devprod-home-'))
    const r = await dryRun({ PATH: `${tools}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(new RegExp(`needs bun ${BUN_PIN.replace(/\./g, '\\.')} or newer`))
    expect(r.stderr).toMatch(/Found only: 0\.0\.1 at /)
    expect(r.stderr).toMatch(/WALNUT_DEVPROD_RUNTIME=node/)
    expect(r.stdout).not.toMatch(/every guard passed/)
  })

  it('passes every guard and stops before anything is deployed', async () => {
    const r = await dryRun()
    expect(r.stderr + r.stdout).toMatch(/every guard passed on \w+/)
    expect(r.stdout).toMatch(/nothing was deployed/)
    expect(r.status).toBe(0)
    // No build, no kill, no launch.
    expect(r.stdout).not.toMatch(/web:build|Server ready|Reaping stray/)
  })

  it('exercises the deploy drain (probe + parse) without waiting', async () => {
    const r = await dryRun()
    expect(r.status).toBe(0)
    // The dry-run port has no server, so the probe takes the "cannot tell →
    // proceed" arm. A zero budget means the dry run never sleeps.
    expect(r.stdout).toMatch(/Drain: .* did not answer the active-turn probe — proceeding/)
  })

  it('still fails fast on an unwritable log', async () => {
    const r = await dryRun({ WALNUT_SERVER_LOG: `/definitely-not-a-dir-${process.pid}/server.log` })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/Cannot append to server log/)
    expect(r.stdout).not.toMatch(/every guard passed/)
  })

  it('leaves no cooldown stamp and no lock — must not block a real deploy', async () => {
    const r = await dryRun()
    expect(r.status).toBe(0)
    expect(fs.existsSync(path.join(r.tmp, 'open-walnut-dev-prod.last-attempt'))).toBe(false)
    expect(fs.existsSync(path.join(r.tmp, 'open-walnut-dev-prod.lock'))).toBe(false)
  })

  it('serves as WALNUT_DEVPROD_SERVE_ROOT, and refuses one that is not a checkout before any step', async () => {
    const repo = path.resolve(path.dirname(SCRIPT), '..')
    const ok = await dryRun({ WALNUT_DEVPROD_SERVE_ROOT: repo })
    expect(ok.status).toBe(0)
    expect(ok.stdout).toMatch(/every guard passed/)
    const bad = await dryRun({ WALNUT_DEVPROD_SERVE_ROOT: `/definitely-not-a-checkout-${process.pid}` })
    expect(bad.status).toBe(1)
    expect(bad.stderr).toMatch(/WALNUT_DEVPROD_SERVE_ROOT is not a Walnut checkout/)
    expect(bad.stdout).not.toMatch(/every guard passed/)
    // The server runs as the serve root: its cwd, its node_modules (stage and
    // rollback copy alike) and the source repo it reports. The build stays REPO_ROOT's.
    expect(script).toMatch(/ln -sfn "\$SERVE_ROOT\/node_modules" "\$STAGE_DIR\/node_modules"/)
    expect(script).toMatch(/ln -sfn "\$SERVE_ROOT\/node_modules" "\$LKG_DIR\.tmp\/node_modules"/)
    expect(script).toMatch(/printf '%s\\n' "\$SERVE_ROOT" > "\$STAGE_DIR\/\.walnut-source-root"/)
    expect(script).toMatch(/open-walnut\n\s*"\$SERVE_ROOT" \/usr\/bin\/env/)
    expect(script).toMatch(/cp -Rc "\$REPO_ROOT\/dist" "\$STAGE_DIR\/dist"/)
    expect(script).not.toMatch(/ln -sfn "\$REPO_ROOT\/node_modules"/)
  })

  it('honours the port override only in dry-run mode and in a guarded rehearsal', () => {
    // The override must never let a real deploy start a second server against the
    // production data dir, so it is read inside the dry-run branch, and in the
    // rehearsal branch only next to the refusals of the production data and daemon dirs.
    const decl = script.slice(0, script.indexOf('LOCK_DIR='))
    expect(decl).toMatch(/if \[\[ "\$DRY_RUN" == "1" \]\]; then\n\s*PORT="\$\{WALNUT_DEVPROD_PORT:-\$PORT\}"/)
    const readers = decl.split('\n').filter((l) => l.includes('WALNUT_DEVPROD_PORT') && !/^\s*#/.test(l) && !/^\s*echo /.test(l))
    expect(readers.map((l) => l.trim())).toEqual(['PORT="${WALNUT_DEVPROD_PORT:-$PORT}"', 'PORT="${WALNUT_DEVPROD_PORT:-}"'])
    const rehearsal = decl.slice(decl.indexOf('if [[ "$REHEARSAL" == "1" ]]; then'))
    for (const refusal of ['other than 3456', '3457 (the Playwright fixture server)', 'production data dir', 'production daemon dir', 'production server log', 'named open-walnut*', 'keeps its LKG']) {
      expect(rehearsal).toContain(refusal)
    }
    expect(rehearsal).toMatch(/LAUNCH_LABEL="com\.open-walnut\.dev-prod-rehearsal\.\$PORT"/)
  })

  describe('rehearsal guards (WALNUT_DEVPROD_REHEARSAL=1, checked in dry-run)', () => {
    function rehearsalDirs() {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devprod-rehearse-')))
      const dirs = { root, scratch: path.join(root, 'scratch'), home: path.join(root, 'data'), daemon: path.join(root, 'daemon'), fakeHome: path.join(root, 'user') }
      for (const d of [dirs.scratch, dirs.fakeHome]) fs.mkdirSync(d, { recursive: true })
      return { ...dirs, state: path.join(dirs.scratch, 'rehearsal-state') }
    }
    const rehearse = async (env: Record<string, string>) => dryRun({ WALNUT_DEVPROD_REHEARSAL: '1', ...env })
    const base = async (d: ReturnType<typeof rehearsalDirs>) => ({
      WALNUT_DEVPROD_PORT: String(await freePort()), WALNUT_DEVPROD_REHEARSAL_DIR: d.scratch,
      OPEN_WALNUT_HOME: d.home, WALNUT_DAEMON_DIR: d.daemon, HOME: d.fakeHome, WALNUT_SERVER_LOG: '',
    })

    it('accepts private dirs and a private port, and keeps every deploy file in its own state dir', async () => {
      const d = rehearsalDirs()
      const env = await base(d)
      // No WALNUT_SERVER_LOG: a rehearsal's default log is in its state dir, never the production one.
      const r = await rehearse(env)
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout).toContain(`Rehearsal: the real deploy path on :${env.WALNUT_DEVPROD_PORT}`)
      expect(r.stdout).toContain(`label com.open-walnut.dev-prod-rehearsal.${env.WALNUT_DEVPROD_PORT}`)
      expect(r.stdout).toMatch(new RegExp(`log: ${d.state}/open-walnut-launchd\\.log`))
      expect(r.stdout).toContain(`temp dir ${d.state}.`)
      expect(r.stdout).toMatch(/every guard passed/)
      // The dirs are made only once every check passed; a dry run leaves no lock or stamp.
      expect(fs.existsSync(d.home) && fs.existsSync(d.daemon) && fs.existsSync(d.state)).toBe(true)
      expect(fs.readdirSync(d.state).filter((f) => f.startsWith('open-walnut-dev-prod'))).toEqual([])
    })

    it("handed the caller's own TMPDIR, never reads or writes production's lock, stamps or LKG there", async () => {
      // A deploy's lock, cooldown stamps and LKG are named files in TMPDIR. A
      // rehearsal that used the dir itself read production's fresh success stamp
      // (and skipped as "already current"), took its lock and replaced its LKG.
      const d = rehearsalDirs()
      const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'devprod-shared-tmp-'))
      fs.writeFileSync(path.join(shared, 'open-walnut-dev-prod.last-success'), `${Math.floor(Date.now() / 1000)}\n`)
      const r = await dryRun({ WALNUT_DEVPROD_REHEARSAL: '1', ...(await base(d)), WALNUT_DEVPROD_REHEARSAL_DIR: shared, TMPDIR: shared })
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout).not.toMatch(/Deploy skipped/)
      expect(r.stdout).toContain(`temp dir ${fs.realpathSync(shared)}/rehearsal-state.`)
      expect(fs.readdirSync(shared).sort()).toEqual(['open-walnut-dev-prod.last-success', 'rehearsal-state'])
    })

    it('refuses a port another process serves, and accepts one that runs from its own stage', async () => {
      // 2026-10-23 review: a rehearsal on :3457 would have stopped another agent's
      // Playwright fixture server; any foreign listener is now a refusal.
      const d = rehearsalDirs()
      const env = await base(d)
      const port = Number(env.WALNUT_DEVPROD_PORT)
      const foreign = net.createServer()
      await new Promise<void>((resolve) => foreign.listen(port, '127.0.0.1', () => resolve()))
      try {
        const r = await rehearse({ ...env, WALNUT_DEVPROD_FORCE: '1' })
        expect(r.status).toBe(1)
        expect(r.stderr).toMatch(new RegExp(`:${port} is served by PID ${process.pid}, which this rehearsal did not start`))
        expect(r.stdout).not.toMatch(/every guard passed/)
      } finally {
        await new Promise<void>((resolve) => foreign.close(() => resolve()))
      }
      // A listener whose command line names one of its stages is its own server.
      const prog = path.join(d.state, 'open-walnut-stage.1.2', 'dist-bin', 'walnut-test.cjs')
      fs.mkdirSync(path.dirname(prog), { recursive: true })
      fs.writeFileSync(prog, `require('net').createServer().listen(${port}, '127.0.0.1', () => console.log('up')); setTimeout(() => {}, 60000)\n`)
      const owned = execFile(process.execPath, [prog, 'web', '--port', String(port)])
      try {
        await new Promise<void>((resolve) => owned.stdout!.once('data', () => resolve()))
        const r = await rehearse({ ...env, WALNUT_DEVPROD_FORCE: '1' })
        expect(r.status, r.stderr).toBe(0)
        expect(r.stdout).toMatch(/every guard passed/)
      } finally {
        owned.kill('SIGKILL')
      }
    })

    it.each([
      ['the production port', { WALNUT_DEVPROD_PORT: '3456' }, /other than 3456/],
      ['the Playwright fixture port', { WALNUT_DEVPROD_PORT: '3457' }, /3457 \(the Playwright fixture server\)/],
      ['no port', { WALNUT_DEVPROD_PORT: '' }, /other than 3456/],
      ['no scratch dir', { WALNUT_DEVPROD_REHEARSAL_DIR: '' }, /WALNUT_DEVPROD_REHEARSAL_DIR must be an existing absolute directory/],
      ['no data dir', { OPEN_WALNUT_HOME: '' }, /set OPEN_WALNUT_HOME and WALNUT_DAEMON_DIR/],
      ['the production data dir', { OPEN_WALNUT_HOME: '<user>/.open-walnut' }, /is the production data dir/],
      ['a dir inside the production data dir', { OPEN_WALNUT_HOME: '<user>/.open-walnut/rehearsal' }, /is the production data dir/],
      ['a data dir named like an ephemeral one', { OPEN_WALNUT_HOME: '<root>/open-walnut-x' }, /named open-walnut\*/],
      ['the production daemon dir', { WALNUT_DAEMON_DIR: '/tmp/open-walnut' }, /production daemon dir/],
      ["a host's fallback daemon dir", { WALNUT_DAEMON_DIR: '<user>/.cache/open-walnut' }, /production daemon dir/],
      ['the production server log', { WALNUT_SERVER_LOG: '/tmp/open-walnut-launchd.log' }, /production server log/],
      ['a rollback snapshot it is pointed at', { WALNUT_DEVPROD_LKG_DIR: '<root>/scratch/rehearsal-state/lkg' }, /keeps its LKG in/],
    ])('refuses %s', async (_what, override, why) => {
      const d = rehearsalDirs()
      fs.mkdirSync(path.join(d.fakeHome, '.open-walnut'), { recursive: true })
      fs.mkdirSync(path.join(d.fakeHome, '.cache'), { recursive: true })
      const env: Record<string, string> = await base(d)
      for (const [k, v] of Object.entries(override)) env[k] = v.replace('<user>', d.fakeHome).replace('<root>', d.root)
      // The production daemon dir must never be created by a refused run.
      const prodDaemonExisted = fs.existsSync('/tmp/open-walnut')
      const r = await rehearse(env)
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(why)
      expect(r.stdout).not.toMatch(/every guard passed/)
      expect(fs.existsSync(d.state)).toBe(false)
      expect(fs.existsSync(path.join(d.fakeHome, '.cache', 'open-walnut'))).toBe(false)
      if (!prodDaemonExisted) expect(fs.existsSync('/tmp/open-walnut')).toBe(false)
    })
  })
})

// ── Deploy drain ────────────────────────────────────────────────────────────
// A kill landing inside a Personal AI lane turn strands the answer: the CLI is
// daemon-owned so it survives and writes the reply, but the process that
// persists it into the conversation is the one being killed. The drain waits for
// quiet first — and, just as importantly, NEVER hangs a deploy: an unreachable
// or wedged server must proceed exactly as before.
describe('dev-prod.sh deploy drain', () => {
  /** The DRAIN_SECS default + both drain helpers, standalone. */
  function drainSnippet(): string {
    const start = script.indexOf('DRAIN_SECS="${WALNUT_DEVPROD_DRAIN_SECS')
    const fnStart = script.indexOf('drain_active_turns() {', start)
    const fnEnd = script.indexOf('\n}\n', fnStart)
    expect(start).toBeGreaterThan(-1)
    expect(fnEnd).toBeGreaterThan(fnStart)
    return script.slice(start, fnEnd + 3)
  }

  /** Runs the drain against a real one-shot HTTP server returning `body`. */
  async function drainAgainst(
    body: string | null,
    env: Record<string, string> = {},
  ): Promise<{ status: number; stdout: string; stderr: string }> {
    let port: number
    let server: import('node:http').Server | undefined
    if (body === null) {
      // Nothing listening: bind, learn the port, release it.
      const probe = net.createServer()
      port = await new Promise<number>((resolve, reject) => {
        probe.once('error', reject)
        probe.listen(0, '127.0.0.1', () => resolve((probe.address() as net.AddressInfo).port))
      })
      await new Promise<void>((r) => probe.close(() => r()))
    } else {
      const http = await import('node:http')
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(body)
      })
      // No bind host: the script probes `localhost`, which resolves to ::1 first
      // on this machine — a stub pinned to 127.0.0.1 would look unreachable and
      // silently test the wrong branch.
      port = await new Promise<number>((resolve, reject) => {
        server!.once('error', reject)
        server!.listen(0, () => resolve((server!.address() as net.AddressInfo).port))
      })
    }
    try {
      const assignments = Object.entries(env)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n')
      // ASYNC exec, not the file's execFileSync helper: the stub server lives in
      // THIS process, so a synchronous child would block the event loop and the
      // probe could never be answered — every case would silently degrade to the
      // "unreachable" arm and the test would prove nothing.
      return await runBashAsync([
        'set -euo pipefail',
        `PORT=${port}`,
        assignments,
        drainSnippet(),
        'drain_active_turns',
        'echo REACHED_KILL',
      ].join('\n'))
    } finally {
      if (server) await new Promise<void>((r) => server!.close(() => r()))
    }
  }

  it('waits before the kill, not after it', () => {
    const drainCall = script.indexOf('\ndrain_active_turns\n')
    const launchdRemove = script.indexOf('  if ! remove_launchd_job; then\n', script.indexOf('  use_launchd=1\n'))
    const killExisting = script.indexOf('kill -15 $existing_pids')
    expect(drainCall).toBeGreaterThan(-1)
    for (const destructive of [launchdRemove, killExisting]) {
      expect(destructive).toBeGreaterThan(-1)
      expect(drainCall).toBeLessThan(destructive)
    }
  })

  it('proceeds immediately when nothing answers the probe', async () => {
    const r = await drainAgainst(null)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/did not answer the active-turn probe — proceeding/)
    expect(r.stdout).toMatch(/REACHED_KILL/)
  })

  it('proceeds immediately when the server reports a quiet box', async () => {
    const r = await drainAgainst('{"activeTurns":0,"queueActive":0,"queueQueued":0,"relayedTurns":0}')
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/no Personal AI turn in flight/)
    expect(r.stdout).toMatch(/REACHED_KILL/)
  })

  it('waits when a turn is in flight, then proceeds on a bounded timeout', async () => {
    const r = await drainAgainst('{"activeTurns":2,"queueActive":1,"queueQueued":0,"relayedTurns":1}', {
      WALNUT_DEVPROD_DRAIN_SECS: '1',
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/2 Personal AI turn\(s\) in flight/)
    expect(r.stderr).toMatch(/Drain TIMEOUT: 2 turn\(s\) still in flight after 1s/)
    // Bounded means bounded — the deploy still gets to the kill.
    expect(r.stdout).toMatch(/REACHED_KILL/)
  })

  it('honours WALNUT_DEVPROD_SKIP_DRAIN=1 without probing at all', async () => {
    const r = await drainAgainst('{"activeTurns":9}', {
      WALNUT_DEVPROD_SKIP_DRAIN: '1', WALNUT_DEVPROD_DRAIN_SECS: '600',
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/Drain skipped/)
    expect(r.stdout).toMatch(/REACHED_KILL/)
  })

  it('falls back to the default budget on a non-numeric knob instead of dying', async () => {
    // `$(( DRAIN_SECS * 2 ))` treats an identifier-shaped value as an UNSET
    // variable, so under `set -u` a typo'd knob used to abort the deploy — after
    // the full build and smoke boot, with a message that never named the knob.
    for (const junk of ['abc', 'off', 'none', 'true']) {
      const r = await drainAgainst('{"activeTurns":0}', { WALNUT_DEVPROD_DRAIN_SECS: junk })
      expect(r.status, `${junk} must not abort the deploy`).toBe(0)
      expect(r.stderr).toMatch(/is not a whole number of seconds; using 90/)
      expect(r.stdout).toMatch(/REACHED_KILL/)
    }
  })

  it('treats a junk body as "cannot tell" and proceeds', async () => {
    const r = await drainAgainst('<html>not json</html>', { WALNUT_DEVPROD_DRAIN_SECS: '600' })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/did not answer the active-turn probe — proceeding/)
    expect(r.stdout).toMatch(/REACHED_KILL/)
  })
})

describe('dev-prod.sh listener detection', () => {
  it('handles hosts without lsof (ss / fuser arms present)', () => {
    const snippet = listenerPidsSnippet()
    expect(snippet).toMatch(/for probe in lsof ss fuser/)
    expect(snippet).toMatch(/^\s*ss\)/m)
    expect(snippet).toMatch(/^\s*fuser\)/m)
  })

  it('never falls open: no probe at all is a hard failure', () => {
    const snippet = listenerPidsSnippet()
    // Empty PATH → command -v finds nothing → the script must refuse, not
    // proceed as if the port were free.
    const r = runBash(`set -euo pipefail\nPORT=3456\nPATH=/nonexistent-${process.pid}\n${snippet}\necho REACHED`)
    expect(r.status).toBe(1)
    expect(r.stdout).not.toMatch(/REACHED/)
    expect(r.stderr).toMatch(/lsof \/ ss \/ fuser/)
  })

  // Alpine's BusyBox answers to lsof, fuser and ps, and takes none of the options
  // used here (its lsof lists every open file, its fuser has no -n, its ps no -p).
  function withStubs(stubs: Record<string, string>, tail: string): { status: number; stdout: string; stderr: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devprod-busybox-'))
    for (const [name, body] of Object.entries(stubs)) fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    const tools = path.join(dir, 'tools')
    fs.mkdirSync(tools)
    for (const t of ['grep', 'cut', 'sort', 'tr', 'sh']) {
      const real = execFileSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf-8' }).trim()
      fs.symlinkSync(real, path.join(tools, t))
    }
    return runBash(`set -euo pipefail\nPORT=3456\nPATH=${dir}:${tools}\n${listenerPidsSnippet()}\n${tail}`)
  }
  const busybox = `if [ "$1" = --help ]; then echo 'BusyBox v1.36.1 (2024-06-10) multi-call binary.'; exit 1; fi\necho '1\t/bin/busybox\t0\t/dev/null'`

  it('never takes a BusyBox applet for a probe', () => {
    const r = withStubs({ lsof: busybox, fuser: busybox }, 'echo REACHED')
    expect(r.status).toBe(1)
    expect(r.stdout).not.toMatch(/REACHED/)
    expect(r.stderr).toMatch(/not BusyBox's/)
  })

  it('passes over a BusyBox lsof to a real ss', () => {
    const ss = `printf '%s\\n' 'LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("walnut",pid=4242,fd=20))'`
    const r = withStubs({ lsof: busybox, ss }, 'echo "probe=$PORT_PROBE"; listener_pids')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim().split('\n')).toEqual(['probe=ss', '4242'])
  })

  it('refuses a BusyBox ps: every server check looks up one process with -p', () => {
    const ss = `printf '%s\\n' 'LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("walnut",pid=4242,fd=20))'`
    const r = withStubs({ ss, ps: busybox }, 'echo REACHED')
    expect(r.status).toBe(1)
    expect(r.stdout).not.toMatch(/REACHED/)
    expect(r.stderr).toMatch(/Install procps/)
  })

  // The ss/fuser arms can't run on macOS, so their PARSING (the part that can
  // silently return garbage) is pinned against canonical Linux output shapes.
  function withStubProbe(name: string, body: string): { status: number; stdout: string; stderr: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `devprod-${name}-`))
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    // PATH holds the stub plus only the text tools the snippet pipes through. Nothing
    // else: with /usr/bin on PATH a Linux box finds its real lsof first (macOS keeps
    // lsof in /usr/sbin, which is why this passed there), and the stub is never consulted.
    const tools = path.join(dir, 'tools')
    fs.mkdirSync(tools)
    for (const t of ['grep', 'cut', 'sort', 'tr', 'sh']) {
      const real = execFileSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf-8' }).trim()
      fs.symlinkSync(real, path.join(tools, t))
    }
    return runBash(`set -euo pipefail\nPORT=3456\nPATH=${dir}:${tools}\n${listenerPidsSnippet()}\nlistener_pids`)
  }

  it('parses Linux `ss -ltnp` output', () => {
    const r = withStubProbe('ss', [
      `printf '%s\\n' 'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process'`,
      `printf '%s\\n' 'LISTEN 0      511           0.0.0.0:3456       0.0.0.0:*     users:(("node",pid=12345,fd=20))'`,
    ].join('\n'))
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('12345')
  })

  it('parses Linux `fuser -n tcp` output (pids on stdout, label on stderr)', () => {
    const r = withStubProbe('fuser', [
      `printf '%s' '3456/tcp:' >&2`,
      `printf '%s\\n' ' 12345  6789'`,
    ].join('\n'))
    expect(r.status).toBe(0)
    expect(r.stdout.trim().split(/\s+/)).toEqual(['12345', '6789'])
  })

  it('reports the pid of a real listener, and nothing once it closes', async () => {
    const server = net.createServer()
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
    })
    const snippet = listenerPidsSnippet()
    const body = (p: number) => `set -euo pipefail\nPORT=${p}\n${snippet}\nlistener_pids`

    const found = runBash(body(port))
    expect(found.status).toBe(0)
    expect(found.stdout.trim().split('\n').filter(Boolean)).toContain(String(process.pid))

    await new Promise<void>((resolve) => server.close(() => resolve()))
    const gone = runBash(body(port))
    // Exit 0 with empty output — a non-zero status inside `x="$(listener_pids)"`
    // would abort the whole deploy under `set -e`.
    expect(gone.status).toBe(0)
    expect(gone.stdout.trim()).toBe('')
  })
})
