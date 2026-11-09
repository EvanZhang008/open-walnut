/**
 * Walnut closes the tabs a task opened once the task no longer uses them
 * (src/web/routes/browser-tab-tidy.ts). 2026-11-08, the user: "the app shows only 2 open, but in
 * browser so many open and keep there, please be consistent also clean up after used, unless wait
 * for human".
 *
 * Guard: after a pass, every tab still held is a live task's, or one that waits for the person
 * (Take over, an open sign-in ask, a task in NEED_ACTION). A tab of a finished task never stays.
 */
import { describe, expect, it } from 'vitest'
import { IDLE_MS, tidyTabs, type TidyDeps } from '../../../src/web/routes/browser-tab-tidy'

type Held = { device: string; tab: number; owner: string; usedAt: number; driving: boolean }
const NOW = 10 * IDLE_MS

function world(held: Held[], phases: Record<string, string | undefined | Error>, opts: { asks?: number[]; offline?: string[]; refuse?: number[]; givenBack?: number[]; busy?: number[]; looking?: number[] } = {}) {
  const tabs = new Map(held.map((t) => [t.tab, t]))
  const sent: Array<{ action: string; args: Record<string, unknown> }> = []
  const released: Array<{ tab: number; why: string }> = []
  const ending = new Map<number, string>()
  const hub = {
    connected: () => ['mac', 'other'].filter((d) => !opts.offline?.includes(d)).map((device) => ({ device })),
    heldTabs: () => [...tabs.values()],
    tabGen: (_d: string, tab: number) => tab * 10,
    tabBusy: (_d: string, tab: number) => opts.busy?.includes(tab) === true,
    endingTab: (_d: string, tab: number, why: string) => { ending.set(tab, why); return () => { ending.delete(tab) } },
    send: async (_d: string, action: string, args: Record<string, unknown>) => {
      sent.push({ action, args })
      if (opts.refuse?.includes(args.tab as number)) throw new Error('no answer')
      expect(args.tidy).toBe(true)
      if (opts.looking?.includes(args.tab as number)) return { closed: false, kept: 'person_looking' }
      return { released: opts.givenBack?.includes(args.tab as number) === true }
    },
    releaseTabIf: (_d: string, tab: number, _o: string, gen: number, why: string) => { expect(gen).toBe(tab * 10); tabs.delete(tab); released.push({ tab, why }); return true },
  }
  const deps: TidyDeps = {
    hub: async () => hub as never,
    phaseOf: async (id) => { const p = phases[id]; if (p instanceof Error) throw p; return p },
    allow: async () => ({ any: true, sites: [], walnut: [] }),
    asksOn: (_d, tab) => opts.asks?.includes(tab) === true,
  }
  return { deps, tabs, sent, released, ending }
}
const held = (tab: number, owner: string, usedAt = NOW, more: Partial<Held> = {}): Held => ({ device: 'mac', tab, owner, usedAt, driving: false, ...more })

describe('the tidy-up of tasks\' tabs', () => {
  it('closes a finished or deleted task\'s tabs at once, and an idle one\'s after IDLE_MS; keeps every tab that waits for the person', async () => {
    const w = world([
      held(1, 'task:done'),                                   // COMPLETE: closed
      held(2, 'task:gone'),                                   // no such task: closed
      held(3, 'task:idle', NOW - IDLE_MS - 1),                // working task, unused 30 min: closed
      held(4, 'task:busy', NOW - 60_000),                     // in use: kept
      held(5, 'task:needs', NOW - 5 * IDLE_MS),               // waits on the person: kept
      held(6, 'task:done', NOW, { driving: true }),           // the person took it over: kept
      held(7, 'task:done'),                                   // an open sign-in ask: kept
      held(8, 'session:abc'),                                 // not a task's: kept
      held(9, 'task:done', NOW, { device: 'other' }),
    ], { 'done': 'COMPLETE', 'gone': undefined, 'idle': 'IN_PROGRESS', 'busy': 'IN_PROGRESS', 'needs': 'NEED_ACTION' }, { asks: [7], offline: ['other'] })
    const out = await tidyTabs(w.deps, NOW)
    expect(out.map((o) => [o.tab, o.why])).toEqual([[1, 'done'], [2, 'done'], [3, 'idle']])
    expect(w.sent).toEqual([1, 2, 3].map((tab) => ({ action: 'close', args: { tab, owner: expect.stringMatching(/^task:/), tidy: true } })))
    // Its end reads "tidied" even when the browser's report comes first.
    expect([...w.ending.entries()]).toEqual([[1, 'tidied'], [2, 'tidied'], [3, 'tidied']])
    expect(w.released.map((r) => r.why)).toEqual(['tidied', 'tidied', 'tidied'])
    // The guard: what is left is live work or waits for the person.
    for (const t of w.tabs.values()) {
      const id = t.owner.slice(5)
      const waits = t.driving || [7].includes(t.tab) || id === 'needs' || !t.owner.startsWith('task:') || t.device === 'other'
      expect(waits || ['busy'].includes(id), `tab ${t.tab} of ${t.owner} stayed`).toBe(true)
    }
  })

  it('a tab of the person\'s own is given back, not closed; a browser that does not answer is tried again next pass', async () => {
    const w = world([held(1, 'task:done'), held(2, 'task:done')], { done: 'COMPLETE' }, { givenBack: [1], refuse: [2] })
    await tidyTabs(w.deps, NOW)
    expect(w.released).toEqual([{ tab: 1, why: 'given_back' }])
    expect(w.tabs.has(2)).toBe(true)
    expect(w.ending.has(2)).toBe(false)
  })

  it('never takes a tab a command is on its way to, nor one the person is looking at', async () => {
    const w = world([held(1, 'task:done'), held(2, 'task:done')], { done: 'COMPLETE' }, { busy: [1], looking: [2] })
    expect(await tidyTabs(w.deps, NOW)).toEqual([])
    expect(w.sent.map((x) => x.args.tab)).toEqual([2])
    expect(w.released).toEqual([])
    expect(w.ending.size).toBe(0)
  })

  it('a task Walnut cannot read now keeps its tabs (never closed on a guess)', async () => {
    const w = world([held(1, 'task:x')], { x: new Error('store busy') })
    expect(await tidyTabs(w.deps, NOW)).toEqual([])
    expect(w.sent).toEqual([])
  })
})
