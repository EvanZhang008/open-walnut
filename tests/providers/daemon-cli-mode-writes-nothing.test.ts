/**
 * The daemon program run as the host's `walnut` CLI (`<daemon> walnut ...`, `wn` the old alias) is a
 * CLI and nothing more: it writes nothing in the daemon's runtime dir or anywhere under HOME.
 *
 * 2026-11-24, a real-systemd drill of two Walnuts on one machine: the line a leader runs on a host
 * (`<daemon binary> walnut daemon install ... --walnut <id>`, daemon-service-update.ts
 * runServiceInstall) first set the whole daemon runtime up, so it made a log file
 * (`/tmp/open-walnut/daemon-<instance>.log`, "machine id made") and `detached/adopts` in the default
 * runtime dir, the other Walnut's, before it ever read its words. The daemon dispatches the CLI before
 * any of that now. Here the default runtime dir is a temp stand-in (WALNUT_DAEMON_DIR) and HOME a
 * temp home; both must be exactly as they were after the CLI ran.
 *
 * MACHINE SAFETY: every path is a temp one; the only processes are the CLIs this file starts.
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { testBun } from '../helpers/bun-runtime.js'
import { guardedPath } from '../setup/exec-guard.js'

const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; command: (...args: string[]) => [string, string[]] }
const TWINS: Twin[] = BUN ? [{ name: 'the daemon (bun)', command: (...args: string[]): [string, string[]] => [BUN, [STANDALONE, ...args]] }] : []

/** Every path under `dir`, relative, sorted. */
function tree(dir: string): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name)
      out.push(r)
      if (e.isDirectory()) walk(r)
    }
  }
  walk('')
  return out.sort()
}

function run(twin: Twin, root: string, words: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const [cmd, argv] = twin.command(...words)
  const home = path.join(root, 'home')
  const env: Record<string, string> = {
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: home,
    TMPDIR: path.join(root, 'tmp'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    // The stand-in for the default runtime dir (/tmp/open-walnut) the leader's line gets.
    WALNUT_DAEMON_DIR: path.join(root, 'default-rt'),
    WALNUT_SPAWN_JOURNAL: path.join(home, '.open-walnut', 'local', 'spawn-journal.jsonl'),
    WALNUT_CLI_WAIT_MS: '2000',
    // Bun's own transpile cache of the .ts entry: an artifact of running the source, not the program's.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
  }
  const child = spawn(cmd, argv, { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (c) => { out += c })
  child.stderr.on('data', (c) => { err += c })
  const killer = setTimeout(() => child.kill('SIGKILL'), 50_000)
  return new Promise((resolve) => child.on('close', (code) => { clearTimeout(killer); resolve({ code, out, err }) }))
}

for (const twin of TWINS) {
  describe(`the daemon program as the walnut CLI writes nothing of the daemon's, ${twin.name}`, () => {
    for (const words of [['walnut', '--help'], ['wn', '--help']]) {
      it(`\`${words.join(' ')}\` leaves the runtime dir and HOME as they were`, async () => {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wcm-')))
        try {
          for (const d of ['home', 'tmp', 'default-rt']) fs.mkdirSync(path.join(root, d), { mode: 0o700 })
          const before = tree(root)
          const r = await run(twin, root, words)
          expect(r.code, r.err).toBe(0)
          expect(r.out).toMatch(/walnut/)
          expect(tree(root)).toEqual(before)
        } finally {
          fs.rmSync(root, { recursive: true, force: true })
        }
      }, 60_000)
    }
  })
}
