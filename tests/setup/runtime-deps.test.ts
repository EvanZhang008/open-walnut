/**
 * The test tiers run on bun only (tests/setup/runtime-deps.ts): a vitest started
 * on Node, or on a bun that silently skips files, stops before any test runs,
 * with the command that runs it right.
 */
import { describe, expect, it } from 'vitest'
import { SQLITE_VERSION } from '../../scripts/build-sqlite-dylib.mjs'
import { MIN_BUN, testRuntimeProblem, testSqliteProblem, type LoadedSqlite, type SqliteFacts } from './runtime-deps'

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
  const ours: LoadedSqlite = { library: built, version: SQLITE_VERSION, options: ['DEFAULT_FOREIGN_KEYS', 'DQS=0'] }
  const apple: LoadedSqlite = { library: 'system', version: '3.51.0', options: ['DQS=3'] }
  /** A macOS checkout with the built SQLite, current, and loaded. */
  const mac = (over: Partial<SqliteFacts> = {}): string | null =>
    testSqliteProblem({ platform: 'darwin', built, env: {}, exists: none, current: () => true, loaded: () => ours, ...over })

  it('refuses macOS without the built SQLite, naming the build command', () => {
    const problem = mac({ built: null })
    expect(problem).toContain('bun scripts/build-sqlite-dylib.mjs')
    expect(problem).toContain('disk I/O error')
  })

  it('refuses a built SQLite older than the build script asks for', () => {
    expect(mac({ current: () => false })).toContain('out of date (vendor/sqlite/darwin/stamp.json): run `bun scripts/build-sqlite-dylib.mjs`')
  })

  it('refuses a run whose databases open on another SQLite, naming what loaded', () => {
    expect(mac({ loaded: () => apple })).toBe(
      `SQLite in this run is 3.51.0 without DQS=0 (system), not Walnut's ${SQLITE_VERSION} built with DQS=0: run \`bun scripts/build-sqlite-dylib.mjs\` (bun install runs it)`)
    // The right version, other options: not the build either.
    expect(mac({ loaded: () => ({ ...ours, options: ['DQS=3'] }) })).toContain('not Walnut\'s')
    const env = { WALNUT_SQLITE_LIBRARY: '/opt/lib.dylib' }
    expect(mac({ env, exists: (f) => f === '/opt/lib.dylib', loaded: () => ({ ...apple, library: '/opt/lib.dylib' }) }))
      .toContain('(/opt/lib.dylib), not Walnut\'s')
  })

  it('refuses a run that cannot open a database at all', () => {
    const env = { WALNUT_SQLITE_LIBRARY: '/etc/hosts' }
    const loaded = (): LoadedSqlite => { throw new Error('unable to open database file: :memory:') }
    expect(mac({ env, exists: () => true, loaded })).toBe(
      'SQLite in this run opens no database (unable to open database file: :memory:): run `bun scripts/build-sqlite-dylib.mjs` (bun install runs it), or unset WALNUT_SQLITE_LIBRARY (/etc/hosts)')
  })

  it('accepts the built SQLite, a library of the same build, or the system build asked for', () => {
    expect(mac()).toBeNull()
    // A named library is checked by what it loads, not by the stamp of the checkout's own.
    expect(mac({ built: null, current: () => false, env: { WALNUT_SQLITE_LIBRARY: '/opt/lib.dylib' }, exists: (f) => f === '/opt/lib.dylib' })).toBeNull()
    expect(mac({ built: null, env: { WALNUT_SQLITE_LIBRARY: 'system' }, loaded: () => apple })).toBeNull()
  })

  it('refuses a WALNUT_SQLITE_LIBRARY that names no file, even with the built one there', () => {
    expect(mac({ env: { WALNUT_SQLITE_LIBRARY: '/gone.dylib' } })).toContain('names no file (/gone.dylib)')
  })

  it('asks nothing off macOS, where bun carries its own SQLite', () => {
    expect(testSqliteProblem({ platform: 'linux', built: null, env: {}, exists: none, loaded: () => apple })).toBeNull()
  })

  it('this run has Walnut\'s SQLite', () => {
    expect(testSqliteProblem()).toBeNull()
  })
})
