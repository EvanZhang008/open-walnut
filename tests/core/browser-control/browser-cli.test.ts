/**
 * `walnut browser` (core/browser-control/browser-cli.ts): the words become the browser op's
 * arguments, a site waiting for the person is waited out, and a screenshot is saved as a file.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseBrowserArgv, runBrowser, BROWSER_EXIT, UPLOAD_MAX_BYTES } from '../../../src/core/browser-control/browser-cli'

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

describe('the newer actions', () => {
  it('parses find, fill-form, hover, the scroll and wait forms, tabs --all, take, downloads, fill-login, dialog and evaluate', () => {
    expect(parseBrowserArgv(['find', 'Place', 'order', '--role', 'button', '--exact', '--limit', '3'])).toMatchObject({ args: { action: 'find', text: 'Place order', role: 'button', exact: true, limit: 3 } })
    expect(parseBrowserArgv(['form-values'])).toMatchObject({ args: { action: 'form_values' } })
    expect(parseBrowserArgv(['fill-form', 'Full name=Test Person', 'f3:e7=yes=no', 'e2=']))
      .toMatchObject({ args: { action: 'fill_form', fields: [{ label: 'Full name', value: 'Test Person' }, { ref: 'f3:e7', value: 'yes=no' }, { ref: 'e2', value: '' }] } })
    expect(parseBrowserArgv(['fill-form', 'nothing'])).toMatchObject({ ok: false })
    expect(parseBrowserArgv(['hover', 'f2:e9', '--trusted'])).toMatchObject({ args: { action: 'hover', ref: 'f2:e9', trusted: true } })
    expect(parseBrowserArgv(['type', 'f2:e9', 'hi'])).toMatchObject({ args: { action: 'type', ref: 'f2:e9', text: 'hi' } })
    expect(parseBrowserArgv(['scroll', 'bottom'])).toMatchObject({ args: { action: 'scroll', to: 'bottom' } })
    expect(parseBrowserArgv(['scroll', 'right', '--by', '300'])).toMatchObject({ args: { action: 'scroll', direction: 'right', by: 300 } })
    expect(parseBrowserArgv(['wait', '--gone', 'Loading'])).toMatchObject({ args: { action: 'wait', textGone: 'Loading' } })
    expect(parseBrowserArgv(['wait', '--url', '/done=1$/'])).toMatchObject({ args: { action: 'wait', url: '/done=1$/' } })
    expect(parseBrowserArgv(['screenshot', '--full'])).toMatchObject({ args: { action: 'screenshot', full: true } })
    expect(parseBrowserArgv(['tabs', '--all'])).toMatchObject({ args: { action: 'tabs', all: true } })
    expect(parseBrowserArgv(['take', '12'])).toMatchObject({ args: { action: 'take', tab: 12 } })
    expect(parseBrowserArgv(['take'])).toMatchObject({ ok: false })
    expect(parseBrowserArgv(['downloads', '--wait', '--ms', '9000'])).toMatchObject({ args: { action: 'downloads', wait: true, ms: 9000 } })
    expect(parseBrowserArgv(['fill-login', '--item', 'Shop'])).toMatchObject({ args: { action: 'fill_login', item: 'Shop' } })
    expect(parseBrowserArgv(['dialog', 'dismiss'])).toMatchObject({ args: { action: 'dialog', accept: false } })
    expect(parseBrowserArgv(['dialog', 'accept', '--text', 'yes'])).toMatchObject({ args: { action: 'dialog', accept: true, text: 'yes' } })
    // Alone (or `read`), it reads the open dialog; any other word is not an answer.
    expect(parseBrowserArgv(['dialog'])).toMatchObject({ ok: true, args: { action: 'dialog', read: true } })
    expect(parseBrowserArgv(['dialog', 'maybe'])).toMatchObject({ ok: false })
    expect(parseBrowserArgv(['evaluate', 'document.title'])).toMatchObject({ args: { action: 'evaluate', expression: 'document.title' } })
    expect(parseBrowserArgv(['upload', 'e5', 'a.pdf', 'b.png'])).toMatchObject({ args: { action: 'upload', ref: 'e5' }, upload: ['a.pdf', 'b.png'] })
    expect(parseBrowserArgv(['upload', '--ref', 'e5', '--file', 'a.pdf'])).toMatchObject({ args: { action: 'upload', ref: 'e5' }, upload: ['a.pdf'] })
    expect(parseBrowserArgv(['upload', 'e5', '--trusted', '--path', '/x/a.pdf'])).toMatchObject({ args: { action: 'upload', ref: 'e5', trusted: true, paths: ['/x/a.pdf'] } })
    expect(parseBrowserArgv(['upload', 'a.pdf'])).toMatchObject({ ok: false })
  })

  it('upload reads the files here and sends their bytes; too much is refused before anything is sent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-up-'))
    fs.writeFileSync(path.join(dir, 'a.pdf'), Buffer.from('%PDF-1.4 test'))
    const calls: Array<Record<string, unknown>> = []
    const p = parseBrowserArgv(['upload', 'e5', 'a.pdf'])
    if (!p.ok) throw new Error('parse')
    const io = { call: async (_n: string, a: Record<string, unknown>) => { calls.push(a); return { ok: true, result: { uploaded: ['a.pdf (13 bytes)'] } } }, say: () => undefined, out: () => undefined, cwd: dir }
    expect(await runBrowser(p, io)).toBe(BROWSER_EXIT.ok)
    expect(calls[0].files).toEqual([{ name: 'a.pdf', type: 'application/pdf', base64: Buffer.from('%PDF-1.4 test').toString('base64') }])
    fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(UPLOAD_MAX_BYTES + 1))
    const big = parseBrowserArgv(['upload', 'e5', 'big.bin'])
    if (!big.ok) throw new Error('parse')
    const said: string[] = []
    expect(await runBrowser(big, { ...io, say: (l: string) => said.push(l) })).toBe(BROWSER_EXIT.error)
    expect(said.join(' ')).toContain('MB')
    expect(calls).toHaveLength(1)
  })

  it('fill-login waits out the person\'s approval by its request id', async () => {
    const calls: Array<Record<string, unknown>> = []
    const answers = [{ status: 'needs_ok', request: 'apr-1', item: { title: 'Shop' } }, { status: 'needs_ok', request: 'apr-1' }, { filled: true, fields: ['username', 'password'], item: { id: 'i1', title: 'Shop' }, tab: 4 }]
    const p = parseBrowserArgv(['fill-login'])
    if (!p.ok) throw new Error('parse')
    const code = await runBrowser(p, { call: async (_n, a) => { calls.push(a); return { ok: true, result: answers.shift() } }, say: () => undefined, out: () => undefined, cwd: os.tmpdir() })
    expect(code).toBe(BROWSER_EXIT.ok)
    expect(calls[0].request).toBeUndefined()
    expect(calls[1]).toMatchObject({ request: 'apr-1', wait_ms: 25_000 })
    expect(calls[2]).toMatchObject({ request: 'apr-1' })
  })

  it('a step that waits for the person says what and how long, then goes on with the ask', async () => {
    const calls: Array<Record<string, unknown>> = []
    const said: string[] = []
    let out = ''
    const ask = { status: 'needs_ok', code: 'outward_needs_ok', request: 'apr-1', what: 'click button "Place order"',
      error: 'Waiting for the person to approve: click button "Place order" on shop.example.test ("Place order" buys or pays). They are asked on their Mac and phone; the ask stays open 10 minutes.' }
    const answers = [ask, ask, { tab: 4, url: 'https://shop.example.test/done', clicked: 'button "Place order"' }]
    const p = parseBrowserArgv(['click', 'e11'])
    if (!p.ok) throw new Error('parse')
    const code = await runBrowser(p, { call: async (_n, args) => { calls.push(args); return { ok: true, result: answers.shift() } }, say: (l) => said.push(l), out: (t) => { out += t }, cwd: os.tmpdir() })
    expect(code).toBe(BROWSER_EXIT.ok)
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('click button "Place order" on shop.example.test')
    expect(said[0]).toContain('waits up to 10 minutes')
    expect(calls[1]).toMatchObject({ action: 'click', ref: 'e11', request: 'apr-1', wait_ms: 25_000 })
    expect(out).toContain('tab 4')
  })

  it('a no or no answer in time ends it', async () => {
    const p = parseBrowserArgv(['click', 'e11'])
    if (!p.ok) throw new Error('parse')
    const io = (r: { ok: boolean; code?: string; message?: string }) => ({ call: async () => r, say: () => undefined, out: () => undefined, cwd: os.tmpdir() })
    expect(await runBrowser(p, io({ ok: false, code: 'denied', message: 'no' }))).toBe(BROWSER_EXIT.refused)
    expect(await runBrowser(p, io({ ok: false, code: 'outward_expired', message: 'late' }))).toBe(BROWSER_EXIT.timeout)
  })

  it('a click that opened a window says which tab it is', async () => {
    let out = ''
    const p = parseBrowserArgv(['click', 'e2'])
    if (!p.ok) throw new Error('parse')
    await runBrowser(p, { call: async () => ({ ok: true, result: { tab: 3, url: 'https://x.test/popup', opened: { tab: 9, url: 'https://x.test/help-window' } } }), say: () => undefined, out: (t) => { out += t }, cwd: os.tmpdir() })
    expect(out).toContain('Opened a new tab: 9  https://x.test/help-window')
  })

  it('a .png name asks for a PNG; a JPEG that comes anyway is saved under .jpg, and says so', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-png-'))
    const png = parseBrowserArgv(['screenshot', 'shot.png'])
    if (!png.ok) throw new Error('parse')
    expect(png.args.format).toBe('png')
    expect(parseBrowserArgv(['screenshot', 'shot.jpg'])).not.toMatchObject({ args: { format: 'png' } })
    const said: string[] = []
    const send = (mime: string) => ({ call: async () => ({ ok: true, result: { image: `data:image/${mime};base64,${Buffer.from([1, 2, 3]).toString('base64')}` } }), say: (l: string) => said.push(l), out: () => undefined, cwd: dir })
    expect(await runBrowser(png, send('png'))).toBe(0)
    expect(fs.existsSync(path.join(dir, 'shot.png'))).toBe(true)
    expect(said).toHaveLength(0)
    expect(await runBrowser(png, send('jpeg'))).toBe(0)
    expect(fs.existsSync(path.join(dir, 'shot.jpg'))).toBe(true)
    expect(said[0]).toContain('saved as shot.jpg')
  })
})
