/**
 * The three shutdown clocks nest: a plugin's deactivate budget inside the
 * server's shutdown bail inside the deploy's SIGKILL grace.
 *
 * 2026-10-01: the bail was 4 s and a plugin may take 5 s to deactivate, so one
 * slow plugin ended the teardown at exactly 4 s with exit 1, before the import
 * and the stores got their turn. The deploy then waits 8 s before SIGKILL, so a
 * bail past that would be killed instead of exiting on its own.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SHUTDOWN_BAIL_MS } from '../../src/commands/web.js'

const root = path.join(import.meta.dirname, '..', '..')

function numberAfter(file: string, re: RegExp): number {
  const text = fs.readFileSync(path.join(root, file), 'utf-8')
  const m = re.exec(text)
  expect(m, `${file} should match ${re}`).not.toBeNull()
  return Number(m![1]!.replace(/_/g, ''))
}

describe('server shutdown bail', () => {
  it('outlasts the plugin deactivate budget', () => {
    const pluginBudgetMs = numberAfter('src/core/plugins/plugin-manager.ts', /deactivationTimeoutMs \?\? ([0-9_]+)/)
    expect(SHUTDOWN_BAIL_MS).toBeGreaterThan(pluginBudgetMs)
  })

  it('fires before the deploy stops waiting and SIGKILLs', () => {
    const graceSecs = numberAfter('scripts/dev-prod.sh', /STOP_GRACE_SECS="\$\{WALNUT_DEVPROD_STOP_GRACE_SECS:-([0-9]+)\}"/)
    expect(SHUTDOWN_BAIL_MS).toBeLessThan(graceSecs * 1000)
  })

  it('writes the bail to the exit trace, so a code=1 exit is attributable', () => {
    const text = fs.readFileSync(path.join(root, 'src/commands/web.ts'), 'utf-8')
    expect(text).toMatch(/SERVER EXIT: shutdown bail after \$\{SHUTDOWN_BAIL_MS\}ms/)
  })
})
