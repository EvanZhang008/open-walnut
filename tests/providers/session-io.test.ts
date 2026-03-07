/**
 * Tests for SessionIO abstraction layer — LocalIO, RemoteIO, createSessionIO.
 *
 * Verifies the unified I/O interface introduced to eliminate local/SSH
 * divergence in ClaudeCodeSession. Tests the abstraction directly,
 * independent of the session runner / mock CLI.
 *
 * Three sections:
 *   1. LocalIO — FIFO creation, write, startTail/stopTail, rename, recovery, cleanup
 *   2. createSessionIO factory — dispatches LocalIO vs RemoteIO
 *   3. RemoteIO structural — property checks (no real SSH)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

// Isolate all file I/O to a temp directory
vi.mock('../../src/constants.js', () => createMockConstants())

import { LocalIO, RemoteIO, createSessionIO, findLocalImagePaths, transferImagesForRemoteSession, buildRemoteCommand, buildRemotePreamble, wrapInLoginShell, REMOTE_BASE_PATH } from '../../src/providers/session-io.js'
import { SESSION_STREAMS_DIR, WALNUT_HOME } from '../../src/constants.js'

const tmpBase = WALNUT_HOME

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 100))
  await fsp.rm(tmpBase, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

// ═══════════════════════════════════════════════════════════════════
//  Section 1: LocalIO
// ═══════════════════════════════════════════════════════════════════

describe('LocalIO', () => {
  it('createFiles() creates FIFO, JSONL, and stderr files', () => {
    const io = new LocalIO('test-create')
    const { pipePath, pipeFd, outputFd, stderrFd } = io.createFiles()

    try {
      // FIFO exists and is actually a FIFO
      const pipeStat = fs.statSync(pipePath)
      expect(pipeStat.isFIFO()).toBe(true)

      // JSONL output file exists
      expect(fs.existsSync(io.outputFile)).toBe(true)
      expect(io.outputFile).toContain('test-create.jsonl')

      // Stderr file exists
      expect(fs.existsSync(io.outputFile + '.err')).toBe(true)

      // File descriptors are valid numbers
      expect(pipeFd).toBeGreaterThan(0)
      expect(outputFd).toBeGreaterThan(0)
      expect(stderrFd).toBeGreaterThan(0)

      // hasPipe should be true after createFiles
      expect(io.hasPipe).toBe(true)
    } finally {
      // Close file descriptors to prevent leaks
      try { fs.closeSync(pipeFd) } catch { /* ignore */ }
      try { fs.closeSync(outputFd) } catch { /* ignore */ }
      try { fs.closeSync(stderrFd) } catch { /* ignore */ }
      io.deletePipe()
    }
  })

  it('writeInitialMessage() writes stream-json payload to FIFO', () => {
    const io = new LocalIO('test-init-msg')
    const { pipePath, pipeFd, outputFd, stderrFd } = io.createFiles()

    try {
      // Write the initial message
      io.writeInitialMessage(pipeFd, 'hello world')
      // pipeFd is now closed by writeInitialMessage

      // Read from the FIFO (non-blocking) to verify what was written.
      // We need to open it non-blocking since the child end is not open.
      const readFd = fs.openSync(pipePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
      const buf = Buffer.alloc(4096)
      let bytesRead = 0
      try {
        bytesRead = fs.readSync(readFd, buf, 0, buf.length, null)
      } catch {
        // EAGAIN on empty pipe is expected
      }
      fs.closeSync(readFd)

      if (bytesRead > 0) {
        const data = buf.subarray(0, bytesRead).toString('utf-8')
        const parsed = JSON.parse(data.trim())
        expect(parsed.type).toBe('user')
        expect(parsed.message.role).toBe('user')
        expect(parsed.message.content).toBe('hello world')
      }
    } finally {
      try { fs.closeSync(outputFd) } catch { /* ignore */ }
      try { fs.closeSync(stderrFd) } catch { /* ignore */ }
      io.deletePipe()
    }
  })

  it('write() returns false when pipePath is null (no createFiles called)', () => {
    const io = new LocalIO('test-no-pipe')
    expect(io.hasPipe).toBe(false)
    expect(io.write('hello')).toBe(false)
  })

  it('write() returns false when FIFO is deleted, and flips hasPipe', () => {
    const io = new LocalIO('test-broken-pipe')
    const { pipePath, pipeFd, outputFd, stderrFd } = io.createFiles()

    try {
      // Close the pipeFd (simulates parent closing after initial write)
      fs.closeSync(pipeFd)

      // Delete the FIFO
      fs.unlinkSync(pipePath)

      // write() should fail and flip hasPipe to false
      const result = io.write('this should fail')
      expect(result).toBe(false)
      expect(io.hasPipe).toBe(false)
    } finally {
      try { fs.closeSync(outputFd) } catch { /* ignore */ }
      try { fs.closeSync(stderrFd) } catch { /* ignore */ }
    }
  })

  it('startTail() + stopTail() lifecycle', async () => {
    const io = new LocalIO('test-tail')

    // Create the JSONL file (not the full createFiles — just the output file)
    fs.mkdirSync(SESSION_STREAMS_DIR, { recursive: true })
    fs.writeFileSync(io.outputFile, '')

    const lines: string[] = []
    io.startTail((line) => lines.push(line))

    // Write a JSONL line to the output file
    const jsonLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test-123' })
    fs.appendFileSync(io.outputFile, jsonLine + '\n')

    // JsonlTailer uses fs.watch + 1s polling fallback.
    // fs.watch may not fire on temp dirs — wait for the poll interval.
    await new Promise((r) => setTimeout(r, 1200))

    expect(lines.length).toBeGreaterThanOrEqual(1)
    expect(lines[0]).toContain('test-123')

    io.stopTail()
  })

  it('flushTail() processes remaining buffer', () => {
    const io = new LocalIO('test-flush')

    fs.mkdirSync(SESSION_STREAMS_DIR, { recursive: true })
    // Write a complete line without trailing newline (will be buffered)
    const jsonLine = JSON.stringify({ type: 'result', subtype: 'success' })
    fs.writeFileSync(io.outputFile, jsonLine)

    const lines: string[] = []
    io.startTail((line) => lines.push(line))

    // Nothing delivered yet (no trailing newline → still buffered)
    // Flush should deliver the buffered data
    io.flushTail()

    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('result')

    io.stopTail()
  })

  it('tailOffset reflects bytes read', () => {
    const io = new LocalIO('test-offset')

    fs.mkdirSync(SESSION_STREAMS_DIR, { recursive: true })
    const jsonLine = JSON.stringify({ type: 'system' }) + '\n'
    // Write content before start so it's read immediately (no polling needed)
    fs.writeFileSync(io.outputFile, jsonLine)

    const lines: string[] = []
    io.startTail((line) => lines.push(line))

    // Existing content is read synchronously on start
    expect(io.tailOffset).toBe(Buffer.byteLength(jsonLine))

    io.stopTail()
  })

  it('renameForSession() renames JSONL and FIFO files', () => {
    const io = new LocalIO('test-rename')
    const { pipePath, pipeFd, outputFd, stderrFd } = io.createFiles()

    try {
      fs.closeSync(pipeFd)
      fs.closeSync(outputFd)
      fs.closeSync(stderrFd)

      const oldOutputFile = io.outputFile
      const oldPipePath = pipePath

      io.renameForSession('real-session-abc')

      // New paths should exist
      const expectedOutput = path.join(SESSION_STREAMS_DIR, 'real-session-abc.jsonl')
      const expectedPipe = path.join(SESSION_STREAMS_DIR, 'real-session-abc.pipe')

      expect(io.outputFile).toBe(expectedOutput)
      expect(fs.existsSync(expectedOutput)).toBe(true)
      expect(fs.existsSync(expectedPipe)).toBe(true)

      // Old paths should be gone
      expect(fs.existsSync(oldOutputFile)).toBe(false)
      expect(fs.existsSync(oldPipePath)).toBe(false)
    } finally {
      io.deletePipe()
    }
  })

  it('renameForSession() preserves tailer continuity (no data gap)', async () => {
    const io = new LocalIO('test-rename-tail')

    fs.mkdirSync(SESSION_STREAMS_DIR, { recursive: true })

    // Pre-populate the file with the first line so it's available at startTail time
    const line1 = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'real-id' })
    fs.writeFileSync(io.outputFile, line1 + '\n')

    const lines: string[] = []
    io.startTail((line) => lines.push(line))

    // First line should be read immediately (existing content)
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('init')

    // Rename the session — tailer restarts on new path preserving offset
    io.renameForSession('real-id')

    // Write second line after rename (to the new path)
    const line2 = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } })
    fs.appendFileSync(io.outputFile, line2 + '\n')

    // Wait for poll to pick up the new data
    await new Promise((r) => setTimeout(r, 1200))

    // Both lines should have been received — no gap
    expect(lines.length).toBe(2)
    expect(lines[1]).toContain('assistant')

    io.stopTail()
  })

  it('renameForSession() is idempotent (skips if already renamed)', () => {
    const io = new LocalIO('test-rename-idem')

    fs.mkdirSync(SESSION_STREAMS_DIR, { recursive: true })
    fs.writeFileSync(io.outputFile, '')

    // First rename
    io.renameForSession('session-xyz')
    const afterFirst = io.outputFile

    // Second rename with same ID — should be no-op
    io.renameForSession('session-xyz')
    expect(io.outputFile).toBe(afterFirst)
  })

  it('recoverPipe() finds existing FIFO', () => {
    const io = new LocalIO('test-recover')

    // Create a FIFO at the expected session-based path
    const candidatePipe = path.join(SESSION_STREAMS_DIR, 'recovered-session.pipe')
    try { fs.unlinkSync(candidatePipe) } catch { /* */ }
    const { execFileSync } = require('node:child_process')
    execFileSync('mkfifo', [candidatePipe])

    expect(io.hasPipe).toBe(false)
    io.recoverPipe('recovered-session')
    expect(io.hasPipe).toBe(true)

    // Clean up
    fs.unlinkSync(candidatePipe)
  })

  it('recoverPipe() is no-op when FIFO does not exist', () => {
    const io = new LocalIO('test-recover-miss')
    expect(io.hasPipe).toBe(false)
    io.recoverPipe('nonexistent-session')
    expect(io.hasPipe).toBe(false)
  })

  it('deletePipe() removes FIFO and flips hasPipe', () => {
    const io = new LocalIO('test-delete-pipe')
    const { pipePath, pipeFd, outputFd, stderrFd } = io.createFiles()

    fs.closeSync(pipeFd)
    fs.closeSync(outputFd)
    fs.closeSync(stderrFd)

    expect(io.hasPipe).toBe(true)
    expect(fs.existsSync(pipePath)).toBe(true)

    io.deletePipe()

    expect(io.hasPipe).toBe(false)
    expect(fs.existsSync(pipePath)).toBe(false)
  })

  it('deletePipe() is safe to call when no pipe exists', () => {
    const io = new LocalIO('test-delete-noop')
    expect(io.hasPipe).toBe(false)
    // Should not throw
    io.deletePipe()
    expect(io.hasPipe).toBe(false)
  })

  it('cleanup() removes JSONL, stderr, and pipe files', async () => {
    const io = new LocalIO('test-cleanup')
    const { pipePath, pipeFd, outputFd, stderrFd } = io.createFiles()

    fs.closeSync(pipeFd)
    fs.closeSync(outputFd)
    fs.closeSync(stderrFd)

    // All files exist before cleanup
    expect(fs.existsSync(io.outputFile)).toBe(true)
    expect(fs.existsSync(io.outputFile + '.err')).toBe(true)
    expect(fs.existsSync(pipePath)).toBe(true)

    await io.cleanup()

    // All files deleted
    expect(io.hasPipe).toBe(false)
    expect(fs.existsSync(pipePath)).toBe(false)
    const jsonlExists = await fsp.access(io.outputFile).then(() => true).catch(() => false)
    const errExists = await fsp.access(io.outputFile + '.err').then(() => true).catch(() => false)
    expect(jsonlExists).toBe(false)
    expect(errExists).toBe(false)
  })

  it('processName is "claude"', () => {
    const io = new LocalIO('test-name')
    expect(io.processName).toBe('claude')
  })

  it('outputFile path contains the tmpId', () => {
    const io = new LocalIO('my-unique-id')
    expect(io.outputFile).toContain('my-unique-id.jsonl')
  })

  it('createFiles(append=true) preserves existing file content', () => {
    // Simulate a previous turn's JSONL data
    const io = new LocalIO('test-append')
    const prevTurnData = '{"type":"system","session_id":"sess-1"}\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}\n'
    fs.writeFileSync(io.outputFile, prevTurnData)

    // Now "resume" — open in append mode
    const { pipeFd, outputFd, stderrFd } = io.createFiles(true)

    // Write new data through the fd (simulating CLI output)
    fs.writeSync(outputFd, '{"type":"system","session_id":"sess-1","subtype":"init"}\n')
    fs.closeSync(outputFd)
    fs.closeSync(stderrFd)
    fs.closeSync(pipeFd)

    // Verify: file has BOTH old and new data
    const content = fs.readFileSync(io.outputFile, 'utf-8')
    const lines = content.split('\n').filter(Boolean)
    expect(lines).toHaveLength(3) // 2 from prev turn + 1 from new
    expect(lines[0]).toContain('"type":"system"')
    expect(lines[1]).toContain('"type":"assistant"')
    expect(lines[2]).toContain('"subtype":"init"')
  })

  it('createFiles(append=false) truncates existing file content (default)', () => {
    // Simulate a previous turn's JSONL data
    const io = new LocalIO('test-truncate')
    const prevTurnData = '{"type":"system","session_id":"sess-1"}\n{"type":"assistant"}\n'
    fs.writeFileSync(io.outputFile, prevTurnData)

    // Open in default (truncate) mode
    const { pipeFd, outputFd, stderrFd } = io.createFiles()

    // Write new data
    fs.writeSync(outputFd, '{"type":"system","session_id":"sess-2"}\n')
    fs.closeSync(outputFd)
    fs.closeSync(stderrFd)
    fs.closeSync(pipeFd)

    // Verify: only new data (old data was truncated)
    const content = fs.readFileSync(io.outputFile, 'utf-8')
    const lines = content.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('sess-2')
  })

  it('fileSize returns current file size', () => {
    const io = new LocalIO('test-filesize')
    // Before file exists
    expect(io.fileSize).toBe(0)

    // Create file with some content
    fs.writeFileSync(io.outputFile, '{"line":1}\n{"line":2}\n')
    const expected = Buffer.byteLength('{"line":1}\n{"line":2}\n')
    expect(io.fileSize).toBe(expected)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Section 2: createSessionIO factory
// ═══════════════════════════════════════════════════════════════════

describe('createSessionIO', () => {
  it('returns LocalIO when no host or sshTarget', () => {
    const io = createSessionIO('factory-local')
    expect(io).toBeInstanceOf(LocalIO)
    expect(io.processName).toBe('claude')
  })

  it('returns RemoteIO when host and sshTarget are provided', () => {
    const io = createSessionIO('factory-remote', 'remote-dev', {
      hostname: 'remote.example.com',
      user: 'testuser',
    })
    expect(io).toBeInstanceOf(RemoteIO)
    expect(io.processName).toBe('ssh')
  })

  it('returns LocalIO when only host is provided (no sshTarget)', () => {
    // Edge case: host string without resolved SSH target → falls back to local
    const io = createSessionIO('factory-edge', 'some-host')
    expect(io).toBeInstanceOf(LocalIO)
    expect(io.processName).toBe('claude')
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Section 3: RemoteIO structural tests (no real SSH)
// ═══════════════════════════════════════════════════════════════════

describe('RemoteIO', () => {
  it('processName is "ssh"', () => {
    const io = new RemoteIO('test-remote', 'dev-host', {
      hostname: 'remote.example.com',
      user: 'testuser',
    })
    expect(io.processName).toBe('ssh')
  })

  it('hasPipe is false before setupRemote', () => {
    const io = new RemoteIO('test-remote-pipe', 'dev-host', {
      hostname: 'remote.example.com',
    })
    expect(io.hasPipe).toBe(false)
  })

  // setupRemote() now makes real SSH calls (deploy script, start, write message).
  // These can't run in unit tests — test the structural properties instead.
  // Integration/E2E tests with real SSH are done manually.

  it('setupRemote() throws when SSH is unavailable (expected in test env)', () => {
    const io = new RemoteIO('test-setup-fail', 'dev-host', {
      hostname: 'remote.example.com',
      user: 'admin',
    })

    // setupRemote() needs real SSH — should throw with a clear error
    expect(() => io.setupRemote(
      ['-p', '--output-format', 'stream-json'],
      '/home/admin/project',
      'hello remote',
    )).toThrow(/Failed to deploy remote script/)
  })

  it('reconnectTail() returns null when no remote output path', () => {
    const io = new RemoteIO('test-reconnect-no-path', 'dev-host', {
      hostname: 'remote.example.com',
    })
    // No setupRemote() called — remoteOutputPath is null
    expect(io.reconnectTail()).toBeNull()
  })

  it('checkRemoteAlive() returns no-pgid when no PGID path set', async () => {
    const io = new RemoteIO('test-alive-no-pgid', 'dev-host', {
      hostname: 'remote.example.com',
    })
    // No setupRemote() called — remotePgidPath is null
    const status = await io.checkRemoteAlive()
    expect(status).toBe('no-pgid')
  })

  it('tailSshPid is null before reconnect', () => {
    const io = new RemoteIO('test-tail-pid', 'dev-host', {
      hostname: 'remote.example.com',
    })
    expect(io.tailSshPid).toBeNull()
  })

  it('recoverPipe() sets remote paths optimistically', () => {
    const io = new RemoteIO('test-recover', 'dev-host', {
      hostname: 'remote.example.com',
    })

    expect(io.hasPipe).toBe(false)
    io.recoverPipe('recovered-session-id')
    expect(io.hasPipe).toBe(true)
  })

  it('deletePipe() flips hasPipe to false', () => {
    const io = new RemoteIO('test-delete', 'dev-host', {
      hostname: 'remote.example.com',
    })

    // Set up hasPipe
    io.recoverPipe('some-session')
    expect(io.hasPipe).toBe(true)

    io.deletePipe()
    expect(io.hasPipe).toBe(false)
  })

  it('write() returns false when hasPipe is false', () => {
    const io = new RemoteIO('test-write-nopipe', 'dev-host', {
      hostname: 'remote.example.com',
    })

    expect(io.hasPipe).toBe(false)
    expect(io.write('hello')).toBe(false)
  })

  it('renameForSession() renames local output file', () => {
    const io = new RemoteIO('test-rename-remote', 'dev-host', {
      hostname: 'remote.example.com',
    })

    // Create the local JSONL file
    fs.writeFileSync(io.outputFile, '')
    fs.writeFileSync(io.outputFile + '.err', '')

    const oldPath = io.outputFile
    io.renameForSession('renamed-session-id')

    const expectedPath = path.join(SESSION_STREAMS_DIR, 'renamed-session-id.jsonl')
    expect(io.outputFile).toBe(expectedPath)
    expect(fs.existsSync(expectedPath)).toBe(true)
    expect(fs.existsSync(oldPath)).toBe(false)
  })

  it('renameForSession() is idempotent', () => {
    const io = new RemoteIO('test-rename-idem', 'dev-host', {
      hostname: 'remote.example.com',
    })

    fs.writeFileSync(io.outputFile, '')

    io.renameForSession('session-abc')
    const afterFirst = io.outputFile

    io.renameForSession('session-abc')
    expect(io.outputFile).toBe(afterFirst)
  })

  it('tailOffset is 0 before startTail', () => {
    const io = new RemoteIO('test-tail-offset', 'dev-host', {
      hostname: 'remote.example.com',
    })
    expect(io.tailOffset).toBe(0)
  })

  it('startTail() tails the local output file', async () => {
    const io = new RemoteIO('test-tail-remote', 'dev-host', {
      hostname: 'remote.example.com',
    })

    // Create a local JSONL file with content
    const jsonLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'remote-123' })
    fs.writeFileSync(io.outputFile, jsonLine + '\n')

    const lines: string[] = []
    io.startTail((line) => lines.push(line))

    await new Promise((r) => setTimeout(r, 200))

    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('remote-123')

    io.stopTail()
  })

  it('host property is accessible', () => {
    const io = new RemoteIO('test-host-prop', 'my-host', {
      hostname: 'remote.example.com',
    })
    expect(io.host).toBe('my-host')
  })

  it('remoteImagesDir is undefined by default', () => {
    const io = new RemoteIO('test-images-dir', 'dev-host', {
      hostname: 'remote.example.com',
    })
    expect(io.remoteImagesDir).toBeUndefined()
  })

  it('remoteImagesDir can be set for cleanup', () => {
    const io = new RemoteIO('test-images-dir-set', 'dev-host', {
      hostname: 'remote.example.com',
    })
    io.remoteImagesDir = '/tmp/walnut-images/abc123'
    expect(io.remoteImagesDir).toBe('/tmp/walnut-images/abc123')
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Section 3b: REMOTE_PATH_SETUP & buildRemoteCommand
// ═══════════════════════════════════════════════════════════════════

describe('buildRemotePreamble', () => {
  it('includes base PATH without shell_setup', () => {
    const preamble = buildRemotePreamble()
    expect(preamble).toContain('$HOME/.local/bin')
    expect(preamble).toContain('$HOME/.npm-global/bin')
  })

  it('includes shell_setup when provided', () => {
    const preamble = buildRemotePreamble('source $HOME/.nvm/nvm.sh')
    expect(preamble).toContain('source $HOME/.nvm/nvm.sh')
    expect(preamble).toContain('|| true')
  })

  it('exits cleanly (code 0) even when shell_setup fails', () => {
    const { execFileSync } = require('node:child_process')
    const preamble = buildRemotePreamble('source /nonexistent/path/nvm.sh')
    const result = execFileSync('bash', ['-c', `${preamble} && echo "DOWNSTREAM_OK"`], {
      encoding: 'utf-8',
      timeout: 5000,
    })
    expect(result.trim()).toBe('DOWNSTREAM_OK')
  })
})

describe('wrapInLoginShell', () => {
  it('wraps command in $SHELL -lc', () => {
    const wrapped = wrapInLoginShell('echo hello')
    expect(wrapped).toContain('$SHELL -lc')
    expect(wrapped).toContain('echo hello')
  })

  it('injects shell_setup inside the login shell before the command', () => {
    const wrapped = wrapInLoginShell('echo hello', 'source $HOME/.nvm/nvm.sh')
    expect(wrapped).toContain('source $HOME/.nvm/nvm.sh')
    expect(wrapped).toContain('|| true')
    expect(wrapped).toContain('echo hello')
    // shell_setup should come BEFORE the main command
    const setupIdx = wrapped.indexOf('nvm.sh')
    const cmdIdx = wrapped.indexOf('echo hello')
    expect(setupIdx).toBeLessThan(cmdIdx)
  })

  it('works without shell_setup', () => {
    const wrapped = wrapInLoginShell('claude -p')
    expect(wrapped).toContain('$SHELL -lc')
    expect(wrapped).toContain('claude -p')
    expect(wrapped).not.toContain('|| true')
  })

  it('shell-quotes the inner command for safety', () => {
    const wrapped = wrapInLoginShell("echo 'hello world'")
    // The inner command should be quoted
    expect(wrapped).toMatch(/\$SHELL -lc '/)
  })
})

describe('buildRemoteCommand', () => {
  it('includes CLAUDE_CODE_DISABLE_BACKGROUND_TASKS and claude', () => {
    const cmd = buildRemoteCommand(['-p', '--output-format', 'stream-json'])
    expect(cmd).toContain('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1')
    expect(cmd).toContain('claude')
  })

  it('includes cd when cwd is provided', () => {
    const cmd = buildRemoteCommand(['-p'], '/home/user/project')
    expect(cmd).toContain("cd '/home/user/project'")
  })

  it('omits cd when no cwd', () => {
    const cmd = buildRemoteCommand(['-p'])
    expect(cmd).not.toMatch(/\bcd\b/)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Section 4: findLocalImagePaths
// ═══════════════════════════════════════════════════════════════════

describe('findLocalImagePaths', () => {
  it('detects image paths in <attached-images> blocks', () => {
    const imgPath = path.join(tmpBase, 'test-image.png')
    fs.writeFileSync(imgPath, 'fake-png-data')

    const text = `Here is context.\n<attached-images>\n${imgPath}\n</attached-images>\nPlease investigate.`
    const result = findLocalImagePaths(text)
    expect(result).toEqual([imgPath])
  })

  it('detects multiple image paths and deduplicates', () => {
    const img1 = path.join(tmpBase, 'shot1.png')
    const img2 = path.join(tmpBase, 'shot2.jpg')
    fs.writeFileSync(img1, 'data1')
    fs.writeFileSync(img2, 'data2')

    // img1 appears twice — should be deduplicated
    const text = `Look at ${img1} and ${img2} and also ${img1}`
    const result = findLocalImagePaths(text)
    expect(result).toHaveLength(2)
    expect(result).toContain(img1)
    expect(result).toContain(img2)
  })

  it('ignores non-image extensions', () => {
    const txtFile = path.join(tmpBase, 'notes.txt')
    fs.writeFileSync(txtFile, 'just text')

    const text = `Read ${txtFile}`
    const result = findLocalImagePaths(text)
    expect(result).toEqual([])
  })

  it('ignores paths that do not exist on disk', () => {
    const text = 'Check /nonexistent/path/screenshot.png'
    const result = findLocalImagePaths(text)
    expect(result).toEqual([])
  })

  it('returns empty array when no image paths in text', () => {
    const text = 'No images here, just text about debugging.'
    const result = findLocalImagePaths(text)
    expect(result).toEqual([])
  })

  it('handles various image extensions', () => {
    const extensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff']
    const created: string[] = []
    for (const ext of extensions) {
      const p = path.join(tmpBase, `test.${ext}`)
      fs.writeFileSync(p, 'data')
      created.push(p)
    }

    const text = created.join('\n')
    const result = findLocalImagePaths(text)
    expect(result).toHaveLength(extensions.length)
    for (const p of created) {
      expect(result).toContain(p)
    }
  })

  it('handles paths with hyphens and underscores', () => {
    const imgPath = path.join(tmpBase, 'my-screenshot_2024.png')
    fs.writeFileSync(imgPath, 'data')

    const text = `See ${imgPath}`
    const result = findLocalImagePaths(text)
    expect(result).toEqual([imgPath])
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Section 5: transferImagesForRemoteSession
//  Tests requiring mocked execFileSync are in session-io-transfer.test.ts
// ═══════════════════════════════════════════════════════════════════

describe('transferImagesForRemoteSession', () => {
  it('returns text unchanged when no image paths exist', async () => {
    const text = 'No images here, just text.'
    const result = await transferImagesForRemoteSession(
      text,
      { hostname: 'remote.example.com', user: 'admin' },
      '/tmp/walnut-images/abc123',
    )
    expect(result).toBe(text)
  })

  it('returns text unchanged when image paths do not exist on disk', async () => {
    const text = 'Check /nonexistent/path/screenshot.png'
    const result = await transferImagesForRemoteSession(
      text,
      { hostname: 'remote.example.com' },
      '/tmp/walnut-images/abc123',
    )
    expect(result).toBe(text)
  })
})
