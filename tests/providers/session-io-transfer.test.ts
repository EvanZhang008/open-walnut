/**
 * Tests for transferImagesForRemoteSession — requires mocked child_process.
 *
 * Separated from session-io.test.ts because LocalIO tests need real execFileSync
 * (for mkfifo), while these tests need it mocked (for SSH/SCP).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

// Isolate all file I/O to a temp directory
vi.mock('../../src/constants.js', () => createMockConstants())

// Mock child_process — capture execFileSync calls for SSH/SCP verification
const mockExecFileSync = vi.fn(() => Buffer.from(''))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  }
})

import { transferImagesForRemoteSession } from '../../src/providers/session-io.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'

const tmpBase = WALNUT_HOME

beforeEach(async () => {
  mockExecFileSync.mockReset()
  mockExecFileSync.mockReturnValue(Buffer.from(''))
  await fsp.rm(tmpBase, { recursive: true, force: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})

afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

describe('transferImagesForRemoteSession (mocked SSH/SCP)', () => {
  it('calls ssh mkdir + scp and rewrites paths', async () => {
    const imgPath = path.join(tmpBase, 'dashboard.png')
    fs.writeFileSync(imgPath, 'fake-png-data')

    const text = `Please analyze this screenshot: ${imgPath}`
    const remoteDir = '/tmp/walnut-images/test123'
    const result = await transferImagesForRemoteSession(
      text,
      { hostname: 'remote.example.com', user: 'admin' },
      remoteDir,
    )

    // SSH mkdir should have been called
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'ssh',
      expect.arrayContaining(['admin@remote.example.com']),
      expect.objectContaining({ timeout: 10_000 }),
    )

    // SCP should have been called with the image file
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'scp',
      expect.arrayContaining([imgPath, 'admin@remote.example.com:/tmp/walnut-images/test123/']),
      expect.objectContaining({ timeout: 60_000 }),
    )

    // Path should be rewritten
    expect(result).toBe(`Please analyze this screenshot: ${remoteDir}/dashboard.png`)
    expect(result).not.toContain(imgPath)
  })

  it('uses -P (uppercase) for scp port and -p (lowercase) for ssh port', async () => {
    const imgPath = path.join(tmpBase, 'screen.png')
    fs.writeFileSync(imgPath, 'data')

    await transferImagesForRemoteSession(
      `See ${imgPath}`,
      { hostname: 'remote.example.com', user: 'admin', port: 2222 },
      '/tmp/walnut-images/porttest',
    )

    // SCP call should use -P (uppercase) for port
    const scpCall = mockExecFileSync.mock.calls.find((c) => c[0] === 'scp')
    expect(scpCall).toBeDefined()
    const scpArgs = scpCall![1] as string[]
    const pIdx = scpArgs.indexOf('-P')
    expect(pIdx).toBeGreaterThan(-1)
    expect(scpArgs[pIdx + 1]).toBe('2222')

    // SSH call should use -p (lowercase) for port
    const sshCall = mockExecFileSync.mock.calls.find((c) => c[0] === 'ssh')
    expect(sshCall).toBeDefined()
    const sshArgs = sshCall![1] as string[]
    const pIdxSsh = sshArgs.indexOf('-p')
    expect(pIdxSsh).toBeGreaterThan(-1)
    expect(sshArgs[pIdxSsh + 1]).toBe('2222')
  })

  it('handles scp failure gracefully — returns original text', async () => {
    const imgPath = path.join(tmpBase, 'fail.png')
    fs.writeFileSync(imgPath, 'data')

    // ssh mkdir succeeds, scp fails
    mockExecFileSync.mockImplementation((cmd: unknown) => {
      if (cmd === 'scp') throw new Error('Connection refused')
      return Buffer.from('')
    })

    const text = `See ${imgPath}`
    const result = await transferImagesForRemoteSession(
      text,
      { hostname: 'remote.example.com' },
      '/tmp/walnut-images/failtest',
    )

    // Should return original text on SCP failure
    expect(result).toBe(text)
  })

  it('handles ssh mkdir failure gracefully — returns original text', async () => {
    const imgPath = path.join(tmpBase, 'mkdirfail.png')
    fs.writeFileSync(imgPath, 'data')

    mockExecFileSync.mockImplementation(() => {
      throw new Error('Permission denied')
    })

    const text = `See ${imgPath}`
    const result = await transferImagesForRemoteSession(
      text,
      { hostname: 'remote.example.com' },
      '/tmp/walnut-images/mkdirfail',
    )

    // Should return original text on mkdir failure
    expect(result).toBe(text)
  })

  it('rewrites multiple paths correctly', async () => {
    const img1 = path.join(tmpBase, 'a.png')
    const img2 = path.join(tmpBase, 'b.jpg')
    fs.writeFileSync(img1, 'data1')
    fs.writeFileSync(img2, 'data2')

    const text = `First: ${img1}\nSecond: ${img2}\nAgain: ${img1}`
    const remoteDir = '/tmp/walnut-images/multi'
    const result = await transferImagesForRemoteSession(
      text,
      { hostname: 'remote.example.com' },
      remoteDir,
    )

    expect(result).toBe(`First: ${remoteDir}/a.png\nSecond: ${remoteDir}/b.jpg\nAgain: ${remoteDir}/a.png`)
    expect(result).not.toContain(tmpBase)
  })

  it('builds correct host string without user', async () => {
    const imgPath = path.join(tmpBase, 'nouser.png')
    fs.writeFileSync(imgPath, 'data')

    await transferImagesForRemoteSession(
      `See ${imgPath}`,
      { hostname: 'remote.example.com' },
      '/tmp/walnut-images/nouser',
    )

    // SSH should use hostname directly (no user@ prefix)
    const sshCall = mockExecFileSync.mock.calls.find((c) => c[0] === 'ssh')
    expect(sshCall).toBeDefined()
    const sshArgs = sshCall![1] as string[]
    expect(sshArgs).toContain('remote.example.com')
    expect(sshArgs.some((a: string) => a.includes('@'))).toBe(false)
  })
})
