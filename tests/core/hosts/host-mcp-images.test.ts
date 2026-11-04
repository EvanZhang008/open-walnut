/**
 * saveCallImages (src/core/hosts/host-mcp-images.ts): images an MCP tool on another
 * host returned become files in the CALLING task's directory on the caller's host.
 * On this Mac the server writes them; on another host its daemon does (fs.writePart).
 * A relayed caller's answer leaves within its budget, naming a write still going as
 * pending; an image that cannot be written keeps only its size.
 *
 * MACHINE SAFETY: WALNUT_TASK_DIR_ROOT points into a temp dir; the remote daemon is a
 * fake transfer connection that writes into the same temp dir.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as daemonConnections from '../../../src/providers/daemon-connection.js'
import { __setTransferConnectionResolverForTesting } from '../../../src/core/transfer/daemon-transfer-client.js'
import { RELAYED_HOLD_MS, type Caller } from '../../../src/core/hosts/host-exec.js'
import { saveCallImages } from '../../../src/core/hosts/host-mcp-images.js'
import { withAnswerBy } from '../../../src/lib/answer-by.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-mcp-images-')))
const localRoot = path.join(root, 'local-tasks')
const remoteRoot = path.join(root, 'devbox-tasks')
const savedEnv = process.env.WALNUT_TASK_DIR_ROOT
const png = (fill: number, n = 300) => Buffer.alloc(n, fill).toString('base64')
const local: Caller = { sid: 's1', taskId: 'task-local', taskTitle: 'x', host: '__local__' }
const remote: Caller = { sid: 's2', taskId: 'task-remote', taskTitle: 'x', host: 'devbox' }
let writeDelayMs = 0
let refuse = false
const parts: Array<Record<string, unknown>> = []

beforeAll(() => {
  process.env.WALNUT_TASK_DIR_ROOT = localRoot
  vi.spyOn(daemonConnections, 'getConnectedDaemonConnection').mockImplementation((key: string) =>
    (key === 'devbox' ? { taskDirRoot: remoteRoot } : null) as unknown as daemonConnections.DaemonConnection)
  __setTransferConnectionResolverForTesting(async (host) => host !== 'devbox' ? [] : [{
    hasCapability: (c: string) => c === 'fs-write-part-v1',
    send: async (cmd: string, p: Record<string, unknown>) => {
      parts.push({ cmd, path: p.path, offset: p.offset, final: p.final, size: p.size })
      await new Promise((r) => setTimeout(r, writeDelayMs))
      if (refuse) return { ok: false, error: 'fs.writePart failed: disk full', code: 'failed' }
      fs.mkdirSync(path.dirname(String(p.path)), { recursive: true })
      fs.writeFileSync(String(p.path), Buffer.from(String(p.data), 'base64'))
      return { ok: true, staged: p.size, done: true }
    },
  }])
})
afterEach(() => { writeDelayMs = 0; refuse = false; parts.length = 0 })
afterAll(() => {
  __setTransferConnectionResolverForTesting(null)
  vi.restoreAllMocks()
  if (savedEnv === undefined) delete process.env.WALNUT_TASK_DIR_ROOT
  else process.env.WALNUT_TASK_DIR_ROOT = savedEnv
  if (root.includes('walnut-mcp-images-')) fs.rmSync(root, { recursive: true, force: true })
})

describe('images from another host\'s MCP tool', () => {
  it('a Mac session: written into its task directory by the server, data replaced by the path', async () => {
    const out = await saveCallImages(local, 'mc-local-1', [
      { mimeType: 'image/png', bytes: 300, data: png(1) },
      { mimeType: 'image/jpeg', bytes: 300, data: png(2) },
      { mimeType: 'image/png', bytes: 5_000_000 }, // past the host's cap: size only
    ], Date.now())
    const dir = path.join(localRoot, 'task-local', 'host-mcp')
    expect(out).toEqual([
      { mimeType: 'image/png', bytes: 300, path: path.join(dir, 'mc-local-1-1.png') },
      { mimeType: 'image/jpeg', bytes: 300, path: path.join(dir, 'mc-local-1-2.jpg') },
      { mimeType: 'image/png', bytes: 5_000_000 },
    ])
    expect(fs.readFileSync(out[1].path!)).toEqual(Buffer.alloc(300, 2))
    expect(fs.readdirSync(dir).sort()).toEqual(['mc-local-1-1.png', 'mc-local-1-2.jpg']) // no staging file left
    expect(parts).toEqual([])
    // The task directory is made the way a session start makes it (owner only).
    expect(fs.statSync(path.join(localRoot, 'task-local')).mode & 0o777).toBe(0o700)
    // Read again, twice at once: the same files, no staging file left, no lost path.
    const twice = await Promise.all([1, 2].map(() => saveCallImages(local, 'mc-local-1', [{ mimeType: 'image/png', bytes: 300, data: png(1) }], Date.now())))
    expect(twice.map((o) => o[0].path)).toEqual([out[0].path, out[0].path])
    expect(fs.readdirSync(dir).sort()).toEqual(['mc-local-1-1.png', 'mc-local-1-2.jpg'])
  })

  it('a session on another host: written there through its daemon, one whole part each', async () => {
    const out = await saveCallImages(remote, 'mc-remote-1', [{ mimeType: 'image/webp', bytes: 300, data: png(3) }], Date.now())
    const file = path.join(remoteRoot, 'task-remote', 'host-mcp', 'mc-remote-1-1.webp')
    expect(out).toEqual([{ mimeType: 'image/webp', bytes: 300, path: file }])
    expect(parts).toEqual([{ cmd: 'fs.writePart', path: file, offset: 0, final: true, size: 300 }])
    expect(fs.readFileSync(file)).toEqual(Buffer.alloc(300, 3))
  })

  it('a write still going when the relayed budget runs out is named pending, and lands after', async () => {
    writeDelayMs = 1_500
    const t0 = Date.now() - RELAYED_HOLD_MS + 1_300 // about 300 ms left after the answer's margin
    const started = Date.now()
    // A call its host's gateway relayed: it carries the gateway's deadline.
    const out = await withAnswerBy(t0 + 20_000, () => saveCallImages(remote, 'mc-slow-1', [{ mimeType: 'image/png', bytes: 300, data: png(4) }], t0))
    expect(Date.now() - started).toBeLessThan(1_200)
    const file = path.join(remoteRoot, 'task-remote', 'host-mcp', 'mc-slow-1-1.png')
    expect(out).toEqual([{ mimeType: 'image/png', bytes: 300, path: file, pending: true }])
    await vi.waitFor(() => expect(fs.existsSync(file)).toBe(true), { timeout: 5_000 })
  })

  it('a refused write, a host whose task directory is unknown, a bad call id: size only, never data', async () => {
    refuse = true
    expect(await saveCallImages(remote, 'mc-refused-1', [{ mimeType: 'image/png', bytes: 300, data: png(5) }], Date.now()))
      .toEqual([{ mimeType: 'image/png', bytes: 300 }])
    refuse = false
    const elsewhere: Caller = { ...remote, host: 'nobox' }
    expect(await saveCallImages(elsewhere, 'mc-x-1', [{ mimeType: 'image/png', bytes: 300, data: png(6) }], Date.now()))
      .toEqual([{ mimeType: 'image/png', bytes: 300 }])
    // The call id names the file; one made of path characters only names none.
    expect(await saveCallImages(local, '../..', [{ mimeType: 'image/png', bytes: 300, data: png(7) }], Date.now()))
      .toEqual([{ mimeType: 'image/png', bytes: 300 }])
    expect(await saveCallImages(local, 'mc-none', undefined, Date.now())).toEqual([])
  })
})
