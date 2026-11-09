/**
 * The machine's vitest slot (tests/setup/test-gate.ts) is held while its run lives: a queued run
 * waits on, however long, and starts once the holder is gone. 2026-11-09: queued runs proceeded
 * after 15 minutes of waiting and ran together beside a deploy build and an iOS build, at a load of
 * 200 to 400 on the Mac.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
  vi.doUnmock('../setup/cpu-idle')
  vi.resetModules()
})

describe('the vitest slot', () => {
  it('a queued run waits past its announce interval while the holder lives, and starts once it is gone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-gate-'))
    const holder = spawn('sleep', ['60'], { stdio: 'ignore' })
    try {
      fs.mkdirSync(path.join(dir, 'run-other'))
      fs.writeFileSync(path.join(dir, 'run-other', `${holder.pid}.pid`), String(Date.now()))
      Object.assign(process.env, {
        WALNUT_VITEST_GATE_DIR: dir, WALNUT_TEST_RUN_ID: 'me', WALNUT_VITEST_SLOT_WAIT_MS: '200',
        WALNUT_VITEST_MAX_LOAD: '1000000', WALNUT_MIN_IDLE_PCT: '0', WALNUT_VITEST_GATE: '1',
      })
      delete process.env.CI
      vi.resetModules()
      // The machine's own load and memory are not under test here: only the slot.
      vi.doMock('../setup/cpu-idle', async (orig) => ({
        ...(await orig<typeof import('../setup/cpu-idle')>()),
        readMemorySync: () => null,
        cpuIdlePct: async () => 100,
        ownLoadPerCore: () => ({ perCore: 0 }),
      }))
      const { acquireTestSlot, releaseTestSlot } = await import('../setup/test-gate')
      let started = false
      const waiting = acquireTestSlot().then(() => { started = true })
      await new Promise((r) => setTimeout(r, 1500))
      expect(started, 'it started beside a live holder').toBe(false)
      holder.kill()
      await new Promise((r) => holder.once('exit', r))
      await waiting
      expect(started).toBe(true)
      expect(fs.existsSync(path.join(dir, 'run-me', `${process.pid}.pid`))).toBe(true)
      releaseTestSlot()
    } finally {
      holder.kill()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
