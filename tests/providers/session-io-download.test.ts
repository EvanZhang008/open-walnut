/**
 * Tests for remote→local image download functions:
 * findRemoteImagePaths, downloadRemoteImage, rewriteRemoteImagePaths.
 *
 * Separated from session-io.test.ts because these need mocked child_process
 * (for SCP download verification).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

// Isolate all file I/O to a temp directory
vi.mock('../../src/constants.js', () => createMockConstants())

// Mock child_process — capture execFile calls for SCP verification
const mockExecFile = vi.fn((_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: Error | null) => void) => {
  cb(null)
})
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (...args: unknown[]) => mockExecFile(...args),
    // Keep execFileSync from actual (not used by download functions)
    execFileSync: actual.execFileSync,
  }
})

import { findImagePaths, findRemoteImagePaths, downloadRemoteImage, rewriteRemoteImagePaths } from '../../src/providers/session-io.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR, REMOTE_IMAGES_DIR } from '../../src/constants.js'

const tmpBase = WALNUT_HOME

beforeEach(async () => {
  mockExecFile.mockReset()
  mockExecFile.mockImplementation((_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: Error | null) => void) => {
    cb(null)
  })
  await fsp.rm(tmpBase, { recursive: true, force: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})

afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

describe('findRemoteImagePaths', () => {
  it('finds absolute image paths in text', () => {
    const text = 'Screenshot at /tmp/walnut-images/abc123/screenshot.png and /home/user/photo.jpg'
    const paths = findRemoteImagePaths(text)
    expect(paths).toHaveLength(2)
    expect(paths).toContain('/tmp/walnut-images/abc123/screenshot.png')
    expect(paths).toContain('/home/user/photo.jpg')
  })

  it('deduplicates paths', () => {
    const text = '/tmp/img.png appears twice: /tmp/img.png'
    const paths = findRemoteImagePaths(text)
    expect(paths).toHaveLength(1)
    expect(paths[0]).toBe('/tmp/img.png')
  })

  it('returns empty array for text without image paths', () => {
    const paths = findRemoteImagePaths('Hello world, no images here')
    expect(paths).toHaveLength(0)
  })

  it('matches various image extensions', () => {
    const text = '/a.png /b.jpg /c.jpeg /d.gif /e.webp /f.bmp /g.tiff'
    const paths = findRemoteImagePaths(text)
    expect(paths).toHaveLength(7)
  })

  it('does NOT require files to exist on local disk (unlike findLocalImagePaths)', () => {
    // Remote paths won't exist locally — that's fine, we don't stat them
    const text = '/nonexistent/path/remote-screenshot.png'
    const paths = findRemoteImagePaths(text)
    expect(paths).toHaveLength(1)
  })
})

describe('downloadRemoteImage', () => {
  it('calls scp with correct args', async () => {
    const localPath = path.join(tmpBase, 'downloaded.png')
    const result = await downloadRemoteImage(
      { hostname: 'remote.example.com', user: 'admin' },
      '/tmp/walnut-images/abc/screenshot.png',
      localPath,
    )

    expect(result).toBe(true)
    expect(mockExecFile).toHaveBeenCalledWith(
      'scp',
      expect.arrayContaining([
        'admin@remote.example.com:/tmp/walnut-images/abc/screenshot.png',
        localPath,
      ]),
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function),
    )
  })

  it('uses -P for port', async () => {
    const localPath = path.join(tmpBase, 'port-test.png')
    await downloadRemoteImage(
      { hostname: 'remote.example.com', user: 'admin', port: 2222 },
      '/tmp/remote.png',
      localPath,
    )

    const scpArgs = mockExecFile.mock.calls[0][1] as string[]
    const pIdx = scpArgs.indexOf('-P')
    expect(pIdx).toBeGreaterThan(-1)
    expect(scpArgs[pIdx + 1]).toBe('2222')
  })

  it('returns false on SCP failure', async () => {
    mockExecFile.mockImplementation((_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: Error | null) => void) => {
      cb(new Error('Connection refused'))
    })

    const result = await downloadRemoteImage(
      { hostname: 'remote.example.com' },
      '/tmp/remote.png',
      path.join(tmpBase, 'fail.png'),
    )

    expect(result).toBe(false)
  })

  it('creates local directory if it does not exist', async () => {
    const localPath = path.join(tmpBase, 'images', 'remote', 'session-123', 'nested.png')
    await downloadRemoteImage(
      { hostname: 'remote.example.com' },
      '/tmp/remote.png',
      localPath,
    )

    // The directory should have been created
    expect(fs.existsSync(path.dirname(localPath))).toBe(true)
  })
})

describe('rewriteRemoteImagePaths', () => {
  it('rewrites remote paths to local paths', () => {
    const text = 'Screenshot at /tmp/walnut-images/abc123/screenshot.png done.'
    const cache = new Map<string, string>()
    const result = rewriteRemoteImagePaths(
      text,
      { hostname: 'remote.example.com' },
      'session-abc',
      cache,
    )

    expect(result).toContain('images/remote/session-abc/screenshot.png')
    expect(result).not.toContain('/tmp/walnut-images/')
  })

  it('caches paths to avoid re-downloading', () => {
    const text = '/tmp/img.png appears here'
    const cache = new Map<string, string>()

    // First call: triggers download
    rewriteRemoteImagePaths(text, { hostname: 'h' }, 'sess', cache)
    expect(mockExecFile).toHaveBeenCalledTimes(1)

    // Second call: uses cache, no new download
    mockExecFile.mockClear()
    rewriteRemoteImagePaths(text, { hostname: 'h' }, 'sess', cache)
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('returns text unchanged when no image paths', () => {
    const text = 'No images in this text.'
    const cache = new Map<string, string>()
    const result = rewriteRemoteImagePaths(text, { hostname: 'h' }, 's', cache)
    expect(result).toBe(text)
  })

  it('rewrites multiple paths in one call', () => {
    const text = '/tmp/a.png and /tmp/b.jpg and /tmp/a.png again'
    const cache = new Map<string, string>()
    const result = rewriteRemoteImagePaths(
      text,
      { hostname: 'h' },
      'session-multi',
      cache,
    )

    expect(result).not.toContain('/tmp/a.png')
    expect(result).not.toContain('/tmp/b.jpg')
    expect(result).toContain('images/remote/session-multi/a.png')
    expect(result).toContain('images/remote/session-multi/b.jpg')
    expect(cache.size).toBe(2)
  })

  it('skips download if local file already exists', () => {
    // Create the local file so fs.existsSync returns true
    const localDir = path.join(REMOTE_IMAGES_DIR, 'session-exists')
    fs.mkdirSync(localDir, { recursive: true })
    fs.writeFileSync(path.join(localDir, 'cached.png'), 'data')

    const text = '/tmp/cached.png is already local'
    const cache = new Map<string, string>()
    rewriteRemoteImagePaths(text, { hostname: 'h' }, 'session-exists', cache)

    // No SCP should be triggered — file already exists
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('handles paths with spaces in backticks', () => {
    const text = 'See `/workplace/user/Screenshot 2026-02-17 at 11.12.47 PM.png` for details'
    const cache = new Map<string, string>()
    const result = rewriteRemoteImagePaths(text, { hostname: 'h' }, 'sess-space', cache)

    expect(result).not.toContain('/workplace/user/Screenshot 2026-02-17 at 11.12.47 PM.png')
    expect(result).toContain('images/remote/sess-space/Screenshot 2026-02-17 at 11.12.47 PM.png')
    expect(cache.size).toBe(1)
  })

  it('handles paths with spaces in double quotes', () => {
    const text = 'File at "/tmp/walnut-images/abc/My Screenshot.png" saved'
    const cache = new Map<string, string>()
    const result = rewriteRemoteImagePaths(text, { hostname: 'h' }, 'sess-dq', cache)

    expect(result).not.toContain('/tmp/walnut-images/abc/My Screenshot.png')
    expect(result).toContain('images/remote/sess-dq/My Screenshot.png')
  })
})

describe('findImagePaths (space-aware path detection)', () => {
  it('finds unquoted paths without spaces', () => {
    const paths = findImagePaths('/tmp/test.png and /home/user/photo.jpg')
    expect(paths).toHaveLength(2)
    expect(paths).toContain('/tmp/test.png')
    expect(paths).toContain('/home/user/photo.jpg')
  })

  it('finds backtick-quoted paths with spaces', () => {
    const paths = findImagePaths('See `/workplace/Screenshot 2026-02-17 at 11.12.47 PM.png` here')
    expect(paths).toHaveLength(1)
    expect(paths[0]).toBe('/workplace/Screenshot 2026-02-17 at 11.12.47 PM.png')
  })

  it('finds double-quoted paths with spaces', () => {
    const paths = findImagePaths('File at "/tmp/My Folder/image file.png" done')
    expect(paths).toHaveLength(1)
    expect(paths[0]).toBe('/tmp/My Folder/image file.png')
  })

  it('finds single-quoted paths with spaces', () => {
    const paths = findImagePaths("File at '/tmp/My Folder/image file.png' done")
    expect(paths).toHaveLength(1)
    expect(paths[0]).toBe('/tmp/My Folder/image file.png')
  })

  it('finds paths in JSON values', () => {
    const json = '{"file_path": "/workspace/remote/Screenshot 2026.png", "other": 123}'
    const paths = findImagePaths(json)
    expect(paths).toHaveLength(1)
    expect(paths[0]).toBe('/workspace/remote/Screenshot 2026.png')
  })

  it('finds both quoted (spaced) and unquoted (no-space) paths in same text', () => {
    const text = 'Unquoted /tmp/simple.png and quoted `/home/user/My Screenshot.jpg` together'
    const paths = findImagePaths(text)
    expect(paths).toHaveLength(2)
    expect(paths).toContain('/tmp/simple.png')
    expect(paths).toContain('/home/user/My Screenshot.jpg')
  })

  it('deduplicates across quoted and unquoted matches', () => {
    const text = '/tmp/same.png and "/tmp/same.png" and `/tmp/same.png`'
    const paths = findImagePaths(text)
    expect(paths).toHaveLength(1)
    expect(paths[0]).toBe('/tmp/same.png')
  })

  it('does not match non-image extensions', () => {
    const paths = findImagePaths('`/tmp/file.txt` and "/home/doc.pdf"')
    expect(paths).toHaveLength(0)
  })

  it('handles the real-world failing example', () => {
    const text = 'Screenshot saved to `/home/user/projects/my-app-main/src/my-app/Screenshot 2026-02-17 at 11.12.47 PM.png`'
    const paths = findImagePaths(text)
    expect(paths).toHaveLength(1)
    expect(paths[0]).toBe('/home/user/projects/my-app-main/src/my-app/Screenshot 2026-02-17 at 11.12.47 PM.png')
  })

  it('returns empty for text without image paths', () => {
    expect(findImagePaths('Hello world')).toHaveLength(0)
  })
})
