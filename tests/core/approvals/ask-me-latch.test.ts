/**
 * The Approvals switch fails closed (src/core/approvals/ask-me.ts): a switch file or a keys file
 * that is there but does not read never reads as "off" or "no device", and a phone key added while
 * approvals are on cannot turn them off for its first day.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-ask-me-latch'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetAskMeLatchForTesting, askMeOf, keyMayTurnOff, loadAskMeLatch, offNeedsSignature, PHONE_KEY_SETTLE_MS, setAskMe } from '../../../src/core/approvals/ask-me.js'

const dir = () => path.join(WALNUT_HOME, 'approvals')
const OFF = { approvals: { ask_me: false } }

beforeEach(async () => {
  _resetAskMeLatchForTesting()
  await fs.rm(dir(), { recursive: true, force: true })
  await fs.mkdir(dir(), { recursive: true })
})

describe('the switch file', () => {
  it('a switch file that does not parse, or is not a record, reads as on', async () => {
    for (const text of ['', '{"on":', '{"on":"no","at":"x"}', '[]']) {
      _resetAskMeLatchForTesting()
      await fs.writeFile(path.join(dir(), 'switch.json'), text)
      await loadAskMeLatch()
      expect(askMeOf(OFF, {}), JSON.stringify(text)).toBe(true)
    }
  })

  it('a switch file that cannot be read reads as on', async () => {
    await fs.mkdir(path.join(dir(), 'switch.json'))
    await loadAskMeLatch()
    expect(askMeOf(OFF, {})).toBe(true)
  })

  it('an off Walnut recorded reads off; config.yaml saying on still wins', async () => {
    await fs.writeFile(path.join(dir(), 'switch.json'), JSON.stringify({ version: 1, on: false, at: new Date().toISOString() }))
    await loadAskMeLatch()
    expect(askMeOf(OFF, {})).toBe(false)
    expect(askMeOf({ approvals: { ask_me: true } }, {})).toBe(true)
  })
})

describe('the keys file', () => {
  it('none at all: no device signs', async () => {
    expect(await offNeedsSignature()).toBe(false)
  })
  it('there but unreadable or broken: a signature is needed', async () => {
    await fs.writeFile(path.join(dir(), 'keys.json'), '{"keys": [')
    expect(await offNeedsSignature()).toBe(true)
    await fs.writeFile(path.join(dir(), 'keys.json'), '{}')
    expect(await offNeedsSignature()).toBe(true)
    await fs.rm(path.join(dir(), 'keys.json'))
    await fs.mkdir(path.join(dir(), 'keys.json'))
    expect(await offNeedsSignature()).toBe(true)
  })
  it('only pending keys: no device signs yet', async () => {
    await fs.writeFile(path.join(dir(), 'keys.json'), JSON.stringify({ version: 1, keys: [{ id: 'ak-1', status: 'pending' }] }))
    expect(await offNeedsSignature()).toBe(false)
  })
})

describe('which key may turn approvals off', () => {
  it('the Mac app any time; a phone from before approvals went on, or after a day', async () => {
    const before = new Date(Date.now() - 60_000).toISOString()
    await setAskMe(true, { person: true })
    const now = Date.now()
    const after = new Date(now + 1000).toISOString()
    expect(keyMayTurnOff({ kind: 'mac-app', createdAt: after, activatedAt: after }, now)).toBe(true)
    expect(keyMayTurnOff({ kind: 'iphone', createdAt: before, activatedAt: before }, now)).toBe(true)
    expect(keyMayTurnOff({ kind: 'iphone', createdAt: after, activatedAt: after }, now + 2000)).toBe(false)
    expect(keyMayTurnOff({ kind: 'iphone', createdAt: after, activatedAt: after }, now + 1000 + PHONE_KEY_SETTLE_MS)).toBe(true)
    expect(keyMayTurnOff({ kind: 'iphone', createdAt: 'not a date' }, now)).toBe(false)
    expect(keyMayTurnOff(undefined, now)).toBe(false)
    // Saving on again keeps when approvals went on, so a later key never becomes "from before".
    await setAskMe(true, { person: true })
    expect(keyMayTurnOff({ kind: 'iphone', createdAt: after, activatedAt: after }, now + 2000)).toBe(false)
  })
})
