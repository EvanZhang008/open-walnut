/**
 * The JS twin (daemon-source.ts) inlines its shared cores by their function's source
 * (`createX.toString()`), so only that function's body reaches it: a name the body reads from its
 * own module's top level (a constant beside the function, a helper) is undefined in the JS twin
 * and throws there, while the bun twin, which imports the module whole, works. 2026-11-23: a floor
 * constant declared beside createFollowerGateway made the JS twin's companion relay throw and every
 * such call hang; only the twins' integration test caught it.
 *
 * Guard: no inlined function's body names a runtime binding declared at its module's top level.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const TWIN = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-source.ts'), 'utf8')

/** The functions the JS twin inlines (`['__X__', fn.toString()]`), with the module each comes from. */
function inlined(): Array<{ fn: string; file: string }> {
  const fns = [...TWIN.matchAll(/\['__[A-Z0-9_]+__', (\w+)\.toString\(\)\]/g)].map((m) => m[1]!)
  const out: Array<{ fn: string; file: string }> = []
  for (const fn of fns) {
    const imp = new RegExp(`^import \\{[^}]*\\b${fn}\\b[^}]*\\} from '(\\.{1,2}/[^']+)\\.js'`, 'm').exec(TWIN)
    // One with no import found stays in with no file, so the check names it instead of skipping it.
    out.push({ fn, file: imp ? path.join(ROOT, 'src/providers', `${imp[1]}.ts`) : '' })
  }
  return out
}

/** Runtime names declared at a module's top level (not types), besides `except`. */
function topLevelNames(src: string, except: string): string[] {
  const names = new Set<string>()
  for (const m of src.matchAll(/^(?:export )?(?:const|let|var|function|async function|class) (\w+)/gm)) names.add(m[1]!)
  names.delete(except)
  return [...names]
}

describe('the JS twin inlines self-contained functions', () => {
  const all = inlined()

  it('finds the inlined cores (the scan still sees them)', () => {
    expect(all.length).toBeGreaterThan(20)
    expect(all.map((x) => x.fn)).toContain('createFollowerGateway')
  })

  it('no inlined function reads a top-level binding of its own module', async () => {
    const bad: string[] = []
    for (const { fn, file } of all) {
      if (!file || !fs.existsSync(file)) { bad.push(`${fn}: its module was not found from daemon-source.ts's imports (${file || 'no import'})`); continue }
      const src = fs.readFileSync(file, 'utf8')
      // The very text the JS twin inlines: the function's own source, as the runtime gives it.
      const mod = await import(file) as Record<string, unknown>
      const own = mod[fn]
      if (typeof own !== 'function') { bad.push(`${path.relative(ROOT, file)}: ${fn} is not exported as a function`); continue }
      // Its code only: comments and the text of plain string literals (a template with no ${} too) out (a name said in words reads nothing).
      const body = own.toString().replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
        .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.|\$(?!\{))*`/g, "''")
      for (const name of topLevelNames(src, fn)) {
        // Declared again inside the body (its own copy), or one the JS twin declares at its own top level.
        if (new RegExp(`(?:const|let|var|function|class)\\s+${name}\\b`).test(body)) continue
        if (new RegExp(`(?:^|\\n)\\s*(?:var|function|const|let) ${name}\\b`).test(TWIN) || new RegExp(`\\b${name}\\.toString\\(\\)`).test(TWIN)) continue
        if (new RegExp(`(?<![.\\w$])${name}\\b(?!\\s*:)`).test(body)) bad.push(`${path.relative(ROOT, file)}: ${fn} reads ${name}`)
      }
    }
    expect(bad, 'pass it in (a dependency) or declare it inside the function').toEqual([])
  })
})
