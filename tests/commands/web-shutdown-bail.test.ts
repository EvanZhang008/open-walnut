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
import os from 'node:os'
import { SHUTDOWN_BAIL_MS } from '../../src/commands/web.js'
import { shutdownBailsSince } from '../../src/core/health-monitor/exit-trace.js'

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

  // 2026-11-12: a bail with no step named had to be traced from the logs by hand.
  it('names the shutdown step it caught, on both bail lines', () => {
    const text = fs.readFileSync(path.join(root, 'src/commands/web.ts'), 'utf-8')
    const lines = text.split('\n').filter((l) => l.includes('SERVER EXIT: shutdown bail after'))
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line).toContain('${shutdownStepSuffix()}')
  })

  it('every stop under a bail hands stopServer that bail, so its steps fit inside it', () => {
    for (const file of ['src/commands/web.ts', 'src/commands/web-restart.ts']) {
      const text = fs.readFileSync(path.join(root, file), 'utf-8')
      const calls = [...text.matchAll(/\bstopServer\(\{[^}]*\}\)/g)].map((m) => m[0])
      expect(calls.length, file).toBeGreaterThan(0)
      for (const call of calls) expect(call, file).toMatch(/bailMs/)
    }
  })

  it('a bail line that names its step still counts for the alarm', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bail-trace-'))
    const file = path.join(dir, 'exit.log')
    fs.writeFileSync(file, '[2026-11-12T04:39:46.235Z] SERVER EXIT: shutdown bail after 7000ms pid=31698 step="external session import" (6400ms)\n')
    const got = await shutdownBailsSince(file, [{ kind: 'boot', at: 1, pid: 31698 } as never])
    expect(got).toEqual([{ kind: 'shutdown-bail', at: Date.parse('2026-11-12T04:39:46.235Z'), pid: 31698 }])
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
