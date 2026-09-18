/**
 * useQuickParseEnabled / setQuickParseEnabled: the module store behind
 * `agent.quick_parse`, which the draft composer's "+" menu toggles.
 *
 * Five things here are worth pinning, and none of them is visible to a browser spec:
 *
 *   . the default is OFF, and a config with no `quick_parse` key (every existing
 *     install) counts as off — not "unknown, ask the model anyway". This flag gates
 *     a per-sentence request that costs ten seconds on a CLI provider, so "not
 *     loaded yet" has to read as off.
 *   . MOUNTING reads nothing. The hook only subscribes; `ensureQuickParseLoaded()`
 *     is the one thing that fetches. This flag's first reader is the draft column,
 *     which appears on a click, and that path must stay network-free — it is the
 *     path the parse burst starved in the first place. A mount-time fetch here
 *     would put one `/api/config` back on it, which no unit test would notice and
 *     tests/e2e/browser/draft-quick-parse-off.spec.ts scenario 4 would fail on.
 *   . the write MERGES into the existing `agent` block. updateConfig replaces the
 *     whole top-level key, so a naive `{ agent: { quick_parse } }` would delete
 *     main_model, language and available_models. That is silent data loss from a
 *     one-click menu row, which makes it the most important case in this file.
 *   . the echo is synchronous, so the row lights up under the cursor rather than
 *     after a round trip.
 *   . a FAILED write reverts the echo. A lit toggle whose config still says off is
 *     worse than one that visibly refuses: the next reload undoes it silently.
 *
 * HOW it runs without a DOM (the root vitest is `environment: 'node'`): React is
 * mocked with stand-ins for the two hooks this module uses, and the PATH matters —
 * web/src code resolves 'react' inside web/node_modules, so a mock keyed on the
 * repo root's copy silently misses. Same trick as use-show-priority.test.ts.
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

/** Bound once per module lifetime; the reset seam deliberately does not unbind it,
 *  so capture the handler in a variable rather than off a mock's call log. */
let onConfigChanged: ((data: unknown) => void) | null = null
vi.mock('@/api/ws', () => ({
  wsClient: {
    onEvent: (event: string, handler: (data: unknown) => void) => {
      if (event === 'config:changed') onConfigChanged = handler
      return () => {}
    },
  },
}))

const {
  useQuickParseEnabled, setQuickParseEnabled, ensureQuickParseLoaded, _resetQuickParseForTests,
} = await import('@/hooks/useQuickParse')

/** One mounted composer: the value it renders, its setState spy, its unmount. */
function mount() {
  const value = useQuickParseEnabled()
  const set = lastSetter!
  const cleanup = lastCleanup
  return { value, set, unmount: () => cleanup?.() }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A realistic agent block: the keys a careless write would destroy. */
const AGENT = {
  provider: 'claude-code',
  language: 'zh',
  main_model: 'global.anthropic.claude-opus-5',
  available_models: ['global.anthropic.claude-opus-5', 'global.anthropic.claude-sonnet-4-6'],
  session_effort: 'high',
}

beforeEach(() => {
  vi.clearAllMocks()
  _resetQuickParseForTests()
  fetchConfig.mockResolvedValue({})
  updateConfig.mockResolvedValue({})
})

describe('useQuickParseEnabled', () => {
  it('MOUNTING a composer reads nothing — the draft-open path stays network-free', async () => {
    // The guard for the whole reason this feature was turned off. A draft column is
    // this flag's first reader and it appears on a click, so a fetch on mount would
    // put a request back on the exact path the parse burst starved.
    const composer = mount()
    await flush()

    expect(fetchConfig, 'the hook only subscribes').not.toHaveBeenCalled()
    // Off on the very first paint too: the failure mode of guessing wrong here is
    // a burst of ten-second requests, so it must never be optimistic.
    expect(composer.value).toBe(false)
    composer.unmount()
  })

  it('is OFF for a config with no quick_parse key', async () => {
    const composer = mount()
    await ensureQuickParseLoaded()
    await flush()

    expect(fetchConfig).toHaveBeenCalledTimes(1)
    expect(composer.set).toHaveBeenLastCalledWith(false)
    composer.unmount()
  })

  it('is OFF when the agent block exists without the key', async () => {
    fetchConfig.mockResolvedValue({ agent: AGENT })
    const composer = mount()
    await ensureQuickParseLoaded()
    expect(composer.set).toHaveBeenLastCalledWith(false)
    composer.unmount()
  })

  it('treats an explicit false, and any non-true value, as off', async () => {
    for (const value of [false, 'true', 1, null]) {
      _resetQuickParseForTests()
      vi.clearAllMocks()
      fetchConfig.mockResolvedValue({ agent: { quick_parse: value } })
      const composer = mount()
      await ensureQuickParseLoaded()
      expect(composer.set, `quick_parse: ${JSON.stringify(value)}`).toHaveBeenLastCalledWith(false)
      composer.unmount()
    }
  })

  it('turns on once the config says so, and a later mount starts there', async () => {
    fetchConfig.mockResolvedValue({ agent: { ...AGENT, quick_parse: true } })
    const first = mount()
    await ensureQuickParseLoaded()
    expect(first.set).toHaveBeenLastCalledWith(true)

    // A second composer reads the cache: no flash of off, no second request.
    const second = mount()
    expect(second.value).toBe(true)
    await ensureQuickParseLoaded()
    expect(fetchConfig, 'already known — ensure must not re-ask').toHaveBeenCalledTimes(1)
    first.unmount()
    second.unmount()
  })

  it('fetches once for several composers asking before the fetch settles', async () => {
    fetchConfig.mockResolvedValue({ agent: { quick_parse: true } })
    const composers = [mount(), mount(), mount()]
    // Three composers with text in them, same tick: one request between them.
    await Promise.all(composers.map(() => ensureQuickParseLoaded()))

    expect(fetchConfig).toHaveBeenCalledTimes(1)
    for (const c of composers) expect(c.set).toHaveBeenLastCalledWith(true)
    for (const c of composers) c.unmount()
  })

  it('a FAILED read settles as off and is not retried on the next keystroke', async () => {
    // `ensureQuickParseLoaded()` is called from a per-keystroke effect, so an
    // unresolved answer would mean one `/api/config` per character typed for as long
    // as the server is unhappy — a retry loop hanging off typing, which is the shape
    // this flag exists to remove. A read that failed is not permission either way.
    fetchConfig.mockRejectedValue(new Error('502 Bad Gateway'))
    const composer = mount()
    await ensureQuickParseLoaded()
    expect(composer.set).toHaveBeenLastCalledWith(false)

    fetchConfig.mockResolvedValue({ agent: { quick_parse: true } })
    for (let keystroke = 0; keystroke < 5; keystroke++) await ensureQuickParseLoaded()
    expect(fetchConfig, 'one attempt, however much more is typed').toHaveBeenCalledTimes(1)

    // Not permanently deaf: the server saying something re-reads.
    onConfigChanged!({ key: 'agent' })
    await flush()
    expect(composer.set).toHaveBeenLastCalledWith(true)
    composer.unmount()
  })
})

describe('setQuickParseEnabled', () => {
  it('KEEPS every sibling agent key — updateConfig replaces the whole block', async () => {
    // The case that makes this a data-loss bug rather than a cosmetic one: one
    // click on a menu row must not delete the user's model, language and catalog.
    fetchConfig.mockResolvedValue({ agent: AGENT })
    const composer = mount()
    await flush()

    setQuickParseEnabled(true)
    await flush()

    expect(updateConfig).toHaveBeenCalledWith({ agent: { ...AGENT, quick_parse: true } })
    const written = updateConfig.mock.calls[0][0] as { agent: Record<string, unknown> }
    expect(Object.keys(written.agent).sort()).toEqual([...Object.keys(AGENT), 'quick_parse'].sort())
    composer.unmount()
  })

  it('echoes to every mounted composer BEFORE the write goes out', async () => {
    fetchConfig.mockResolvedValue({ agent: AGENT })
    const a = mount()
    const b = mount()
    await flush()
    a.set.mockClear()
    b.set.mockClear()

    setQuickParseEnabled(true)

    // Synchronous: the row lights up under the cursor, not after a round trip.
    expect(a.set).toHaveBeenCalledWith(true)
    expect(b.set).toHaveBeenCalledWith(true)
    expect(updateConfig).not.toHaveBeenCalled()

    await flush()
    expect(updateConfig).toHaveBeenCalledTimes(1)
    a.unmount()
    b.unmount()
  })

  it('writes false back the same way', async () => {
    fetchConfig.mockResolvedValue({ agent: { ...AGENT, quick_parse: true } })
    const composer = mount()
    await flush()
    composer.set.mockClear()

    setQuickParseEnabled(false)

    expect(composer.set).toHaveBeenCalledWith(false)
    await flush()
    expect(updateConfig).toHaveBeenCalledWith({ agent: { ...AGENT, quick_parse: false } })
    composer.unmount()
  })

  it('REVERTS the echo when the write fails, so the row never lies', async () => {
    fetchConfig.mockResolvedValue({ agent: AGENT })
    updateConfig.mockRejectedValue(new Error('disk full'))
    const composer = mount()
    await ensureQuickParseLoaded()
    composer.set.mockClear()

    setQuickParseEnabled(true)
    expect(composer.set).toHaveBeenLastCalledWith(true)   // optimistic

    await flush()

    // Back to off: the config still says off, and a lit row would be undone by the
    // next reload with no explanation.
    expect(composer.set).toHaveBeenLastCalledWith(false)
    composer.unmount()
  })

  it('reverts to the PREVIOUS value, not to a hardcoded off', async () => {
    fetchConfig.mockResolvedValue({ agent: { ...AGENT, quick_parse: true } })
    updateConfig.mockRejectedValue(new Error('disk full'))
    const composer = mount()
    // Loaded, because that is the only way a user sees a lit switch to click: the
    // menu that draws it asks for the value as it opens.
    await ensureQuickParseLoaded()
    composer.set.mockClear()

    setQuickParseEnabled(false)
    await flush()

    expect(composer.set).toHaveBeenLastCalledWith(true)
    composer.unmount()
  })

  it('does not throw at the caller when the write rejects', async () => {
    updateConfig.mockRejectedValue(new Error('disk full'))
    const composer = mount()
    await flush()
    expect(() => setQuickParseEnabled(true)).not.toThrow()
    await flush()
    composer.unmount()
  })

  it('a read that was ALREADY IN FLIGHT when the user clicked does not undo the click', async () => {
    // The WebKit failure this test was written from. The "+" menu asks for the value
    // as it opens; automation (and a quick human) clicks before that GET comes back,
    // and the stale `false` landed a beat later and snapped the switch off again.
    let settle: (c: Record<string, unknown>) => void = () => {}
    fetchConfig.mockReturnValueOnce(new Promise((resolve) => { settle = resolve }))
    const composer = mount()
    void ensureQuickParseLoaded()        // the menu opening

    setQuickParseEnabled(true)           // the click, while that read is in flight
    expect(composer.set).toHaveBeenLastCalledWith(true)

    settle({ agent: { quick_parse: false } })   // …and the pre-click answer arrives
    await flush()

    expect(composer.set, 'the stale read must not overwrite the click')
      .toHaveBeenLastCalledWith(true)
    composer.unmount()
  })

  it('a failed write does not undo a SECOND click that already replaced it', async () => {
    // Same rule for the revert path: two clicks, the first write fails last. Undoing
    // to the first call's `previous` would silently discard the value the user is
    // looking at.
    fetchConfig.mockResolvedValue({ agent: AGENT })
    let failFirst: (e: Error) => void = () => {}
    updateConfig.mockReturnValueOnce(new Promise((_, reject) => { failFirst = reject }))
    const composer = mount()
    await ensureQuickParseLoaded()

    setQuickParseEnabled(true)
    await flush()
    setQuickParseEnabled(false)
    composer.set.mockClear()

    failFirst(new Error('disk full'))
    await flush()

    expect(composer.set, 'the superseded write must stay quiet').not.toHaveBeenCalled()
    composer.unmount()
  })

  it('an unmounted composer stops hearing changes', async () => {
    const composer = mount()
    await flush()
    composer.unmount()
    composer.set.mockClear()

    setQuickParseEnabled(true)

    expect(composer.set).not.toHaveBeenCalled()
  })
})

describe('config:changed', () => {
  it('adopts a value another window wrote', async () => {
    const composer = mount()
    await flush()
    expect(onConfigChanged).toBeTypeOf('function')
    composer.set.mockClear()

    fetchConfig.mockResolvedValue({ agent: { quick_parse: true } })
    onConfigChanged!({ key: 'agent' })
    await flush()

    expect(composer.set).toHaveBeenLastCalledWith(true)
    composer.unmount()
  })

  it('ignores a change to an unrelated config key', async () => {
    const composer = mount()
    await flush()
    fetchConfig.mockClear()

    onConfigChanged!({ key: 'ui' })
    await flush()

    expect(fetchConfig).not.toHaveBeenCalled()
    composer.unmount()
  })

  it('ignores the echo of our OWN write', async () => {
    fetchConfig.mockResolvedValue({ agent: AGENT })
    const composer = mount()
    await flush()
    setQuickParseEnabled(true)
    await flush()
    composer.set.mockClear()

    // The server's own config:changed arrives a beat later. Re-reading a snapshot
    // taken before the write landed would flip the toggle back off under the user.
    fetchConfig.mockResolvedValue({ agent: AGENT })
    onConfigChanged!({ key: 'agent' })
    await flush()

    expect(composer.set).not.toHaveBeenCalled()
    composer.unmount()
  })
})
