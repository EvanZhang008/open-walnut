/**
 * A Director's right-click menu (web/src/components/org/director-actions.ts).
 * 2026-11-20, the user: "we can also de-promote or promote any task to director ... we can also create
 * director".
 */
import { describe, expect, it, vi } from 'vitest'
import { directorMenuItems } from '../../web/src/components/org/director-actions.js'

describe('a Director\'s menu', () => {
  it('opens its chat, opens it, and takes it off the Directors, in that order', () => {
    const openChat = vi.fn(); const openTask = vi.fn(); const remove = vi.fn()
    const items = directorMenuItems({ title: 'Crane lead', openChat, openTask, remove })
    expect(items.map((i) => (i.divider ? '---' : String(i.label)))).toEqual(['Crane lead', 'Open chat', 'Open task', '---', 'Remove from Directors'])
    items.find((i) => i.key === 'chat')!.onSelect!()
    items.find((i) => i.key === 'task')!.onSelect!()
    items.find((i) => i.key === 'remove')!.onSelect!()
    expect([openChat.mock.calls.length, openTask.mock.calls.length, remove.mock.calls.length]).toEqual([1, 1, 1])
  })
})
