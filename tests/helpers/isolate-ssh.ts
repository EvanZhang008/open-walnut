/**
 * A test server never reaches a REAL ssh host.
 *
 * A server under test reads `~/.ssh/config` (its Host blocks become discovered
 * hosts) and, at startup, sweeps every host for orphaned terminal sessions over
 * ssh with a ControlMaster. A gate review watched an e2e server do exactly that:
 * it opened real ControlMasters to the developer's own machines, named in their
 * real ssh config.
 *
 * isolateFromRealSsh() closes both doors for this process (and every child that
 * inherits its env): HOME (and USERPROFILE) point at an empty throwaway home, so
 * no real ssh config, key or known_hosts is read; and the FIRST `ssh` on PATH is
 * a stand-in that records its arguments and refuses at once, so whatever still
 * runs ssh reaches nothing. Call it before the server starts; `restore()` in
 * afterAll.
 *
 * A server under test that is NOT behind it never reads ~/.ssh/config and never
 * sweeps over ssh at all (src/lib/real-ssh-guard.ts): it knows it is isolated by
 * WALNUT_TEST_SSH_ISOLATED_HOME naming its HOME, which only this helper sets.
 * tests/core/test-ssh-isolation-ratchet.test.ts checks both halves by behavior.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface SshIsolation {
  /** The throwaway home now in HOME. */
  home: string
  /** Every argv the stand-in ssh was run with, one line each. */
  calls: () => string[]
  restore: () => void
}

/** `base` holds the throwaway home and the stand-in; without one, a temp dir of its own that restore() removes. */
export function isolateFromRealSsh(base?: string): SshIsolation {
  const owned = base === undefined
  if (base === undefined) base = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-no-real-ssh-'))
  const dir = base
  const home = path.join(base, 'isolated-home')
  const bin = path.join(base, 'isolated-bin')
  const log = path.join(base, 'isolated-ssh.log')
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'ssh'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
    'echo "ssh: refused by the test (no real ssh from a test server)" >&2',
    'exit 255',
    '',
  ].join('\n'), { mode: 0o755 })
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PATH: process.env.PATH,
    WALNUT_TEST_SSH_ISOLATED_HOME: process.env.WALNUT_TEST_SSH_ISOLATED_HOME,
  }
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.WALNUT_TEST_SSH_ISOLATED_HOME = home
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`
  return {
    home,
    calls: () => {
      try { return fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean) } catch { return [] }
    },
    restore: () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      if (owned) fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}
