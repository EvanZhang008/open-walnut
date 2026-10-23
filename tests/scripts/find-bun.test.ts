/**
 * scripts/lib/find-bun.sh: the one way the repo's bash scripts pick a bun. A
 * script run through `bun run` used to take the first `bun` on PATH, which on a
 * real Mac was ~/.bun/bin/bun 1.3.9 while bun 1.4.4 ran it. The helper takes the
 * first bun of the version package.json pins or newer. Stand-in buns (sh scripts
 * that answer `--version`) in a temp dir, a temp HOME, and a repo with its own
 * package.json, so no real bun on this machine decides an answer.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { guardedPath } from '../setup/exec-guard-core.js'

const REPO = path.join(import.meta.dirname, '..', '..')
const HELPER = path.join(REPO, 'scripts', 'lib', 'find-bun.sh')
const CALLERS = [
  'scripts/dev-prod.sh', 'scripts/dev-ephemeral.sh', 'scripts/onboarding-demo.sh', 'scripts/check-committed-bundle.sh',
  'scripts/ios-client-log-e2e.sh', 'scripts/bridge-monitor/install.sh', 'scripts/walnut-sandbox.sh', 'scripts/walnut-logs.sh',
  'scripts/build-daemon.sh', 'scripts/onboarding-cleanroom.sh', 'scripts/onboarding-test/lib/common.sh',
]
// The fixed places the helper looks after PATH: a real bun there would (rightly) be picked.
const FIXED = ['/opt/homebrew/bin/bun', '/usr/local/bin/bun']
const fixedBun = FIXED.some((p) => fs.existsSync(p))

function standIn(dir: string, version: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'bun')
  fs.writeFileSync(file, `#!/bin/sh\n[ "$1" = --version ] && echo ${version}\n`, { mode: 0o755 })
  return file
}

function pick(env: Record<string, string>, pin = '1.4.4'): { bin: string; version: string; seen: string; missing: string; ok: boolean } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'find-bun-repo-'))
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ packageManager: pin ? `bun@${pin}` : undefined }))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'find-bun-home-'))
  const script = `. ${JSON.stringify(HELPER)}; if walnut_find_bun ${JSON.stringify(repo)}; then ok=1; else ok=0; fi; printf '%s\\n%s\\n%s\\n%s\\n%s' "$ok" "$BUN_BIN" "$BUN_VERSION" "$BUN_SEEN" "$(walnut_bun_missing)"`
  const out = execFileSync('/bin/bash', ['-c', script], {
    encoding: 'utf8',
    env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, ...env },
  })
  const [ok, bin, version, seen, missing] = out.split('\n')
  return { ok: ok === '1', bin: bin ?? '', version: version ?? '', seen: seen ?? '', missing: missing ?? '' }
}

describe('walnut_find_bun', () => {
  it.skipIf(fixedBun)('passes over an older bun first on PATH and takes the pinned one after it', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'find-bun-'))
    const old = standIn(path.join(tmp, 'old'), '1.3.9')
    const good = standIn(path.join(tmp, 'good'), '1.4.4')
    const r = pick({ PATH: guardedPath([path.dirname(old), path.dirname(good)], '/usr/bin:/bin') })
    expect(r.ok).toBe(true)
    expect(r.bin).toBe(good)
    expect(r.version).toBe('1.4.4')
    expect(r.seen).toBe(`1.3.9 at ${old}`)
  })

  it.skipIf(fixedBun)('takes a newer bun than the pin', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'find-bun-'))
    const newer = standIn(path.join(tmp, 'n'), '1.10.0')
    expect(pick({ PATH: guardedPath([path.dirname(newer)], '/usr/bin:/bin') }).bin).toBe(newer)
  })

  it.skipIf(fixedBun)('WALNUT_BUN first, then the bun that runs the script under `bun run`, then PATH', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'find-bun-'))
    const onPath = standIn(path.join(tmp, 'path'), '1.4.4')
    const running = standIn(path.join(tmp, 'running'), '1.4.5')
    const asked = standIn(path.join(tmp, 'asked'), '1.4.6')
    const PATH = guardedPath([path.dirname(onPath)], '/usr/bin:/bin')
    expect(pick({ PATH, npm_execpath: running, WALNUT_BUN: asked }).bin).toBe(asked)
    expect(pick({ PATH, npm_execpath: running }).bin).toBe(running)
    // npm's own execpath is a JS file, never a bun.
    expect(pick({ PATH, npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' }).bin).toBe(onPath)
  })

  it.skipIf(fixedBun)('fails, naming the pin and what it passed over, when only an older bun is there', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'find-bun-'))
    const old = standIn(path.join(tmp, 'old'), '1.3.9')
    const r = pick({ PATH: guardedPath([path.dirname(old)], '/usr/bin:/bin') })
    expect(r.ok).toBe(false)
    expect(r.bin).toBe('')
    expect(r.missing).toBe(`this needs bun 1.4.4 or newer (package.json packageManager); found only 1.3.9 at ${old}. Set WALNUT_BUN to a newer one, or run: bun upgrade`)
  })

  it.skipIf(fixedBun)('fails with the install line when there is no bun at all', () => {
    const r = pick({})
    expect(r.ok).toBe(false)
    expect(r.missing).toMatch(/none was found .*curl -fsSL https:\/\/bun\.sh\/install \| bash$/)
  })

  it.skipIf(fixedBun)('without a pin, any bun counts', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'find-bun-'))
    const any = standIn(path.join(tmp, 'a'), '1.0.0')
    expect(pick({ PATH: guardedPath([path.dirname(any)], '/usr/bin:/bin') }, '').bin).toBe(any)
  })
})

describe('the scripts that pick a bun share the helper', () => {
  it.each(CALLERS)('%s sources scripts/lib/find-bun.sh and keeps no bun list of its own', (rel) => {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8')
    expect(src).toMatch(/lib\/find-bun\.sh/)
    expect(src).toMatch(/walnut_find_bun /)
    // The old per-script candidate loops.
    expect(src).not.toMatch(/for cand in "\$\{WALNUT_BUN:-\}"/)
    expect(src).not.toMatch(/^find_bun\(\) \{/m)
  })
})
