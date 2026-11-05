/**
 * A `web --ephemeral` server ends when the process it works for does
 * (src/commands/ephemeral-owner.ts). 2026-11-04: a test server outlived the work that
 * started it, holding a 6.15 GB copy of the data dir until the Mac's disk was full.
 * The owner is the first ancestor of the launcher that is not a shell or a script
 * runner; the watch ends the server once that pid is gone or now names another process.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ownerGone, parsePsRows, pickOwner, resolveEphemeralOwner, startOwnerWatch, type ProcessRow } from '../../src/commands/ephemeral-owner.js'

const T = 'Wed Nov 4 20:57:01 2026'
const row = (pid: number, ppid: number, args: string): ProcessRow => ({ pid, ppid, start: T, args })

describe('pickOwner', () => {
  // The launcher's parents when an agent runs `bun run dev:ephemeral` from its Bash tool.
  const agentChain = [
    row(500, 1, 'claude -p --output-format stream-json'),
    row(510, 500, '/bin/zsh -c -l source ~/.zshrc && bun run dev:ephemeral'),
    row(520, 510, 'bun run dev:ephemeral'),
    row(530, 520, 'bash scripts/dev-ephemeral.sh'),
    row(540, 530, 'timeout 600 nice -n 5 env FOO=1 bash -c x'),
  ]

  it('skips shells, wrappers and script runners up to the agent CLI', () => {
    expect(pickOwner(agentChain, 540)?.pid).toBe(500)
    expect(pickOwner(agentChain, 530)).toMatchObject({ pid: 500, start: T })
  })

  it('a program that is not a pass-through is the owner (a test runner, a compiled walnut file)', () => {
    const rows = [row(600, 1, 'node /repo/node_modules/vitest/vitest.mjs run'), row(610, 600, '-zsh'),
      row(620, 1, '/usr/local/bin/walnut-darwin-arm64 web')]
    expect(pickOwner(rows, 610)?.pid).toBe(600)
    expect(pickOwner(rows, 620)?.pid).toBe(620)
    expect(pickOwner([row(700, 1, 'bun dist/cli.js web')], 700)?.pid).toBe(700)
    expect(pickOwner([row(701, 1, 'bun x vitest'), row(702, 701, 'sh')], 702)).toBeNull()
  })

  it('bun <package script>, time and sudo only pass the command on', () => {
    const rows = [row(500, 1, 'claude -p'), row(510, 500, 'bun dev:ephemeral'), row(520, 510, '/usr/bin/time -p sudo -E x')]
    expect(pickOwner(rows, 520)?.pid).toBe(500)
    expect(pickOwner([row(530, 1, 'bun src/cli.ts web')], 530)?.pid).toBe(530)
  })

  it('records the owner\'s own ancestors, nearest first, for when the owner was a wrapper', () => {
    const rows = [row(400, 1, 'login -pf someone'), row(450, 400, '-zsh'), row(500, 450, 'claude -p'),
      row(505, 500, 'zsh -c x'), row(510, 505, 'mywrapper --wait'), row(520, 510, 'sh')]
    expect(pickOwner(rows, 520)).toMatchObject({ pid: 510, above: [{ pid: 500 }, { pid: 400 }] })
  })

  it('no owner when only pass-throughs lead to pid 1, a parent is missing, or the table loops', () => {
    expect(pickOwner([row(800, 1, 'bash'), row(801, 800, 'sh')], 801)).toBeNull()
    expect(pickOwner([row(900, 899, 'sh')], 900)).toBeNull()
    expect(pickOwner([row(910, 911, 'sh'), row(911, 910, 'bash')], 910)).toBeNull()
    expect(pickOwner(agentChain, 1)).toBeNull()
  })
})

describe('parsePsRows', () => {
  it('reads macOS and Linux ps lines, args with spaces included', () => {
    const out = [
      '  500     1 Wed Nov  4 20:57:01 2026     claude -p --model x',
      '12345 12000 Thu Nov  5 01:02:03 2026 /bin/zsh -c echo hi there',
      'garbage line',
    ].join('\n')
    expect(parsePsRows(out)).toEqual([
      { pid: 500, ppid: 1, start: 'Wed Nov 4 20:57:01 2026', args: 'claude -p --model x' },
      { pid: 12345, ppid: 12000, start: 'Thu Nov 5 01:02:03 2026', args: '/bin/zsh -c echo hi there' },
    ])
  })
})

/** A real process that is gone by the time this returns. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid!
  await new Promise((r) => child.on('exit', r))
  return pid
}

describe('ownerGone and the real process table', () => {
  it('the test process is its own live owner; a dead pid or a reused pid is gone', async () => {
    const me = await resolveEphemeralOwner({ WALNUT_EPHEMERAL_OWNER_PID: String(process.pid) })
    expect(me?.pid).toBe(process.pid)
    expect(await ownerGone(me!)).toBe(false)
    expect(await ownerGone({ pid: await deadPid(), start: me!.start, command: 'x' })).toBe(true)
    expect(await ownerGone({ pid: process.pid, start: 'Mon Jan 1 00:00:00 2001', command: 'x' })).toBe(true)
  })

  it('WALNUT_EPHEMERAL_OWNER_PID=0 names no owner', async () => {
    expect(await resolveEphemeralOwner({ WALNUT_EPHEMERAL_OWNER_PID: '0' })).toBeNull()
  })
})

describe('startOwnerWatch', () => {
  it('touches the heartbeat, and calls onGone once when the owner dies', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-owner-watch-'))
    const control = path.join(dir, 'ephemeral.json')
    fs.writeFileSync(control, '{}')
    const old = new Date(Date.now() - 3600_000)
    fs.utimesSync(control, old, old)
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' })
    const owner = await resolveEphemeralOwner({ WALNUT_EPHEMERAL_OWNER_PID: String(sleeper.pid) })
    expect(owner?.pid).toBe(sleeper.pid)
    const reasons: string[] = []
    const stop = startOwnerWatch(control, owner, (r) => reasons.push(r), 50)
    try {
      await expect.poll(() => fs.statSync(control).mtimeMs > Date.now() - 60_000, { timeout: 5_000 }).toBe(true)
      expect(reasons).toEqual([])
      sleeper.kill('SIGKILL')
      await expect.poll(() => reasons.length, { timeout: 10_000 }).toBe(1)
      await new Promise((r) => setTimeout(r, 300))
      expect(reasons).toEqual([`owner pid ${sleeper.pid} is gone`])
    } finally {
      stop()
      sleeper.kill('SIGKILL')
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an owner gone right after the start was a wrapper: the next live ancestor takes over', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-owner-watch-'))
    const control = path.join(dir, 'ephemeral.json')
    fs.writeFileSync(control, '{}')
    const wrapper = spawn('sleep', ['30'], { stdio: 'ignore' })
    const agent = spawn('sleep', ['30'], { stdio: 'ignore' })
    const w = (await resolveEphemeralOwner({ WALNUT_EPHEMERAL_OWNER_PID: String(wrapper.pid) }))!
    const a = (await resolveEphemeralOwner({ WALNUT_EPHEMERAL_OWNER_PID: String(agent.pid) }))!
    const reasons: string[] = []
    wrapper.kill('SIGKILL')
    await new Promise((r) => wrapper.on('exit', r))
    const stop = startOwnerWatch(control, { ...w, above: [a] }, (r) => reasons.push(r), 50, 60_000)
    try {
      await new Promise((r) => setTimeout(r, 500))
      expect(reasons).toEqual([]) // the agent still lives
      agent.kill('SIGKILL')
      await expect.poll(() => reasons.length, { timeout: 10_000 }).toBe(1)
      expect(reasons[0]).toBe(`owner pid ${agent.pid} is gone`)
    } finally {
      stop(); agent.kill('SIGKILL')
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('past the grace an owner gone is the end, even with ancestors recorded', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-owner-watch-'))
    const control = path.join(dir, 'ephemeral.json')
    fs.writeFileSync(control, '{}')
    const me = (await resolveEphemeralOwner({ WALNUT_EPHEMERAL_OWNER_PID: String(process.pid) }))!
    const reasons: string[] = []
    const stop = startOwnerWatch(control, { pid: await deadPid(), start: me.start, command: 'x', above: [me] }, (r) => reasons.push(r), 50, 0)
    try {
      await expect.poll(() => reasons.length, { timeout: 10_000 }).toBe(1)
    } finally {
      stop(); fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('with no owner it only heartbeats', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-owner-watch-'))
    const control = path.join(dir, 'ephemeral.json')
    fs.writeFileSync(control, '{}')
    const reasons: string[] = []
    const stop = startOwnerWatch(control, null, (r) => reasons.push(r), 50)
    await new Promise((r) => setTimeout(r, 300))
    stop()
    expect(reasons).toEqual([])
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('the server is wired to it', () => {
  it('the launcher records the owner and the child watches it and heartbeats', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/commands/web-ephemeral.ts'), 'utf-8')
    expect(src).toMatch(/const owner = await resolveEphemeralOwner\(\)/)
    expect(src).toMatch(/EPHEMERAL_OWNER_FILE\), JSON\.stringify\(owner\)\)/)
    expect(src).toMatch(/startOwnerWatch\(controlFile, owner, /)
    expect(src).toMatch(/heartbeat: true/)
  })
})
