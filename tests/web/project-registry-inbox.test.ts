/**
 * The Inbox in the project registry store (web/src/hooks/useProjectRegistry.ts).
 *
 * The Inbox is a project named "Inbox" with settings of its own (src/core/inbox-project.ts).
 * GET /api/projects keeps it out of `projects[]` (every client already draws it as its one
 * fixed entry) and sends it in the `inbox` slot. The store must:
 *  - never list it (no second "Inbox" row in a picker or the rail), even from a server that
 *    put it in `projects[]` too;
 *  - still answer its row, so its detail pane and its launch defaults read its settings,
 *    whether a caller names it `Inbox` or the older '';
 *  - take a settings patch on it like on any project.
 *
 * Hook-without-a-DOM technique of project-registry-recovery.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../web/node_modules/react', () => ({
  useSyncExternalStore: <T,>(subscribe: (cb: () => void) => () => void, getSnapshot: () => T): T => {
    subscribe(() => {})
    return getSnapshot()
  },
  useMemo: <T,>(fn: () => T) => fn(),
  useCallback: <T,>(fn: T) => fn,
}))

vi.mock('@/api/ws', () => ({ wsClient: { onEvent() {}, offEvent() {} } }))
vi.mock('@/utils/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const projectsApi = vi.hoisted(() => ({ fetchProjects: vi.fn<() => Promise<unknown>>() }))
vi.mock('@/api/projects', () => projectsApi)

const registry = await import('@/hooks/useProjectRegistry')
const { useProjectRegistry, useProjectEntry, useProjectLaunchDefaults, projectLaunchDefaultsNow, patchProjectLocal, resetProjectRegistryForTests, resolveProjectNameList } = registry

const counts = { todo: 1, active: 0, done: 0 }
const row = (name: string, metadata: Record<string, unknown> = {}) => ({ name, source: 'local', favorite: false, counts, metadata })

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  resetProjectRegistryForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

async function load(answer: unknown): Promise<void> {
  projectsApi.fetchProjects.mockResolvedValue(answer)
  useProjectRegistry()
  await vi.advanceTimersByTimeAsync(0)
}

describe('the Inbox in the project registry', () => {
  it('is never listed, and reads its settings from the inbox slot', async () => {
    await load({
      projects: [row('Marina', { default_cwd: '/work/marina' })],
      inbox: { counts, name: 'Inbox', metadata: { default_cwd: '/work/inbox', default_host: 'devbox', default_engine: 'codex', default_mode: 'plan' } },
    })
    const snap = useProjectRegistry()
    expect(snap.loaded).toBe(true)
    expect(snap.projectNames).toEqual(['Marina'])
    expect(snap.rows.map((r) => r.name)).toEqual(['Marina'])
    // A folder never means "the Inbox": only real projects answer projectByCwd.
    expect([...snap.projectByCwd.values()]).toEqual(['Marina'])
    expect(snap.inbox).toMatchObject({ name: 'Inbox', source: 'local', defaultCwd: '/work/inbox', defaultHost: 'devbox' })
    // Known and local: never badged "new", never a sync claim.
    expect(snap.isKnownProject('inbox')).toBe(true)
    expect(snap.sourceByName.get('inbox')).toBe('local')

    // '' is the Inbox too (a draft with no project): its row, as for its launch defaults below.
    for (const name of ['Inbox', 'inbox', '']) {
      const entry = useProjectEntry(name)
      expect(entry.row?.defaultCwd, name).toBe('/work/inbox')
    }
    // No project ('') launches with the Inbox's defaults, as the server's launchProjectName does.
    expect(useProjectLaunchDefaults('')).toEqual({ engine: 'codex', mode: 'plan', project: 'Inbox' })
    expect(projectLaunchDefaultsNow('Inbox')).toEqual({ engine: 'codex', mode: 'plan', project: 'Inbox' })
    // `null` is a launch that takes no project's defaults (Ask Walnut, a fork).
    expect(useProjectLaunchDefaults(null)).toEqual({})
  })

  it('keeps one Inbox when a server also lists it among the projects', async () => {
    await load({
      projects: [row('Inbox', { default_cwd: '/stale' }), row('Marina')],
      inbox: { counts, name: 'Inbox', metadata: { default_cwd: '/work/inbox' } },
    })
    const snap = useProjectRegistry()
    expect(snap.projectNames).toEqual(['Marina'])
    expect(snap.inbox.defaultCwd).toBe('/work/inbox')
  })

  it('works against an older server whose inbox slot carries counts only', async () => {
    await load({ projects: [row('Marina')], inbox: { counts } })
    const snap = useProjectRegistry()
    expect(snap.projectNames).toEqual(['Marina'])
    expect(snap.inbox).toEqual({ name: 'Inbox', source: 'local', favorite: false })
    expect(useProjectLaunchDefaults('')).toEqual({})
  })

  it('takes a settings patch on the Inbox like on any project', async () => {
    await load({ projects: [row('Marina')], inbox: { counts, name: 'Inbox' } })
    const settle = patchProjectLocal('Inbox', { defaultCwd: '/work/inbox' })
    expect(useProjectRegistry().inbox.defaultCwd).toBe('/work/inbox')
    expect(useProjectEntry('').row?.defaultCwd).toBe('/work/inbox')
    expect(useProjectEntry('Inbox').row?.defaultCwd).toBe('/work/inbox')
    expect(useProjectRegistry().projectNames).toEqual(['Marina'])
    settle(false)
    expect(useProjectRegistry().inbox.defaultCwd).toBeUndefined()
  })

  it('keeps the Inbox\'s slot once in a project order, whichever name it carries', async () => {
    await load({ projects: [row('Marina')], inbox: { counts, name: 'Inbox' } })
    // useOrdering reads the order through this: without the Inbox the order cannot rank it.
    expect(resolveProjectNameList(['Marina', '', 'Reading'])).toEqual(['Marina', '', 'Reading'])
    expect(resolveProjectNameList(['', 'Marina', 'Inbox'])).toEqual(['', 'Marina'])
  })
})
