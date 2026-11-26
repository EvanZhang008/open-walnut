/**
 * Ratchet: every fs.realpathSync in the daemon and service code (src/providers, src/binary,
 * src/replica) either resolves a path Walnut itself owns, or first asks isMacGuarded / guarded.
 *
 * A realpath opens the path. On a Mac, a path in a place macOS guards (Desktop, Documents, another
 * app's data: src/core/hosts/mac-places.ts) makes that open wait on a consent dialog, with the loop
 * stopped until someone answers (2026-11-26: a session cwd in ~/Desktop froze a host's service at
 * every start). A new call fails here until it is listed below (own paths only) or guarded within
 * the six lines above it.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOTS = ['src/providers', 'src/binary', 'src/replica']
/** file -> how many realpathSync calls in it resolve only Walnut's own or the system's fixed paths. */
const OWN_PATHS: Record<string, number> = {
  'src/providers/acp-session.ts': 1, // an engine's executable
  'src/providers/claude-check-core.ts': 1, // the claude binary
  'src/providers/cli-owner-core.ts': 1, // the CLI's config dir
  'src/providers/daemon-instance-lock.ts': 2, // the daemon's own dir
  'src/providers/daemon-ownership.ts': 1, // two homes compared
  'src/providers/daemon-skills.ts': 1, // a skill link and its canonical dir
  'src/providers/daemon-standalone.ts': 4, // picture roots, runtime trees, the daemon dir, follower reads (guarded inside the core)
  'src/providers/ephemeral-session-gate.ts': 2, // the temp dir, a demo home
  'src/providers/host-fix-core.ts': 2, // install paths of the CLI
  'src/providers/micro-claude-warm.ts': 1, // the temp dir
  'src/providers/outbound-uploads.ts': 1, // the upload roots (the other call is guarded)
  'src/providers/task-dir-core.ts': 1, // task dirs
  'src/binary/service-entry.ts': 1, // two homes compared
  'src/binary/service-mode.ts': 1, // an fs type, no call
  'src/replica/boot-guard.ts': 1, // the replica's data dir
}
const GUARD_RE = /\bisMacGuarded\(|\bguarded\(/

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? files(p) : /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : []
  })
}

describe('realpathSync in daemon and service code never opens a guarded place unasked', () => {
  it('each call is an own path (listed) or guarded just above', () => {
    const unguarded: Record<string, number> = {}
    for (const f of ROOTS.flatMap(files)) {
      const lines = fs.readFileSync(f, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/realpathSync\(/.test(line)) return
        if (GUARD_RE.test(lines.slice(Math.max(0, i - 6), i + 1).join('\n'))) return
        unguarded[f] = (unguarded[f] ?? 0) + 1
      })
    }
    const over = Object.entries(unguarded).filter(([f, n]) => n > (OWN_PATHS[f] ?? 0))
    expect(over, 'a new realpathSync: guard it with isMacGuarded (src/core/hosts/mac-places.ts) or, for a path Walnut owns, list it in OWN_PATHS').toEqual([])
  })
})
