/**
 * useShowPriority / setShowPriority: the module store behind `ui.show_priority`.
 *
 * The flag decides whether ANY surface draws task priority, so hundreds of rows
 * read it at once and the Settings toggle has to flip all of them in the same
 * tick. That makes three things worth pinning here, none of which a browser spec
 * can see:
 *
 *   . the default is HIDDEN, and a config that simply has no `show_priority` key
 *     (every existing install) counts as hidden — not "unknown, draw it anyway".
 *   . ONE fetch for the whole app: a second mounted instance reads the module
 *     cache, and instances mounted before the first fetch settles share it.
 *   . `setShowPriority` echoes to every mounted instance BEFORE the write goes
 *     out, and the write MERGES into the existing `ui` block (updateConfig
 *     replaces the whole key, so a naive `{ ui: { show_priority } }` would drop
 *     the user's sibling ui settings).
 *
 * HOW it runs without a DOM (the root vitest is `environment: 'node'`): React is
 * mocked with stand-ins for the two hooks this module uses, the same trick as
 * use-project-actions.test.ts — and, as there, the PATH matters: web/src code
 * resolves 'react' inside web/node_modules, so a mock keyed on the repo root's
 * copy silently misses. `useEffect` runs its body immediately, which is what makes
 * a "mounted" instance really subscribe to the store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

let lastSetter: ReturnType<typeof vi.fn> | null = null
let lastCleanup: (() => void) | undefined

vi.mock('../../web/node_modules/react', () => ({
  useState: <T,>(initial: T) => {
    const set = vi.fn()
    lastSetter = set
    return [initial, set] as const
  },
  useEffect: (fn: () => void | (() => void)) => { lastCleanup = fn() ?? undefined },
}))

const fetchConfig = vi.fn<() => Promise<Record<string, unknown>>>()
const updateConfig = vi.fn<(patch: Record<string, unknown>) => Promise<unknown>>()
vi.mock('@/api/config', () => ({ fetchConfig, updateConfig }))

/**
 * The WS subscription is bound ONCE per module lifetime (`wsBound`), and
 * `_resetShowPriorityForTests` deliberately does not undo that — so the handler is
 * captured into a plain variable here rather than read back off a vi.fn's call
 * log, which `clearAllMocks` would wipe between tests.
 */
let onConfigChanged: ((data: unknown) => void) | null = null
vi.mock('@/api/ws', () => ({
  wsClient: {
    onEvent: (event: string, handler: (data: unknown) => void) => {
      if (event === 'config:changed') onConfigChanged = handler
      return () => {}
    },
  },
}))

const { useShowPriority, setShowPriority, _resetShowPriorityForTests } =
  await import('@/hooks/useShowPriority')

/** One mounted reader: the value it renders, its setState spy, its unmount. */
function mount() {
  const value = useShowPriority()
  const set = lastSetter!
  const cleanup = lastCleanup
  return { value, set, unmount: () => cleanup?.() }
}

/** Let every pending microtask (the config fetch chain) settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.clearAllMocks()
  _resetShowPriorityForTests()
  fetchConfig.mockResolvedValue({})
  updateConfig.mockResolvedValue({})
})

describe('useShowPriority', () => {
  it('stays hidden for a config with no show_priority key', async () => {
    const row = mount()
    // Hidden on the very first paint too: a row must never flash a badge that
    // the config then takes away.
    expect(row.value).toBe(false)

    await flush()

    expect(fetchConfig).toHaveBeenCalledTimes(1)
    expect(row.set).toHaveBeenLastCalledWith(false)
    row.unmount()
  })

  it('stays hidden when the ui block exists without the key', async () => {
    fetchConfig.mockResolvedValue({ ui: { session_panels: 3 } })
    const row = mount()
    await flush()
    expect(row.set).toHaveBeenLastCalledWith(false)
    expect(mount().value).toBe(false)
    row.unmount()
  })

  it('shows priority once the config says so, and every later mount starts there', async () => {
    fetchConfig.mockResolvedValue({ ui: { show_priority: true } })
    const first = mount()
    await flush()

    expect(first.set).toHaveBeenLastCalledWith(true)
    // A row mounted after the fetch reads the cache — no flash of hidden, and no
    // second request.
    const second = mount()
    expect(second.value).toBe(true)
    expect(fetchConfig).toHaveBeenCalledTimes(1)
    first.unmount()
    second.unmount()
  })

  it('fetches once for many instances mounted before the first fetch settles', async () => {
    fetchConfig.mockResolvedValue({ ui: { show_priority: true } })
    const rows = [mount(), mount(), mount()]
    await flush()

    expect(fetchConfig).toHaveBeenCalledTimes(1)
    for (const row of rows) expect(row.set).toHaveBeenLastCalledWith(true)
    for (const row of rows) row.unmount()
  })

  it('keeps the flag hidden when the config request fails', async () => {
    fetchConfig.mockRejectedValue(new Error('502 Bad Gateway'))
    const row = mount()
    await flush()
    expect(row.value).toBe(false)
    expect(row.set).not.toHaveBeenCalled()
    row.unmount()
  })

  it('an unmounted instance stops hearing changes', async () => {
    const row = mount()
    await flush()
    row.unmount()
    row.set.mockClear()

    setShowPriority(true)

    expect(row.set).not.toHaveBeenCalled()
  })
})

describe('setShowPriority', () => {
  it('echoes to every mounted instance before the write goes out', async () => {
    fetchConfig.mockResolvedValue({ ui: { session_panels: 3 } })
    const a = mount()
    const b = mount()
    await flush()
    a.set.mockClear()
    b.set.mockClear()

    setShowPriority(true)

    // SYNCHRONOUS: the Settings toggle flips the whole page in the same tick, so
    // the echo cannot wait on the round-trip.
    expect(a.set).toHaveBeenCalledWith(true)
    expect(b.set).toHaveBeenCalledWith(true)
    expect(updateConfig).not.toHaveBeenCalled()

    await flush()

    // MERGED: sibling ui keys survive, because updateConfig replaces the whole
    // `ui` object rather than patching one sub-key.
    expect(updateConfig).toHaveBeenCalledWith({ ui: { session_panels: 3, show_priority: true } })
    a.unmount()
    b.unmount()
  })

  it('writes false back the same way', async () => {
    fetchConfig.mockResolvedValue({ ui: { show_priority: true } })
    const row = mount()
    await flush()
    row.set.mockClear()

    setShowPriority(false)

    expect(row.set).toHaveBeenCalledWith(false)
    await flush()
    expect(updateConfig).toHaveBeenCalledWith({ ui: { show_priority: false } })
    row.unmount()
  })

  it('a rejected write does not throw at the caller', async () => {
    updateConfig.mockRejectedValue(new Error('disk full'))
    const row = mount()
    await flush()

    expect(() => setShowPriority(true)).not.toThrow()
    await flush()
    row.unmount()
  })
})

describe('config:changed', () => {
  it('adopts a value another window wrote', async () => {
    const row = mount()
    await flush()
    expect(onConfigChanged).toBeTypeOf('function')
    row.set.mockClear()

    fetchConfig.mockResolvedValue({ ui: { show_priority: true } })
    onConfigChanged!({ key: 'ui' })
    await flush()

    expect(row.set).toHaveBeenLastCalledWith(true)
    row.unmount()
  })

  it('ignores a change to an unrelated config key', async () => {
    const row = mount()
    await flush()
    fetchConfig.mockClear()

    onConfigChanged!({ key: 'agent' })
    await flush()

    expect(fetchConfig).not.toHaveBeenCalled()
    row.unmount()
  })

  it('ignores the echo of our OWN write', async () => {
    const row = mount()
    await flush()
    setShowPriority(true)
    await flush()
    row.set.mockClear()

    // The server's own `config:changed` arrives a beat later. Re-reading here is
    // the race: a snapshot taken before the write landed would flip the whole UI
    // back off under the user.
    fetchConfig.mockResolvedValue({})
    onConfigChanged!({ key: 'ui' })
    await flush()

    expect(row.set).not.toHaveBeenCalled()
    row.unmount()
  })
})
