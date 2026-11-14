/**
 * The draft's "Isolated workspace" option as data (web/src/components/workspaces/
 * draft-workspace-model.ts): what a Start sends, when it waits and says why, and
 * that the complaint goes away with the next edit.
 */
import { describe, expect, it } from 'vitest'
import {
  applyChoicePatch, isPickable, selectedCandidate, workspaceRequestFor, type DraftWorkspaceChoice,
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
})
