/**
 * A message parked because its session's folder was gone goes out by itself once that folder is
 * back, whichever way it came back (src/core/sessions/folder-wait.ts). 2026-11-24: rows a host
 * parked while a released workspace was gone stayed parked for hours after the workspace was made
 * again; a remake later sent a five-hour-old one a person had already sent again by hand.
 *
 * Pinned here:
 *  - a park on a gone folder marks its row; any other park, and leaving the park, drop the mark;
 *  - a row going out takes the marked rows with it, ahead of it, in their order; never an unmarked
 *    one (parked by an older Walnut), one queued over a day ago, or one a Stop came after;
 *  - with nothing going out, the delivery clock sends a marked row once the session's folder is
 *    there (on its growing wait), and leaves it while the folder is still gone; past its day it drops
 *    the mark;
 *  - Walnut's own release of the folder (the host's sendFolderWaiting) sends only marked rows; a
 *    person's press ('all') sends every row parked on the folder.
 *
 * Real: the queue file and its park, the session store, the bus, the folder check (local dirs).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>()
  return { ...actual, ...createMockConstants('walnut-folder-wait') }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { sessionRunner } from '../../../src/providers/claude-code-session.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { enqueueMessage, getQueue, resetCache, unparkMessage, unparkRowsAhead } from '../../../src/core/session-message-queue.js'
import { parkMessages } from '../../../src/core/session-queue-park.js'
import { mutateStore } from '../../../src/core/session-queue-store.js'
import { createSessionRecord, updateSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js'
import { RETRY_BACKOFF_MS, stopDeliveryRetry, sweepDeliveryRetries } from '../../../src/core/sessions/delivery-retry.js'
import { FOLDER_WAIT_MAX_AGE_MS } from '../../../src/core/sessions/folder-wait.js'
import { sendFolderWaiting } from '../../../src/core/sessions/folder-gone.js'
import { classifyDeliveryFailure } from '../../../src/providers/delivery-failure.js'
import { CwdMissingError } from '../../../src/providers/cwd-check.js'

const SID = 'f01de000-1111-4222-8333-555555555555'
let folder: string
let sends: string[] = []

const gone = () => classifyDeliveryFailure(new CwdMissingError(`Working directory no longer exists: ${folder}`))
const rowsOf = async () => (await getQueue(SID)).map((m) => `${m.message}:${m.status}`)

async function parkedOnFolder(text: string) {
  const row = await enqueueMessage(SID, text)
  await parkMessages([row], gone())
  return (await getQueue(SID)).find((m) => m.id === row.id)!
}

/** As an older Walnut parked it: the same words and code, no mark. */
async function parkedByOlderWalnut(text: string) {
  const row = await parkedOnFolder(text)
  await mutateStore((s) => { delete s.queues[SID]!.find((m) => m.id === row.id)!.folderWait })
  return row
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  _resetSessionTrackerForTesting()
  stopDeliveryRetry()
  sends = []
  folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-folder-wait-')))
  vi.spyOn(sessionRunner, 'isTurnRunning').mockReturnValue(false)
  await createSessionRecord(SID, 't-folder-wait', 'Acme', folder, { initialProcessStatus: 'stopped' })
  bus.subscribe('folder-wait-test', (e) => {
    if (e.name === EventNames.SESSION_SEND) sends.push(`${(e.data as { sessionId: string }).sessionId}:${e.source}`)
  }, { global: true, interest: [EventNames.SESSION_SEND] })
})

afterEach(async () => {
  stopDeliveryRetry()
  bus.unsubscribe('folder-wait-test')
  vi.restoreAllMocks()
  resetCache()
  fs.rmSync(folder, { recursive: true, force: true })
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a park on a gone folder marks its row', () => {
  it('marked on the folder, not on any other park, and the mark leaves with the park', async () => {
    const row = await parkedOnFolder('on the folder')
    expect(row).toMatchObject({ status: 'parked', parkedCode: 'cwd_missing', folderWait: true })
    const other = await enqueueMessage(SID, 'other')
    await parkMessages([other], 'Not delivered: Claude Code exited before it read this message. Retry it.')
    expect((await getQueue(SID)).find((m) => m.id === other.id)?.folderWait).toBeUndefined()
    expect(await unparkMessage(SID, row.id)).toBe(true)
    expect((await getQueue(SID)).find((m) => m.id === row.id)?.folderWait).toBeUndefined()
  })
})

describe('a row going out takes the rows that waited on the folder with it', () => {
  it('ahead of it, in their own order; nothing when no row goes out', async () => {
    const a = await parkedOnFolder('first')
    const b = await parkedOnFolder('second')
    expect(await unparkRowsAhead(SID, null)).toEqual([])
    expect(await rowsOf()).toEqual(['first:parked', 'second:parked'])
    await enqueueMessage(SID, 'new one')
    expect(await unparkRowsAhead(SID, null)).toEqual([a.id, b.id])
    expect(await rowsOf()).toEqual(['first:pending', 'second:pending', 'new one:pending'])
  })

  it('never a row an older Walnut parked, one queued over a day ago, or one a Stop came after', async () => {
    await parkedByOlderWalnut('older walnut')
    const old = await parkedOnFolder('a day old')
    await mutateStore((s) => { s.queues[SID]!.find((m) => m.id === old.id)!.enqueuedAt = new Date(Date.now() - FOLDER_WAIT_MAX_AGE_MS - 1000).toISOString() })
    const fenced = await parkedOnFolder('before a stop')
    await mutateStore((s) => { s.queues[SID]!.find((m) => m.id === fenced.id)!.stopFence = 'an-older-stop' })
    await enqueueMessage(SID, 'new one')
    expect(await unparkRowsAhead(SID, null)).toEqual([])
    expect((await getQueue(SID)).filter((m) => m.status === 'parked').map((m) => m.message).sort()).toEqual(['a day old', 'before a stop', 'older walnut'])
  })
})

describe('with nothing going out, the clock sends them once the folder is there', () => {
  it('sent when the folder is back, kept while it is gone, on the clock\'s growing wait', async () => {
    const row = await parkedOnFolder('waits on the folder')
    await updateSessionRecord(SID, { cwd: path.join(folder, 'gone') } as never)
    expect(await sweepDeliveryRetries(Date.now() + RETRY_BACKOFF_MS[0])).toEqual([])
    expect(await rowsOf()).toEqual(['waits on the folder:parked'])
    // The folder came back (made again by hand, a remount, a remake: the clock does not ask how).
    await updateSessionRecord(SID, { cwd: folder } as never)
    expect(await sweepDeliveryRetries(Date.now())).toEqual([])
    expect(await sweepDeliveryRetries(Date.now() + RETRY_BACKOFF_MS[0])).toEqual([row.id])
    expect(await rowsOf()).toEqual(['waits on the folder:pending'])
    expect(sends).toEqual([`${SID}:delivery-retry`])
    // Refused again (a folder check the spawn disagrees with): its next try waits longer.
    await parkMessages(await getQueue(SID), gone())
    expect(await sweepDeliveryRetries(Date.now() + RETRY_BACKOFF_MS[0])).toEqual([])
    expect(await sweepDeliveryRetries(Date.now() + RETRY_BACKOFF_MS[1])).toEqual([row.id])
  })

  it('never a row an older Walnut parked on the folder', async () => {
    await parkedByOlderWalnut('older walnut')
    expect(await sweepDeliveryRetries(Date.now() + 10 * 60 * 60_000)).toEqual([])
    expect(sends).toEqual([])
  })

  it('a row past the day it may wait goes by itself no more: the clock drops its mark (its asker is told, session-request-notify.test.ts)', async () => {
    const row = await parkedOnFolder('waited too long')
    const later = Date.parse(row.enqueuedAt) + FOLDER_WAIT_MAX_AGE_MS + 1000
    expect(await sweepDeliveryRetries(later)).toEqual([])
    resetCache()
    expect((await getQueue(SID)).map((m) => [m.status, m.folderWait])).toEqual([['parked', undefined]])
    expect(sends).toEqual([])
  })
})

describe('the release of a folder that is back', () => {
  it("Walnut's own sends only the rows that waited by the rule; a person's press sends every one", async () => {
    await parkedByOlderWalnut('older walnut')
    await parkedOnFolder('marked')
    expect(await sendFolderWaiting(SID)).toBe(1)
    expect(await rowsOf()).toEqual(['older walnut:parked', 'marked:pending'])
    expect(await sendFolderWaiting(SID, null, null, 'all')).toBe(2)
    expect(await rowsOf()).toEqual(['older walnut:pending', 'marked:pending'])
  })
})
