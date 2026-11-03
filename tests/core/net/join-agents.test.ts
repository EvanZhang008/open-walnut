/**
 * The invite script's closing lines, run for real (sh): which coding agents the new
 * machine has. 2026-11-03, the user: "We don't bind to Claude Code, user can choose to
 * install it, but we don't install for them automatically". The one line sets up Walnut
 * and joins; it installs no agent, and says how to add one when there is none.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { joinScript } from '../../../src/core/net/net-join-script.js'
import { guardedPath } from '../../setup/exec-guard.js'

let dir = ''
let home = ''

// A Walnut that joins: its own two steps as src/commands/net.ts prints them.
function walnut(opts: { joins?: boolean } = {}): void {
  const f = path.join(home, '.local/share/open-walnut/bin/walnut')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, `#!/bin/sh
case "$1" in
  --version) echo "0.6.25" ;;
  net) if [ "$3" = "--help" ]; then echo "  --steps  Continue the numbered steps"; exit 0; fi
       echo "  2/3  Keep it running ... on (starts when you log in)"
       ${opts.joins === false ? `echo "  3/3  Join .............. this invite was used already"; exit 1` : `echo "  3/3  Join .............. done: this machine is \\"devbox\\""`} ;;
esac
`, { mode: 0o755 })
}

/** An agent binary in `bin` answering --version with `line`; every other call is recorded. */
function agent(bin: string, name: string, line: string): void {
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh
[ "$1" = --version ] && { echo "${line}"; exit 0; }
echo "${name} $*" >> "${path.join(dir, 'agent-calls')}"
`, { mode: 0o755 })
}

function run(extraPath: string[] = []) {
  const file = path.join(dir, 'join.sh')
  fs.writeFileSync(file, joinScript({ origin: 'https://wn.example', code: 'AAAA-BBBB-CCCC' }))
  // The test guard's refusing `claude` sits on every test PATH; a broken one (no
  // --version answer) comes first, the way it would on a real machine.
  const broken = path.join(dir, 'broken-bin')
  fs.mkdirSync(broken, { recursive: true })
  fs.writeFileSync(path.join(broken, 'claude'), '#!/bin/sh\nexit 127\n', { mode: 0o755 })
  const r = spawnSync('sh', [file], {
    encoding: 'utf8',
    env: { HOME: home, PATH: guardedPath([...extraPath, broken], '/usr/bin:/bin'), OPEN_WALNUT_TARGET: 'linux-x64', TMPDIR: path.join(dir, 'tmp') },
  })
  const calls = fs.existsSync(path.join(dir, 'agent-calls')) ? fs.readFileSync(path.join(dir, 'agent-calls'), 'utf8') : ''
  return { ...r, calls }
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'join-agents-')))
  home = path.join(dir, 'home')
  fs.mkdirSync(home)
  fs.mkdirSync(path.join(dir, 'tmp'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('the invite script names the coding agents and installs none', () => {
  it('a machine with none: three steps, then how to add Claude Code', () => {
    walnut()
    const r = run()
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('  1/3  Walnut ............ installed (0.6.25)')
    expect(r.stdout).toContain('  3/3  Join .............. done: this machine is "devbox"')
    expect(r.stdout.endsWith(
      "\nNo coding agent is on this machine yet. To add Claude Code, click Install on this machine in your Mac's Remote Hosts, or run here:\n"
      + '  curl -fsSL https://claude.ai/install.sh | bash\n',
    )).toBe(true)
    expect(fs.existsSync(path.join(home, '.local/bin/claude'))).toBe(false)
    expect(fs.readdirSync(path.join(dir, 'tmp'))).toEqual([])
  })

  it('Claude Code on PATH and Codex where its installer puts it: both named, only --version asked', () => {
    walnut()
    const bin = path.join(dir, 'bin')
    agent(bin, 'claude', '2.1.312 (Claude Code)')
    agent(path.join(home, '.local/bin'), 'codex', 'codex-cli 0.58.0')
    const r = run([bin])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.endsWith('\nCoding agents here: Claude Code 2.1.312, Codex 0.58.0.\n')).toBe(true)
    expect(r.stdout).not.toContain('No coding agent')
    // Nothing but --version: no install, no update, no sign-in check that could start a session.
    expect(r.calls).toBe('')
  })

  it('a Claude Code only in ~/.local/bin (a shell from before its install) still counts', () => {
    walnut()
    agent(path.join(home, '.local/bin'), 'claude', '2.1.312 (Claude Code)')
    const r = run()
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Coding agents here: Claude Code 2.1.312.')
  })

  it('a join that fails ends the script with its status and no agents line', () => {
    walnut({ joins: false })
    const r = run()
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('  3/3  Join .............. this invite was used already')
    expect(r.stdout).not.toContain('Coding agents here')
    expect(r.stdout).not.toContain('No coding agent')
  })

  it('the script itself never downloads or installs an agent (the class: any new agent step must not either)', () => {
    for (const s of [joinScript({ origin: 'https://wn.example', code: 'AAAA-BBBB-CCCC' }), joinScript({ ticket: true })]) {
      expect(s).not.toContain('downloads.claude.ai')
      expect(s).not.toMatch(/claude"? install\b/)
      expect(s).not.toMatch(/npm (?:i|install) [^\n]*(?:claude-code|codex)/)
      // The install line appears only inside the closing text, never as a command.
      for (const line of s.split('\n').filter((l) => l.includes('claude.ai/install.sh'))) expect(line).toMatch(/printf/)
    }
  })
})
