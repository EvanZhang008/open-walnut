/**
 * The Approvals switch fails closed (src/core/approvals/ask-me.ts): a switch file that is there but
 * does not read never reads as "off", and config.yaml can turn it on but never off. No device key
 * takes part (2026-11-21: a person turns it off from any device they are signed in on).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-ask-me-latch'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetAskMeLatchForTesting, askMeOf, loadAskMeLatch, setAskMe } from '../../../src/core/approvals/ask-me.js'

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

describe('a person turns it off and on', () => {
  it('an off the person set holds across a restart, and a keys.json an older Walnut left changes nothing', async () => {
    // An older Walnut's device keys, active: they once made an off need a signature.
    await fs.writeFile(path.join(dir(), 'keys.json'), JSON.stringify({ version: 1, keys: [{ id: 'ak-1', status: 'active', kind: 'iphone' }] }))
    await setAskMe(true, { person: true })
    expect(askMeOf(OFF, {})).toBe(true)
    await setAskMe(false, { person: true })
    expect(askMeOf(OFF, {})).toBe(false)
    _resetAskMeLatchForTesting()
    await loadAskMeLatch()
    expect(askMeOf(OFF, {})).toBe(false)
    await setAskMe(true, { person: true })
    expect(askMeOf(OFF, {})).toBe(true)
  })
})
