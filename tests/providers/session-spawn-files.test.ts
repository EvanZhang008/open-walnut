/**
 * The files a session's CLI starts on (src/providers/session-spawn-files.ts), on a real temp dir
 * with the real fs and the real mkfifo: a fresh start makes the stream anew (a new inode), a
 * resume appends to it and touches it, the stream files are private whatever the umask, and a
 * step that fails gives back every descriptor the steps before it opened.
 */
import { execFile } from 'node:child_process'
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareSpawnFiles, STREAM_FILE_MODE, type SessionSpawnFiles, type SpawnFilesDeps, type SpawnFilesRequest } from '../../src/providers/session-spawn-files.js'

let dir: string
let prepared: SessionSpawnFiles[] = []

beforeEach(() => { dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'walnut-spawn-files-')) })
afterEach(() => {
  for (const p of prepared.splice(0)) p.closeAll()
  nodeFs.rmSync(dir, { recursive: true, force: true })
})

/** The real fs, with every descriptor that open() hands out recorded. */
function recordingFs() {
  const fds: number[] = []
  const fs = Object.create(nodeFs) as typeof nodeFs & { fdsOpened: number[] }
  fs.open = ((...args: unknown[]) => {
    const cb = args.pop() as (err: NodeJS.ErrnoException | null, fd?: number) => void
    ;(nodeFs.open as unknown as (...a: unknown[]) => void)(...args, (err: NodeJS.ErrnoException | null, fd?: number) => {
      if (!err && fd !== undefined) fds.push(fd)
      cb(err, fd)
    })
  }) as typeof nodeFs.open
  fs.fdsOpened = fds
  return fs
}

function makeDeps(overrides: Partial<SpawnFilesDeps> = {}) {
  const fs = recordingFs()
  const lockFifo = vi.fn((p: string) => { nodeFs.chmodSync(p, 0o200); return true })
  const discardCheckpoint = vi.fn()
  const warn = vi.fn()
  const deps: SpawnFilesDeps = { fs, execFile: execFile as unknown as SpawnFilesDeps['execFile'], lockFifo, discardCheckpoint, warn, ...overrides }
  return { deps, fs, lockFifo, discardCheckpoint, warn }
}

function request(overrides: Partial<SpawnFilesRequest> = {}): SpawnFilesRequest {
  return {
    sid: 'sid-1',
    pipePath: path.join(dir, 's.pipe'),
    jsonlPath: path.join(dir, 's.jsonl'),
    stderrPath: path.join(dir, 's.err'),
    resume: false,
    checkCurrent: () => {},
    ...overrides,
  }
}

async function prepare(deps: SpawnFilesDeps, req: SpawnFilesRequest) {
  const files = await prepareSpawnFiles(deps, req)
  prepared.push(files)
  return files
}

const isOpen = (fd: number) => { try { nodeFs.fstatSync(fd); return true } catch { return false } }
const modeOf = (p: string) => nodeFs.statSync(p).mode & 0o777

describe('prepareSpawnFiles', () => {
  it('a fresh start makes the stream anew (a new inode, never truncated in place) and starts the stderr log over', async () => {
    const { deps, lockFifo, discardCheckpoint } = makeDeps()
    const req = request()
    nodeFs.writeFileSync(req.jsonlPath, 'old line\n')
    nodeFs.writeFileSync(req.stderrPath, 'old stderr\n')
    // A second name keeps the old stream's inode alive, so a new one cannot reuse its number.
    const keep = path.join(dir, 'old.jsonl')
    nodeFs.linkSync(req.jsonlPath, keep)
    const oldIno = nodeFs.statSync(req.jsonlPath).ino

    const files = await prepare(deps, req)

    expect(nodeFs.statSync(req.jsonlPath).ino).not.toBe(oldIno)
    expect(nodeFs.readFileSync(keep, 'utf8')).toBe('old line\n') // the old epoch untouched
    expect(files.cronStartOffset).toBe(0)
    expect(files.stderrStartOffset).toBe(0)
    expect(nodeFs.readFileSync(req.stderrPath, 'utf8')).toBe('')
    expect(discardCheckpoint).toHaveBeenCalledWith(req.jsonlPath)

    // The stream is opened O_APPEND, the FIFO O_RDWR and made write-only by lockFifo.
    nodeFs.writeSync(files.outputFd, 'first\n')
    expect(nodeFs.readFileSync(req.jsonlPath, 'utf8')).toBe('first\n')
    expect(nodeFs.fstatSync(files.pipeFd).isFIFO()).toBe(true)
    expect(lockFifo).toHaveBeenCalledWith(req.pipePath)
    expect(modeOf(req.pipePath)).toBe(0o200)
    nodeFs.writeSync(files.pipeFd, 'x')
  })

  it('a resume appends to the stream and its stderr log, and touches the stream', async () => {
    const { deps, discardCheckpoint } = makeDeps()
    const req = request({ resume: true })
    nodeFs.writeFileSync(req.jsonlPath, 'abc\n')
    nodeFs.writeFileSync(req.stderrPath, 'err\n')
    const past = new Date('2000-01-01T00:00:00Z')
    nodeFs.utimesSync(req.jsonlPath, past, past)
    const ino = nodeFs.statSync(req.jsonlPath).ino

    const files = await prepare(deps, req)

    expect(nodeFs.statSync(req.jsonlPath).ino).toBe(ino)
    expect(files.cronStartOffset).toBe(4)
    expect(files.stderrStartOffset).toBe(4)
    expect(nodeFs.statSync(req.jsonlPath).mtimeMs).toBeGreaterThan(Date.now() - 60_000)
    expect(discardCheckpoint).not.toHaveBeenCalled()
    nodeFs.writeSync(files.outputFd, 'def\n')
    nodeFs.writeSync(files.stderrFd, 'more\n')
    expect(nodeFs.readFileSync(req.jsonlPath, 'utf8')).toBe('abc\ndef\n')
    expect(nodeFs.readFileSync(req.stderrPath, 'utf8')).toBe('err\nmore\n')
  })

  it('makes the stream and the stderr log private whatever the umask', async () => {
    // A control file shows this process's umask lets group and others read what it creates.
    const control = path.join(dir, 'control')
    nodeFs.writeFileSync(control, '')
    const umaskWide = (modeOf(control) & 0o077) !== 0

    const { deps } = makeDeps()
    const req = request()
    // A stderr log an older run left wide open is made private by a fresh start too.
    nodeFs.writeFileSync(req.stderrPath, 'old\n', { mode: 0o644 })
    nodeFs.chmodSync(req.stderrPath, 0o644)
    await prepare(deps, req)
    expect(modeOf(req.jsonlPath)).toBe(STREAM_FILE_MODE)
    expect(modeOf(req.stderrPath)).toBe(STREAM_FILE_MODE)

    // A resume that has to create its files creates them private as well.
    const resumed = request({ resume: true, pipePath: path.join(dir, 'r.pipe'), jsonlPath: path.join(dir, 'r.jsonl'), stderrPath: path.join(dir, 'r.err') })
    await prepare(makeDeps().deps, resumed)
    expect(modeOf(resumed.jsonlPath)).toBe(STREAM_FILE_MODE)
    expect(modeOf(resumed.stderrPath)).toBe(STREAM_FILE_MODE)
    expect(umaskWide).toBe(true) // else this test proves nothing on this machine
  })

  it('closes what it opened when a later step fails', async () => {
    const { deps, fs } = makeDeps()
    // The stderr log's folder is missing: its open fails after the FIFO and the stream opened.
    const req = request({ stderrPath: path.join(dir, 'missing', 's.err') })
    await expect(prepareSpawnFiles(deps, req)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fs.fdsOpened).toHaveLength(2)
    for (const fd of fs.fdsOpened) expect(isOpen(fd)).toBe(false)
  })

  it('a start overtaken after mkfifo opens nothing', async () => {
    const { deps, fs, lockFifo } = makeDeps()
    const overtaken = new Error('superseded')
    const req = request({ checkCurrent: () => { throw overtaken } })
    await expect(prepareSpawnFiles(deps, req)).rejects.toBe(overtaken)
    expect(nodeFs.statSync(req.pipePath).isFIFO()).toBe(true) // mkfifo ran
    expect(fs.fdsOpened).toEqual([])
    expect(lockFifo).not.toHaveBeenCalled()
    expect(nodeFs.existsSync(req.jsonlPath)).toBe(false)
  })

  it('a failed mkfifo says so and opens nothing', async () => {
    const { deps, fs } = makeDeps()
    const req = request({ pipePath: path.join(dir, 'missing', 's.pipe') })
    await expect(prepareSpawnFiles(deps, req)).rejects.toThrow(/^mkfifo failed: /)
    expect(fs.fdsOpened).toEqual([])
  })

  it('makes the FIFO anew over a stale one, and warns when it cannot lock it', async () => {
    const { deps, warn } = makeDeps({ lockFifo: () => false })
    const req = request()
    nodeFs.writeFileSync(req.pipePath, 'a stale regular file')
    await prepare(deps, req)
    expect(nodeFs.statSync(req.pipePath).isFIFO()).toBe(true)
    expect(warn).toHaveBeenCalledWith('spawn: could not make the stdin FIFO write-only', { sid: 'sid-1' })
  })

  it('closeAll closes the three descriptors once, and again is harmless', async () => {
    const { deps } = makeDeps()
    const files = await prepareSpawnFiles(deps, request())
    const fds = [files.pipeFd, files.outputFd, files.stderrFd]
    for (const fd of fds) expect(isOpen(fd)).toBe(true)
    files.closeAll()
    for (const fd of fds) expect(isOpen(fd)).toBe(false)
    files.closeAll()
  })
})
