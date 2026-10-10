/**
 * The Search settings row for the cloud companion's copy of the index
 * (web/src/components/settings/sections/companion-search-copy.ts): one sentence
 * per state, a warning when it runs without the memory Auto asks for, and the
 * confirm before On whenever the companion is not known to have that memory.
 */
import { describe, expect, it } from 'vitest'
import {
  companionSearchHelp, memoryWarningMessage, onNeedsMemoryWarning, showCompanionSearchRow, gb,
  type CompanionSearchStatus,
} from '../../web/src/components/settings/sections/companion-search-copy'

const at = (s: Partial<CompanionSearchStatus>): CompanionSearchStatus => ({ mode: 'auto', state: 'ready', checkedAt: 0, ...s })

describe('companion search row', () => {
  it('is shown only once the Mac has a companion', () => {
    expect(showCompanionSearchRow(null)).toBe(false)
    expect(showCompanionSearchRow(at({ state: 'no-companion' }))).toBe(false)
    expect(showCompanionSearchRow(at({ state: 'memory' }))).toBe(true)
  })

  it('says one sentence per state, a warning where something is wrong', () => {
    expect(companionSearchHelp(at({ state: 'ready', docs: 12_342 }))).toEqual({ text: 'Ready: the companion runs semantic search over 12,342 items while this Mac is away.' })
    expect(companionSearchHelp(at({ state: 'ready', reason: 'forced', totalMb: 3_900, needMb: 2_600 }))).toEqual({
      text: 'On with little memory: the model takes about 2.5 GB of the companion\'s 3.8 GB.', warning: true,
    })
    expect(companionSearchHelp(at({ state: 'syncing', pending: 3_120 })).text).toBe('Copying this index to the companion: 3,120 items left.')
    expect(companionSearchHelp(at({ state: 'memory', totalMb: 3_900, autoMinMb: 5_600 })).text).toBe('Off: Auto needs 5.5 GB of memory and the companion has 3.8 GB.')
    expect(companionSearchHelp(at({ state: 'off', mode: 'off' })).text).toBe('Off: the companion searches by keyword while this Mac is away.')
    expect(companionSearchHelp(at({ state: 'error', error: 'HTTP 502' }))).toEqual({ text: 'Couldn\'t reach the companion: HTTP 502.', warning: true })
    for (const s of ['model', 'unsupported', 'mac-keyword-only'] as const) {
      const help = companionSearchHelp(at({ state: s }))
      expect(help.text).toMatch(/\.$/)
      expect(help.text).not.toMatch(/[–—]/)
    }
  })

  it('choosing On warns unless the companion is known to have the room', () => {
    expect(onNeedsMemoryWarning('on', at({ totalMb: 7_813, autoMinMb: 5_600 }))).toBe(false)
    expect(onNeedsMemoryWarning('on', at({ totalMb: 3_900, autoMinMb: 5_600 }))).toBe(true)
    expect(onNeedsMemoryWarning('on', null)).toBe(true)
    expect(onNeedsMemoryWarning('auto', at({ totalMb: 3_900 }))).toBe(false)
    expect(onNeedsMemoryWarning('off', null)).toBe(false)
    expect(memoryWarningMessage(at({ totalMb: 3_900, needMb: 2_600 }))).toBe(
      'The companion has 3.8 GB of memory. The search model takes about 2.5 GB, which can leave too little for the companion itself and make it slow.',
    )
    expect(memoryWarningMessage(null)).toContain(gb(5_600))
  })
})
