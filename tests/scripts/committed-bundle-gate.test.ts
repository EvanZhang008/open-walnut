/**
 * The committed-tree gate (scripts/check-committed-bundle.sh) exists to catch a
 * HEAD that cannot build on a clean checkout. On 2026-08-22 it reported "clean"
 * on a HEAD whose `await import('../human-inbox/relay.js')` target had never been
 * committed, so main's CI build gate went red anyway.
 *
 * Cause: esbuild deliberately IGNORES an unresolvable dynamic import when any
 * enclosing scope has a catch — "dynamic import failures appear to be handled
 * here" — which describes essentially every lazily-loaded module in this
 * codebase. `tsc` calls the same line an error. The gate now promotes that
 * message to an error with --log-override:ignored-dynamic-import=error.
 *
 * These tests characterize esbuild's actual behaviour rather than trusting it: if
 * an upgrade changes the default, the first test tells us the override is now
 * redundant instead of quietly protecting nothing.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const REPO = path.join(import.meta.dirname, '..', '..')
const SCRIPT = path.join(REPO, 'scripts', 'check-committed-bundle.sh')
const ESBUILD = path.join(REPO, 'node_modules', '.bin', 'esbuild')

/**
 * A tree whose dynamic import cannot resolve, with the catch that hides it. The
 * import must sit INSIDE the try: esbuild only grants the leniency when a catch
 * encloses the import site (in the real incident the handler was the outer
 * try/catch wrapping the whole switch, 28 lines below the import).
 */
function treeWithGuardedDanglingImport(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-gate-'))
  fs.writeFileSync(path.join(dir, 'lazy.ts'), [
    'export async function run(): Promise<unknown> {',
    '  try {',
    "    const m = await import('./gone/relay.js')",   // never committed
    '    return (m as { go: () => unknown }).go()',
    '  } catch (err) {',
    '    throw err',
    '  }',
    '}',
  ].join('\n'))
  fs.writeFileSync(path.join(dir, 'entry.ts'), "import { run } from './lazy.js'\nawait run()\n")
  return dir
}

function bundle(dir: string, extraArgs: string[]): { status: number; output: string } {
  const args = [
    'entry.ts', '--bundle', '--platform=node', '--format=esm',
    '--packages=external', '--loader:.node=file', '--outfile=/dev/null', ...extraArgs,
  ]
  try {
    const out = execFileSync(ESBUILD, args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, output: out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, output: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

describe.skipIf(!fs.existsSync(ESBUILD))('committed-tree bundle gate', () => {
  it('passes the override that makes a hidden dangling import fail', () => {
    const script = fs.readFileSync(SCRIPT, 'utf-8')
    expect(script).toMatch(/--log-override:ignored-dynamic-import=error/)
  })

  it('esbuild alone still hides the break — this is why the override is needed', () => {
    const r = bundle(treeWithGuardedDanglingImport(), [])
    // If this ever starts failing, esbuild changed its default and the override
    // in the gate became belt-and-braces rather than the load-bearing part.
    expect(r.status).toBe(0)
    expect(r.output).not.toMatch(/ERROR/)
  })

  it('with the override, the same tree fails and names the import', () => {
    const r = bundle(treeWithGuardedDanglingImport(), ['--log-override:ignored-dynamic-import=error'])
    expect(r.status).not.toBe(0)
    expect(r.output).toMatch(/ERROR/)
    expect(r.output).toMatch(/gone\/relay\.js/)
  })

  it('does not flag an optional BARE dependency loaded the same way', () => {
    // Optional deps are the legitimate use of a guarded dynamic import, and
    // --packages=external keeps them out of resolution entirely. If this failed,
    // the override would be unusable in this repo.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-gate-opt-'))
    fs.writeFileSync(path.join(dir, 'entry.ts'), [
      'export async function maybe(): Promise<unknown> {',
      '  try {',
      "    return await import('some-package-that-is-not-installed')",
      '  } catch {',
      '    return null',
      '  }',
      '}',
    ].join('\n'))
    const r = bundle(dir, ['--log-override:ignored-dynamic-import=error'])
    expect(r.status).toBe(0)
  })
})
