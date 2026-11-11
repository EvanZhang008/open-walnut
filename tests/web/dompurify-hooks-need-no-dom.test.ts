/**
 * A module that registers a DOMPurify hook at import dies in a node-env test whose import graph
 * reaches it ("addHook is not a function": DOMPurify has no hooks without a DOM). Settings
 * pulled markdown.ts in through AgentText and its registry test failed to collect. So every
 * hook registration in web/src is guarded, and the renderers import with no DOM at all.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const WEB = path.resolve(__dirname, '../../web/src')

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(full)
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : []
  })
}

describe('DOMPurify hooks at module scope', () => {
  it('every addHook call checks isSupported on its own line', () => {
    const bare: string[] = []
    for (const file of sources(WEB)) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (/\.addHook\(/.test(line) && !/\.isSupported\b/.test(line) && !line.trim().startsWith('*') && !line.trim().startsWith('//')) {
          bare.push(`${path.relative(WEB, file)}:${index + 1}`)
        }
      })
    }
    expect(bare, 'guard each hook with `if (purify.isSupported)` so the module imports without a DOM').toEqual([])
  })

  it('the markdown renderers import with no DOM', async () => {
    expect(typeof document).toBe('undefined')
    await expect(import('../../web/src/utils/markdown')).resolves.toBeDefined()
    await expect(import('../../web/src/components/notes/notes-markdown')).resolves.toBeDefined()
  })
})
