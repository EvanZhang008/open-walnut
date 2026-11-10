/**
 * At most WALNUT_EPHEMERAL_MAX ephemeral servers at once (src/commands/ephemeral-slots.ts).
 * 2026-11-09: one Mac ran up to three test servers at once (each 0.3 to 1.5 GB with its daemon)
 * while its load watchdog logged 129 "MEMORY TIGHT" samples. A slot is a file naming its
 * holder; a dead or reused pid frees it; a launcher that finds none waits, says who holds
 * them, and gives up after its wait.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  acquireEphemeralSlot, ephemeralMaxServers, ephemeralSlotDir, ephemeralWaitMs, giveUpLines, liveSlots,
  releaseSlot, slotWanted, tryTakeSlot, SERVER_SLOT_STALE_MS, updateSlot, waitingLines, markWanted, WANTED_FRESH_MS, type SlotHolder,
} from '../../src/commands/ephemeral-slots.js'
import { processStartOf } from '../../src/commands/ephemeral-owner.js'

const DEAD_PID = 2 ** 22
let dir: string
const kids: ChildProcess[] = []

/** A live process to hold a slot; ended by its own pid in afterEach. */
function sleeper(): number {
  const p = spawn('sleep', ['120'], { stdio: 'ignore' })
  kids.push(p)
  return p.pid!
}
const holder = (pid: number, extra: Partial<SlotHolder> = {}): SlotHolder => ({ pid, start: '', role: 'launcher', takenAt: Date.now(), ...extra })
const slotFiles = () => fs.readdirSync(dir).filter((n) => /^slot-\d+\.json$/.test(n)).sort()

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-eph-slots-')) })
afterEach(() => {
  for (const k of kids.splice(0)) { try { process.kill(k.pid!, 'SIGKILL') } catch { /* gone */ } }
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('settings', () => {
  it('caps at 2 on macOS and 3 elsewhere by default; WALNUT_EPHEMERAL_MAX overrides, 0 = no cap', () => {
    expect(ephemeralMaxServers({}, 'darwin')).toBe(2)
    expect(ephemeralMaxServers({}, 'linux')).toBe(3)
    expect(ephemeralMaxServers({ WALNUT_EPHEMERAL_MAX: '1' }, 'linux')).toBe(1)
    expect(ephemeralMaxServers({ WALNUT_EPHEMERAL_MAX: '0' }, 'darwin')).toBe(0)
    expect(ephemeralMaxServers({ WALNUT_EPHEMERAL_MAX: 'two' }, 'darwin')).toBe(2)
  })

  it('waits 30 min by default; the slot dir sits in the data home tmp/ unless a test names one', () => {
    expect(ephemeralWaitMs({})).toBe(30 * 60_000)
    expect(ephemeralWaitMs({ WALNUT_EPHEMERAL_WAIT_MINUTES: '0.05' })).toBe(3_000)
    expect(ephemeralWaitMs({ WALNUT_EPHEMERAL_WAIT_MINUTES: 'soon' })).toBe(30 * 60_000)
    expect(ephemeralSlotDir('/h', {})).toBe(path.join('/h', 'tmp', 'ephemeral-slots'))
    expect(ephemeralSlotDir('/h', { WALNUT_EPHEMERAL_SLOT_DIR: '/x' })).toBe('/x')
  })
})

describe('taking and freeing slots', () => {
  it('takes up to the cap, then none', async () => {
    const a = await tryTakeSlot(dir, 2, holder(sleeper()), [])
    const b = await tryTakeSlot(dir, 2, holder(sleeper()), await liveSlots(dir))
    expect(a && b).toBeTruthy()
    expect(await tryTakeSlot(dir, 2, holder(sleeper()), await liveSlots(dir))).toBeNull()
    // Even past the count check (a stale `held` list), no third file appears.
    expect(await tryTakeSlot(dir, 2, holder(sleeper()), [])).toBeNull()
    expect(slotFiles()).toEqual(['slot-0.json', 'slot-1.json'])
  })

  it('a live server that stopped rewriting its slot (a hung loop) frees it; a launcher\'s does not expire', async () => {
    const start = await processStartOf(process.pid)
    const server = path.join(dir, 'slot-0.json')
    const launcher = path.join(dir, 'slot-1.json')
    fs.writeFileSync(server, JSON.stringify(holder(process.pid, { start, role: 'server' })))
    fs.writeFileSync(launcher, JSON.stringify(holder(process.pid, { start, role: 'launcher' })))
    expect((await liveSlots(dir)).map((h) => path.basename(h.file))).toEqual(['slot-0.json', 'slot-1.json'])
    const old = (Date.now() - SERVER_SLOT_STALE_MS - 60_000) / 1000
    fs.utimesSync(server, old, old)
    fs.utimesSync(launcher, old, old)
    expect((await liveSlots(dir)).map((h) => path.basename(h.file))).toEqual(['slot-1.json'])
  })

  it('a slot whose holder died, or whose pid now names another process, is free', async () => {
    fs.writeFileSync(path.join(dir, 'slot-0.json'), JSON.stringify(holder(DEAD_PID)))
    // Our own pid with a start time it never had: a reused pid.
    fs.writeFileSync(path.join(dir, 'slot-1.json'), JSON.stringify(holder(process.pid, { start: 'Mon Jan 1 00:00:00 2001' })))
    expect(await liveSlots(dir)).toEqual([])
    expect(slotFiles()).toEqual([])
    const pid = sleeper()
    const start = await processStartOf(pid)
    expect(start).not.toBe('')
    expect(await tryTakeSlot(dir, 1, holder(pid, { start }), [])).not.toBeNull()
    expect((await liveSlots(dir)).map((s) => s.holder.pid)).toEqual([pid])
  })

  it('takes a dead holder\'s slot directly when the count says there is room', async () => {
    fs.writeFileSync(path.join(dir, 'slot-0.json'), JSON.stringify(holder(DEAD_PID)))
    const got = await tryTakeSlot(dir, 1, holder(process.pid), [])
    expect(got?.file).toBe(path.join(dir, 'slot-0.json'))
    expect(JSON.parse(fs.readFileSync(got!.file, 'utf-8')).pid).toBe(process.pid)
  })

  it('live servers that hold no slot (an older build) count against the cap', async () => {
    expect(await tryTakeSlot(dir, 2, holder(sleeper()), [], 2)).toBeNull()
    expect(await tryTakeSlot(dir, 2, holder(sleeper()), [], 1)).not.toBeNull()
    expect(await tryTakeSlot(dir, 2, holder(sleeper()), await liveSlots(dir), 1)).toBeNull()
  })

  it('updates and releases only the holder\'s own slot', async () => {
    const launcher = sleeper()
    const got = (await tryTakeSlot(dir, 1, holder(launcher), []))!
    expect(updateSlot(got.file, 12345, { port: 1 })).toBe(false)
    const server = sleeper()
    expect(updateSlot(got.file, launcher, { pid: server, role: 'server' })).toBe(true)
    releaseSlot(got.file, launcher) // the launcher's exit after the hand-over
    expect(fs.existsSync(got.file)).toBe(true)
    expect(updateSlot(got.file, server, { port: 4321 })).toBe(true)
    expect(JSON.parse(fs.readFileSync(got.file, 'utf-8'))).toMatchObject({ pid: server, role: 'server', port: 4321 })
    releaseSlot(got.file, server)
    expect(fs.existsSync(got.file)).toBe(false)
  })

  it('separate processes racing for 2 slots get exactly 2', async () => {
    const mod = path.join(import.meta.dirname, '../../src/commands/ephemeral-slots.ts')
    const code = `const m = await import(${JSON.stringify(mod)}); const got = await m.tryTakeSlot(${JSON.stringify(dir)}, 2, { pid: process.pid, start: '', role: 'launcher', takenAt: Date.now() }, []); console.log(got ? 'took' : 'none'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0))`
    const racers = Array.from({ length: 6 }, () => {
      const p = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'inherit'] })
      kids.push(p)
      return new Promise<string>((resolve) => { let out = ''; p.stdout!.on('data', (d) => { out += d; if (out.includes('\n')) resolve(out.trim()) }) })
    })
    const results = await Promise.all(racers)
    expect(results.filter((r) => r === 'took')).toHaveLength(2)
    expect(slotFiles()).toEqual(['slot-0.json', 'slot-1.json'])
    for (const k of kids) k.stdin?.end()
  }, 30_000)
})

describe('the waiting marker', () => {
  it('reads as wanted only while its waiter lives and keeps it fresh', () => {
    expect(slotWanted(dir)).toBe(false)
    markWanted(dir, process.pid)
    expect(slotWanted(dir)).toBe(true)
    expect(slotWanted(dir, Date.now() + WANTED_FRESH_MS + 1_000)).toBe(false)
    fs.writeFileSync(path.join(dir, `wanted-${DEAD_PID}.json`), '{}')
    fs.unlinkSync(path.join(dir, `wanted-${process.pid}.json`))
    expect(slotWanted(dir)).toBe(false)
    expect(fs.existsSync(path.join(dir, `wanted-${DEAD_PID}.json`))).toBe(false)
  })
})

describe('what a waiting launcher says', () => {
  const now = Date.parse('2026-11-09T12:00:00Z')
  const running = [
    { pid: 4242, port: 51234, ownerPid: 777, ownerCommand: 'claude -p --output-format stream-json', since: now - 42 * 60_000, idleMinutes: 3.14, idleLimitMinutes: 120 },
    { pid: 4343, starting: true, ownerPid: 778, since: now - 60_000 },
  ]

  it('names every server, the cap and its setting, the wait, and the contended rule', () => {
    const text = waitingLines(running, 2, 30 * 60_000, 15, now).join('\n')
    expect(text).toContain('2 Walnut test servers already run on this machine, and at most 2 run at once (WALNUT_EPHEMERAL_MAX=2)')
    expect(text).toContain('Waiting for one to end (up to 30 min, WALNUT_EPHEMERAL_WAIT_MINUTES)')
    expect(text).toContain('pid 4242, port 51234, owner pid 777 (claude -p --output-format stream-json), up 42 min, idle 3.1 min of 120')
    expect(text).toContain('pid 4343, starting, owner pid 778, up 1 min')
    expect(text).toContain('a server idle for 15 min ends by itself (WALNUT_EPHEMERAL_CONTENDED_IDLE_MINUTES)')
  })

  it('giving up says what to do', () => {
    const text = giveUpLines(running, 2, 30 * 60_000, now).join('\n')
    expect(text).toContain('gave up after 30 min: 2 Walnut test servers still run')
    expect(text).toContain('kill <its pid> ends it cleanly')
    expect(text).toContain('WALNUT_EPHEMERAL_WAIT_MINUTES')
  })
})

describe('acquireEphemeralSlot', () => {
  const base = { max: 1, contendedMinutes: 15, liveServers: () => [], pollMs: 20 }

  it('waits while the slot is held, marks itself wanted, and takes the slot once its holder ends', async () => {
    const blocker = spawn('sleep', ['120'], { stdio: 'ignore' })
    kids.push(blocker)
    fs.writeFileSync(path.join(dir, 'slot-0.json'), JSON.stringify(holder(blocker.pid!, { role: 'server', port: 5555 })))
    const said: string[] = []
    let wantedWhileWaiting = false
    const got = await acquireEphemeralSlot({
      ...base, dir, waitMs: 20_000, holder: holder(process.pid),
      say: (line) => {
        said.push(line)
        wantedWhileWaiting ||= slotWanted(dir)
        if (said.length === 1) blocker.kill('SIGKILL')
      },
    })
    expect(got.slot?.holder.pid).toBe(process.pid)
    expect(said[0]).toContain('1 Walnut test server already runs on this machine, and at most 1 run at once')
    expect(said.join('\n')).toContain(`pid ${blocker.pid}, port 5555`)
    expect(wantedWhileWaiting).toBe(true)
    expect(slotWanted(dir)).toBe(false)
  }, 30_000)

  it('gives up after its wait with who holds the slots, and leaves no marker', async () => {
    const pid = sleeper()
    fs.writeFileSync(path.join(dir, 'slot-0.json'), JSON.stringify(holder(pid)))
    const got = await acquireEphemeralSlot({ ...base, dir, waitMs: 150, holder: holder(process.pid), say: () => {} })
    expect(got.slot).toBeNull()
    if (got.slot === null) {
      expect(got.reason).toBe('timeout')
      expect(got.running.map((r) => r.pid)).toEqual([pid])
    }
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('wanted-'))).toEqual([])
  })

  it('stops waiting once the process that asked is gone', async () => {
    fs.writeFileSync(path.join(dir, 'slot-0.json'), JSON.stringify(holder(sleeper())))
    const got = await acquireEphemeralSlot({ ...base, dir, waitMs: 20_000, holder: holder(process.pid), say: () => {}, ownerGone: async () => true, ownerCheckEveryMs: 0 })
    expect(got.slot === null && got.reason).toBe('owner-gone')
  })
})
