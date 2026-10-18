/**
 * A replica prunes its log dir every day, not only at start (WP14,
 * docs/plan/walnut-replica-servers-impl.md section 13): it runs for weeks and
 * never sees the Mac's restarts. The Mac keeps its prune at start only.
 * Fake timers drive the day; the files are real, in the mocked LOG_DIR.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { initFileLogger, _dailyLogPruneForTesting } from '../../src/logging/logger.js'
import { LOG_DIR, LOG_PREFIX } from '../../src/constants.js'

const DAY = 24 * 60 * 60 * 1000
const saved = { role: process.env.WALNUT_ROLE, host: process.env.WALNUT_HOST_SERVER }

function logFile(name: string): string {
  const f = path.join(LOG_DIR, `${LOG_PREFIX}${name}.log`)
  fs.writeFileSync(f, '{"message":"x"}\n')
  return f
}

beforeEach(() => {
  fs.rmSync(LOG_DIR, { recursive: true, force: true })
  delete process.env.WALNUT_ROLE
  delete process.env.WALNUT_HOST_SERVER
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(new Date('2026-10-01T08:00:00Z'))
})

afterEach(() => {
  _dailyLogPruneForTesting().stop()
  vi.useRealTimers()
  if (saved.role === undefined) delete process.env.WALNUT_ROLE; else process.env.WALNUT_ROLE = saved.role
  if (saved.host === undefined) delete process.env.WALNUT_HOST_SERVER; else process.env.WALNUT_HOST_SERVER = saved.host
  fs.rmSync(LOG_DIR, { recursive: true, force: true })
})

describe('the log dir prune', () => {
  it('a host replica prunes every day while it runs', () => {
    process.env.WALNUT_ROLE = 'replica'
    initFileLogger()
    expect(_dailyLogPruneForTesting().running).toBe(true)
    // Written "now" by the file system's own clock; the fake clock moves on.
    const old = logFile('2026-10-01')
    const keep = path.join(LOG_DIR, 'not-a-walnut-log.txt')
    fs.writeFileSync(keep, 'x')
    const real = fs.statSync(old).mtimeMs
    vi.setSystemTime(real)
    vi.advanceTimersByTime(DAY)
    expect(fs.existsSync(old)).toBe(true)
    vi.advanceTimersByTime(3 * DAY)
    expect(fs.existsSync(old)).toBe(false)
    expect(fs.existsSync(keep)).toBe(true)
    // A file written later stays until it is 3 days old in turn.
    const fresh = logFile('2026-10-05')
    vi.setSystemTime(fs.statSync(fresh).mtimeMs)
    vi.advanceTimersByTime(2 * DAY)
    expect(fs.existsSync(fresh)).toBe(true)
  })

  it('a plain host server prunes daily too; a second init starts no second timer', () => {
    process.env.WALNUT_HOST_SERVER = '1'
    initFileLogger()
    initFileLogger()
    expect(_dailyLogPruneForTesting().running).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('the Mac (the leader) prunes at start only, as before', () => {
    initFileLogger()
    expect(_dailyLogPruneForTesting().running).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
