/**
 * The browser reads the SAME asks-list module the server answers GET /api/v1/asks
 * with. The web alias `@open-walnut/ask-list` must resolve to
 * src/core/sessions/ask-list.ts in every config (vite, web tsconfig, the three
 * vitest configs), and at test time it is literally the same module instance as
 * the server's relative import, so the two drawers cannot drift.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as viaAlias from '@open-walnut/ask-list'
import * as viaServer from '../../../src/core/sessions/ask-list.js'
import * as askAgent from '../../../src/core/sessions/ask-agent.js'

const root = path.resolve(import.meta.dirname, '../../..')
const target = path.join(root, 'src/core/sessions/ask-list.ts')

describe('@open-walnut/ask-list alias', () => {
  it('is the same module instance as the server import, and ask-agent re-exports its naming rule', () => {
    expect(viaAlias.selectAsks).toBe(viaServer.selectAsks)
    expect(viaAlias.compareAsks).toBe(viaServer.compareAsks)
    expect(viaAlias.askState).toBe(viaServer.askState)
    expect(askAgent.askProjectFor).toBe(viaServer.askProjectFor)
  })

  it('every config points the alias at the same file', () => {
    const vite = readFileSync(path.join(root, 'web/vite.config.ts'), 'utf8')
    const m = vite.match(/'@open-walnut\/ask-list':\s*path\.resolve\(__dirname,\s*'([^']+)'\)/)
    expect(m).not.toBeNull()
    expect(path.resolve(root, 'web', m![1])).toBe(target)

    const tsconfig = JSON.parse(readFileSync(path.join(root, 'web/tsconfig.json'), 'utf8'))
    const p = tsconfig.compilerOptions.paths['@open-walnut/ask-list']
    expect(path.resolve(root, 'web', p[0]) + '.ts').toBe(target)

    for (const cfg of ['vitest.config.ts', 'vitest.focus.config.ts', 'vitest.quick.config.ts']) {
      const src = readFileSync(path.join(root, cfg), 'utf8')
      const hit = src.match(/'@open-walnut\/ask-list':\s*path\.resolve\(import\.meta\.dirname,\s*'([^']+)'\)/)
      expect(hit, cfg).not.toBeNull()
      expect(path.resolve(root, hit![1])).toBe(target)
    }
  })
})
