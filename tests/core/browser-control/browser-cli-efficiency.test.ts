/**
 * `walnut browser` made quick for an agent (src/core/browser-control/browser-cli.ts; 2026-11-10: a
 * read-only task took 16 calls and its --help was guessed at): the usage leads with the commands
 * needed first, one line each; `--read` and `--max` parse; `text e12` reads one element; every
 * acting step prints one line of what it did and what changed, a step real input could not do says
 * why, and "nothing changed" says not to wait; `find` says how many more matched; a covered window's
 * refusal exits as a refusal (1).
 */
import { describe, expect, it } from 'vitest'
import os from 'node:os'
import { BROWSER_EXIT, BROWSER_USAGE, parseBrowserArgv, runBrowser } from '../../../src/core/browser-control/browser-cli'

async function out(argv: string[], result: Record<string, unknown>): Promise<string> {
  const p = parseBrowserArgv(argv)
  if (!p.ok) throw new Error(p.error)
  let text = ''
  await runBrowser(p, { call: async () => ({ ok: true, result }), say: () => undefined, out: (t) => { text += t }, cwd: os.tmpdir() })
  return text
}

describe('the usage', () => {
  it('leads with the commands an agent needs first, task-ordered, one line each, with an example', () => {
    const lines = BROWSER_USAGE.split('\n')
    const start = lines.findIndex((l) => l.startsWith('Start here'))
    const more = lines.findIndex((l) => l === 'More:')
    expect(start).toBe(1)
    const first = lines.slice(start + 1, more)
    expect(first.length).toBeLessThanOrEqual(11)
    expect(first.map((l) => l.trim().split(/\s/)[0])).toEqual(['open', 'snapshot', 'click', 'type', 'text', 'find', 'wait', 'close', 'e.g.'])
    expect(BROWSER_USAGE).toContain('open https://example.com/issues --read')
    expect(lines.every((l) => l.length <= 130)).toBe(true)
  })
})

describe('parsing', () => {
  it('--read and --max on any step; text e12 reads that element', () => {
    expect(parseBrowserArgv(['open', 'https://x.test', '--read'])).toMatchObject({ args: { action: 'open', url: 'https://x.test', read_text: true } })
    expect(parseBrowserArgv(['click', '--text', 'Issues', '--read', '--max', '900'])).toMatchObject({ args: { action: 'click', text: 'Issues', read_text: true, max: 900 } })
    expect(parseBrowserArgv(['text', 'f3:e12'])).toMatchObject({ args: { action: 'text', ref: 'f3:e12' } })
    expect(parseBrowserArgv(['text', '--selector', 'article p', '--all'])).toMatchObject({ args: { action: 'text', selector: 'article p', all: true } })
    expect(parseBrowserArgv(['text', '--max', 'lots'])).toMatchObject({ ok: false, error: '--max takes a whole number (characters for text, elements for snapshot)' })
    expect(parseBrowserArgv(['text', 'article'])).toMatchObject({ ok: false, error: expect.stringMatching(/^text takes a ref \(e12\) from snapshot, or --selector css/) })
  })
})

describe('what an acting step prints', () => {
  it('one line: what it did and what changed', async () => {
    expect(await out(['click', 'e5'], { tab: 7, clicked: 'link "Issues"', changed: 'went to https://x.test/issues "Issues"', url: 'https://x.test/issues' }))
      .toBe('ok  clicked link "Issues": went to https://x.test/issues "Issues"  [tab 7]\n')
    expect(await out(['type', 'e2', 'hi'], { tab: 7, typed: '2 characters into textbox "Search"', changed: 'a field\'s value changed' }))
      .toBe('ok  typed 2 characters into textbox "Search": a field\'s value changed  [tab 7]\n')
  })

  it('nothing changed says not to wait; trusted false says why; a match it chose is named', async () => {
    const t = await out(['click', '--text', 'Next'], { tab: 7, clicked: 'button "Next"', changed: 'nothing changed on the page', trusted: false, why: 'the agent window is covered; Chrome drops real input there, so page events were used', matched: { ref: 'e9', of: 3 } })
    expect(t).toContain('ok  clicked button "Next": nothing changed on the page  [tab 7]')
    expect(t).toContain('(the best of 3 matches, e9)')
    expect(t).toContain('(trusted false: the agent window is covered')
    expect(t).toContain('(no change in its text, fields, scroll or address: nothing to wait for; snapshot to check before acting again)')
  })

  it('a new tab is said once; an older extension\'s answer (no line) shows the address', async () => {
    const t = await out(['click', 'e2'], { tab: 3, clicked: 'link "Help"', changed: 'opened a new tab 9: https://x.test/help (yours too: --tab 9)', opened: { tab: 9, url: 'https://x.test/help' } })
    expect(t.match(/tab 9/g)?.length).toBe(2)
    expect(await out(['click', 'e2'], { tab: 3, clicked: 'link "Help"', url: 'https://x.test/a' })).toBe('ok  clicked link "Help"  [tab 3 at https://x.test/a]\n')
  })

  it('--read prints the page\'s text under the step\'s line, or why it could not', async () => {
    expect(await out(['open', 'https://x.test', '--read'], { tab: 7, where: 'In Walnut\'s agent window, tab 7', page_text: { tab: 7, text: 'First paragraph.', scope: 'main content' } }))
      .toBe('ok  In Walnut\'s agent window, tab 7\n\n== main content ==\nFirst paragraph.\n')
    expect(await out(['click', 'e1', '--read'], { tab: 7, clicked: 'x', changed: 'the page content changed', page_text: { tab: 7, error: 'no time', code: 'browser_timeout' } }))
      .toContain('(could not read the page: no time)')
  })
})

describe('find and refusals', () => {
  it('find says how many more matched, and how to narrow', async () => {
    const t = await out(['find', 'checkout'], { matches: [{ ref: 'e1', role: 'button', name: 'Checkout', text: 'Checkout' }], count: 13 })
    expect(t).toBe('[e1] button "Checkout"\n… 12 more match(es): --limit N, or --role button / --exact to narrow\n')
  })

  it('window_hidden and input_dropped are refusals (exit 1), with the message as it came', async () => {
    const p = parseBrowserArgv(['click', 'e1', '--trusted'])
    if (!p.ok) throw new Error('parse')
    for (const code of ['window_hidden', 'input_dropped']) {
      let said = ''
      const r = await runBrowser(p, { call: async () => ({ ok: false, code, message: 'Chrome drops real input while Walnut\'s agent window is covered or minimized.' }), say: (l) => { said += l }, out: () => undefined, cwd: os.tmpdir() })
      expect(r).toBe(BROWSER_EXIT.refused)
      expect(said).toContain('covered or minimized')
    }
  })
})
