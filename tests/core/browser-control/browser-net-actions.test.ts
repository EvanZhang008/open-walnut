/**
 * The actions that let the old private relay retire (2026-11-07, the user: "we actually now fully
 * migrate to this new extension"), on the shell and op side: `network`, `network-body`,
 * `network-request-body`, `console`, `resize`, `upload --selector` and `open --record` become the
 * browser op's arguments (core/browser-control/browser-cli.ts), the route keeps only their own
 * keys, cut to size (act-args.ts), the shell prints them (one request or message a line, a body
 * as it came), and the op's outcome says what came back (ops/browser.ts). The refusals that send
 * an agent to the person say exactly which switch to turn on, and where.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseBrowserArgv, runBrowser, BROWSER_EXIT } from '../../../src/core/browser-control/browser-cli'
import { cleanArgs } from '../../../src/core/browser-control/act-args'

const parsed = (argv: string[]) => {
  const p = parseBrowserArgv(argv)
  if (!p.ok) throw new Error(p.error)
  return p
}

async function printed(argv: string[], result: Record<string, unknown>): Promise<{ code: number; out: string; sent: Record<string, unknown> }> {
  let out = ''
  let sent: Record<string, unknown> = {}
  const code = await runBrowser(parsed(argv), { call: async (_n, args) => { sent = args; return { ok: true, result } }, say: () => undefined, out: (t) => { out += t }, cwd: os.tmpdir() })
  return { code, out, sent }
}

describe('the shell words', () => {
  it('maps network, its bodies, console, resize and open --record to the op', () => {
    expect(parsed(['network', '--url', '/api/', '--method', 'POST', '--status', '4xx', '--type', 'XHR', '--limit', '20', '--include-static', '--tab', '3']).args)
      .toEqual({ action: 'network', url: '/api/', method: 'POST', status: '4xx', type: 'XHR', limit: 20, include_static: true, tab: 3 })
    expect(parsed(['network', '--status', '404']).args.status).toBe(404)
    expect(parsed(['network', '--stop']).args).toEqual({ action: 'network', stop: true })
    expect(parsed(['network-body', '1234.5', '--max-chars', '500000']).args).toEqual({ action: 'network_body', request_id: '1234.5', max_chars: 500_000 })
    expect(parsed(['network-request-body', '77.1']).args).toEqual({ action: 'network_request_body', request_id: '77.1' })
    expect(parsed(['console', '--level', 'error', '--limit', '5']).args).toEqual({ action: 'console', level: 'error', limit: 5 })
    expect(parsed(['resize', '1280', '900']).args).toEqual({ action: 'resize', width: 1280, height: 900 })
    expect(parsed(['resize', '1024x768', '--viewport']).args).toEqual({ action: 'resize', width: 1024, height: 768, viewport: true })
    expect(parsed(['open', 'https://portal.example.test/', '--record']).args).toEqual({ action: 'open', url: 'https://portal.example.test/', record: true })
  })

  it('upload names a hidden file field by a CSS selector', () => {
    const p = parsed(['upload', '--selector', '#image-upload-field', './a.png'])
    expect(p.args).toEqual({ action: 'upload', selector: '#image-upload-field' })
    expect(p.upload).toEqual(['./a.png'])
    expect(parsed(['upload', 'e5', './a.png']).args).toEqual({ action: 'upload', ref: 'e5' })
  })

  it('says what is missing', () => {
    expect(parseBrowserArgv(['resize', 'wide'])).toMatchObject({ ok: false, error: expect.stringMatching(/width and a height/) })
    expect(parseBrowserArgv(['network-body'])).toMatchObject({ ok: false, error: expect.stringMatching(/request id/) })
    expect(parseBrowserArgv(['upload', './a.png'])).toMatchObject({ ok: false, error: expect.stringMatching(/--selector/) })
  })

  it('upload --selector reads the file here and sends its bytes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-up-sel-'))
    fs.writeFileSync(path.join(dir, 'a.png'), 'png-bytes')
    let sent: Record<string, unknown> = {}
    await runBrowser(parsed(['upload', '--selector', 'input[type=file]', 'a.png']), {
      call: async (_n, args) => { sent = args; return { ok: true, result: { uploaded: ['a.png (9 bytes)'] } } }, say: () => undefined, out: () => undefined, cwd: dir,
    })
    expect(sent).toMatchObject({ action: 'upload', selector: 'input[type=file]', files: [{ name: 'a.png', type: 'image/png', base64: Buffer.from('png-bytes').toString('base64') }] })
  })
})

describe('what the shell prints', () => {
  it('a request a line; a body as it came; console messages with their level', async () => {
    const net = await printed(['network'], {
      since: '2026-11-07T08:00:00.000Z', total: 3, matched: 2,
      requests: [{ id: '10.1', status: 200, method: 'GET', type: 'Fetch', ms: 41, url: 'https://portal.example.test/api/records' }, { id: '10.2', method: 'POST', type: 'XHR', failed: 'canceled', url: 'https://portal.example.test/api/note' }],
    })
    expect(net.code).toBe(BROWSER_EXIT.ok)
    expect(net.out).toContain('2 of 2 matching, 3 recorded since 2026-11-07T08:00:00.000Z')
    expect(net.out).toContain('10.1  200  GET  Fetch  41 ms  https://portal.example.test/api/records')
    expect(net.out).toContain('10.2  failed (canceled)  POST')
    const body = await printed(['network-body', '10.1'], { body: '{"items":[1,2]}', length: 15 })
    expect(body.out).toBe('{"items":[1,2]}\n')
    const cut = await printed(['network-body', '10.1'], { body: 'abc', length: 9, cut: true })
    expect(cut.out).toContain('[cut at 3 of 9 characters: --max-chars reads more]')
    const con = await printed(['console'], { since: 'x', total: 1, messages: [{ level: 'error', text: 'demo error 42', where: 'https://x.test/a.js:3' }] })
    expect(con.out).toContain('[error] demo error 42  (https://x.test/a.js:3)')
    const size = await printed(['resize', '1000', '700'], { width: 1000, height: 700, viewport: { width: 984, height: 580 } })
    expect(size.out).toBe('ok  window 1000x700, page 984x580\n')
    const rec = await printed(['open', 'https://portal.example.test/', '--record'], { tab: 4, where: 'In Walnut\'s agent window (behind theirs, not minimized), tab 4.', recording: true })
    expect(rec.out).toContain('Recording its requests and console')
  })

  it('a refusal that sends the agent to the person exits 1 and passes their step on', async () => {
    let said = ''
    const code = await runBrowser(parsed(['network']), {
      call: async () => ({ ok: false, code: 'trusted_off', message: 'Recording ... turn on "Let agents use real mouse and keys" ...' }),
      say: (l) => { said += l }, out: () => undefined, cwd: os.tmpdir(),
    })
    expect(code).toBe(BROWSER_EXIT.refused)
    expect(said).toContain('Let agents use real mouse and keys')
    for (const c of ['not_agent_opened', 'filled_here', 'recording_cancelled', 'person_window']) {
      expect(await runBrowser(parsed(['network']), { call: async () => ({ ok: false, code: c, message: c }), say: () => undefined, out: () => undefined, cwd: os.tmpdir() })).toBe(BROWSER_EXIT.refused)
    }
  })
})

describe('what the route passes to the browser', () => {
  it('keeps the new keys, each of its own type and cut to size', () => {
    expect(cleanArgs({ action: 'network', url: '/api/', method: 'POST', status: '4xx', type: 'XHR', include_static: true, limit: 20, stop: false, junk: 1 }))
      .toEqual({ url: '/api/', method: 'POST', status: '4xx', type: 'XHR', include_static: true, limit: 20, stop: false })
    expect(cleanArgs({ action: 'network_body', request_id: 'r'.repeat(300), max_chars: 5000 })).toEqual({ request_id: 'r'.repeat(100), max_chars: 5000 })
    expect(cleanArgs({ action: 'upload', selector: 's'.repeat(900) }).selector).toHaveLength(500)
    expect(cleanArgs({ action: 'resize', width: 1000, height: '700', viewport: 'yes' })).toEqual({ width: 1000 })
    expect(cleanArgs({ action: 'open', url: 'portal.example.test', record: true })).toEqual({ url: 'https://portal.example.test', record: true })
    expect(cleanArgs({ action: 'console', level: { x: 1 }, status: [1] })).toEqual({})
  })
})

describe('the op\'s outcome', () => {
  it('says what came back, and closes a tab by its own id', async () => {
    const { getOp } = await import('../../../src/ops/registry.js')
    await import('../../../src/ops/browser.js')
    const op = getOp('browser')!
    const out = (body: Record<string, unknown>, args: Record<string, unknown>) => op.mapResult!({ body, args } as never) as { outcome: string; next: string }
    expect(out({ tab: 4, since: 'T', total: 9, matched: 2, requests: [{}, {}] }, { action: 'network' }).outcome).toBe('2 of 2 matching request(s) (tab 4), of 9 recorded since T.')
    expect(out({ tab: 4, stopped: true }, { action: 'network', stop: true }).outcome).toMatch(/^Stopped recording/)
    expect(out({ request_id: '1.2', length: 40, base64: true }, { action: 'network_body' }).outcome).toBe('Response body of 1.2 (40 characters, base64).')
    expect(out({ tab: 4, total: 3, since: 'T', messages: [{}] }, { action: 'console' }).outcome).toBe('1 console message(s) (tab 4), of 3 since T.')
    expect(out({ tab: 4, width: 1000, height: 700, viewport: { width: 984, height: 580 } }, { action: 'resize' }).outcome).toBe('The agent window is 1000x700; the page sees 984x580 (tab 4).')
    expect(out({ tab: 4, closed: true }, { action: 'close' }).outcome).toBe('Closed tab 4.')
    expect(out({ tab: 4, where: 'In Walnut\'s agent window, tab 4.', record_refused: { message: 'Real input is off.' } }, { action: 'open' }).outcome).toBe('In Walnut\'s agent window, tab 4. Not recording: Real input is off.')
  })
})
