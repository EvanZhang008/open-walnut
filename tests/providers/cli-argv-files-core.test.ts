/**
 * cli-argv-files-core.ts: the CLI's content arguments become files.
 * MACHINE SAFETY: every file lives in a temp dir this file makes and removes.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { createCliArgvFiles } from '../../src/providers/cli-argv-files-core.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
function make(now = () => Date.now(), over: Partial<typeof fs> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'argv-files-'))
  dirs.push(root)
  const logs: string[] = []
  const dir = path.join(root, 'argv')
  return { dir, logs, af: createCliArgvFiles({ fs: { ...fs, ...over } as never, path, crypto, dir, now, log: (_l, msg) => { logs.push(msg) } }) }
}

describe('toFiles', () => {
  it('moves each content value to a file named by its content, and keeps every other arg', () => {
    const { af, dir } = make()
    const args = ['--model', 'opus', '--settings', '{"a":1}', '--append-system-prompt', 'pé 中', '--resume', 'sid']
    const out = af.toFiles(args)
    expect(out).toEqual(['--model', 'opus', '--settings', expect.stringMatching(/\.json$/), '--append-system-prompt-file', expect.stringMatching(/\.txt$/), '--resume', 'sid'])
    expect(fs.readFileSync(out[3], 'utf8')).toBe('{"a":1}')
    expect(fs.readFileSync(out[5], 'utf8')).toBe('pé 中')
    expect(fs.statSync(out[3]).mode & 0o777).toBe(0o600)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    // Same content, same file; the caller's array is not changed.
    expect(af.toFiles(args)).toEqual(out)
    expect(args[3]).toBe('{"a":1}')
    expect(fs.readdirSync(dir)).toHaveLength(2)
  })

  it('handles the joined form, every --mcp-config value, --agents, paths and empty prompts', () => {
    const { af } = make()
    const out = af.toFiles(['claude', '--settings={"b":2}', '--mcp-config', '{"m":1}', '/etc/m.json', '{"m":2}', '--agents', '{"x":{}}', '--append-system-prompt', '', '--system-prompt'])
    expect(out[0]).toBe('claude')
    expect(out[1]).toMatch(/^--settings=\/.*\.json$/)
    expect(fs.readFileSync(out[1].slice('--settings='.length), 'utf8')).toBe('{"b":2}')
    expect(out[2]).toBe('--mcp-config')
    expect(fs.readFileSync(out[3], 'utf8')).toBe('{"m":1}')
    expect(out[4]).toBe('/etc/m.json')
    expect(fs.readFileSync(out[5], 'utf8')).toBe('{"m":2}')
    expect(out[6]).toBe('--agents')
    expect(fs.readFileSync(out[7], 'utf8')).toBe('{"x":{}}')
    expect(out.slice(8)).toEqual(['--append-system-prompt', '', '--system-prompt'])
  })

  it('keeps the inline args when it cannot write, and says so', () => {
    const { af, logs } = make(undefined, { writeFileSync: (() => { throw new Error('ENOSPC') }) as never })
    const args = ['--settings', '{"a":1}']
    expect(af.toFiles(args)).toEqual(args)
    expect(logs.join()).toMatch(/inline/)
  })
})

describe('sweep', () => {
  it('keeps what live args or a live command line name, and removes the rest once a day old (temp files after an hour)', () => {
    const { af, dir } = make()
    const live = ['--settings', '{"live":1}']
    const [, keep] = af.toFiles(live)
    const [, running] = af.toFiles(['--settings', '{"running":1}'])
    const [, old] = af.toFiles(['--settings', '{"old":1}'])
    const [, fresh] = af.toFiles(['--settings', '{"fresh":1}'])
    const tmp = path.join(dir, 'x.json.tmp-1-a')
    fs.writeFileSync(tmp, '')
    const past = (ms: number) => new Date(Date.now() - ms)
    for (const f of [keep, running, old]) fs.utimesSync(f, past(2 * 86400_000), past(2 * 86400_000))
    fs.utimesSync(tmp, past(2 * 3600_000), past(2 * 3600_000))
    // No ps answer: nothing is proven unused.
    expect(af.sweep([live], null)).toBe(0)
    const ps = ['/usr/bin/node /x/claude --resume s --settings ' + running + ' --model opus', 'bash']
    expect(af.sweep([live, null, undefined], ps)).toBe(2)
    expect(fs.readdirSync(dir).sort()).toEqual([keep, running, fresh].map((f) => path.basename(f)).sort())
  })

  it('touches a file a spawn reuses, so its day starts again', () => {
    const { af } = make()
    const args = ['--settings', '{"reuse":1}']
    const [, file] = af.toFiles(args)
    fs.utimesSync(file, new Date(Date.now() - 2 * 86400_000), new Date(Date.now() - 2 * 86400_000))
    af.toFiles(args)
    expect(Date.now() - fs.statSync(file).mtimeMs).toBeLessThan(60_000)
    expect(af.sweep([], [])).toBe(0)
  })

  it('answers 0 for a dir that is not there', () => {
    expect(make().af.sweep([], [])).toBe(0)
  })
})

describe('isClaude', () => {
  it('names a claude binary or node running the CLI script', () => {
    const { af } = make()
    expect(af.isClaude('/home/u/.local/bin/claude', ['-p'])).toBe(true)
    expect(af.isClaude('/usr/bin/node', ['/lib/node_modules/@anthropic-ai/claude-code/cli.js', '-p'])).toBe(true)
    expect(af.isClaude('/usr/bin/git', ['status'])).toBe(false)
  })
})
