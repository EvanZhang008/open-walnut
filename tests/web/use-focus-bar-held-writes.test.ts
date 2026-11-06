/**
 * useFocusBar: every Focus Bar write holds its optimistic patch until the write is
 * answered, settles that hold exactly once (before any rollback or snapshot), and
 * the page takes ONE answer only once every write is in.
 *
 * Two races, one file:
 *   . A task list read that left after the optimistic patch but was answered before
 *     the write landed drew the old values back (1971accf7's project rename class;
 *     a reorder, whose pin_order has no per-task event, kept the old order until the
 *     next read). `patchTasksLocal(..., { pending: true })` holds the patch.
 *   . The server applies writes in the order they get its write lock, not the order
 *     they were sent. A collapsed folder dropped in another tier sends one tier write
 *     per member plus a reorder in the same tick; the reorder often lands first and
 *     its snapshot still holds the old tiers. Applying that snapshot (or any answer
 *     while another write is out) wrote the old tier over the members' held edits,
 *     their echoes were then laid under the old value, and the folder snapped back.
 *     Now a write's own answer is applied only when it ran alone; otherwise the last
 *     write in pulls the whole snapshot once.
 *
 * The task store here is wired to the REAL merge rules of web/src/hooks/useTasks.ts
 * (noteLocalEdits, settleLocalEdits, heldOverEcho and overlayLaterEdits from
 * task-list-merge.ts), and the focus API to a small model of the server's tier
 * store whose writes land in the order a test chooses. React is stand-ins (one call,
 * no re-render; the root vitest is `environment: 'node'`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { heldOverEcho, noteLocalEdits, overlayLaterEdits, settleLocalEdits, type LocalEdit } from '../../web/src/hooks/task-list-merge'

// The frontend's React lives in web/node_modules; a bare 'react' mock misses it.
vi.mock('../../web/node_modules/react', () => ({
  useState: <T,>(initial: T) => [initial, vi.fn()] as const,
  useCallback: <T,>(fn: T) => fn,
  useMemo: <T,>(fn: () => T) => fn(),
  useRef: <T,>(initial: T) => ({ current: initial }),
  useEffect: () => {},
  useLayoutEffect: () => {},
}))
vi.mock('@/hooks/useCommittedRef', () => ({ useCommittedRef: <T,>(value: T) => ({ current: value }) }))
/** The socket events the hook listens to, so a test can deliver one. */
const socketHandlers = new Map<string, (data: unknown) => void>()
vi.mock('@/hooks/useWebSocket', () => ({ useEvent: (name: string, cb: (data: unknown) => void) => { socketHandlers.set(name, cb) } }))
vi.mock('@/utils/fetch-retry', () => ({ fetchWithRetry: () => new Promise(() => {}) }))

interface Row { id: string; title: string; status: string; phase: string; pinned?: boolean; pin_order?: number; focus_tier?: string }
type PinFields = Pick<Row, 'pinned' | 'pin_order' | 'focus_tier'>
interface Snapshot { pinned_tasks: string[]; focus_tasks?: string[]; wait_tasks?: string[]; satellite_tasks?: string[]; custom_tier_tasks?: Record<string, string[]> }

// ── The server: one tier store, writes applied when the test lands them ──
const server = new Map<string, PinFields>()
function snapshot(): Snapshot {
  const pinned = [...server].filter(([, t]) => t.pinned).sort((a, b) => (a[1].pin_order ?? 0) - (b[1].pin_order ?? 0))
  const inTier = (tier?: string) => pinned.filter(([, t]) => t.focus_tier === tier).map(([id]) => id)
  return { pinned_tasks: pinned.map(([id]) => id), focus_tasks: inTier('focus'), wait_tasks: inTier('wait'), satellite_tasks: inTier(undefined), custom_tier_tasks: {} }
}
const reorderOnServer = (ids: string[]) => {
  const rest = [...server].filter(([id, t]) => t.pinned && !ids.includes(id)).sort((a, b) => (a[1].pin_order ?? 0) - (b[1].pin_order ?? 0)).map(([id]) => id)
  ;[...ids.filter((id) => server.get(id)?.pinned), ...rest].forEach((id, i) => { server.get(id)!.pin_order = i })
}
/** PUT /api/focus/tasks/:id/tier: an unpinned task is refused, as setFocusTier does. */
const setTierOnServer = (id: string, tier: string) => {
  if (!server.get(id)!.pinned) throw new Error('400 Task is not pinned')
  tierOnServer(id, tier)
}
/** The pin and batch routes: an unpinned task is pinned at the bottom first. */
const tierOnServer = (id: string, tier: string | null) => {
  const t = server.get(id)!
  if (tier === null) { t.pinned = false; delete t.pin_order; delete t.focus_tier; return }
  if (!t.pinned) { t.pinned = true; t.pin_order = Math.max(-1, ...[...server.values()].filter((r) => r.pinned).map((r) => r.pin_order ?? 0)) + 1 }
  t.focus_tier = tier === 'satellite' ? undefined : tier
}

/** A write sent and not yet applied by the server. */
interface Out { name: string; land: () => void; fail: (err?: Error) => void }
let out: Out[] = []
function serverWrite<T>(name: string, apply: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    out.push({
      name,
      land: () => {
        order.push(`land ${name}`)
        try { resolve(apply()) } catch (err) { reject(err) }
      },
      fail: (err = new Error('500')) => { order.push(`fail ${name}`); reject(err) },
    })
  })
}
/** Let the server apply the write named `name`, then let its answer reach the page. */
async function land(name: string) {
  const i = out.findIndex((o) => o.name === name)
  if (i === -1) throw new Error(`no write ${name} is out (out: ${out.map((o) => o.name).join(', ')})`)
  const [op] = out.splice(i, 1)
  op.land()
  await flush()
}
async function fail(name: string, err?: Error) {
  const i = out.findIndex((o) => o.name === name)
  const [op] = out.splice(i, 1)
  op.fail(err)
  await flush()
}

const api = {
  fetchPinnedTasks: vi.fn(async () => { order.push('pull'); return snapshot() }),
  pinTask: vi.fn((id: string) => serverWrite(`pin:${id}`, () => { tierOnServer(id, 'satellite'); return { pinned_tasks: snapshot().pinned_tasks } })),
  unpinTask: vi.fn((id: string) => serverWrite(`unpin:${id}`, () => { tierOnServer(id, null); return { pinned_tasks: snapshot().pinned_tasks } })),
  reorderPinnedTasks: vi.fn((ids: string[]) => serverWrite(`reorder:${ids.join('')}`, () => { reorderOnServer(ids); return snapshot() })),
  setTaskTier: vi.fn((id: string, tier: string) => serverWrite(`tier:${id}`, () => { setTierOnServer(id, tier); return snapshot() })),
  setTierBulk: vi.fn((ids: string[], tier: string | null) => serverWrite(`bulk:${ids.join('')}`, () => {
    const failed = ids.filter((id) => id === 'x').map((id) => ({ id, ok: false as const, error: 'refused' }))
    for (const id of ids) if (id !== 'x') tierOnServer(id, tier)
    return { ...snapshot(), changed: ids.filter((id) => id !== 'x'), failed }
  })),
  fetchCustomTiers: vi.fn(),
}
vi.mock('@/api/focus', () => api)

// ── The page's task store, with useTasks' real merge rules ──
const order: string[] = []
let rows: Row[] = []
const edits = new Map<string, LocalEdit>()
let clock = 0
const tick = () => ++clock
/** Every settle the store handed out for a held patch, with how many times it ran. */
let settles: { label: string; calls: number }[] = []

const describePatch = (patches: Record<string, Partial<Row>>) =>
  Object.entries(patches).map(([id, p]) => `${id}{${Object.entries(p).map(([k, v]) => `${k}=${String(v)}`).join(',')}}`).join(' ')

const patchTasksLocal = vi.fn((patches: Record<string, Partial<Row>>, opts?: { pending?: boolean }) => {
  const label = describePatch(patches)
  const pending = opts?.pending === true
  order.push(`${pending ? 'hold' : 'patch'} ${label}`)
  noteLocalEdits(edits, patches as never, pending, tick())
  // New row objects in the SAME array, as the store does: the hook's ref keeps the
  // array, and a row it read before the patch keeps its old values.
  rows.forEach((t, i) => { if (patches[t.id]) rows[i] = { ...t, ...patches[t.id] } })
  const entry = { label, calls: 0 }
  if (pending) settles.push(entry)
  let settled = !pending
  return () => {
    entry.calls++
    if (settled) return
    settled = true
    settleLocalEdits(edits, Object.keys(patches), tick())
    order.push(`settle ${label}`)
  }
})
const showOperationError = vi.fn((msg: string) => { order.push(`error ${msg}`) })
vi.mock('@/contexts/TasksContext', () => ({
  useTasksContext: () => ({ tasks: rows, patchTasksLocal, guardEcho: () => {}, showOperationError }),
}))

/** The server's task:updated for one row reaches the page (the useTasks echo path). */
function echo(id: string) {
  const i = rows.findIndex((t) => t.id === id)
  const fields = server.get(id)!
  rows[i] = heldOverEcho({ ...rows[i], pinned: fields.pinned, pin_order: fields.pin_order, focus_tier: fields.focus_tier } as never, edits) as unknown as Row
}
/** A task list read: left now, read the server now, answered later with `answer()`. */
function listRead() {
  const sentAt = tick()
  const read = rows.map((t) => ({ ...t, ...server.get(t.id) }))
  return () => {
    const merged = overlayLaterEdits(read as never, edits, sentAt) as unknown as Row[]
    merged.forEach((t, i) => { rows[i] = t })
  }
}

const { useFocusBar } = await import('@/hooks/useFocusBar')

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) }
const heldCalls = () => patchTasksLocal.mock.calls.filter((c) => c[1]?.pending === true)
const appliedSnapshots = () => order.filter((l) => l.startsWith('patch ') && /pinned=true,pin_order=0/.test(l))
const row = (id: string) => rows.find((t) => t.id === id)!
const drawnOrder = () => rows.filter((t) => t.pinned).sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0)).map((t) => t.id)
function expectEachHeldSettledOnce() {
  expect(settles.length).toBeGreaterThan(0)
  for (const s of settles) expect(s.calls, s.label).toBe(1)
}

beforeEach(() => {
  vi.clearAllMocks()
  order.length = 0
  settles = []
  out = []
  edits.clear()
  const seed: Row[] = [
    { id: 'a', title: 'A', status: 'todo', phase: 'TODO', pinned: true, pin_order: 0, focus_tier: 'focus' },
    { id: 'b', title: 'B', status: 'todo', phase: 'TODO', pinned: true, pin_order: 1, focus_tier: 'focus' },
    { id: 'c', title: 'C', status: 'todo', phase: 'TODO', pinned: true, pin_order: 2 },
    { id: 'd', title: 'D', status: 'todo', phase: 'TODO' },
  ]
  rows = seed.map((t) => ({ ...t }))
  server.clear()
  for (const t of seed) server.set(t.id, { pinned: t.pinned, pin_order: t.pin_order, focus_tier: t.focus_tier })
})

describe('a write alone', () => {
  it('reorder: holds the new order, settles when answered, then takes its own answer (no pull)', async () => {
    const bar = useFocusBar()
    const done = bar.reorder(['c', 'a', 'b'])
    await land('reorder:cab')
    await done
    expect(heldCalls()).toHaveLength(1)
    expect(order).toEqual([
      'hold c{pin_order=0} a{pin_order=1} b{pin_order=2}',
      'land reorder:cab',
      'settle c{pin_order=0} a{pin_order=1} b{pin_order=2}',
      'patch c{pinned=true,pin_order=0,focus_tier=undefined} a{pinned=true,pin_order=1,focus_tier=focus} b{pinned=true,pin_order=2,focus_tier=focus}',
    ])
    expect(api.fetchPinnedTasks).not.toHaveBeenCalled()
    expectEachHeldSettledOnce()
  })

  it('reorder: a list read answered before the write landed does not draw the old order back', async () => {
    const bar = useFocusBar()
    const done = bar.reorder(['c', 'a', 'b'])
    listRead()()
    expect(drawnOrder()).toEqual(['c', 'a', 'b'])
    await land('reorder:cab')
    await done
    expect(drawnOrder()).toEqual(['c', 'a', 'b'])
  })

  it('reorder failure: settles before the error and the pull, and the pull draws the server order', async () => {
    const bar = useFocusBar()
    const done = bar.reorder(['c', 'a', 'b'])
    await fail('reorder:cab')
    await done
    await flush()
    const at = (prefix: string) => order.findIndex((l) => l.startsWith(prefix))
    expect(at('settle ')).toBeGreaterThan(at('fail '))
    expect(at('settle ')).toBeLessThan(at('error '))
    expect(at('error ')).toBeLessThan(at('pull'))
    expect(drawnOrder()).toEqual(['a', 'b', 'c'])
    expectEachHeldSettledOnce()
  })

  it('a timeout (the API rejects with TimeoutError after 15s) settles exactly once', async () => {
    const bar = useFocusBar()
    const done = bar.reorder(['b', 'a', 'c'])
    await fail('reorder:bac', Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }))
    await done
    expectEachHeldSettledOnce()
    expect(showOperationError).toHaveBeenCalledTimes(1)
  })

  it('setTier with a new order: held over both requests, then its own answer', async () => {
    const bar = useFocusBar()
    const done = bar.setTier('c', 'focus', ['c', 'a', 'b'])
    await land('reorder:cab')
    await land('tier:c')
    await done
    expect(order.slice(0, 4)).toEqual([
      'hold c{focus_tier=focus,pin_order=0} a{pin_order=1} b{pin_order=2}',
      'land reorder:cab',
      'land tier:c',
      'settle c{focus_tier=focus,pin_order=0} a{pin_order=1} b{pin_order=2}',
    ])
    expect(order[4]).toBe('patch c{pinned=true,pin_order=0,focus_tier=focus} a{pinned=true,pin_order=1,focus_tier=focus} b{pinned=true,pin_order=2,focus_tier=focus}')
    expect(order).toHaveLength(5)
    expectEachHeldSettledOnce()
  })

  it('pin failure: settles before the rollback, then pulls', async () => {
    const bar = useFocusBar()
    const done = bar.pin('d')
    await fail('pin:d')
    await done
    await flush()
    expect(order.slice(0, 5)).toEqual([
      'hold d{pinned=true,pin_order=3,focus_tier=undefined}',
      'fail pin:d',
      'settle d{pinned=true,pin_order=3,focus_tier=undefined}',
      'patch d{pinned=false,focus_tier=undefined,pin_order=undefined}',
      'pull',
    ])
    expect(row('d').pinned).toBe(false)
    expectEachHeldSettledOnce()
  })

  it('pin success: settles, then takes the server order (pinned ids only, no tier touched)', async () => {
    const bar = useFocusBar()
    const done = bar.pin('d')
    await land('pin:d')
    await done
    expect(order[2]).toBe('settle d{pinned=true,pin_order=3,focus_tier=undefined}')
    expect(order[3]).toBe('patch a{pinned=true,pin_order=0} b{pinned=true,pin_order=1} c{pinned=true,pin_order=2} d{pinned=true,pin_order=3}')
    expect(api.fetchPinnedTasks).not.toHaveBeenCalled()
  })

  it('unpin failure: settles, then pulls', async () => {
    const bar = useFocusBar()
    const done = bar.unpin('c')
    await fail('unpin:c')
    await done
    await flush()
    expect(order.slice(0, 4)).toEqual([
      'hold c{pinned=false,focus_tier=undefined,pin_order=undefined}',
      'fail unpin:c',
      'settle c{pinned=false,focus_tier=undefined,pin_order=undefined}',
      'pull',
    ])
    expect(row('c').pinned).toBe(true)
    expectEachHeldSettledOnce()
  })

  it('setTierBulk: settles, then its answer puts a refused row back', async () => {
    rows.push({ id: 'x', title: 'X', status: 'todo', phase: 'TODO', pinned: true, pin_order: 3, focus_tier: 'focus' })
    server.set('x', { pinned: true, pin_order: 3, focus_tier: 'focus' })
    const onError = vi.fn()
    const bar = useFocusBar()
    const done = bar.setTierBulk(['c', 'x'], 'wait', onError)
    expect(row('x').focus_tier).toBe('wait')
    await land('bulk:cx')
    await done
    expect(order.indexOf('settle c{focus_tier=wait} x{focus_tier=wait}')).toBeLessThan(order.findIndex((l) => l.startsWith('patch ')))
    expect(row('c').focus_tier).toBe('wait')
    expect(row('x').focus_tier).toBe('focus')
    expect(onError).toHaveBeenCalledTimes(1)
    expectEachHeldSettledOnce()
  })

  it('setTierBulk failure: settles before the rollback, then pulls', async () => {
    const onError = vi.fn()
    const bar = useFocusBar()
    const done = bar.setTierBulk(['c', 'd'], 'wait', onError)
    await fail('bulk:cd')
    await done
    await flush()
    expect(order.slice(0, 5)).toEqual([
      'hold c{focus_tier=wait} d{pinned=true,pin_order=3,focus_tier=wait}',
      'fail bulk:cd',
      'settle c{focus_tier=wait} d{pinned=true,pin_order=3,focus_tier=wait}',
      'patch c{focus_tier=undefined} d{pinned=undefined,pin_order=undefined,focus_tier=undefined}',
      'pull',
    ])
    expect(onError).toHaveBeenCalledTimes(1)
    expectEachHeldSettledOnce()
  })
})

describe('overlapping writes: one answer, once all are in', () => {
  it('a collapsed folder dropped in another tier: the reorder lands first with the old tiers, the members still end in the new tier', async () => {
    const bar = useFocusBar()
    // TodoPanel's whole-folder drop: one setTier per member, then the reorder, same tick.
    const writes = [bar.setTier('a', 'wait'), bar.setTier('b', 'wait'), bar.reorder(['c', 'a', 'b'])]
    const read = listRead() // another writer's list refetch, read before anything landed
    await land('reorder:cab') // the reorder route locks first: its snapshot has a, b in Focus
    expect(appliedSnapshots(), 'an answer was applied while other writes were out').toEqual([])
    expect(row('a').focus_tier).toBe('wait')
    await land('tier:a')
    echo('a')
    await land('tier:b')
    echo('b')
    read()
    await Promise.all(writes)
    await flush()
    // Every held patch settled, then exactly one pull, sent after all three landed.
    expect(api.fetchPinnedTasks).toHaveBeenCalledTimes(1)
    expect(order.indexOf('pull')).toBeGreaterThan(order.indexOf('land tier:b'))
    expect(row('a').focus_tier).toBe('wait')
    expect(row('b').focus_tier).toBe('wait')
    expect(drawnOrder()).toEqual(['c', 'a', 'b'])
    // A later list read and a late echo agree: nothing held is left to pull them back.
    listRead()()
    echo('a')
    expect(row('a').focus_tier).toBe('wait')
    expect(row('b').focus_tier).toBe('wait')
    expectEachHeldSettledOnce()
  })

  it('the same drop with the tier writes answering first ends right too', async () => {
    const bar = useFocusBar()
    const writes = [bar.setTier('a', 'wait'), bar.setTier('b', 'wait'), bar.reorder(['c', 'a', 'b'])]
    await land('tier:b')
    await land('tier:a')
    await land('reorder:cab')
    await Promise.all(writes)
    await flush()
    expect(api.fetchPinnedTasks).toHaveBeenCalledTimes(1)
    expect([row('a').focus_tier, row('b').focus_tier]).toEqual(['wait', 'wait'])
    expect(drawnOrder()).toEqual(['c', 'a', 'b'])
  })

  it('two quick drags whose later one lands first: no answer of either is applied, the pull draws what the server kept', async () => {
    const bar = useFocusBar()
    const one = bar.reorder(['b', 'a', 'c'])
    const two = bar.reorder(['c', 'b', 'a'])
    await land('reorder:cba')
    await land('reorder:bac') // applied last by the server, so it is the server's order
    await Promise.all([one, two])
    await flush()
    expect(appliedSnapshots().length).toBe(1) // the pull's
    expect(api.fetchPinnedTasks).toHaveBeenCalledTimes(1)
    expect(drawnOrder()).toEqual(snapshot().pinned_tasks)
    expectEachHeldSettledOnce()
  })

  it('a tier write that reaches the server before its pin is refused (400 not pinned); the pull shows the server word', async () => {
    const bar = useFocusBar()
    const pinned = bar.pin('d')
    const moved = bar.setTier('d', 'focus')
    await land('tier:d')
    await land('pin:d')
    await Promise.all([pinned, moved])
    await flush()
    expect(showOperationError).toHaveBeenCalledTimes(1)
    expect(api.fetchPinnedTasks).toHaveBeenCalledTimes(1)
    expect(row('d')).toMatchObject({ pinned: true, focus_tier: undefined })
  })

  it('pin, then setTier 100ms later while the pin is out: the tier sticks', async () => {
    const bar = useFocusBar()
    const pinned = bar.pin('d')
    const moved = bar.setTier('d', 'focus')
    await land('pin:d')
    await land('tier:d')
    await Promise.all([pinned, moved])
    await flush()
    expect(row('d')).toMatchObject({ pinned: true, focus_tier: 'focus' })
    expect(api.fetchPinnedTasks).toHaveBeenCalledTimes(1)
  })

  it('a failure among overlapping writes is resolved by the one pull', async () => {
    const bar = useFocusBar()
    const writes = [bar.setTier('a', 'wait'), bar.reorder(['c', 'a', 'b'])]
    await fail('tier:a')
    await land('reorder:cab')
    await Promise.all(writes)
    await flush()
    expect(api.fetchPinnedTasks).toHaveBeenCalledTimes(1)
    expect(row('a').focus_tier).toBe('focus')
    expect(drawnOrder()).toEqual(['c', 'a', 'b'])
  })

  it('an overlapped setTierBulk answer is not applied; the pull puts the refused row back', async () => {
    rows.push({ id: 'x', title: 'X', status: 'todo', phase: 'TODO', pinned: true, pin_order: 3, focus_tier: 'focus' })
    server.set('x', { pinned: true, pin_order: 3, focus_tier: 'focus' })
    const bar = useFocusBar()
    const writes = [bar.setTierBulk(['c', 'x'], 'wait', () => {}), bar.reorder(['x', 'c', 'a', 'b'])]
    await land('bulk:cx')
    expect(row('x').focus_tier).toBe('wait')
    await land('reorder:xcab')
    await Promise.all(writes)
    await flush()
    expect(row('x').focus_tier).toBe('focus')
    expect(row('c').focus_tier).toBe('wait')
  })

  it('a write that starts while the pull is out makes the pull answer stale: the next quiet moment pulls again', async () => {
    const bar = useFocusBar()
    let release!: () => void
    api.fetchPinnedTasks.mockImplementationOnce(() => new Promise((resolve) => {
      order.push('pull')
      const at = snapshot()
      release = () => resolve(at)
    }))
    const writes = [bar.setTier('a', 'wait'), bar.reorder(['c', 'a', 'b'])]
    await land('reorder:cab')
    await land('tier:a')
    await Promise.all(writes)
    await flush()
    // The first pull is out; a new drag starts and lands before it answers.
    const third = bar.reorder(['b', 'c', 'a'])
    release()
    await flush()
    expect(drawnOrder()).toEqual(['b', 'c', 'a'])
    await land('reorder:bca')
    await third
    await flush()
    expect(api.fetchPinnedTasks).toHaveBeenCalledTimes(2)
    expect(drawnOrder()).toEqual(['b', 'c', 'a'])
    expect(row('a').focus_tier).toBe('wait')
  })
})

describe('the write count always comes back to zero', () => {
  it('a caller callback that throws (setTierBulk onError) still ends the write: the next write takes its own answer', async () => {
    rows.push({ id: 'x', title: 'X', status: 'todo', phase: 'TODO', pinned: true, pin_order: 3, focus_tier: 'focus' })
    server.set('x', { pinned: true, pin_order: 3, focus_tier: 'focus' })
    const bar = useFocusBar()
    const bulk = expect(bar.setTierBulk(['c', 'x'], 'wait', () => { throw new Error('caller callback broke') })).rejects.toThrow('caller callback broke')
    await land('bulk:cx')
    await bulk
    // Its own answer still went in (it ran alone).
    expect(row('x').focus_tier).toBe('focus')
    order.length = 0
    const drag = bar.reorder(['c', 'a', 'b', 'x'])
    await land('reorder:cabx')
    await drag
    expect(order[order.length - 1]).toMatch(/^patch c\{pinned=true,pin_order=0/)
    expect(api.fetchPinnedTasks).not.toHaveBeenCalled()
  })

  it('an error report that throws on a failed write still ends it: the pull runs, then a later write takes its own answer', async () => {
    showOperationError.mockImplementationOnce(() => { throw new Error('toast broke') })
    const bar = useFocusBar()
    const drag = expect(bar.reorder(['c', 'a', 'b'])).rejects.toThrow('toast broke')
    await fail('reorder:cab')
    await drag
    await flush()
    expect(api.fetchPinnedTasks).toHaveBeenCalledTimes(1)
    expect(drawnOrder()).toEqual(['a', 'b', 'c'])
    const next = bar.reorder(['b', 'a', 'c'])
    await land('reorder:bac')
    await next
    expect(api.fetchPinnedTasks).toHaveBeenCalledTimes(1)
    expect(drawnOrder()).toEqual(['b', 'a', 'c'])
  })

  it('a pull that fails ends quietly: no second pull, and the next write takes its own answer', async () => {
    api.fetchPinnedTasks.mockImplementationOnce(async () => { order.push('pull'); throw new Error('offline') })
    const bar = useFocusBar()
    const drag = bar.reorder(['c', 'a', 'b'])
    await fail('reorder:cab')
    await drag
    await flush()
    expect(api.fetchPinnedTasks).toHaveBeenCalledTimes(1)
    const next = bar.reorder(['b', 'a', 'c'])
    await land('reorder:bac')
    await next
    await flush()
    expect(api.fetchPinnedTasks).toHaveBeenCalledTimes(1)
    expect(drawnOrder()).toEqual(['b', 'a', 'c'])
  })
})

describe('another client changes the board while our write is out', () => {
  it('config:changed during our write only marks the overlap; the pull after it carries that change', async () => {
    const realNow = Date.now
    let offset = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
    try {
      const bar = useFocusBar()
      const drag = bar.reorder(['c', 'a', 'b'])
      // Past the self-change cooldown, another client moves b to Parked.
      offset = 5_000
      server.get('b')!.focus_tier = 'wait'
      socketHandlers.get('config:changed')!({ key: 'focus_bar' })
      expect(api.fetchPinnedTasks).not.toHaveBeenCalled()
      await land('reorder:cab')
      await drag
      await flush()
      // The reorder ran alone but overlapped the other client's change: one pull.
      expect(api.fetchPinnedTasks).toHaveBeenCalledTimes(1)
      expect(row('b').focus_tier).toBe('wait')
      expect(drawnOrder()).toEqual(['c', 'a', 'b'])
    } finally {
      nowSpy.mockRestore()
    }
  })
})

describe('quick-add pins', () => {
  it('are not held: their write (the create) has its own answer', () => {
    const bar = useFocusBar()
    bar.addLocalPin('tmp-1', 'focus')
    bar.replaceLocalPinId('tmp-1', 'd')
    bar.removeLocalPin('d')
    expect(heldCalls()).toHaveLength(0)
  })

  it('a quick-add counts as a write in flight: a snapshot read before its create never unpins the real row', async () => {
    rows.push({ id: 'tmp-1', title: 'New', status: 'todo', phase: 'TODO' })
    const bar = useFocusBar()
    const drag = bar.reorder(['b', 'a', 'c'])
    bar.addLocalPin('tmp-1', 'focus')
    await land('reorder:bac') // its snapshot knows nothing of the new task
    await drag
    expect(appliedSnapshots()).toEqual([])
    // The create lands with the pin, then reconciles the temp row to its real id.
    server.set('d', { pinned: true, pin_order: 3, focus_tier: 'focus' })
    rows[rows.findIndex((t) => t.id === 'tmp-1')] = { id: 'd2', title: 'New', status: 'todo', phase: 'TODO' }
    server.set('d2', server.get('d')!)
    server.delete('d')
    bar.replaceLocalPinId('tmp-1', 'd2')
    await flush()
    expect(api.fetchPinnedTasks).toHaveBeenCalledTimes(1)
    expect(row('d2')).toMatchObject({ pinned: true, focus_tier: 'focus' })
  })

  it('the same when the stale answer arrives only after the create reconciled to the real id', async () => {
    rows.push({ id: 'tmp-1', title: 'New', status: 'todo', phase: 'TODO' })
    let deliver!: () => void
    // The server applies the reorder before the create; its answer reaches the page late.
    api.reorderPinnedTasks.mockImplementationOnce((ids: string[]) => new Promise((resolve) => {
      reorderOnServer(ids)
      const at = snapshot()
      deliver = () => resolve(at)
    }))
    const bar = useFocusBar()
    const drag = bar.reorder(['b', 'a', 'c'])
    bar.addLocalPin('tmp-1', 'focus')
    server.set('d2', { pinned: true, pin_order: 3, focus_tier: 'focus' })
    rows[rows.findIndex((t) => t.id === 'tmp-1')] = { id: 'd2', title: 'New', status: 'todo', phase: 'TODO' }
    bar.replaceLocalPinId('tmp-1', 'd2')
    deliver()
    await drag
    await flush()
    expect(row('d2')).toMatchObject({ pinned: true, focus_tier: 'focus' })
    expect(api.fetchPinnedTasks).toHaveBeenCalledTimes(1)
  })
})
