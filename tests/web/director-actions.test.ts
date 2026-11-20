/**
 * A Director's right-click menu (web/src/components/org/director-actions.ts).
 * 2026-11-20, the user: "we can also de-promote or promote any task to director ... we can also create
 * director".
 */
import { describe, expect, it, vi } from 'vitest'
import { directorMenuItems } from '../../web/src/components/org/director-actions.js'

const topicsFlag = vi.hoisted(() => ({ on: false }))
vi.mock('../../web/src/components/topics/topics-flag.js', () => ({ topicsOnNow: () => topicsFlag.on, useTopicsOn: () => topicsFlag.on }))

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

  it('offers "Add to topic…" after Open task only with the topics experiment on and the task named', () => {
    const fns = { openChat: vi.fn(), openTask: vi.fn(), remove: vi.fn() }
    const labels = (id?: string) => directorMenuItems({ id, title: 'Crane lead', ...fns }).map((i) => (i.divider ? '---' : String(i.label)))
    topicsFlag.on = true
    expect(labels('task-crane')).toEqual(['Crane lead', 'Open chat', 'Open task', 'Add to topic…', '---', 'Remove from Directors'])
    expect(labels()).not.toContain('Add to topic…')
    topicsFlag.on = false
    expect(labels('task-crane')).not.toContain('Add to topic…')
  })
})
