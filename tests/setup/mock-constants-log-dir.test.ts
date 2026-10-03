/**
 * createMockConstants keeps the log dir outside the test home.
 *
 * The logger appends to LOG_DIR from a 2s timer, and most test files delete
 * their home in a beforeEach/afterEach. With the log dir inside the home, a
 * flush that landed between rm's unlink of the log file and its rmdir of
 * `logs/` failed the rm with ENOTEMPTY, and whichever test owned that hook
 * failed with it (CI 2026-10-03, tests/core/plugin-capabilities.test.ts).
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('mock-log-dir'))

import { DTACH_SOCKET_DIR, LOG_DIR, WALNUT_HOME } from '../../src/constants.js'
import { flushLogBufferNow, logFilePath, writeLogEntry } from '../../src/logging/logger.js'

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

describe('the mocked log dir', () => {
  it('is not inside the home a test deletes', () => {
    expect(inside(LOG_DIR, WALNUT_HOME)).toBe(false)
    expect(inside(logFilePath(), LOG_DIR)).toBe(true)
    // Still the production shape for the dtach sockets: under LOG_DIR, per file.
    expect(path.dirname(DTACH_SOCKET_DIR)).toBe(LOG_DIR)
  })

  it('a flush after the home is removed still lands, and leaves the home gone', async () => {
    fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
    writeLogEntry({ time: new Date().toISOString(), level: 'info', subsystem: 'test', message: 'after the home went away' })
    await flushLogBufferNow(5_000)
    expect(fs.readFileSync(logFilePath(), 'utf8')).toContain('after the home went away')
    expect(fs.existsSync(WALNUT_HOME)).toBe(false)
  })
})
