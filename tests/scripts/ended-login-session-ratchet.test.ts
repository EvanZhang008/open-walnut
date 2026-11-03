/**
 * The class "a Walnut process lives on where its environment is gone" (2026-11-03:
 * a deploy during a macOS logout left a server and its daemon in the ended login
 * session for hours: ssh "No user exists for uid 503", no DNS, and a deleted build
 * clone as the server's cwd, so the voice model died with FileNotFoundError; the
 * Mac app's first launch then timed out on that busy server, started its own,
 * the data-dir lock refused it, and the launch ended on an error screen).
 *
 * Each member below is enumerated from the source, so a new signal, a new server
 * launch path or a new copy of the probe that misses its part fails here:
 *   - every login-session signal is judged everywhere it is read (the server, the
 *     deploy script, the Mac app) and has words for the user;
 *   - the deploy refuses an ended session before its first destructive step;
 *   - every way the deploy and the Mac app start a server names a working
 *     directory that outlives the starter, and the server heals a deleted one at
 *     boot and on its monitor, so no child inherits one;
 *   - the Mac app never answers a refused second server with an error screen
 *     while a server owns the data dir, and replaces one in an ended session;
 *   - a server in a working session replaces a local daemon in an ended one, and
 *     its CLIs are recycled through the idle reaper, never killed.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { LOGIN_SESSION_PROBLEMS, LOGIN_SESSION_PROBE_SCRIPT } from '../../src/core/login-session.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const devProd = read('scripts/dev-prod.sh')
const swiftDiag = read('desktop/DesktopDiagnostics.swift')
const swiftMain = read('desktop/main.swift')
const SESSION_SIGNALS = LOGIN_SESSION_PROBLEMS.filter((p) => p !== 'cwd_gone')

/** login_session_problems() from dev-prod.sh, standalone. */
function probeFn(): string {
  const start = devProd.indexOf('login_session_problems() {')
  const end = devProd.indexOf('\n}\n', start)
  expect(start).toBeGreaterThan(-1)
  return devProd.slice(start, end + 3)
}

function runProbe(output: string): string {
  const body = `REHEARSAL=0\n${probeFn()}\nlogin_session_problems`
  return execFileSync('bash', ['-c', body], {
    encoding: 'utf8',
    env: { ...process.env, WALNUT_DEVPROD_DRY_RUN: '1', WALNUT_DEVPROD_LOGIN_PROBE_CMD: `printf '%b' ${JSON.stringify(output)}` },
  }).trim()
}

describe('every login-session signal is read everywhere', () => {
  it('the deploy runs the same probe the server runs', () => {
    expect(devProd).toContain(`local probe="${LOGIN_SESSION_PROBE_SCRIPT}"`)
  })

  it('the deploy names each session signal, and the Mac app acts on each one', () => {
    for (const p of SESSION_SIGNALS) {
      expect(probeFn(), p).toContain(`printf '${p} '`)
      expect(swiftDiag, p).toContain(`"${p}"`)
    }
  })

  it('the deploy reads an ended session, and a working one as none', () => {
    const uid = String(process.getuid?.() ?? 0)
    expect(runProbe(`--walnut-id--\n${uid}\n--walnut-dns--\nNo DNS configuration available\n`)).toBe('user_lookup dns_config')
    expect(runProbe(`--walnut-id--\nid: ${uid}: no such user\n--walnut-dns--\n`)).toBe('user_lookup')
    expect(runProbe('--walnut-id--\nsomeone\n--walnut-dns--\nDNS configuration\n')).toBe('')
    expect(runProbe(`${uid}\n--walnut-id--\nsomeone\n--walnut-dns--\n`)).toBe('')
    expect(runProbe('')).toBe('')
  })

  it('only a dry run or a rehearsal may name its own probe', () => {
    expect(probeFn()).toMatch(/WALNUT_DEVPROD_LOGIN_PROBE_CMD:-\}" \]\] && \[\[ "\$\{WALNUT_DEVPROD_DRY_RUN:-0\}" == "1" \|\| "\$REHEARSAL" == "1" \]\]/)
  })
})

describe('the deploy refuses an ended session before anything it cannot undo', () => {
  it('the refusal comes before the build, the launchd removal and the kill', () => {
    const refuse = devProd.indexOf('Deploy refused: this shell runs in a macOS login session that has ended')
    expect(refuse).toBeGreaterThan(-1)
    for (const step of ['--bun run web:build', '  if ! remove_launchd_job; then\n', 'kill -15 $existing_pids', 'date +%s > "$ATTEMPT_STAMP"']) {
      const at = devProd.indexOf(step)
      expect(at, step).toBeGreaterThan(-1)
      expect(refuse, step).toBeLessThan(at)
    }
  })
})

describe('no server starts in a directory that may be deleted', () => {
  it('every server launch in the deploy script cds into the checkout first', () => {
    const lines = devProd.split('\n')
    const launches = lines.flatMap((l, i) => (/"\$\{server_argv\[@\]\}" web --port/.test(l) && !/^\s*#/.test(l) ? [i] : []))
    expect(launches.length).toBeGreaterThanOrEqual(2) // the launchd job and the nohup fallback
    for (const i of launches) {
      const block = lines.slice(Math.max(0, i - 12), i + 1).join('\n')
      expect(block, `launch at dev-prod.sh:${i + 1}`).toMatch(/\/bin\/sh -c 'cd "\$1" && shift && exec "\$@"' open-walnut\s*\\?\s*\n?\s*"\$SERVE_ROOT"/)
    }
  })

  it('every server launch of the Mac app names its directory', () => {
    const runtime = read('desktop/BundledRuntime.swift')
    const launches = [...runtime.matchAll(/Launch\(executable:[^\n]*/g)].map((m) => m[0])
    expect(launches.length).toBeGreaterThanOrEqual(3)
    for (const l of launches) expect(l).toMatch(/directory: [A-Za-z]/)
    expect(swiftMain).toContain('process.currentDirectoryURL = URL(fileURLWithPath: launch.directory)')
  })

  it('the server heals a deleted cwd at boot, before anything else, and keeps checking', () => {
    const web = read('src/commands/web.ts')
    const body = web.slice(web.indexOf('export async function runWeb('))
    const heal = body.indexOf("import('../core/login-session.js')).healCwd()")
    expect(heal).toBeGreaterThan(-1)
    expect(heal).toBeLessThan(body.indexOf('bootEnvOf(process.env)'))
    expect(body).toContain("import('../core/login-session.js')).startLoginSessionMonitor()")
    expect(read('src/core/login-session.ts')).toMatch(/const pass = \(async \(\) => \{\n\s*const healed = healCwd\(\)/)
  })

  it('every long-lived Walnut process keeps a working directory that exists (a child inherits only its parent\'s)', () => {
    // The server: healCwd at boot and on its monitor (above). The daemon, both twins:
    for (const twin of ['src/providers/daemon-standalone.ts', 'src/providers/daemon-source.ts']) {
      const src = read(twin)
      expect(src, twin).toMatch(/function healDaemonCwd\(\)/)
      expect(src, twin).toMatch(/\nhealDaemonCwd\(\);?\n/)
      expect(src, twin).toMatch(/setInterval\(healDaemonCwd, 60_?000\)/)
    }
    // The Mac app is started by LaunchServices in "/", and names the server's directory (below).
  })

  it('the local daemon is spawned in its own directory', () => {
    const src = read('src/providers/local-daemon.ts')
    const spawns = [...src.matchAll(/= spawn\(/g)].map((m) => src.slice(m.index!, m.index! + 400))
    expect(spawns.length).toBeGreaterThanOrEqual(2)
    for (const s of spawns) expect(s).toMatch(/\{[^}]*\bcwd: this\.daemonDir,/)
  })
})

describe('the processes in the current session replace the ones in an ended session', () => {
  it('/api/config reports the server\'s login session', () => {
    expect(read('src/web/routes/config.ts')).toContain("loginSession: (await import('../../core/login-session.js')).loginSessionState()")
  })

  it('the Mac app waits for the data dir\'s owner instead of an error screen, and replaces one in an ended session', () => {
    const start = swiftMain.slice(swiftMain.indexOf('    func startServer() {'), swiftMain.indexOf('    func checkExistingServer('))
    expect(start).toMatch(/if let holder = liveLockHolder\(\) \{\s*waitForRunningServer\(holder\)/)
    const failure = swiftMain.slice(swiftMain.indexOf('    func handleServerStartupFailure('))
    expect(failure.slice(0, 900)).toMatch(/if let holder = liveLockHolder\(\) \{[\s\S]*waitForRunningServer\(holder\)[\s\S]*return\s*\}\s*if isRecoveringServer/)
    // Every attach goes through the login-session check: the plain attach is called
    // only from the check and from the replacement that could not replace.
    expect(swiftMain).toMatch(/func attachExistingServer\(port: Int\) \{[\s\S]*?ServerLoginSession\.endedSessionProblems[\s\S]*?replaceEndedSessionServer/)
    const fnStart = swiftMain.indexOf('    func attachExistingServer(port: Int) {')
    const fnEnd = swiftMain.indexOf('    func attachServer(port: Int) {')
    const outside = swiftMain.slice(0, fnStart) + swiftMain.slice(fnEnd + 10)
    expect(outside).not.toMatch(/attachServer\(port:/)
    expect(swiftMain.match(/attachExistingServer\(port:/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('the server replaces a local daemon in an ended session and lets the idle reaper recycle its CLIs', () => {
    const daemon = read('src/providers/local-daemon.ts')
    // Through the version-mismatch path, with its holds (open ACP turns, fold prewarm).
    expect(daemon).toMatch(/const sessionEnded = [^\n]*_sessionEnded\.has\(helloResult\.instanceId\)\n\s*if \(\(expectedVersion && helloResult\.version && helloResult\.version !== expectedVersion\) \|\| sessionEnded\) \{\n[\s\S]{0,1200}?readAcpBusySids/)
    expect(daemon).toContain('this.checkDaemonSessionInBackground(existingPort, helloResult)')
    // Two probes agree, this server's own session works, and a brake stops a loop.
    expect(daemon).toMatch(/confirmedProblems\(probe, uid\)/)
    expect(daemon).toMatch(/loginSessionSeen\(\)\.some/)
    expect(daemon).toMatch(/_sessionReplacements >= 2/)
    expect(daemon).toContain('markEndedSessionClis(live)')
    const monitor = read('src/core/session-health-monitor.ts')
    expect(monitor).toMatch(/isEndedSessionCli\(session\)\) \{\n\s*idleTimeoutMs = Math\.min\(idleTimeoutMs, ENDED_SESSION_IDLE_TIMEOUT_MS\)/)
    // Never a kill of its own: the marker only shortens the idle timeout.
    expect(read('src/core/sessions/ended-session-clis.ts')).not.toMatch(/process\.kill|terminateSession|stopThroughOwner/)
  })
})
