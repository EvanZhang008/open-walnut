/**
 * The daemon's resume records and resume command (src/providers/host-resume-core.ts):
 * how a host starts a stopped session again for a trigger fire, and how the
 * companion's bridgeResume builds its command.
 *
 * Why: the idle reaper stops a quiet CLI after two hours, so an overnight fire
 * finds its session stopped, and on 2026-10-09 one waited six hours for the Mac.
 * The command must be the session's own (its model, prompt, mode), and must be a
 * resume the CLI accepts: a fresh start's `--session-id` beside `--resume` is
 * refused by the CLI unless it forks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostResume } from '../../src/providers/host-resume-core.js'
import { MODE_CLI } from '../../src/providers/daemon-core.js'

let dir: string
let now = 1_000_000
const logs: Array<{ level: string; msg: string }> = []

function make() {
  return createHostResume({ fs, path, dir, now: () => now, log: (level, msg) => { logs.push({ level, msg }) }, modeCli: MODE_CLI })
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-resume-'))
  fs.rmSync(dir, { recursive: true })
  now = Date.UTC(2026, 9, 10)
  logs.length = 0
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const SID = 'aaaaaaaa-1111-4111-8111-111111111111'

describe('resumeArgs', () => {
  const hr = () => make()

  it('turns a fresh start into a resume the CLI accepts, keeping everything else', () => {
    const fresh = ['claude', '-p', '--output-format', 'stream-json', '--model', 'opus', '--permission-mode', 'default',
      '--session-id', SID, '--append-system-prompt', 'You are a Walnut session.', '--settings', '{"env":{"A":"1"}}',
      '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio']
    const args = hr().resumeArgs(fresh, SID, 'plan')
    expect(args).not.toContain('--session-id')
    expect(args.filter((a) => a === SID)).toEqual([SID])
    expect(args.slice(-2)).toEqual(['--resume', SID])
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan')
    expect(args[1]).toBe('--allow-dangerously-skip-permissions')
    expect(args[args.indexOf('--model') + 1]).toBe('opus')
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('You are a Walnut session.')
    expect(args[args.indexOf('--settings') + 1]).toBe('{"env":{"A":"1"}}')
    expect(args[0]).toBe('claude')
    expect(fresh).toContain('--session-id') // the input is not changed
  })

  it('drops the bare bypass flag, which would select bypass over the mode', () => {
    const args = hr().resumeArgs(['claude', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions'], SID, 'default')
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).toContain('--allow-dangerously-skip-permissions')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default')
  })

  it('a fork resumes as itself: its own id, no fork flag, no session-id', () => {
    const fork = ['claude', '--resume', 'parent-id', '--fork-session', '--session-id', SID]
    const args = hr().resumeArgs(fork, SID, 'accept')
    expect(args).toEqual(['claude', '--allow-dangerously-skip-permissions', '--resume', SID, '--permission-mode', 'acceptEdits'])
  })

  it('a resume command is rewritten to this sid, and running it twice changes nothing more', () => {
    const once = hr().resumeArgs(['claude', '--allow-dangerously-skip-permissions', '--resume', 'old', '--permission-mode', 'plan'], SID, 'plan')
    expect(once).toEqual(['claude', '--allow-dangerously-skip-permissions', '--resume', SID, '--permission-mode', 'plan'])
    expect(hr().resumeArgs(once, SID, 'plan')).toEqual(once)
  })

  it('an unknown mode keeps the command\'s own; a flag left without its value gets one', () => {
    expect(hr().resumeArgs(['claude', '--permission-mode', 'plan'], SID, 'nonsense')).toContain('plan')
    const args = hr().resumeArgs(['claude', '--resume'], SID, undefined)
    expect(args.slice(-2)).toEqual(['--resume', SID])
    expect(args.filter((a) => a === '--resume')).toHaveLength(1)
  })
})

describe('resume records', () => {
  it('keeps a record per session, private to the user, and reads it back whole', () => {
    const hr = make()
    hr.remember(SID, { args: ['claude', '--session-id', SID], cwd: '/work/repo', mode: 'plan', home: '/data/walnut', task: 'mtask-1' })
    const file = path.join(dir, `${SID}.json`)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(hr.recall(SID)).toMatchObject({ v: 1, sid: SID, args: ['claude', '--session-id', SID], cwd: '/work/repo', mode: 'plan', home: '/data/walnut', task: 'mtask-1' })
    // A fresh instance (a restarted daemon) reads the same.
    expect(make().recall(SID)?.mode).toBe('plan')
    // A later write (a mode change, the end of the session) replaces it.
    hr.remember(SID, { args: ['claude', '--session-id', SID], cwd: '/work/repo', mode: 'default' })
    expect(hr.recall(SID)?.mode).toBe('default')
    expect(fs.readdirSync(dir)).toEqual([`${SID}.json`])
  })

  it('refuses what it could not use: a bad id, no command, no folder, a command too large', () => {
    const hr = make()
    hr.remember('../escape', { args: ['claude'], cwd: '/x' })
    hr.remember(SID, { args: [], cwd: '/x' })
    hr.remember(SID, { args: ['claude'], cwd: '' })
    hr.remember(SID, { args: ['claude', 'x'.repeat(600 * 1024)], cwd: '/x' })
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([])
    expect(hr.recall('../escape')).toBeNull()
    expect(logs.some((l) => l.msg.includes('too large'))).toBe(true)
  })

  it('a damaged or foreign record reads as none', () => {
    const hr = make()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${SID}.json`), '{"v":1,"sid":')
    expect(hr.recall(SID)).toBeNull()
    fs.writeFileSync(path.join(dir, `${SID}.json`), JSON.stringify({ v: 1, sid: 'someone-else', args: ['claude'], cwd: '/x', at: now }))
    expect(hr.recall(SID)).toBeNull()
    fs.writeFileSync(path.join(dir, `${SID}.json`), JSON.stringify({ v: 1, sid: SID, args: [1], cwd: '/x', at: now }))
    expect(hr.recall(SID)).toBeNull()
  })

  it('a record older than 30 days is not used, and pruning removes it', () => {
    const hr = make()
    hr.remember(SID, { args: ['claude'], cwd: '/x' })
    const file = path.join(dir, `${SID}.json`)
    now += 31 * 24 * 60 * 60 * 1000
    expect(hr.recall(SID)).toBeNull()
    const old = (now - 31 * 24 * 60 * 60 * 1000) / 1000
    fs.utimesSync(file, old, old)
    expect(hr.prune()).toBe(1)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('keeps at most 300, the oldest go first', () => {
    const hr = make()
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    for (let i = 0; i < 305; i++) {
      const sid = `s${String(i).padStart(4, '0')}`
      const file = path.join(dir, `${sid}.json`)
      fs.writeFileSync(file, JSON.stringify({ v: 1, sid, args: ['claude'], cwd: '/x', at: now }))
      const t = (now - (305 - i) * 1000) / 1000
      fs.utimesSync(file, t, t)
    }
    expect(hr.prune()).toBe(5)
    const left = fs.readdirSync(dir).sort()
    expect(left).toHaveLength(300)
    expect(left[0]).toBe('s0005.json')
  })
})
