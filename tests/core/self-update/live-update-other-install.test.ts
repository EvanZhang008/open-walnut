/**
 * The live update next to someone else's install (live-update.ts): the
 * supervisor's startup download that outlived its budget, install.sh, an earlier
 * start's npm. The server waits for it and picks its result up, and never clears
 * a first-start record it did not write (2026-11-03 review: the child's own
 * install lost the lock, cleared the supervisor's record, and the new version's
 * first start went unwatched). Also: updates.auto turned on in Settings acts now.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-live-update-other'))

import { setRestartHandler } from '../../../src/core/self-update/live-update.js'
import { resetUserActivityForTest } from '../../../src/core/self-update/idle-gate.js'
import { flush, harness, state, STATUS } from './live-update-harness.js'

beforeEach(() => { resetUserActivityForTest(); setRestartHandler(null) })
afterEach(() => { setRestartHandler(null) })

const SUPERVISOR_RECORD = { version: '0.6.0', from: '0.5.1' }

describe('live update: another install runs', () => {
  it('the supervisor still downloads: wait, write nothing, and take its version once the link names it', async () => {
    const h = harness({}, { busy: 'an update of /opt/w is running (pid 4242)', record: SUPERVISOR_RECORD })
    setRestartHandler(vi.fn())
    await h.updater.onChecked(STATUS)
    expect(await h.updater.snapshot()).toMatchObject({ state: 'downloading', version: '0.6.0', error: null })
    await h.t.advance(5 * 60_000)
    expect(await state(h)).toBe('downloading')
    expect(h.calls.install).toEqual([])
    h.set({ busy: null, installed: '0.6.0' })
    await h.t.advance(60_000)
    // In, and waiting on the gate: 6 minutes since the start is not 10 idle minutes yet.
    expect(await h.updater.snapshot()).toMatchObject({ state: 'waiting', version: '0.6.0', error: null })
    expect(h.calls.unverified).toEqual([])
    expect(h.calls.install).toEqual([])
  })

  it('the lock is taken between the look and the install: the record stays, and goes only once nobody installs', async () => {
    const h = harness({}, { lockTaken: true })
    await h.updater.onChecked(STATUS)
    await flush()
    expect(await h.updater.snapshot()).toMatchObject({ state: 'downloading', error: null })
    // Written before the install (no record was there), never cleared by the lock failure.
    expect(h.calls.unverified).toEqual([SUPERVISOR_RECORD])
    // The other install ends without the version; this one now installs it itself.
    h.set({ lockTaken: false })
    await h.t.advance(60_000)
    expect(await state(h)).toBe('installed')
    expect(h.calls.unverified).toEqual([SUPERVISOR_RECORD, null, SUPERVISOR_RECORD, SUPERVISOR_RECORD])
  })

  it('a record of this version another start wrote is kept, and its `from` survives an install that replaced nothing', async () => {
    const h = harness({}, { record: SUPERVISOR_RECORD, from: '0.6.0' })
    await h.updater.onChecked(STATUS)
    await flush()
    expect(await state(h)).toBe('installed')
    // Never `{0.6.0 from 0.6.0}`: that start would not be watched or gone back from.
    expect(h.calls.unverified).toEqual([SUPERVISOR_RECORD])
  })

  it('a failure clears only the record this install wrote', async () => {
    const own = harness({}, { fail: 'HTTP 503' })
    await own.updater.onChecked(STATUS)
    await flush()
    expect(own.calls.unverified).toEqual([SUPERVISOR_RECORD, null])
    const theirs = harness({}, { fail: 'HTTP 503', record: SUPERVISOR_RECORD })
    await theirs.updater.onChecked(STATUS)
    await flush()
    expect(await state(theirs)).toBe('failed')
    expect(theirs.calls.unverified).toEqual([])
  })
})

describe('live update: updates.auto turned on in Settings', () => {
  it('an update already known installs now, not at the next 6-hourly check', async () => {
    const h = harness({}, { auto: false })
    await h.updater.onChecked(STATUS)
    expect(await state(h)).toBe('off')
    h.set({ auto: true })
    await h.updater.configChanged()
    await flush()
    expect(h.calls.install).toEqual(['0.6.0'])
    expect(await state(h)).toBe('installed')
  })

  it('with nothing known yet the registry is asked now; other config changes do nothing', async () => {
    const none = { ...STATUS, available: false, latest: null, checkedAt: null }
    const h = harness({ status: () => none }, { auto: false })
    await h.updater.onChecked(none)
    await h.updater.configChanged()
    expect(h.calls.checks).toBe(0)
    h.set({ auto: true })
    await h.updater.configChanged()
    expect(h.calls.checks).toBe(1)
    await h.updater.configChanged()
    expect(h.calls.checks).toBe(1)
    expect(h.calls.install).toEqual([])
  })
})
