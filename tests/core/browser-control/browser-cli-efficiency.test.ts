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
import { BROWSER_EXIT, BROWSER_USAGE, GUIDE_SKILL, parseBrowserArgv, runBrowser } from '../../../src/core/browser-control/browser-cli'

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
    expect(first.length).toBeLessThanOrEqual(12)
    expect(first.map((l) => l.trim().split(/\s/)[0])).toEqual(['open', 'snapshot', 'click', 'type', 'text', 'find', 'wait', 'close', 'e.g.', 'e.g.', 'Two'])
    expect(BROWSER_USAGE).toContain('open https://example.com/issues --read')
    // A short read on open and click, with an example (2026-11-10 review: 4,300 characters for one fact).
    expect(first.find((l) => l.trim().startsWith('open'))).toContain('[--read [--max N]]')
    expect(first.find((l) => l.trim().startsWith('click'))).toContain('[--read [--max N]]')
    expect(BROWSER_USAGE).toMatch(/open https:\/\/\S+ --read --max 800/)
    // Several tabs or subagents at once: every command names its tab (2026-11-10: a subagent's bare close closed the main agent's tab).
    expect(first.at(-1)).toMatch(/subagents in the browser at once: every command names its tab with --tab N \(open prints N\)/)
    expect(lines.every((l) => l.length <= 130)).toBe(true)
  })
})

describe('the guide and the exit codes', () => {
  it('the usage\'s first line names the guide; exit 2 is no answer in time, 3 an error, a wait that did not come included', () => {
    expect(BROWSER_USAGE.split('\n')[0]).toMatch(/walnut browser guide/)
    expect(BROWSER_USAGE).toMatch(/2 Walnut or the browser did not answer in time \(run it again\); 3 an error, a wait whose text or\n\s+address did not come included/)
  })

  it('walnut browser guide prints the skill as plain markdown, without its front matter or JSON', async () => {
    const p = parseBrowserArgv(['guide'])
    expect(p).toMatchObject({ ok: true, op: 'skill_read', args: { dirName: GUIDE_SKILL }, guide: true })
    if (!p.ok) return
    let text = ''
    let asked: unknown
    const content = '---\nname: walnut-browser\ndescription: >-\n  x\n---\n\n# The user\'s browser for agents\n\n## Quick start\n\nThree calls read a page "quoted".\n'
    const code = await runBrowser(p, { call: async (name, args) => { asked = { name, args }; return { ok: true, result: { skill: { content } } } }, say: () => undefined, out: (t) => { text += t }, cwd: os.tmpdir() })
    expect(code).toBe(BROWSER_EXIT.ok)
    expect(asked).toEqual({ name: 'skill_read', args: { dirName: 'walnut-browser' } })
    expect(text).toBe('# The user\'s browser for agents\n\n## Quick start\n\nThree calls read a page "quoted".\n')
    let said = ''
    expect(await runBrowser(p, { call: async () => ({ ok: true, result: {} }), say: (l) => { said += l }, out: () => undefined, cwd: os.tmpdir() })).toBe(BROWSER_EXIT.error)
    expect(said).toMatch(/no walnut-browser skill/)
  })

  it('walnut browser guide more prints the reference file; the short guide and help stay small (2026-11-11: 16.8 KB skill)', async () => {
    const p = parseBrowserArgv(['guide', 'more'])
    expect(p).toMatchObject({ ok: true, op: 'api', args: { method: 'GET', path: '/api/v1/skills/walnut-browser/references/more.md' }, guide: true })
    if (!p.ok) return
    let text = ''
    expect(await runBrowser(p, { call: async () => ({ ok: true, result: { content: '# The rest\n\nDialogs.\n' } }), say: () => undefined, out: (t) => { text += t }, cwd: os.tmpdir() })).toBe(BROWSER_EXIT.ok)
    expect(text).toBe('# The rest\n\nDialogs.\n')
    const fs = await import('node:fs')
    const dir = 'src/data/skills/walnut-browser'
    // The guide every agent reads first, and the usage: budgets an addition must earn.
    expect(fs.readFileSync(`${dir}/SKILL.md`, 'utf8').length).toBeLessThan(6000)
    expect(BROWSER_USAGE.length).toBeLessThan(3000)
    const more = fs.readFileSync(`${dir}/references/more.md`, 'utf8')
    for (const w of ['dialog', '--record', 'network-body', 'take <tab>', 'upload', 'click-label']) expect(more).toContain(w)
  })

  it('a wait whose text never came exits 3 (an error to look at), a call with no answer in time exits 2', async () => {
    const run = async (code: string) => {
      const p = parseBrowserArgv(['wait', 'Never there', '--ms', '500'])
      if (!p.ok) throw new Error(p.error)
      return runBrowser(p, { call: async () => ({ ok: false, code, message: 'x' }), say: () => undefined, out: () => undefined, cwd: os.tmpdir() })
    }
    expect(await run('wait_timeout')).toBe(3)
    expect(await run('browser_timeout')).toBe(2)
  })

  it('the skill on disk leads with a quick start a model reads in 40 lines', async () => {
    const fs = await import('node:fs')
    const md = fs.readFileSync('src/data/skills/walnut-browser/SKILL.md', 'utf8')
    const body = md.replace(/^---\n[\s\S]*?\n---\n+/, '').split('\n').slice(0, 40).join('\n')
    expect(body).toMatch(/## Quick start/)
    for (const step of ['open https://', '--read', 'click --text', 'close', 'walnut browser guide']) expect(body).toContain(step)
  })
})

describe('parsing', () => {
  it('--read and --max on any step; text e12 reads that element', () => {
    expect(parseBrowserArgv(['open', 'https://x.test', '--read'])).toMatchObject({ args: { action: 'open', url: 'https://x.test', read_text: true } })
    expect(parseBrowserArgv(['click', '--text', 'Issues', '--read', '--max', '900'])).toMatchObject({ args: { action: 'click', text: 'Issues', read_text: true, max: 900 } })
    expect(parseBrowserArgv(['open', 'https://x.test', '--read', '--max', '800'])).toMatchObject({ args: { action: 'open', url: 'https://x.test', read_text: true, max: 800 } })
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

  it('a typed text that submits: what was typed, then what its Enter did; a pressed Enter says it once', async () => {
    expect(await out(['type', 'e17', 'walnut personal ai', '--submit'], { tab: 7, typed: '18 characters into textbox "Search GitHub"', changed: 'Enter: went to https://x.test/search?q=walnut' }))
      .toBe('ok  typed 18 characters into textbox "Search GitHub"; Enter: went to https://x.test/search?q=walnut  [tab 7]\n')
    const quiet = await out(['type', 'e17', 'cats', '--submit'], { tab: 7, typed: '4 characters into textbox "Search"', changed: 'Enter changed nothing on the page (no navigation, nothing submitted; the text is in the field): click the search or submit button beside it (find search), or open the results address directly' })
    expect(quiet).toMatch(/^ok {2}typed 4 characters into textbox "Search"; Enter changed nothing on the page \(no navigation/)
    expect(quiet).not.toContain('page content changed')
    expect(await out(['press', 'Enter'], { tab: 7, pressed: 'Enter', changed: 'Enter: went to https://x.test/s' })).toBe('ok  pressed Enter: went to https://x.test/s  [tab 7]\n')
    expect(await out(['press', 'Enter'], { tab: 7, pressed: 'Enter', changed: 'Enter changed nothing on the page (no navigation, nothing submitted; the text is in the field): x' }))
      .toBe('ok  pressed Enter: changed nothing on the page (no navigation, nothing submitted; the text is in the field): x  [tab 7]\n')
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
      .toContain('The step was done, but its page was not read: no time')
  })

  it('a step done whose --read failed exits with the read\'s code, not 0 (2026-11-11: a cheap model took it as read)', async () => {
    const code = async (result: Record<string, unknown>) => {
      const p = parseBrowserArgv(['open', 'https://x.test', '--read'])
      if (!p.ok) throw new Error(p.error)
      return runBrowser(p, { call: async () => ({ ok: true, result }), say: () => undefined, out: () => undefined, cwd: os.tmpdir() })
    }
    const opened = { tab: 7, where: 'In Walnut\'s agent window, tab 7' }
    expect(await code({ ...opened, page_text: { tab: 7, text: 'Hi' } })).toBe(BROWSER_EXIT.ok)
    expect(await code({ ...opened, page_text: { tab: 7, error: 'Tab 7 was closed in the browser', code: 'not_your_tab' } })).toBe(BROWSER_EXIT.refused)
    expect(await code({ ...opened, page_text: { tab: 7, error: 'no time', code: 'browser_timeout' } })).toBe(BROWSER_EXIT.timeout)
    expect(await code({ ...opened, page_text: { tab: 7, error: 'broke', code: 'page_error' } })).toBe(BROWSER_EXIT.error)
    expect(BROWSER_USAGE).toMatch(/A --read whose read failed exits with the\s+read's code/)
  })
})

describe('find and refusals', () => {
  it('find says how many more matched, and how to narrow', async () => {
    const t = await out(['find', 'checkout'], { matches: [{ ref: 'e1', role: 'button', name: 'Checkout', text: 'Checkout' }], count: 13 })
    expect(t).toBe('[e1] button "Checkout"\n… 12 more match(es): --limit N, or --role button / --exact to narrow\n')
  })

  it('find that matched by the words on controls says so first', async () => {
    const t = await out(['find', 'search', 'box'], { matches: [{ ref: 'e17', role: 'textbox', name: 'Search GitHub', text: '' }], count: 1, by_words: 'search' })
    expect(t).toBe('Nothing has those words together; controls named with "search":\n[e17] textbox "Search GitHub"\n')
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
