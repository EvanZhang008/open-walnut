/**
 * The session daemon picks its own dir on every machine (src/lib/daemon-dir.ts on this one,
 * src/providers/remote-daemon-dir.ts on a host): `~/.cache/open-walnut` where nothing ran yet, the
 * shared temp dir where a daemon already ran since the boot. A script or a live test that reads
 * the daemon's files by a fixed path reads nothing on the other kind of machine.
 *
 * 2026-11-26: the remote host onboarding live test read `daemon.pid` from the temp dir and failed
 * on GitHub once a fresh host kept the daemon in its home dir; no local run had started it. This
 * guard reads every script and every live test from the source tree, so a new one that names a
 * daemon file under the temp dir fails here, in the quick tier.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')

/** A daemon file named under the shared temp dir. The server's own scratch there (logs, images) is not one. */
const FIXED = /\/tmp\/open-walnut\/(daemon\.(pid|port|instance|version)|sessions\.json|daemon-start\.log|daemon-d-|agent-gateway\.sock)/

/** The rule itself: the one place that names both dirs' files. */
const THE_RULE = new Set(['scripts/lib/daemon-dir.sh'])

function walk(dir: string, keep: (rel: string) => boolean, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      // scripts/local is not part of the repo (gitignored, per machine).
      if (entry.name === 'node_modules' || rel === 'scripts/local') continue
      walk(rel, keep, out)
    } else if (keep(rel)) out.push(rel)
  }
  return out
}

function offenders(files: string[]): string[] {
  const out: string[] = []
  for (const rel of files) {
    if (THE_RULE.has(rel)) continue
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf-8').split('\n')
    lines.forEach((line, i) => { if (FIXED.test(line)) out.push(`${rel}:${i + 1}`) })
  }
  return out
}

describe('the daemon\'s files are read where the daemon is, never by a fixed path', () => {
  it('no script names a daemon file under the shared temp dir', () => {
    const scripts = walk('scripts', (rel) => /\.(sh|mjs|cjs|js|ts|py)$/.test(rel))
    expect(scripts.length).toBeGreaterThan(50)
    expect(offenders(scripts)).toEqual([])
  })

  it('no live test names a daemon file under the shared temp dir', () => {
    const live = walk('tests', (rel) => /\.live\.test\.ts$/.test(rel))
    expect(live.length).toBeGreaterThan(5)
    expect(live).toContain('tests/live/remote-host-onboarding.live.test.ts')
    expect(offenders(live)).toEqual([])
  })

  it('the guard sees what it guards against', () => {
    expect(FIXED.test('cat /tmp/open-walnut/daemon.pid')).toBe(true)
    expect(FIXED.test('cat /tmp/open-walnut/sessions.json')).toBe(true)
    expect(FIXED.test('tail /tmp/open-walnut/open-walnut-2026-11-26.log')).toBe(false)
    expect(FIXED.test('for d in /tmp/open-walnut "$HOME/.cache/open-walnut"; do cat "$d/daemon.pid"; done')).toBe(false)
  })
})
