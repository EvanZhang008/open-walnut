/**
 * The steps a transferred task's new session follows to set its workspace up
 * (src/core/transfer/workspace.ts): a fresh clone on the target copies no git
 * config, so the steps give it the commit identity the source repository used.
 */
import { describe, expect, it } from 'vitest'
import { workspaceInstructions, type MovedWorkspace } from '../../../src/core/transfer/workspace.js'
import type { PackMeta } from '../../../src/core/transfer/daemon-transfer-client.js'

function moved(meta: Partial<PackMeta>): MovedWorkspace {
  return {
    meta: { kind: 'git', root: '/src/app', relCwd: '', createdAt: '', branch: 'main', head: 'abc123', remotes: [{ name: 'origin', url: 'https://example.test/acme/app.git' }], ...meta },
    bundleDir: '/home/u/.open-walnut-transfers/xf-1', files: ['meta.json'], route: 'direct', bytes: 10,
  } as MovedWorkspace
}

describe('workspaceInstructions: the commit identity', () => {
  it('a fresh clone is told to take the source identity, as one runnable line', () => {
    const text = workspaceInstructions(moved({ identity: { name: 'Pat Doe', email: 'pat@example.test' } }), { repoRoot: '/w/app', known: false })
    expect(text).toContain("git config user.name 'Pat Doe' && git config user.email pat@example.test")
    expect(text).toContain('Pat Doe <pat@example.test>')
    // The step comes after the clone it applies to.
    expect(text.indexOf('git clone')).toBeLessThan(text.indexOf('git config user.name'))
  })

  it('a repository the target already has is checked, not overwritten blindly', () => {
    const text = workspaceInstructions(moved({ identity: { email: 'pat@example.test' } }), { repoRoot: '/w/app', known: true })
    expect(text).toContain('If this checkout commits as the machine does (`git config user.email` here prints the same as `git -C / config user.email`)')
    expect(text).toContain('git config user.email pat@example.test')
    expect(text).not.toContain('user.name')
  })

  it('quotes a name a shell would split or expand', () => {
    const text = workspaceInstructions(moved({ identity: { name: "Renée O'Brien $HOME" } }), { repoRoot: '/w/app', known: false })
    expect(text).toContain("git config user.name 'Renée O'\\''Brien $HOME'")
  })

  it('a pack from an older daemon (no identity) adds no step', () => {
    const text = workspaceInstructions(moved({}), { repoRoot: '/w/app', known: false })
    expect(text).not.toContain('git config')
  })
})
