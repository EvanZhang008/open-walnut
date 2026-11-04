/**
 * `walnut browser` (core/browser-control/browser-cli.ts): the words become the browser op's
 * arguments, a site waiting for the person is waited out, and a screenshot is saved as a file.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseBrowserArgv, runBrowser, BROWSER_EXIT } from '../../../src/core/browser-control/browser-cli'

describe('parseBrowserArgv', () => {
  it('maps each action to the op', () => {
    expect(parseBrowserArgv(['open', 'https://example.test/'])).toMatchObject({ ok: true, op: 'browser', args: { action: 'open', url: 'https://example.test/' } })
    expect(parseBrowserArgv(['go', 'https://example.test/x', '--tab', '4'])).toMatchObject({ args: { action: 'navigate', url: 'https://example.test/x', tab: 4 } })
    expect(parseBrowserArgv(['click', 'e12'])).toMatchObject({ args: { action: 'click', ref: 'e12' } })
    expect(parseBrowserArgv(['click', '--at', '120,44'])).toMatchObject({ args: { action: 'click', x: 120, y: 44 } })
    expect(parseBrowserArgv(['type', 'e3', 'hello', 'world', '--submit'])).toMatchObject({ args: { action: 'type', ref: 'e3', text: 'hello world', submit: true } })
    expect(parseBrowserArgv(['type', 'just', 'text'])).toMatchObject({ args: { action: 'type', text: 'just text' } })
    expect(parseBrowserArgv(['scroll', 'up', '--amount', '2'])).toMatchObject({ args: { action: 'scroll', direction: 'up', amount: 2 } })
    expect(parseBrowserArgv(['wait', '--ms', '500'])).toMatchObject({ args: { action: 'wait', ms: 500 } })
    expect(parseBrowserArgv(['screenshot', 'out.jpg'])).toMatchObject({ args: { action: 'screenshot', inline: true }, file: 'out.jpg' })
    expect(parseBrowserArgv(['status'])).toMatchObject({ op: 'browser_status' })
  })

  it('says what is missing', () => {
    expect(parseBrowserArgv([])).toMatchObject({ ok: false })
    expect(parseBrowserArgv(['open'])).toMatchObject({ ok: false, error: 'open needs a URL' })
    expect(parseBrowserArgv(['click'])).toMatchObject({ ok: false })
    expect(parseBrowserArgv(['click', '--at', 'nope'])).toMatchObject({ ok: false })
    expect(parseBrowserArgv(['fly'])).toMatchObject({ ok: false, error: 'unknown action fly' })
  })
})

describe('runBrowser', () => {
  it('waits out a site the person is asked about, then goes on', async () => {
    const calls: Array<Record<string, unknown>> = []
    const said: string[] = []
    let out = ''
    const answers = [{ status: 'needs_ok', site: 'example.test' }, { status: 'needs_ok', site: 'example.test' }, { tab: 5, url: 'https://example.test/', title: 'Example' }]
    const p = parseBrowserArgv(['open', 'https://example.test/'])
    if (!p.ok) throw new Error('parse')
    const code = await runBrowser(p, {
      call: async (_n, args) => { calls.push(args); return { ok: true, result: answers.shift() } },
      say: (l) => said.push(l), out: (t) => { out += t }, cwd: os.tmpdir(),
    })
    expect(code).toBe(BROWSER_EXIT.ok)
    expect(said.filter((l) => l.includes('Waiting'))).toHaveLength(1)
    expect(calls[0].wait_ms).toBeUndefined()
    expect(calls[1].wait_ms).toBe(25_000)
    expect(out).toContain('tab 5')
  })

  it('saves a screenshot to the file named, or into the task directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-'))
    const image = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 1, 2]).toString('base64')}`
    const io = (outRef: { v: string }) => ({
      call: async () => ({ ok: true, result: { tab: 2, image } }),
      say: () => undefined, out: (t: string) => { outRef.v += t }, cwd: dir, env: { WALNUT_TASK_DIR: dir },
    })
    const named = { v: '' }
    const p1 = parseBrowserArgv(['screenshot', 'a.jpg'])
    if (!p1.ok) throw new Error('parse')
    expect(await runBrowser(p1, io(named))).toBe(0)
    expect([...fs.readFileSync(path.join(dir, 'a.jpg'))]).toEqual([0xff, 0xd8, 0xff, 1, 2])
    const dflt = { v: '' }
    const p2 = parseBrowserArgv(['screenshot'])
    if (!p2.ok) throw new Error('parse')
    expect(await runBrowser(p2, io(dflt))).toBe(0)
    expect(dflt.v.trim().startsWith(path.join(dir, 'shots', 'browser-'))).toBe(true)
    expect(fs.existsSync(dflt.v.trim())).toBe(true)
  })

  it('a refusal exits 1, an error 3', async () => {
    const p = parseBrowserArgv(['snapshot'])
    if (!p.ok) throw new Error('parse')
    const io = (r: { ok: boolean; code?: string; message?: string }) => ({ call: async () => r, say: () => undefined, out: () => undefined, cwd: os.tmpdir() })
    expect(await runBrowser(p, io({ ok: false, code: 'not_your_tab', message: 'no' }))).toBe(BROWSER_EXIT.refused)
    expect(await runBrowser(p, io({ ok: false, message: 'boom' }))).toBe(BROWSER_EXIT.error)
  })
})
