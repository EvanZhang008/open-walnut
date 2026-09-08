/**
 * The write guard on the REMOTE-HOST branch — the path the incident actually took.
 *
 * The file that was clobbered five times lives on an exec host, not on this Mac, so
 * the write went through `writeFileContentPayload`'s remote branch: read the current
 * bytes over the daemon, compare, then write them back over the daemon. The two
 * branches carry the SAME three refusals in two separate places, which is exactly
 * the shape where one gets updated and the other quietly does not, so both need
 * their own test.
 *
 * It also settles a question raised while diagnosing the recurrence: the exec-host
 * daemon's `fs.write` is a bare `writeFile` with no staleness check of any kind, and
 * that is correct. The daemon is a filesystem primitive; it has no editor, no lock
 * and no notion of a base. The compare-and-refuse belongs in the ONE process that
 * knows what the editor was looking at, and it happens BEFORE the daemon is asked
 * to write, so a refused write never reaches the host at all. Nothing has to be
 * deployed to a host for the guard to protect its files.
 *
 * The honest limit, pinned by the last test: this is read-compare-write with no
 * remote file lock, so the window is one round trip. It is a guard against a stale
 * EDITOR, not a distributed mutex.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

/** One in-memory file, standing in for the exec host's disk. */
const host = { path: '/home/dev/project/design.md', content: '' }
const calls: Array<{ op: 'read' | 'write' | 'stat'; content?: string }> = []

vi.mock('../../src/core/session-file-reader.js', () => ({
  createFileReader: async () => ({
    stat: async () => {
      calls.push({ op: 'stat' })
      return { size: Buffer.byteLength(host.content, 'utf-8'), isFile: true }
    },
    readFile: async () => {
      calls.push({ op: 'read' })
      return host.content
    },
    writeFile: async (_p: string, content: string) => {
      calls.push({ op: 'write', content })
      host.content = content
    },
  }),
}))

const { fileContentRouter } = await import('../../src/web/routes/file-content.js')
const { errorHandler } = await import('../../src/web/middleware/error-handler.js')
const { computeContentHash } = await import('../../src/utils/file-ops.js')

const FRESH = `# Design v2\n\n${'the restructured section\n'.repeat(400)}`
const STALE = `# Design\n\n${'the older section\n'.repeat(300)}`

let app: express.Express

const put = (body: Record<string, unknown>) =>
  request(app).put('/api/file-content').send({ path: host.path, host: 'marina', ...body })

beforeEach(() => {
  host.content = FRESH
  calls.length = 0
  app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use('/api/file-content', fileContentRouter)
  app.use(errorHandler)
})

describe('remote host: an automatic write must prove its base', () => {
  it('refuses a machine write with no base claim, and the daemon is never asked to write', async () => {
    const res = await put({ content: STALE, writer: 'live', expectedHash: computeContentHash(FRESH) })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'conflict', reason: 'unverified-base' })
    expect(host.content).toBe(FRESH)
    // The point about where the guard belongs: no write RPC was issued at all, so
    // the host's own daemon never had a chance to be the last line of defence.
    expect(calls.some((c) => c.op === 'write')).toBe(false)
  })

  it('refuses a machine write with no lock at all', async () => {
    const res = await put({ content: STALE, writer: 'live', baseFrom: 'content' })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'conflict', reason: 'unlocked-machine-write' })
    expect(host.content).toBe(FRESH)
  })

  it('refuses a claimed write whose base is the stale copy (the incident)', async () => {
    const res = await put({
      content: STALE, writer: 'live', expectedHash: computeContentHash(STALE), baseFrom: 'content',
    })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'conflict', reason: 'stale-lock' })
    expect(host.content).toBe(FRESH)
  })

  it('accepts a claimed write based on what is actually on the host', async () => {
    const typed = `${FRESH}one more line\n`
    const res = await put({
      content: typed, writer: 'live', expectedHash: computeContentHash(FRESH), baseFrom: 'content',
    })
    expect(res.status).toBe(200)
    expect(host.content).toBe(typed)
  })

  it('still lets a human Save replace the file (the 409 dialog is their answer)', async () => {
    const res = await put({ content: STALE, writer: 'user', expectedHash: computeContentHash(FRESH) })
    expect(res.status).toBe(200)
    expect(host.content).toBe(STALE)
  })

  it('reads the host before it writes, in that order (the guard is compare-then-write)', async () => {
    await put({ content: `${FRESH}x`, writer: 'live', expectedHash: computeContentHash(FRESH), baseFrom: 'content' })
    const ops = calls.filter((c) => c.op !== 'stat').map((c) => c.op)
    expect(ops).toEqual(['read', 'write'])
    // ⚠️ And therefore: no remote file lock. Another writer landing between those
    // two operations is not caught by anything here. Documented, not fixed — the
    // window is one round trip, and closing it needs a lock the daemon does not have.
  })
})
