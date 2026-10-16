/**
 * The phone's task detail head says why a save failed (docs/plan/walnut-replica-servers-impl.md,
 * WP7 review fix W3). On a host replica's console with the Mac away, a rename or
 * a phase change is refused with "Needs your Mac. ..." (api/leader-presence.ts);
 * the head showed "Couldn't save. Try again." for the rename (a retry cannot
 * help) and nothing at all for the phase. Now both show the refusal's own words,
 * and any other failure keeps the generic line.
 *
 * The real component on a linkedom document; the network seam (`updateTask`) is
 * stubbed to fail, the phase sheet is a stand-in that hands over its callback,
 * and there is no task store (the head's REST path, as on a detail page opened
 * for a task the list does not hold).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

const spy = vi.hoisted(() => ({
  fail: null as null | Error,
  calls: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  setPhase: null as null | ((phase: string) => void),
}))

vi.mock('@/api/tasks', () => ({
  updateTask: (id: string, patch: Record<string, unknown>) => {
    spy.calls.push({ id, patch })
    return spy.fail ? Promise.reject(spy.fail) : Promise.resolve({ id, ...patch })
  },
}))
vi.mock('@/contexts/TasksContext', () => ({ useTasksContextSafe: () => null }))
vi.mock('../../web/src/components/tasks/PhonePhaseSheet', () => ({
  PhonePhaseSheet: ({ onSetPhase }: { onSetPhase: (phase: string) => void }) => {
    spy.setPhase = onSetPhase
    return null
  },
}))

import { PhoneTaskDetailHead, saveFailedText } from '../../web/src/components/tasks/PhoneTaskDetailHead'
import { leaderErrorMessage } from '../../web/src/api/leader-presence'

const LEADER_WORDS = leaderErrorMessage({ error: { code: 'needs_leader', why: 'task_writes_need_mac' } })!
const GENERIC = "Couldn't save. Try again."

let doc: Document
beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  doc = dom.document as unknown as Document
})
beforeEach(() => { spy.fail = null; spy.calls = []; spy.setPhase = null })

function reactProps(node: Element): Record<string, (...args: unknown[]) => unknown> {
  const key = Object.keys(node).find((k) => k.startsWith('__reactProps$'))
  if (!key) throw new Error('no React props on the node')
  return (node as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>)[key]!
}

const task = { id: 'task-phone-head-1', title: 'Release plan', phase: 'IN_PROGRESS' } as never

async function mount() {
  const el = doc.createElement('div')
  doc.body.appendChild(el)
  const root = createRoot(el as unknown as Element)
  await act(async () => { root.render(createElement(PhoneTaskDetailHead, { task })) })
  return { el, root }
}

async function rename(el: Element, to: string) {
  const ta = el.querySelector('textarea')!
  const props = () => reactProps(ta)
  await act(async () => { props().onFocus!() })
  await act(async () => { props().onChange!({ target: { value: to } }) })
  await act(async () => { props().onBlur!() })
  // The rejected save settles on the next ticks.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

const alertText = (el: Element) => el.querySelector('[role="alert"]')?.textContent ?? null

describe('PhoneTaskDetailHead: a failed save says why', () => {
  it('the words: the replica\'s own about the Mac, else the generic line', () => {
    expect(saveFailedText(new Error(LEADER_WORDS))).toBe(LEADER_WORDS)
    expect(saveFailedText(new Error('Your Mac did not answer in time. Nothing was saved; try again.'))).toBe('Your Mac did not answer in time. Nothing was saved; try again.')
    expect(saveFailedText(new Error('HTTP 500'))).toBe(GENERIC)
    expect(saveFailedText(undefined)).toBe(GENERIC)
  })

  it('a rename refused while the Mac is away shows "Needs your Mac" with the reason', async () => {
    spy.fail = new Error(LEADER_WORDS)
    const { el, root } = await mount()
    await rename(el, 'Release plan v2')
    expect(spy.calls).toEqual([{ id: 'task-phone-head-1', patch: { title: 'Release plan v2' } }])
    expect(alertText(el)).toBe('Needs your Mac. Changing a task needs your Mac for now.')
    // The old title is back in the field.
    expect((el.querySelector('textarea') as unknown as { value: string }).value).toBe('Release plan')
    await act(async () => { root.unmount() })
  })

  it('a rename that fails for any other reason keeps the generic line', async () => {
    spy.fail = new Error('HTTP 500')
    const { el, root } = await mount()
    await rename(el, 'Release plan v3')
    expect(alertText(el)).toBe(GENERIC)
    await act(async () => { root.unmount() })
  })

  it('a phase change that fails now says so: the replica\'s words, or the generic line', async () => {
    spy.fail = new Error(LEADER_WORDS)
    const { el, root } = await mount()
    expect(alertText(el)).toBeNull()
    await act(async () => { spy.setPhase!('COMPLETE'); await new Promise((r) => setTimeout(r, 0)) })
    expect(spy.calls).toEqual([{ id: 'task-phone-head-1', patch: { phase: 'COMPLETE' } }])
    expect(alertText(el)).toBe(LEADER_WORDS)
    spy.fail = new Error('socket hang up')
    await act(async () => { spy.setPhase!('TODO'); await new Promise((r) => setTimeout(r, 0)) })
    expect(alertText(el)).toBe(GENERIC)
    await act(async () => { root.unmount() })
  })
})
