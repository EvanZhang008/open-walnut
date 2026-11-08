/**
 * A resend of a line that already ran sends nothing (core/sessions/resend-already-ran.ts).
 *
 * 2026-11-10 acceptance: a send's acknowledgement was lost (the server took it and
 * the CLI answered), the user pressed Retry, the route enqueued it again under the
 * same line uuid, the session was dead, so a --resume spawn came up for a line the
 * daemon then did not write, and the session read "working" with no turn running.
 *
 * Guard: every route that reads a settled line's uuid (a resend of a message whose
 * row already left the queue) asks the daemon first. A new such route fails here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fate, conn } = vi.hoisted(() => ({
  fate: { value: null as unknown, throws: false, calls: [] as unknown[][] },
  conn: { value: { connected: true } as unknown },
}))
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  getConnectedDaemonConnection: vi.fn(() => conn.value),
  readDaemonLineFate: vi.fn(async (...args: unknown[]) => {
    fate.calls.push(args)
    if (fate.throws) throw new Error('link dropped')
    return fate.value
  }),
}))

import { resendAlreadyRan } from '../../../src/core/sessions/resend-already-ran.js'

const SID = 'aaaaaaaa-1111-4222-8333-444444444444'
const UUID = 'bbbbbbbb-1111-4222-8333-444444444444'

beforeEach(() => { fate.value = null; fate.throws = false; fate.calls = []; conn.value = { connected: true } })

describe('resendAlreadyRan', () => {
  it.each([
    ['finished', { fate: 'ran', state: 'completed' }],
    ['answered', { fate: 'ran', state: 'started', answer: 'yes' }],
    ['being answered by the process running now', { fate: 'ran', state: 'started', answer: 'pending' }],
  ])('a line that ran (%s) is not sent again', async (_name, value) => {
    fate.value = value
    expect(await resendAlreadyRan({ sessionId: SID, host: null, lineUuid: UUID })).toBe(true)
    expect(fate.calls[0]?.slice(1)).toEqual([SID, UUID, []])
  })

  it.each([
    ['taken by a gone process and never answered', { fate: 'unanswered', state: 'started' }],
    ['waiting in the live process', { fate: 'waiting' }],
    ['cancelled', { fate: 'cancelled', state: 'cancelled' }],
    ['dropped', { fate: 'dropped', state: 'discarded' }],
    ['unknown (older daemon, no link)', null],
  ])('any other answer sends it as before: %s', async (_name, value) => {
    fate.value = value
    expect(await resendAlreadyRan({ sessionId: SID, host: 'devbox', lineUuid: UUID, messageIds: ['qm-1'] })).toBe(false)
  })

  it('no line uuid asks nothing', async () => {
    expect(await resendAlreadyRan({ sessionId: SID, lineUuid: undefined })).toBe(false)
    expect(fate.calls).toHaveLength(0)
  })

  it('a failing read sends it as before', async () => {
    fate.throws = true
    expect(await resendAlreadyRan({ sessionId: SID, lineUuid: UUID })).toBe(false)
  })
})

const ROOT = path.resolve(import.meta.dirname, '../../..')
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

/** The queue's own modules: they keep the settled uuid, they do not resend. */
const QUEUE_ITSELF = new Set(['src/core/session-queue-lines.ts', 'src/core/session-message-queue.ts'])

describe('every resend of a settled line asks whether it already ran', () => {
  it('each file that reads settledLineUuid calls resendAlreadyRan', () => {
    const readers = sourceFiles(path.join(ROOT, 'src'))
      .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
      .filter((f) => !QUEUE_ITSELF.has(f))
      .filter((f) => /\bsettledLineUuid\s*\(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))
    expect(readers.length, 'the known resend routes are found').toBeGreaterThanOrEqual(2)
    const missing = readers.filter((f) => !/\bresendAlreadyRan\s*\(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))
    expect(missing, 'a resend of a line that ran must not enqueue it again (core/sessions/resend-already-ran.ts)').toEqual([])
  })
})
