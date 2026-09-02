/**
 * useProjectActions: the two project actions that need a dialog, and above all
 * their FAILURE paths.
 *
 * Both the kebab menu and the project row's right-click menu call this hook, so
 * the delete semantics (local claim vs provider claim, and the `?remote=1`
 * cascade) and every dialog string live here exactly once. The paths worth a unit
 * test are the ones a browser spec cannot reach without a broken server or a real
 * provider account:
 *
 *   . rename rejected by the server: the user gets "Rename failed", not a silent
 *     no-op that looks like the rename worked.
 *   . the project detail lookup rejected: delete ABORTS with "Delete unavailable"
 *     instead of guessing the source. Guessing is not harmless: a provider-claimed
 *     project shown the harmless local copy ("tasks move to the Inbox") would hit
 *     the route's 409 anyway, and the confirm would have lied about what the button
 *     does.
 *   . a provider-claimed project: the confirm has to say the remote container goes
 *     with it, and the request has to carry `remote: true`.
 *
 * HOW this runs without a DOM (the root vitest is `environment: 'node'`, no jsdom,
 * no @testing-library/react): the hook's only React needs are `useState` and
 * `useCallback`, so React itself is mocked with stand-ins for those two and the
 * hook is invoked directly. The code under test is the REAL hook, not a replica of
 * its logic. Its two collaborators are mocked at the module edge: the dialogs
 * (`useConfirm`) because their real implementation is a React context, and the API
 * client because these cases ARE its failures.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Two hooks, no renderer. useState never needs to re-render here: every assertion
// is about what the returned promise DID (which dialog, which request), and `busy`
// is only ever read by a host that draws its own trigger.
//
// The PATH matters and a bare 'react' does not work: the frontend's React lives in
// web/node_modules, so `import 'react'` inside web/src/ resolves to a different
// module id than the repo root's, and a mock keyed on the root id silently misses
// (the symptom is the real React's "Cannot read properties of null (reading
// 'useState')", i.e. hooks called outside a render).
vi.mock('../../web/node_modules/react', () => ({
  useState: <T,>(initial: T) => [initial, vi.fn()] as const,
  useCallback: <T,>(fn: T) => fn,
}))

const confirm = vi.fn<(opts: Record<string, unknown>) => Promise<boolean>>()
const alert = vi.fn<(opts: Record<string, unknown>) => Promise<void>>()
const prompt = vi.fn<(opts: Record<string, unknown>) => Promise<string | null>>()

vi.mock('@/hooks/useConfirm', () => ({
  useConfirm: () => confirm,
  useAlert: () => alert,
  usePrompt: () => prompt,
}))

const fetchProjectDetail = vi.fn<(name: string) => Promise<unknown>>()
const renameProject = vi.fn<(from: string, to: string) => Promise<unknown>>()
const deleteProject = vi.fn<(name: string, opts?: { remote?: boolean }) => Promise<unknown>>()

vi.mock('@/api/projects', () => ({ fetchProjectDetail, renameProject, deleteProject }))

const { useProjectActions } = await import('@/hooks/useProjectActions')

/** The detail shape the delete path reads: the claim source and the task counts. */
function detail(source: string, counts = { todo: 2, active: 1, done: 0 }) {
  return { name: 'Marina', source, metadata: {}, memorySummary: null, counts }
}

beforeEach(() => {
  vi.clearAllMocks()
  confirm.mockResolvedValue(true)
  alert.mockResolvedValue(undefined)
  deleteProject.mockResolvedValue({})
  renameProject.mockResolvedValue({})
})

describe('useProjectActions.rename', () => {
  it('reports a rejected rename instead of failing silently', async () => {
    prompt.mockResolvedValue('Harbour')
    renameProject.mockRejectedValue(new Error('project "Harbour" already exists'))
    const onChanged = vi.fn()

    await useProjectActions({ onChanged }).rename('Marina')

    expect(renameProject).toHaveBeenCalledWith('Marina', 'Harbour')
    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert.mock.calls[0][0]).toMatchObject({
      title: 'Rename failed',
      message: 'project "Harbour" already exists',
    })
    // A failed rename is not a change: a host that refreshed its registry copy
    // here would show the new name that never landed.
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('does nothing at all when the prompt is dismissed or unchanged', async () => {
    const handle = useProjectActions({})
    for (const answer of [null, '', '   ', 'Marina']) {
      prompt.mockResolvedValue(answer)
      await handle.rename('Marina')
    }
    expect(renameProject).not.toHaveBeenCalled()
    expect(alert).not.toHaveBeenCalled()
  })

  it('reports the change once the server confirms it', async () => {
    prompt.mockResolvedValue('  Harbour  ')
    const onChanged = vi.fn()
    await useProjectActions({ onChanged }).rename('Marina')
    // Trimmed: the trailing space the user typed must not become the name.
    expect(renameProject).toHaveBeenCalledWith('Marina', 'Harbour')
    expect(onChanged).toHaveBeenCalledWith('rename', 'Marina', 'Harbour')
    expect(alert).not.toHaveBeenCalled()
  })
})

describe('useProjectActions.remove', () => {
  it('aborts with "Delete unavailable" when the source cannot be read', async () => {
    fetchProjectDetail.mockRejectedValue(new Error('502 Bad Gateway'))

    await useProjectActions({}).remove('Marina')

    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert.mock.calls[0][0]).toMatchObject({ title: 'Delete unavailable' })
    expect(String((alert.mock.calls[0][0] as { message: string }).message)).toContain('502 Bad Gateway')
    // THE point of the abort: no confirm was shown, so the user was never asked to
    // approve copy that might have described the wrong kind of delete, and no
    // request went out on a guess.
    expect(confirm).not.toHaveBeenCalled()
    expect(deleteProject).not.toHaveBeenCalled()
  })

  it('a LOCAL project: the confirm names the task count, the request has no cascade', async () => {
    fetchProjectDetail.mockResolvedValue(detail('local', { todo: 2, active: 1, done: 0 }))
    const onChanged = vi.fn()

    await useProjectActions({ onChanged }).remove('Marina')

    expect(confirm).toHaveBeenCalledTimes(1)
    const opts = confirm.mock.calls[0][0] as { message: string; confirmLabel: string }
    expect(opts.message).toContain('Its 3 tasks move to the Inbox')
    expect(opts.confirmLabel).toBe('Delete project')
    // undefined, not { remote: false }: the cascade is opt-in at the route.
    expect(deleteProject).toHaveBeenCalledWith('Marina', undefined)
    expect(onChanged).toHaveBeenCalledWith('delete', 'Marina')
  })

  it('says "1 task", not "1 tasks"', async () => {
    fetchProjectDetail.mockResolvedValue(detail('local', { todo: 1, active: 0, done: 0 }))
    await useProjectActions({}).remove('Marina')
    const message = (confirm.mock.calls[0][0] as { message: string }).message
    expect(message).toContain('Its 1 task')
    expect(message).not.toContain('1 tasks')
  })

  it('a PROVIDER-claimed project: the confirm says the remote goes too, and the request cascades', async () => {
    fetchProjectDetail.mockResolvedValue(detail('ms-todo'))

    await useProjectActions({}).remove('Marina')

    const opts = confirm.mock.calls[0][0] as { message: string; confirmLabel: string; danger?: boolean }
    expect(opts.message).toContain('ms-todo')
    expect(opts.message).toContain('ALSO DELETES the remote container')
    expect(opts.message).toContain('cannot be undone')
    expect(opts.confirmLabel).toBe('Delete here + remote')
    expect(opts.danger).toBe(true)
    expect(deleteProject).toHaveBeenCalledWith('Marina', { remote: true })
  })

  it('a cancelled confirm deletes nothing', async () => {
    fetchProjectDetail.mockResolvedValue(detail('local'))
    confirm.mockResolvedValue(false)
    const onChanged = vi.fn()

    await useProjectActions({ onChanged }).remove('Marina')

    expect(deleteProject).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
    expect(alert).not.toHaveBeenCalled()
  })

  it('reports a rejected delete', async () => {
    fetchProjectDetail.mockResolvedValue(detail('local'))
    deleteProject.mockRejectedValue(new Error('409 claimed by ms-todo'))
    const onChanged = vi.fn()

    await useProjectActions({ onChanged }).remove('Marina')

    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert.mock.calls[0][0]).toMatchObject({ title: 'Delete failed' })
    expect(onChanged).not.toHaveBeenCalled()
  })
})
