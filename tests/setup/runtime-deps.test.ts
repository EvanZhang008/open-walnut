/**
 * The test tiers run on bun only (tests/setup/runtime-deps.ts): a vitest started
 * on Node, or on a bun that silently skips files, stops before any test runs,
 * with the command that runs it right.
 */
import { describe, expect, it } from 'vitest'
import { MIN_BUN, testRuntimeProblem, testSqliteProblem } from './runtime-deps'

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

describe('testSqliteProblem', () => {
  const none = (): boolean => false
  const built = '/repo/vendor/sqlite/darwin/libsqlite3.dylib'

  it('refuses macOS without the built SQLite, naming the build command', () => {
    const problem = testSqliteProblem('darwin', null, {}, none)
    expect(problem).toContain('bun scripts/build-sqlite-dylib.mjs')
    expect(problem).toContain('disk I/O error')
  })

  it('accepts the built SQLite, a library that exists, or the system build asked for', () => {
    expect(testSqliteProblem('darwin', built, {}, none)).toBeNull()
    expect(testSqliteProblem('darwin', null, { WALNUT_SQLITE_LIBRARY: '/opt/lib.dylib' }, (f) => f === '/opt/lib.dylib')).toBeNull()
    expect(testSqliteProblem('darwin', null, { WALNUT_SQLITE_LIBRARY: 'system' }, none)).toBeNull()
  })

  it('refuses a WALNUT_SQLITE_LIBRARY that names no file, even with the built one there', () => {
    expect(testSqliteProblem('darwin', built, { WALNUT_SQLITE_LIBRARY: '/gone.dylib' }, none)).toContain('names no file (/gone.dylib)')
  })

  it('asks nothing off macOS, where bun carries its own SQLite', () => {
    expect(testSqliteProblem('linux', null, {}, none)).toBeNull()
  })

  it('this run has Walnut\'s SQLite', () => {
    expect(testSqliteProblem()).toBeNull()
  })
})
