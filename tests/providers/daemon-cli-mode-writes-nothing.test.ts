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
 * temp home; both must be exactly as they were after the CLI ran. The leader's own lines too
 * (`daemon status|install --walnut <id>`), with the default set taken by another Walnut so the
 * line picks its own set: stand-in service tools on PATH record any call, and the install stops at
 * its refusal of a home that is not the real account's, so nothing is installed.
 *
 * MACHINE SAFETY: every path is a temp one; the only processes are the CLIs this file starts and
 * the stand-in tools; install refuses the temp home before it touches any service.
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

function run(twin: Twin, root: string, words: string[], tools?: string): Promise<{ code: number | null; out: string; err: string }> {
  const [cmd, argv] = twin.command(...words)
  const home = path.join(root, 'home')
  const env: Record<string, string> = {
    SHELL: '/bin/sh',
    PATH: guardedPath([], `${tools ? `${tools}:` : ''}/usr/bin:/bin`),
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

const WALNUT = '0123456789abcdef0123456789abcdef'
/** Service tools that only record their call: nothing real runs. */
function standInTools(dir: string): string {
  fs.mkdirSync(dir)
  for (const tool of ['systemctl', 'loginctl', 'crontab', 'launchctl']) {
    fs.writeFileSync(path.join(dir, tool), `#!/bin/sh\necho "${tool} $*" >> "${dir}/calls.txt"\nexit 1\n`, { mode: 0o755 })
  }
  return dir
}

for (const twin of TWINS) {
  describe.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(`a leader's set line writes nothing of the daemon's, ${twin.name}`, () => {
    it.each([
      [['walnut', 'daemon', 'status', '--walnut', WALNUT], 0, /service set: 0123456789abcdef/],
      [['walnut', 'daemon', 'install', '--yes', '--walnut', WALNUT], 1, /real host account/],
    ])('`%s` leaves the default runtime dir and HOME as they were', async (words, code, said) => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wcm-')))
      try {
        for (const d of ['home', 'tmp', 'default-rt']) fs.mkdirSync(path.join(root, d), { mode: 0o700 })
        // The default set is another Walnut's (its claim), so the line acts on its own set.
        const def = process.platform === 'darwin'
          ? path.join(root, 'home', 'Library', 'Application Support', 'Open Walnut', 'Daemon')
          : path.join(root, 'home', '.local', 'share', 'open-walnut', 'daemon')
        fs.mkdirSync(def, { recursive: true })
        fs.writeFileSync(path.join(def, 'set-owner.json'), '{"v":1,"walnutId":"fedcba9876543210fedcba9876543210"}\n')
        const tools = standInTools(path.join(root, 'tools'))
        const before = { home: tree(path.join(root, 'home')), rt: tree(path.join(root, 'default-rt')) }
        const r = await run(twin, root, words, tools)
        expect(r.code, r.err).toBe(code)
        expect(`${r.out}\n${r.err}`).toMatch(said)
        expect({ home: tree(path.join(root, 'home')), rt: tree(path.join(root, 'default-rt')) }).toEqual(before)
        // Whatever it asked of the service tools, it only read: no enable, start or install.
        const calls = fs.existsSync(path.join(tools, 'calls.txt')) ? fs.readFileSync(path.join(tools, 'calls.txt'), 'utf8') : ''
        expect(calls).not.toMatch(/\b(enable|start|restart|load|bootstrap|daemon-reload)\b/)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }, 60_000)
  })
}
