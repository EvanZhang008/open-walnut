/**
 * C75: the browser reads the SAME module the server words its 409 with. The
 * web alias `@open-walnut/host-problem` must resolve to src/core/hosts/host-problem.ts
 * in every config (vite, web tsconfig, the three vitest configs), and at test
 * time it is literally the same module instance as the server's relative import.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as viaAlias from '@open-walnut/host-problem'
import * as viaServer from '../../../src/core/hosts/host-problem.js'

const root = path.resolve(import.meta.dirname, '../../..')
const target = path.join(root, 'src/core/hosts/host-problem.ts')

describe('@open-walnut/host-problem alias', () => {
  it('is the same module instance as the server import', () => {
    expect(viaAlias.hostFailureHeadline).toBe(viaServer.hostFailureHeadline)
    expect(viaAlias.hostProblemOf).toBe(viaServer.hostProblemOf)
    expect(viaAlias.hostGateBody).toBe(viaServer.hostGateBody)
  })

  it('every config points the alias at the same file', () => {
    const vite = readFileSync(path.join(root, 'web/vite.config.ts'), 'utf8')
    const m = vite.match(/'@open-walnut\/host-problem':\s*path\.resolve\(__dirname,\s*'([^']+)'\)/)
    expect(m).not.toBeNull()
    expect(path.resolve(root, 'web', m![1])).toBe(target)

    const tsconfig = JSON.parse(readFileSync(path.join(root, 'web/tsconfig.json'), 'utf8'))
    const p = tsconfig.compilerOptions.paths['@open-walnut/host-problem']
    expect(path.resolve(root, 'web', p[0]) + '.ts').toBe(target)

    for (const cfg of ['vitest.config.ts', 'vitest.focus.config.ts', 'vitest.quick.config.ts']) {
      const src = readFileSync(path.join(root, cfg), 'utf8')
      const hit = src.match(/'@open-walnut\/host-problem':\s*path\.resolve\(import\.meta\.dirname,\s*'([^']+)'\)/)
      expect(hit, cfg).not.toBeNull()
      expect(path.resolve(root, hit![1])).toBe(target)
    }
  })
})
