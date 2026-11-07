/**
 * Both sound guards against one case table (sound-guard-cases.ts): the Bash
 * PreToolUse hook (src/providers/sound-guard-hook.ts), run for real as the exact
 * command string Walnut puts in `--settings`, through every POSIX shell on this
 * machine, and the TypeScript judge host_exec runs on the server
 * (src/providers/sound-guard.ts). A case the twins disagree on fails here.
 *
 * MACHINE SAFETY: nothing here plays a sound; the hook only reads its stdin,
 * and every command below is data in that JSON.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { guardedPath } from '../setup/exec-guard.js'
import { SOUND_AWK_PROGRAM, SOUND_GUARD_COMMAND, soundGuardHooks } from '../../src/providers/sound-guard-hook.js'
import { soundGuardOn, soundRisk } from '../../src/providers/sound-guard.js'
import { ALWAYS_PLAYS } from '../../src/providers/sound-rules.js'
import { SOUND_CASES } from './sound-guard-cases.js'

const SHELLS = ['/bin/sh', '/bin/bash', '/bin/dash', '/usr/bin/dash', '/bin/zsh'].filter((s) => fs.existsSync(s))

function run(shell: string, command: string) {
  const input = JSON.stringify({
    session_id: 's', transcript_path: '/x.jsonl', cwd: '/home/u', permission_mode: 'bypassPermissions',
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'd' }, tool_use_id: 't',
  })
  const r = spawnSync(shell, ['-c', SOUND_GUARD_COMMAND], {
    input, encoding: 'utf8', env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: '/home/u' },
  })
  let reason = ''
  if (r.stdout) {
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } }
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    reason = out.hookSpecificOutput.permissionDecisionReason
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, reason }
}

describe.each(SHELLS)('sound guard hook under %s', (shell) => {
  it.each(SOUND_CASES)('%j -> refused=%s', (command, refused) => {
    const r = run(shell, command)
    expect(r.status).toBe(0)
    if (refused) {
      expect(r.reason).toMatch(/^Walnut refused this command: it would make sound on the machine it runs on \(.+\)\./)
      expect(r.reason).toContain('say -o out.aiff')
      expect(r.reason).toContain('virtual audio device')
    } else {
      expect(r.stdout).toBe('')
    }
  })

  it('unpacks exactly the awk program it was built from', () => {
    const unpack = SOUND_GUARD_COMMAND.split('\n').filter((l) => /^  (b|p)=/.test(l)).join('\n') + "\nprintf '%s' \"$p\""
    const r = spawnSync(shell, ['-c', unpack], { encoding: 'utf8', env: { PATH: guardedPath([], '/usr/bin:/bin') } })
    expect(r.stdout).toBe(SOUND_AWK_PROGRAM.replace(/\n+$/, ''))
  })

  it('refuses a command too long to parse when it names any program that can make sound', () => {
    const big = "cat > data.txt <<'EOF'\n" + 'x '.repeat(60_000) + '\nEOF\n'
    expect(run(shell, big).stdout).toBe('')
    for (const tail of ['say done', 'afplay x.wav', 'mpv a.mp3', 'pactl set-sink-volume @DEFAULT_SINK@ 50%']) {
      expect(run(shell, big + tail).reason).toMatch(/too long to check/)
    }
  })

  it('answers a long command quickly', () => {
    const long = 'cat > n.md <<EOF\n' + 'word $(date) say play volume\n'.repeat(3000) + 'EOF\n'
    let t = Date.now()
    expect(run(shell, long + 'ls').stdout).toBe('')
    expect(Date.now() - t).toBeLessThan(5000)
    t = Date.now()
    expect(run(shell, long + 'afplay x.wav').reason).toMatch(/\(afplay\)/)
    expect(Date.now() - t).toBeLessThan(5000)
  })
})

describe('sound guard on the server (host_exec)', () => {
  it.each(SOUND_CASES)('%j -> refused=%s', (command, refused) => {
    expect(soundRisk(command) !== null).toBe(refused)
  })

  it('names what it found the way the hook does', () => {
    for (const [command, refused] of SOUND_CASES) {
      if (!refused || SHELLS.length === 0) continue
      const hook = run(SHELLS[0], command).reason.match(/runs on \((.+?)\)\. The person/)?.[1]
      expect({ command, what: soundRisk(command) }).toEqual({ command, what: hook })
    }
  })
})

describe('the rule set', () => {
  // A new player added to the list is refused by both twins with no further code.
  it.each(ALWAYS_PLAYS.map((p) => [p]))('always refuses %s', (p) => {
    expect(soundRisk(`${p} x.wav`)).toBe(p)
    if (SHELLS.length) expect(run(SHELLS[0], `${p} x.wav`).reason).toContain(`(${p})`)
  })
})

describe('soundGuardHooks', () => {
  it('is a PreToolUse Bash hook, off with WALNUT_SOUND_GUARD=0', () => {
    expect(soundGuardHooks({})).toEqual({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: SOUND_GUARD_COMMAND, timeout: 10 }] }],
    })
    expect(soundGuardHooks({ WALNUT_SOUND_GUARD: '0' })).toBeNull()
    expect(soundGuardOn({})).toBe(true)
    expect(soundGuardOn({ WALNUT_SOUND_GUARD: '0' })).toBe(false)
  })
})
