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
import { beforeAll, describe, it, expect } from 'vitest'
import { execFile, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { guardedPath } from '../setup/exec-guard.js'
import { SOUND_AWK_PROGRAM, SOUND_GUARD_COMMAND, soundGuardHooks } from '../../src/providers/sound-guard-hook.js'
import { soundGuardOn, soundRisk } from '../../src/providers/sound-guard.js'
import { ALWAYS_PLAYS, INPUT_PREFIX, INPUT_PROGRAMS } from '../../src/providers/sound-rules.js'
import { INPUT_CASES, SOUND_CASES } from './sound-guard-cases.js'

const SHELLS = ['/bin/sh', '/bin/bash', '/bin/dash', '/usr/bin/dash', '/bin/zsh'].filter((s) => fs.existsSync(s))

interface HookRun { status: number | null; stdout: string; stderr: string }
type HookResult = HookRun & { reason: string }

const hookInput = (command: string) => JSON.stringify({
  session_id: 's', transcript_path: '/x.jsonl', cwd: '/home/u', permission_mode: 'bypassPermissions',
  hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'd' }, tool_use_id: 't',
})
const HOOK_ENV = { PATH: guardedPath([], '/usr/bin:/bin'), HOME: '/home/u' }

function readHook(r: HookRun): HookResult {
  let reason = ''
  if (r.stdout) {
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } }
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    reason = out.hookSpecificOutput.permissionDecisionReason
  }
  return { ...r, reason }
}

/** At most this many hook processes at once, for the whole file. */
const SPAWN_LIMIT = 6
let spawning = 0
const waiting: Array<() => void> = []
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (spawning >= SPAWN_LIMIT) await new Promise<void>((r) => waiting.push(r))
  spawning++
  try { return await fn() } finally { spawning--; waiting.shift()?.() }
}

function spawnHook(shell: string, command: string): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const c = execFile(shell, ['-c', SOUND_GUARD_COMMAND], { encoding: 'utf8', env: HOOK_ENV, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const status = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0
      if (err && status === null) reject(err)
      else resolve({ status, stdout, stderr })
    })
    c.stdin!.end(hookInput(command))
  })
}

/**
 * The hook, run for real. It only reads its stdin, so one shell and command always give one
 * answer: each pair is spawned once per file, a few at a time, and never synchronously
 * (2026-11-11: about 1,400 spawnSync calls in a row held the worker's event loop for minutes on a
 * loaded Mac, past one test's 15 s timeout and vitest's own worker RPC timeout).
 */
const hookRuns = new Map<string, Promise<HookRun>>()
async function run(shell: string, command: string): Promise<HookResult> {
  const key = `${shell}\0${command}`
  let r = hookRuns.get(key)
  if (!r) { r = slot(() => spawnHook(shell, command)); hookRuns.set(key, r) }
  return readHook(await r)
}

/** Starts every command at once (bounded by the slots), so each case's own test reads a finished run. */
async function runAll(shell: string, commands: Iterable<string>): Promise<void> {
  await Promise.all([...commands].map((c) => run(shell, c)))
}
const PREFETCH_MS = 600_000

describe.each(SHELLS)('sound guard hook under %s', (shell) => {
  beforeAll(() => runAll(shell, SOUND_CASES.map(([c]) => c)), PREFETCH_MS)
  it.each(SOUND_CASES)('%j -> refused=%s', async (command, refused) => {
    const r = await run(shell, command)
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

  it('refuses a command too long to parse when it names any program that can make sound', async () => {
    const big = "cat > data.txt <<'EOF'\n" + 'x '.repeat(60_000) + '\nEOF\n'
    expect((await run(shell, big)).stdout).toBe('')
    for (const tail of ['say done', 'afplay x.wav', 'mpv a.mp3', 'pactl set-sink-volume @DEFAULT_SINK@ 50%']) {
      expect((await run(shell, big + tail)).reason).toMatch(/too long to check/)
    }
  })

  it('answers a long command quickly', async () => {
    const long = 'cat > n.md <<EOF\n' + 'word $(date) say play volume\n'.repeat(3000) + 'EOF\n'
    let t = Date.now()
    expect((await run(shell, long + 'ls')).stdout).toBe('')
    expect(Date.now() - t).toBeLessThan(5000)
    t = Date.now()
    expect((await run(shell, long + 'afplay x.wav')).reason).toMatch(/\(afplay\)/)
    expect(Date.now() - t).toBeLessThan(5000)
  })
})

describe('sound guard on the server (host_exec)', () => {
  it.each(SOUND_CASES)('%j -> refused=%s', (command, refused) => {
    expect(soundRisk(command) !== null).toBe(refused)
  })

  it('names what it found the way the hook does', async () => {
    if (SHELLS.length) await runAll(SHELLS[0], SOUND_CASES.filter(([, refused]) => refused).map(([c]) => c))
    for (const [command, refused] of SOUND_CASES) {
      if (!refused || SHELLS.length === 0) continue
      const hook = (await run(SHELLS[0], command)).reason.match(/runs on \((.+?)\)\. The person/)?.[1]
      expect({ command, what: soundRisk(command) }).toEqual({ command, what: hook })
    }
  })
})

describe('the rule set', () => {
  // A new player added to the list is refused by both twins with no further code.
  it.each(ALWAYS_PLAYS.map((p) => [p]))('always refuses %s', async (p) => {
    expect(soundRisk(`${p} x.wav`)).toBe(p)
    if (SHELLS.length) expect((await run(SHELLS[0], `${p} x.wav`)).reason).toContain(`(${p})`)
  })
})

describe('real foreground input (2026-11-09: cliclick on a Mac whose person was watching a video)', () => {
  const INPUT_REFUSAL = /^Walnut refused this command: it would send real input \((.+?)\) to the front window of this machine/
  describe.each(SHELLS)('the hook under %s', (shell) => {
    beforeAll(() => runAll(shell, INPUT_CASES.map(([c]) => c)), PREFETCH_MS)
    it.each(INPUT_CASES)('%j -> refused=%s', async (command, refused) => {
      const r = await run(shell, command)
      expect(r.status).toBe(0)
      if (refused) {
        expect(r.reason).toMatch(INPUT_REFUSAL)
        expect(r.reason).toContain("WALNUT_INPUT_REASON='<why, 10+ characters>'")
      } else expect(r.stdout).toBe('')
    })
  })
  it.each(INPUT_CASES)('on the server: %j -> refused=%s', (command, refused) => {
    const what = soundRisk(command)
    expect(what !== null).toBe(refused)
    if (what) expect(what.startsWith(INPUT_PREFIX)).toBe(true)
  })
  it('both twins name the same thing', async () => {
    if (SHELLS.length) await runAll(SHELLS[0], INPUT_CASES.filter(([, refused]) => refused).map(([c]) => c))
    for (const [command, refused] of INPUT_CASES) {
      if (!refused || SHELLS.length === 0) continue
      const hook = (await run(SHELLS[0], command)).reason.match(INPUT_REFUSAL)?.[1]
      expect({ command, what: soundRisk(command) }).toEqual({ command, what: INPUT_PREFIX + hook })
    }
  })
  // A new input program added to the list is refused by both twins with no further code, and the case table names it.
  it.each(INPUT_PROGRAMS.map((p) => [p]))('always refuses %s, and the case table lists it', async (p) => {
    expect(soundRisk(`${p} x`)).toBe(INPUT_PREFIX + p)
    if (SHELLS.length) expect((await run(SHELLS[0], `${p} x`)).reason).toMatch(new RegExp(`\\(${p}\\) to the front window`))
    expect(INPUT_CASES.some(([c, refused]) => refused && new RegExp(`(^|[ /|"])${p}( |$)`).test(c))).toBe(true)
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
