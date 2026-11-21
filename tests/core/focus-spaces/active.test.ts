/**
 * Being in a focus (src/core/focus-spaces/active.ts): changes run one at a time, so the focus
 * file and its quiet hold never disagree; a block enters only over none or a block's, and only
 * the owner of a block ends it; at start the file and the hold agree again; the experiment
 * switched off ends a focus left on and the scopes plugins' holds carried (lifecycle.ts).
 * 2026-11-21 review: a leave racing an enter left Walnut quiet with no focus to leave, and any
 * plugin's clear ended Rhythm's block.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('focus-active'))
const flags = { focus_workspace: true }
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: async () => ({ experimental: { ...flags } }) }))

import { WALNUT_HOME } from '../../../src/constants.js'
import {
  enterFocus, enterFocusIf, getActiveFocus, leaveFocus, reconcileFocusQuiet, resetActiveFocus, FOCUS_QUIET_SOURCE,
} from '../../../src/core/focus-spaces/active.js'
import { getQuiet, setQuiet, stopQuiet } from '../../../src/core/quiet/quiet-state.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { startFocusSpaces } from '../../../src/core/focus-spaces/lifecycle.js'

const focusHold = async () => (await getQuiet()).holds.find((h) => h.source === FOCUS_QUIET_SOURCE)
const fileFocus = async () => JSON.parse(await fs.readFile(path.join(WALNUT_HOME, 'local', 'focus-active.json'), 'utf8'))

beforeEach(async () => {
  flags.focus_workspace = true
  stopQuiet()
  resetActiveFocus()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})
afterEach(async () => {
  bus.unsubscribe('focus-spaces-switch')
  stopQuiet()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('active focus', () => {
  it('an enter and a leave asked together end as the last one asked, file and hold alike', async () => {
    await Promise.all([enterFocus({ scope: { projects: ['Walnut'] } }), leaveFocus()])
    expect(await getActiveFocus()).toBeNull()
    expect(await fileFocus()).toBeNull()
    expect(await focusHold()).toBeUndefined()

    await Promise.all([leaveFocus(), enterFocus({ scope: { projects: ['Walnut'] } })])
    expect(await getActiveFocus()).toMatchObject({ name: 'Focus', scope: { projects: ['Walnut'] } })
    expect(await focusHold()).toMatchObject({ scope: { projects: ['Walnut'] } })
  })

  it('a block enters over none or a block, never over the person\'s, even asked at once', async () => {
    const block = { scope: { tasks: ['t1'] }, by: 'block', owner: 'walnut-rhythm#1' }
    const overBlock = (prev: { by: string } | null) => !prev || prev.by === 'block'
    await Promise.all([enterFocus({ scope: { projects: ['Walnut'] } }), enterFocusIf(block, overBlock)])
    expect(await getActiveFocus()).toMatchObject({ by: 'person', scope: { projects: ['Walnut'] } })

    await leaveFocus()
    expect(await enterFocusIf(block, overBlock)).toMatchObject({ by: 'block', owner: 'walnut-rhythm#1' })
  })

  it('only the owner of a block ends it', async () => {
    await enterFocus({ scope: { tasks: ['t1'] }, by: 'block', owner: 'walnut-rhythm#2' })
    expect(await leaveFocus({ onlyBy: 'block', onlyOwner: 'walnut-rhythm#1' })).toBeNull()
    expect(await leaveFocus({ onlyBy: 'block', onlyOwner: 'other-plugin#5' })).toBeNull()
    expect(await getActiveFocus()).toMatchObject({ owner: 'walnut-rhythm#2' })
    expect(await leaveFocus({ onlyBy: 'block', onlyOwner: 'walnut-rhythm#2' })).toMatchObject({ owner: 'walnut-rhythm#2' })
    expect(await getActiveFocus()).toBeNull()
  })

  it('at start, a focus whose hold went holds again, and a hold with no focus lets go', async () => {
    await enterFocus({ scope: { projects: ['Walnut'] } })
    await (await import('../../../src/core/quiet/quiet-state.js')).clearQuiet(FOCUS_QUIET_SOURCE)
    await reconcileFocusQuiet()
    expect(await focusHold()).toMatchObject({ scope: { projects: ['Walnut'] } })

    await leaveFocus()
    await setQuiet({ source: FOCUS_QUIET_SOURCE, reason: 'Focus: left over', scope: { projects: ['Walnut'] } })
    await reconcileFocusQuiet()
    expect(await focusHold()).toBeUndefined()
  })

  it('the switch turned off ends the focus and the scopes of plugins\' holds, no window asking', async () => {
    await startFocusSpaces()
    await enterFocus({ scope: { projects: ['Walnut'] } })
    await setQuiet({ source: 'plugin:walnut-rhythm', owner: 'walnut-rhythm#1', scope: { tasks: ['t1'] } })
    flags.focus_workspace = false
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'experimental' }, ['web-ui'])
    await vi.waitFor(async () => expect(await getActiveFocus()).toBeNull())
    await vi.waitFor(async () => {
      const holds = (await getQuiet()).holds
      expect(holds.map((h) => h.source)).toEqual(['plugin:walnut-rhythm'])
      expect(holds[0].scope).toBeUndefined()
    })
  })
})
