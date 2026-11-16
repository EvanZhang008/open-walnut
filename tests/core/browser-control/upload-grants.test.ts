/**
 * The person's yes for a trusted upload (src/core/browser-control/upload-grants.ts), on the real
 * approvals store: an ask names the task, the files and the site, sits outside the Approvals switch
 * and needs the person's proof (guard person); one ask per task, site and set of files; only the task
 * that asked, into that site, and only for the files it named, gets the yes, for a day; a no holds
 * for an hour.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-upload-grants'))

import { answerApproval, getApproval } from '../../../src/core/approvals/store.js'
import { DENIED_MS, GRANT_MS, _resetUploadGrantsForTesting, answerUpload, askUpload, askWords, deniedOf, grantedOf, isFilePath, settledAsk } from '../../../src/core/browser-control/upload-grants.js'

const requester = { host: 'clouddev', taskId: 't1', taskTitle: 'Upload the demo', sessionId: 's1' }
const REC = '/Users/evan/Desktop/demo.mov'
const noKey = async () => undefined

afterEach(() => _resetUploadGrantsForTesting())

describe('upload grants', () => {
  it('a path is one absolute file: never a folder, a relative path or ..', () => {
    for (const p of ['/Users/evan/a.mov', 'C:\\Users\\evan\\a.mp4', '/Users/evan/Screen Recording 12.32.01\u202fPM.mov']) expect(isFilePath(p), p).toBe(true)
    for (const p of ['/Users/evan/', 'a.mov', '~/a.mov', '/Users/evan/../x', 'C:\\Users\\', '/Users/evan/a.mov ', ' /Users/evan/a.mov',
      '/Users/evan/\u202evom.exe', '/Users/evan/a\u200b.mov', '/Users/evan/a\n.mov']) expect(isFilePath(p), JSON.stringify(p)).toBe(false)
  })

  it('the ask says which task, which files and which site, and the switch never answers it', async () => {
    expect(askWords([REC], 'example.test', 'Upload the demo')).toEqual({
      what: 'Upload ~/Desktop/demo.mov from this computer into example.test',
      detail: `Task "Upload the demo" asks to put this file into a file field on example.test. Allow lets that task send it into example.test for a day.\n${REC}`,
    })
    expect(askWords(['/a/x.pdf', '/b/y.pdf'], '', undefined).what).toBe('Upload x.pdf, y.pdf from this computer into a web page')
    expect(askWords(['/1', '/2', '/3', '/4'], 's.test', undefined).what).toBe('Upload 4 files from this computer into s.test')
    const { id } = await askUpload({ taskId: 't1', paths: [REC], site: 'example.test', requester })
    const rec = await getApproval(id)
    expect(rec).toMatchObject({ status: 'pending', mode: 'tap', guard: 'person', outsideSwitch: true, detailRole: 'summary' })
    expect(rec?.unasked).toBeUndefined()
    // The same task and files again: the same ask.
    expect(await askUpload({ taskId: 't1', paths: [REC], site: 'example.test', requester })).toEqual({ id, reused: true })
    // Another site is another ask.
    expect((await askUpload({ taskId: 't1', paths: [REC], site: 'other.test', requester })).id).not.toBe(id)
  })

  it('a yes grants only the asking task, only its files, for a day', async () => {
    const { id } = await askUpload({ taskId: 't1', paths: [REC], site: 'example.test', requester })
    expect(await answerUpload({ id, taskId: 't1', site: 'example.test', paths: [REC], holdMs: 0 })).toBe('pending')
    await answerApproval(id, { decision: 'approve', device: { name: 'Test phone', kind: 'iphone' } } as never, noKey)
    // Another task naming the ask, or a file it did not name, gets nothing.
    expect(await answerUpload({ id, taskId: 't2', site: 'example.test', paths: [REC], holdMs: 0 })).toBe('unknown')
    expect(await answerUpload({ id, taskId: 't1', site: 'example.test', paths: ['/Users/evan/.ssh/id_ed25519'], holdMs: 0 })).toBe('unknown')
    expect(await answerUpload({ id, taskId: 't1', site: 'other.test', paths: [REC], holdMs: 0 })).toBe('unknown')
    expect(await answerUpload({ id, taskId: 't1', site: 'example.test', paths: [REC], holdMs: 0 })).toBe('approved')
    expect(grantedOf('t1', 'example.test', [REC, '/Users/evan/other.mov'])).toEqual([REC])
    expect(grantedOf('t1', 'other.test', [REC])).toEqual([])
    expect(grantedOf('t2', 'example.test', [REC])).toEqual([])
    expect(grantedOf('t1', 'example.test', [REC], Date.now() + GRANT_MS + 1)).toEqual([])
  })

  it('a no is a no, and grants nothing', async () => {
    const { id } = await askUpload({ taskId: 't1', paths: [REC], site: 'example.test', requester })
    await answerApproval(id, { decision: 'deny', device: { name: 'Test phone', kind: 'iphone' } } as never, noKey)
    expect(await answerUpload({ id, taskId: 't1', site: 'example.test', paths: [REC], holdMs: 0 })).toBe('denied')
    expect(grantedOf('t1', 'example.test', [REC])).toEqual([])
    expect(deniedOf('t1', 'example.test', [REC])).toEqual([REC])
    expect(deniedOf('t1', 'example.test', [REC], Date.now() + DENIED_MS + 1)).toEqual([])
  })

  it('holding for the answer sees a yes given meanwhile', async () => {
    const { id } = await askUpload({ taskId: 't1', paths: [REC], site: 'example.test', requester })
    setTimeout(() => { void answerApproval(id, { decision: 'approve', device: { name: 'Test phone', kind: 'iphone' } } as never, noKey) }, 100)
    expect(await answerUpload({ id, taskId: 't1', site: 'example.test', paths: [REC], holdMs: 3000 })).toBe('approved')
  })

  it('a yes the agent never came back for (its call cut off) is claimed by the next call, never asked again', async () => {
    const { id } = await askUpload({ taskId: 't1', paths: [REC], site: 'example.test', requester })
    expect(await settledAsk('t1', 'example.test', [REC])).toBe('unknown')
    await answerApproval(id, { decision: 'approve', device: { name: 'Test phone', kind: 'iphone' } } as never, noKey)
    expect(await settledAsk('t2', 'example.test', [REC])).toBe('unknown')
    expect(await settledAsk('t1', 'other.test', [REC])).toBe('unknown')
    expect(await settledAsk('t1', 'example.test', [REC])).toBe('approved')
    expect(grantedOf('t1', 'example.test', [REC])).toEqual([REC])
  })
})
