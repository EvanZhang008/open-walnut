/** Main's quick actions in the "+" of Main's own composer (web/src/components/org/main-quick-plus-rows.ts). */
import { describe, expect, it, vi } from 'vitest'
import {
  QUICK_ACTION_HELD_TITLE, QUICK_ACTIONS_GROUP, mainQuickPlusRows,
} from '../../web/src/components/org/main-quick-plus-rows'
import { MAIN_QUICK_ACTIONS_NOTE, quickActionMessage } from '../../web/src/components/org/main-quick-actions'

const anchor = {} as HTMLElement

describe('Main quick actions in the composer "+"', () => {
  it('only Main\'s composer gets them, and never on a replica', () => {
    const send = vi.fn()
    expect(mainQuickPlusRows({ mainId: null, replica: false, waitsOnUser: false, send })).toEqual([])
    expect(mainQuickPlusRows({ mainId: 'main-1', replica: true, waitsOnUser: false, send })).toEqual([])
  })

  it('lists the three actions under Quick actions, each saying nothing changes on the click', () => {
    const rows = mainQuickPlusRows({ mainId: 'main-1', replica: false, waitsOnUser: false, send: vi.fn() })
    expect(rows.map((r) => [r.id, r.label])).toEqual([
      ['main-qa-projects', 'Tidy projects'], ['main-qa-place', 'Put tasks in place'], ['main-qa-triage', 'Triage'],
    ])
    for (const r of rows) {
      expect(r.group).toBe(QUICK_ACTIONS_GROUP)
      expect(r.disabled).toBe(false)
      expect(r.title).toContain(MAIN_QUICK_ACTIONS_NOTE)
    }
  })

  it('a click sends the action\'s whole message through the composer\'s send, once', () => {
    const send = vi.fn()
    const sent = vi.fn()
    const rows = mainQuickPlusRows({ mainId: 'main-1', replica: false, waitsOnUser: false, send, onSent: sent })
    rows[2]!.onSelect({ anchor })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(quickActionMessage('triage'))
    expect(sent).toHaveBeenCalledWith('triage')
  })

  it('while Main waits on the user\'s answer the rows are off and say why', () => {
    const rows = mainQuickPlusRows({ mainId: 'main-1', replica: false, waitsOnUser: true, send: vi.fn() })
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(r.disabled).toBe(true)
      expect(r.title).toBe(QUICK_ACTION_HELD_TITLE)
    }
  })

  it('rows are off with their own reason when sending is blocked (the Mac is away)', () => {
    const rows = mainQuickPlusRows({ mainId: 'main-1', replica: false, waitsOnUser: false, blocked: 'Your Mac is away.', send: vi.fn() })
    expect(rows.every((r) => r.disabled && r.title === 'Your Mac is away.')).toBe(true)
  })
})
