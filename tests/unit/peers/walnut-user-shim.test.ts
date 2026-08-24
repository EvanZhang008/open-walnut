/**
 * Regression: the user-PATH `walnut` shim must never exec a sibling copy of
 * itself. Two copies get installed (~/.local/bin AND ~/bin); the first
 * version's PATH scan only excluded the invoking copy's own directory, so
 * copy A exec'd copy B, B exec'd A, and every `walnut` call on a host with
 * both dirs hung in an infinite exec loop (caught live 2026-08-23 by the
 * rename verification session). The scan now skips any candidate carrying
 * the shim marker.
 *
 * The shim text is extracted from the deployed node twin (daemon-source.ts
 * template) and RUN as real /bin/sh, covering four scenarios: sibling shims
 * with a real CLI later in PATH, no real CLI (daemon fallback), invocation
 * via the second copy, and nothing to fall back to (exit 6).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')

/** Extract userWalnutShimText() from the node twin template and evaluate it. */
function walnutShimText(): string {
  const src = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-source.ts'), 'utf-8')
  const start = src.indexOf('const DAEMON_SOURCE = `')
  expect(start).toBeGreaterThan(-1)
  const body = src.slice(src.indexOf('`', start) + 1, src.lastIndexOf('`'))
  // eslint-disable-next-line no-eval
  const twin = eval('`' + body + '`') as string
  const fnStart = twin.indexOf('function userWalnutShimText()')
  expect(fnStart).toBeGreaterThan(-1)
  const fnEnd = twin.indexOf('\n}', fnStart)
  const fnSrc = twin.slice(fnStart, fnEnd + 2)
  // The function references PROD_DAEMON_DIR and USER_WALNUT_SHIM_MARKER.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const make = new Function(
    'PROD_DAEMON_DIR', 'USER_WALNUT_SHIM_MARKER',
    fnSrc + '\nreturn userWalnutShimText();',
  ) as (prodDir: string, marker: string) => string
  return make('/tmp/open-walnut', 'walnut-user-shim v1')
}

let tmp: string
let A: string   // first shim copy dir
let B: string   // second shim copy dir
let REAL: string
let DAEMON: string

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-shim-loop-'))
  A = path.join(tmp, 'a'); B = path.join(tmp, 'b')
  REAL = path.join(tmp, 'real'); DAEMON = path.join(tmp, 'daemon')
  for (const d of [A, B, REAL, path.join(DAEMON, 'bin')]) fs.mkdirSync(d, { recursive: true })
  const shim = walnutShimText()
  expect(shim).toContain('walnut-user-shim v1')
  for (const d of [A, B]) fs.writeFileSync(path.join(d, 'walnut'), shim, { mode: 0o755 })
  fs.writeFileSync(path.join(REAL, 'walnut'), '#!/bin/sh\necho REAL-CLI "$@"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(DAEMON, 'bin', 'walnut'), '#!/bin/sh\necho GATEWAY-SHIM "$@"\n', { mode: 0o755 })
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function run(entryDir: string, pathDirs: string[], daemonDir: string): { out: string; code: number | null } {
  const r = spawnSync(path.join(entryDir, 'walnut'), ['hello'], {
    env: { PATH: [...pathDirs, '/usr/bin', '/bin'].join(':'), WALNUT_DAEMON_DIR: daemonDir },
    encoding: 'utf-8',
    timeout: 10_000, // the loop bug hung forever — a timeout here IS the failure signal
  })
  return { out: (r.stdout ?? '') + (r.stderr ?? ''), code: r.status }
}

describe('user-PATH walnut shim: sibling copies never exec each other', () => {
  it('the bun twin (daemon-standalone.ts) carries the same sibling-skip line', () => {
    const standalone = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf-8')
    expect(standalone).toContain('grep -q "walnut-user-shim" "$d/walnut" 2>/dev/null && continue')
  })

  it('two sibling shims pass through to the real CLI later in PATH', () => {
    const r = run(A, [A, B, REAL], DAEMON)
    expect(r.out).toContain('REAL-CLI hello')
    expect(r.code).toBe(0)
  })

  it('invoked via the SECOND copy it still reaches the real CLI (the loop case)', () => {
    const r = run(B, [B, A, REAL], DAEMON)
    expect(r.out).toContain('REAL-CLI hello')
    expect(r.code).toBe(0)
  })

  it('with no real CLI it falls back to the daemon gateway shim', () => {
    const r = run(A, [A, B], DAEMON)
    expect(r.out).toContain('GATEWAY-SHIM hello')
    expect(r.code).toBe(0)
  })

  it('with nothing to fall back to it exits 6 with a walnut-prefixed error', () => {
    const r = run(A, [A, B], path.join(tmp, 'nonexistent'))
    expect(r.out).toContain('walnut: no Walnut daemon on this host')
    expect(r.code).toBe(6)
  })
})
