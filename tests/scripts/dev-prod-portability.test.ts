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
 * The script is never EXECUTED here: PORT is hardcoded to production 3456, so a
 * run in a test process could touch the real server. Ordering is asserted
 * statically; the shell logic is exercised by slicing the helper out and running
 * that slice alone.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { execFileSync } from 'node:child_process'

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'dev-prod.sh')
const script = fs.readFileSync(SCRIPT, 'utf-8')

/** The PORT_PROBE detection + listener_pids() definition, standalone. */
function listenerPidsSnippet(): string {
  const start = script.indexOf('PORT_PROBE=""')
  const fnStart = script.indexOf('listener_pids() {', start)
  const fnEnd = script.indexOf('\n}\n', fnStart)
  expect(start).toBeGreaterThan(-1)
  expect(fnEnd).toBeGreaterThan(fnStart)
  return script.slice(start, fnEnd + 3)
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
    const launchdRemove = script.indexOf('launchctl remove "$LAUNCH_LABEL"')
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

  // The ss/fuser arms can't run on macOS, so their PARSING (the part that can
  // silently return garbage) is pinned against canonical Linux output shapes.
  function withStubProbe(name: string, body: string): { status: number; stdout: string; stderr: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `devprod-${name}-`))
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return runBash(`set -euo pipefail\nPORT=3456\nPATH=${dir}:/usr/bin:/bin\n${listenerPidsSnippet()}\nlistener_pids`)
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
