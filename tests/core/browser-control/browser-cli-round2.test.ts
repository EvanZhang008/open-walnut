/**
 * `walnut browser` words a person and an agent read (core/browser-control/browser-cli.ts,
 * act-args.ts, gone-words.ts): --help prints the usage alone and exits 0; an address typed
 * without a scheme opens over https (localhost over http), a word that is no address is refused
 * with how to give one; status names a browser the person disconnected or turned off.
 */
import { describe, expect, it } from 'vitest'
import os from 'node:os'
import { BROWSER_EXIT, BROWSER_USAGE, browserParseOutcome, parseBrowserArgv, runBrowser } from '../../../src/core/browser-control/browser-cli'
import { cleanArgs, webAddress } from '../../../src/core/browser-control/act-args'
import { noBrowserLine } from '../../../src/core/browser-control/gone-words'

describe('walnut browser --help', () => {
  it.each([['--help'], ['-h'], ['help'], ['click', '--help']])('%s prints the usage only, to stdout, exit 0', (...argv) => {
    const p = parseBrowserArgv(argv)
    expect(p).toMatchObject({ ok: false, help: true })
    if (p.ok) throw new Error('parsed')
    const o = browserParseOutcome(p)
    expect(o).toEqual({ stdout: `${BROWSER_USAGE}\n`, code: BROWSER_EXIT.ok })
    expect(o.stdout).not.toContain('unknown option')
  })

  it('a real mistake still goes to stderr with the usage, exit 3', () => {
    const p = parseBrowserArgv(['--nope'])
    if (p.ok) throw new Error('parsed')
    expect(browserParseOutcome(p)).toEqual({ stderr: `walnut browser: unknown option --nope\n${BROWSER_USAGE}\n`, code: BROWSER_EXIT.error })
  })

  it('the exit codes say a choice to make is not a refusal of the person', () => {
    expect(BROWSER_USAGE).toContain('1 refused or a choice to make')
  })
})

describe('an address without a scheme', () => {
  it.each([
    ['example.com', 'https://example.com'],
    ['shop.example.com/cart?x=1', 'https://shop.example.com/cart?x=1'],
    ['news.example.test:8080/a', 'https://news.example.test:8080/a'],
    ['localhost:3000/x', 'http://localhost:3000/x'],
    ['127.0.0.1:5173', 'http://127.0.0.1:5173'],
    ['https://example.com/', 'https://example.com/'],
    ['http://example.com/', 'http://example.com/'],
    ['  example.com  ', 'https://example.com'],
  ])('%s opens %s', (raw, want) => {
    expect(webAddress(raw)).toBe(want)
  })

  it('a word that is no address is refused, saying how to give one', () => {
    let err: unknown
    try { webAddress('notaurl') } catch (e) { err = e }
    expect(err).toMatchObject({ code: 'not_a_web_page', status: 400 })
    expect((err as Error).message).toContain('https://example.com')
  })

  it('only open and navigate are addresses: wait --url keeps its part or /regex/', () => {
    expect(cleanArgs({ action: 'navigate', url: 'example.com' }).url).toBe('https://example.com')
    expect(cleanArgs({ action: 'open', url: 'example.com/x' }).url).toBe('https://example.com/x')
    expect(cleanArgs({ action: 'wait', url: '/checkout' }).url).toBe('/checkout')
    expect(cleanArgs({ action: 'wait', url: '/done\\/\\d+/' }).url).toBe('/done\\/\\d+/')
  })
})

describe('status when no browser lets agents in', () => {
  it('names a browser the person disconnected, or turned off', () => {
    expect(noBrowserLine({ label: 'Walnut extension (Chrome on Linux)', why: 'disconnected' }))
      .toBe('Not connected: the person disconnected Walnut extension (Chrome on Linux) from Walnut. Ask them to connect it again (the Walnut extension popup, Connect).')
    expect(noBrowserLine({ label: 'Walnut extension (Chrome on Linux)', why: 'off' })).toContain('turned agents off')
    expect(noBrowserLine()).toContain('No browser lets agents in now')
  })

  it('walnut browser status prints it', async () => {
    const p = parseBrowserArgv(['status'])
    if (!p.ok) throw new Error('parse')
    let out = ''
    const code = await runBrowser(p, {
      call: async () => ({ ok: true, result: { browsers: [], mode: 'any', sites: [], gone: { label: 'Walnut extension (Chrome on Linux)', why: 'disconnected', at: new Date().toISOString() } } }),
      say: () => undefined, out: (t) => { out += t }, cwd: os.tmpdir(),
    })
    expect(code).toBe(0)
    expect(out).toContain('Not connected: the person disconnected Walnut extension (Chrome on Linux)')
    expect(out).not.toContain('Connected:')
  })
})
