/**
 * The mock CLI prints its init the way Claude Code does: when it takes a line
 * (QueryEngine.submitMessage yields one per message), never at boot. A resumed
 * CLI given no line prints nothing, so Walnut never reads a turn into a process
 * that runs none (2026-11-10: a Retry of a line that had already run spawned a
 * resume the daemon wrote no line into, and the mock's boot init kept the session
 * "working" with nothing running).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const MOCK = path.join(import.meta.dirname, 'mock-claude.mjs')
const SID = '11111111-2222-4333-8444-555555555555'
const ARGS = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--resume', SID]

const children: ChildProcess[] = []
afterEach(() => { for (const c of children.splice(0)) c.kill('SIGTERM') })

function run(extra: string[] = []): { child: ChildProcess; lines: () => Array<Record<string, unknown>> } {
  const child = spawn(process.execPath, [MOCK, ...ARGS, ...extra], {
    stdio: ['pipe', 'pipe', 'ignore'],
    // No mock knobs from the runner's env: the plain CLI shape, writing no transcript.
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MOCK_CLAUDE'))),
  })
  children.push(child)
  let text = ''
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => { text += chunk })
  const lines = () => text.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>] } catch { return [] } })
  return { child, lines }
}

const isInit = (l: Record<string, unknown>) => l.type === 'system' && l.subtype === 'init'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('mock CLI init timing on a resume', () => {
  it('prints nothing until a line arrives, then its init and the turn', async () => {
    const { child, lines } = run()
    await sleep(1500)
    expect(lines().filter(isInit), 'a resume given no line runs no turn').toEqual([])
    child.stdin!.write(JSON.stringify({ type: 'user', uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', message: { role: 'user', content: 'hello there' } }) + '\n')
    for (let i = 0; i < 50 && !lines().some((l) => l.type === 'result'); i++) await sleep(100)
    const out = lines()
    const init = out.findIndex(isInit)
    const result = out.findIndex((l) => l.type === 'result')
    expect(init).toBeGreaterThanOrEqual(0)
    expect(result).toBeGreaterThan(init)
  }, 20_000)

  it('a fork keeps its boot init', async () => {
    const { lines } = run(['--fork-session'])
    for (let i = 0; i < 30 && !lines().some(isInit); i++) await sleep(100)
    expect(lines().some(isInit)).toBe(true)
  }, 20_000)
})
