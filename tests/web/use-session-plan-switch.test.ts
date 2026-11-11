/**
 * useSessionPlan keeps a plan with the session it was read for: a panel switched from A to B never
 * shows A's plan for B (its first frame included), and A's late answer never fills B.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot, type Root } from '../../web/node_modules/react-dom/client.js'

type Plan = { content: string; sourceSessionId?: string }
const pending = new Map<string, Array<(p: Plan | null) => void>>()
vi.mock('@/api/sessions', () => ({
  fetchSessionPlan: (id: string) => new Promise<Plan | null>((resolve) => {
    pending.set(id, [...(pending.get(id) ?? []), resolve])
  }),
}))

let useSessionPlan: typeof import('../../web/src/hooks/useSessionPlan').useSessionPlan
let root: Root | null = null
let box: Element
/** What the hook returned on every render, with the session it was rendered for. */
const frames: Array<{ sid: string; content: string | null }> = []

function Probe({ sid }: { sid: string }) {
  const { plan } = useSessionPlan(sid, true)
  frames.push({ sid, content: plan?.content ?? null })
  return null
}

beforeAll(async () => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  box = dom.document.createElement('div')
  dom.document.body.appendChild(box)
  ;({ useSessionPlan } = await import('../../web/src/hooks/useSessionPlan'))
})

afterEach(async () => {
  if (root) await act(async () => { root!.unmount() })
  root = null
  pending.clear()
  frames.length = 0
})

const answer = async (sid: string, plan: Plan | null) => {
  const queue = pending.get(sid) ?? []
  expect(queue.length, `a plan read for ${sid} is out`).toBeGreaterThan(0)
  await act(async () => { queue.shift()!(plan) })
}

describe('useSessionPlan across a session switch', () => {
  it("never shows A's plan for B, from B's first frame on", async () => {
    root = createRoot(box)
    await act(async () => { root!.render(createElement(Probe, { sid: 'A' })) })
    await answer('A', { content: 'plan of A' })
    expect(frames.at(-1)).toEqual({ sid: 'A', content: 'plan of A' })
    const before = frames.length
    await act(async () => { root!.render(createElement(Probe, { sid: 'B' })) })
    for (const f of frames.slice(before)) expect(f, 'a frame of B showed A\'s plan').toEqual({ sid: 'B', content: null })
    await answer('B', { content: 'plan of B', sourceSessionId: 'writer-of-B' })
    expect(frames.at(-1)).toEqual({ sid: 'B', content: 'plan of B' })
  })

  it("A's late answer never fills B", async () => {
    root = createRoot(box)
    await act(async () => { root!.render(createElement(Probe, { sid: 'A' })) })
    await act(async () => { root!.render(createElement(Probe, { sid: 'B' })) })
    await answer('A', { content: 'late plan of A' })
    expect(frames.filter((f) => f.sid === 'B').every((f) => f.content === null), 'B never showed A\'s late plan').toBe(true)
    await answer('B', { content: 'plan of B' })
    expect(frames.at(-1)).toEqual({ sid: 'B', content: 'plan of B' })
  })
})
