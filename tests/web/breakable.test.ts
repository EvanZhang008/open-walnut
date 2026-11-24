import { describe, expect, it } from 'vitest'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import { Breakable } from '../../web/src/components/common/Breakable'

const html = (text: string) => renderToStaticMarkup(createElement(Breakable, { text }))

// Breakable wraps a path after its separators, never inside a file name: a break after a
// dot split `settings.json` into `settings.` and `json` in the engine settings Files list.
describe('Breakable', () => {
  it('breaks after slashes, dashes and underscores', () => {
    expect(html('repo/my-branch_x')).toBe('repo/<wbr/>my-<wbr/>branch_<wbr/>x')
  })

  it('never breaks after a dot, so a file name keeps its extension', () => {
    const out = html('~/repo/.claude/settings.local.json')
    expect(out).toBe('~/<wbr/>repo/<wbr/>.claude/<wbr/>settings.local.json')
    for (const name of ['settings.json', 'package.lock.json', 'a.b.c.d']) expect(html(name)).toBe(name)
  })

  it('keeps the text unchanged', () => {
    const text = 'a/b-c_d.e/f'
    expect(html(text).replace(/<wbr\/>/g, '')).toBe(text)
  })
})
