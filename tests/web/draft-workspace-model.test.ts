/**
 * The draft's "Isolated workspace" option as data (web/src/components/workspaces/
 * draft-workspace-model.ts): what a Start sends, when it waits and says why, and
 * that the complaint goes away with the next edit.
 */
import { describe, expect, it } from 'vitest'
import {
  applyChoicePatch, autoGivesWay, defaultIsolationOn, isPickable, selectedCandidate, workspaceRequestFor, type DraftWorkspaceChoice,
} from '../../web/src/components/workspaces/draft-workspace-model'
import type { WorkspaceCandidate } from '../../src/core/workspaces/types'

const git: WorkspaceCandidate = {
  provider: 'git-worktree', displayName: 'Git worktree', priority: 10, builtin: true, claimed: true, root: '/r/app',
  inputSchema: { type: 'object', properties: { baseRef: { type: 'string', title: 'Base branch' } } },
}
const gitNoRepo: WorkspaceCandidate = { ...git, claimed: false, reason: 'not a git repository' }
const multi: WorkspaceCandidate = {
  provider: 'multi', displayName: 'Multi', priority: 50, builtin: false, claimed: false,
  inputSchema: {
    type: 'object',
    properties: {
      packages: { type: 'array', title: 'Packages' },
      mode: { type: 'string', enum: ['fresh', 'worktree'], default: 'fresh' },
      shallow: { type: 'boolean', title: 'Shallow' },
    },
    required: ['packages'],
  },
}
const on = (patch: Partial<DraftWorkspaceChoice> = {}): DraftWorkspaceChoice => ({ enabled: true, values: {}, ...patch })

describe('draft workspace choice', () => {
  it('sends nothing while the option is off', () => {
    expect(workspaceRequestFor({ enabled: false, values: {}, candidates: [git] })).toBeNull()
  })

  it('waits while the host is still being asked, and when nothing can isolate the folder', () => {
    expect(workspaceRequestFor(on({ loading: true, candidates: [git] }))).toEqual({ error: 'Still checking which workspaces this folder supports' })
    expect(workspaceRequestFor(on({ candidates: [gitNoRepo] }))).toMatchObject({ error: expect.stringMatching(/Pick how to isolate/) })
    expect(workspaceRequestFor(on({ candidates: [] }))).toMatchObject({ error: expect.stringMatching(/Pick how to isolate/) })
  })

  it('uses the provider that claims the folder unless the user picked another', () => {
    expect(selectedCandidate(on({ candidates: [multi, git] }))?.provider).toBe('git-worktree')
    expect(selectedCandidate(on({ candidates: [multi, git], provider: 'multi' }))?.provider).toBe('multi')
    expect(isPickable(gitNoRepo)).toBe(false)
    expect(isPickable(multi)).toBe(true)
    expect(workspaceRequestFor(on({ candidates: [git] }))).toEqual({ provider: 'git-worktree', inputs: {} })
    expect(workspaceRequestFor(on({ candidates: [git], values: { baseRef: '  main ' } }))).toEqual({ provider: 'git-worktree', inputs: { baseRef: 'main' } })
  })

  it('a required field holds the Start, typed lists split on spaces and commas, defaults apply', () => {
    const picked = on({ candidates: [gitNoRepo, multi], provider: 'multi' })
    expect(workspaceRequestFor(picked)).toEqual({ error: 'Packages is required for Multi' })
    expect(workspaceRequestFor({ ...picked, values: { packages: ' , ' } })).toEqual({ error: 'Packages is required for Multi' })
    expect(workspaceRequestFor({ ...picked, values: { packages: 'alpha, beta  gamma', shallow: true } }))
      .toEqual({ provider: 'multi', inputs: { packages: ['alpha', 'beta', 'gamma'], mode: 'fresh', shallow: true } })
    expect(workspaceRequestFor({ ...picked, values: { packages: 'alpha', mode: 'worktree' } }))
      .toEqual({ provider: 'multi', inputs: { packages: ['alpha'], mode: 'worktree' } })
  })

  it("the last Start's complaint clears on the next edit, and only then", () => {
    const failed = applyChoicePatch(on({ candidates: [multi], provider: 'multi' }), { startError: 'Packages is required for Multi' })
    expect(failed.startError).toBe('Packages is required for Multi')
    // A host answer is not an edit: the complaint stays.
    expect(applyChoicePatch(failed, { loading: false, candidates: [multi] }).startError).toBe('Packages is required for Multi')
    expect(applyChoicePatch(failed, { values: { packages: 'a' } }).startError).toBeUndefined()
    expect(applyChoicePatch(failed, { provider: 'git-worktree' }).startError).toBeUndefined()
    expect(applyChoicePatch(failed, { enabled: false }).startError).toBeUndefined()
  })

  it('a default choice (no click) gives way quietly when there is nothing to make; a clicked one says why', () => {
    const auto = (patch: Partial<DraftWorkspaceChoice> = {}) => on({ auto: true, ...patch })
    expect(workspaceRequestFor(auto({ candidates: [git] }))).toEqual({ provider: 'git-worktree', inputs: {} })
    expect(autoGivesWay(auto({ loading: true }))).toBe(false)
    // Sent before the host answered: the server picks the claiming provider (or none), the Start never waits.
    expect(workspaceRequestFor(auto({ loading: true }))).toEqual({ auto: true })
    for (const quiet of [auto({ candidates: [gitNoRepo] }), auto({ candidates: [] }), auto({ candidates: [git], degraded: 'timeout' }),
      auto({ candidates: [git], error: 'host offline' }), auto({ candidates: [{ ...multi, claimed: true }] })]) {
      expect(autoGivesWay(quiet)).toBe(true)
      expect(workspaceRequestFor(quiet)).toBeNull()
    }
    // Its required field filled: the claiming plugin makes it.
    expect(workspaceRequestFor(auto({ candidates: [{ ...multi, claimed: true }], values: { packages: 'a, b' } }))).toMatchObject({ provider: 'multi', inputs: { packages: ['a', 'b'] } })
    expect(workspaceRequestFor(on({ candidates: [gitNoRepo] }))).toMatchObject({ error: expect.stringMatching(/Pick how to isolate/) })
    // The provider's detect step suggested the packages of this folder: the default makes it with them.
    const suggested = { ...multi, claimed: true, inputs: { packages: ['alpha', 'beta'] } }
    expect(autoGivesWay(auto({ candidates: [git, suggested] }))).toBe(false)
    expect(workspaceRequestFor(auto({ candidates: [suggested, git] }))).toEqual({ provider: 'multi', inputs: { packages: ['alpha', 'beta'], mode: 'fresh' } })
    // What the person typed wins over the suggestion.
    expect(workspaceRequestFor(auto({ candidates: [suggested], values: { packages: 'gamma' } }))).toMatchObject({ inputs: { packages: ['gamma'] } })
  })

  it('the project\'s setting wins over the global one, as on the server', () => {
    expect(defaultIsolationOn(true, undefined)).toBe(true)
    expect(defaultIsolationOn(false, undefined)).toBe(false)
    expect(defaultIsolationOn(true, 'off')).toBe(false)
    expect(defaultIsolationOn(false, 'on')).toBe(true)
  })
})
