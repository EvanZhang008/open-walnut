/**
 * The loop's budget (src/providers/loop-budget.ts): a few milliseconds a turn of the event loop,
 * shared by every piece of work that asks, ended by the check phase of the same loop iteration.
 * The clock is injected; the turn's end is the real setImmediate.
 */
import { describe, expect, it } from 'vitest'
import { createLoopBudget, LOOP_BUDGET_MS, sharedLoopBudget } from '../../src/providers/loop-budget.js'

const nextCheckPhase = () => new Promise<void>((resolve) => setImmediate(resolve))

function fakeClock(start = 1000) {
  let t = start
  return { now: () => t, advance(ms: number) { t += ms } }
}

describe('createLoopBudget', () => {
  it('is under budget until budgetMs of the turn passed, then over', () => {
    const clock = fakeClock()
    const budget = createLoopBudget(4, clock.now)
    expect(budget.over()).toBe(false) // the first ask starts the turn
    clock.advance(3)
    expect(budget.over()).toBe(false)
    clock.advance(0.9)
    expect(budget.over()).toBe(false)
    clock.advance(0.1)
    expect(budget.over()).toBe(true) // exactly budgetMs is spent
    clock.advance(50)
    expect(budget.over()).toBe(true)
  })

  it('a new turn starts with a full budget once the loop reached its check phase', async () => {
    const clock = fakeClock()
    const budget = createLoopBudget(4, clock.now)
    budget.over()
    clock.advance(10)
    expect(budget.over()).toBe(true)
    await budget.yieldTurn()
    // The turn ended in the check phase; the time spent before does not count any more.
    expect(budget.over()).toBe(false)
    clock.advance(3)
    expect(budget.over()).toBe(false)
    clock.advance(1)
    expect(budget.over()).toBe(true)
  })

  it('yieldTurn resolves in a later turn, not in this one\'s microtasks', async () => {
    const budget = createLoopBudget()
    let resumed = false
    const yielded = budget.yieldTurn().then(() => { resumed = true })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(resumed).toBe(false)
    await yielded
    expect(resumed).toBe(true)
  })

  it('a clock that reads 0 still starts the turn', () => {
    let t = 0
    const budget = createLoopBudget(4, () => t)
    expect(budget.over()).toBe(false)
    t = 4
    expect(budget.over()).toBe(true)
  })

  it('every user of one budget shares its turn: what one spent, the next has not', async () => {
    const clock = fakeClock()
    const shared = createLoopBudget(4, clock.now)
    // Two tailers, each handing over slices under the same budget in the same turn.
    expect(shared.over()).toBe(false) // tailer A, first slice
    clock.advance(4)
    expect(shared.over()).toBe(true) // tailer B asks: A spent this turn's budget
    await nextCheckPhase()
    expect(shared.over()).toBe(false) // a fresh turn for both
    // A budget of their own each would not have stopped B.
    const own = createLoopBudget(4, clock.now)
    expect(own.over()).toBe(false)
  })

  it('the process has one shared budget with the default of LOOP_BUDGET_MS', async () => {
    expect(LOOP_BUDGET_MS).toBe(4)
    await nextCheckPhase()
    expect(sharedLoopBudget.over()).toBe(false)
    const until = performance.now() + LOOP_BUDGET_MS + 1
    while (performance.now() < until) { /* spend this turn's budget */ }
    expect(sharedLoopBudget.over()).toBe(true)
    await sharedLoopBudget.yieldTurn()
    expect(sharedLoopBudget.over()).toBe(false)
  })
})
