/**
 * The test tiers run on bun only (tests/setup/runtime-deps.ts): a vitest started
 * on Node, or on a bun that silently skips files, stops before any test runs,
 * with the command that runs it right.
 */
import { describe, expect, it } from 'vitest'
import { MIN_BUN, testRuntimeProblem } from './runtime-deps'

const node = { node: '25.9.0' } as NodeJS.ProcessVersions

describe('testRuntimeProblem', () => {
  it('refuses Node, naming the bun command', () => {
    const problem = testRuntimeProblem(node)
    expect(problem).toContain('run on bun, not on Node 25.9.0')
    expect(problem).toContain('bun run test:quick')
    expect(problem).toContain('bun --bun vitest run')
  })

  it('refuses a bun older than the trusted one', () => {
    expect(testRuntimeProblem({ ...node, bun: '1.3.9' })).toContain('silently skips test files')
    expect(testRuntimeProblem({ ...node, bun: '1.4.3' })).toContain(`bun ${MIN_BUN.join('.')} or newer`)
  })

  it('accepts the trusted bun and newer ones', () => {
    expect(testRuntimeProblem({ ...node, bun: MIN_BUN.join('.') })).toBeNull()
    expect(testRuntimeProblem({ ...node, bun: '1.4.10' })).toBeNull()
    expect(testRuntimeProblem({ ...node, bun: '1.5.0-canary.1' })).toBeNull()
  })

  it('this run is on a bun it accepts', () => {
    expect(process.versions.bun).toBeTypeOf('string')
    expect(testRuntimeProblem()).toBeNull()
  })
})
