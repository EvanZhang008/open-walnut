/**
 * The CLI entries refuse Node before anything else loads (src/lib/entry-runtime.ts):
 * `node dist/cli.js --version` used to answer, so an install check on Node
 * passed and Walnut failed later, at its first database open. They also drop
 * BUN_BE_BUN, which a walnut file running a dist build as bun carries in its env
 * and every child it starts would inherit.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { realNodeOnPath } from '../../scripts/outside-node.mjs'
import { dropBunBeBun, runtimeRefusal } from '../../src/lib/entry-runtime.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
// The real Node, not the `node` shim `bun --bun` puts first on PATH (it is bun).
// CI's node-side job runs this file with WALNUT_REQUIRE_NODE=1 (test:source-twin-node-suites, the name the workflow calls), where a missing Node fails.
const NODE = realNodeOnPath()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-entry-runtime-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** The first import statement of a source file. */
function firstImport(file: string): string | undefined {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').find((line) => /^import\s/.test(line))
}

/** entry-runtime.ts as plain JS, the way a bundle carries it, beside the one module it imports. */
function builtModule(): string {
  const Transpiler = (globalThis as unknown as { Bun: { Transpiler: new (o: { loader: string }) => { transformSync(code: string): string } } }).Bun.Transpiler
  const transpile = (name: string) => new Transpiler({ loader: 'ts' }).transformSync(fs.readFileSync(path.join(ROOT, `src/lib/${name}.ts`), 'utf8'))
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}\n')
  fs.writeFileSync(path.join(tmp, 'jsc-ram-hint.js'), transpile('jsc-ram-hint'))
  const file = path.join(tmp, 'entry-runtime.js')
  fs.writeFileSync(file, transpile('entry-runtime'))
  return file
}

describe('the CLI entries run only on bun', () => {
  it('names bun and the walnut file to a Node, in one line, and lets bun through', () => {
    const refusal = runtimeRefusal({ node: '22.11.0' } as NodeJS.ProcessVersions)
    expect(refusal).toMatch(/^Walnut runs on bun or as the compiled walnut file, and this is Node 22\.11\.0: run the same command with bun/)
    expect(refusal).toContain('install.sh | sh')
    expect(refusal).not.toContain('\n')
    expect(runtimeRefusal({ node: '24.3.0', bun: '1.4.4' } as NodeJS.ProcessVersions)).toBeNull()
  })

  it('is the first import of src/cli.ts and src/cli-fast.ts, so it runs before any other module', () => {
    expect(firstImport('src/cli.ts')).toBe("import './lib/entry-runtime.js';")
    expect(firstImport('src/cli-fast.ts')).toBe("import './lib/entry-runtime.js';")
    // It must not depend on a Walnut module, which would load first: only the RAM hint,
    // which imports nothing of Walnut itself (tests/lib/jsc-ram-hint.test.ts).
    const imports = fs.readFileSync(path.join(ROOT, 'src/lib/entry-runtime.ts'), 'utf8').match(/^import .*$/gm) ?? []
    expect(imports).toEqual(["import fs from 'node:fs'", "import { startWithRamHint } from './jsc-ram-hint.js'"])
  })

  it('has a real Node to run on where one is required', () => {
    if (process.env.WALNUT_REQUIRE_NODE === '1') expect(NODE, 'WALNUT_REQUIRE_NODE=1, and there is no Node on PATH').not.toBeNull()
  })

  it.skipIf(!NODE)('on a real Node: exits 1 with the line on stderr and nothing on stdout', () => {
    const r = spawnSync(NODE!, [builtModule()], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr.trim().split('\n')).toHaveLength(1)
    expect(r.stderr).toMatch(/Walnut runs on bun or as the compiled walnut file, and this is Node \d+\./)
  })

  it('on bun: says nothing and goes on', () => {
    const r = spawnSync(process.execPath, ['-e', `await import(${JSON.stringify(builtModule())}); console.log('went on')`], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('went on')
    expect(r.stderr).toBe('')
  })

  it('drops BUN_BE_BUN, so no child of a walnut file running the build as bun is told to be bun', () => {
    const env: NodeJS.ProcessEnv = { BUN_BE_BUN: '1', OPEN_WALNUT_HOME: '/home/alice/.open-walnut' }
    expect(dropBunBeBun(env)).toBe(true)
    expect(env).toEqual({ OPEN_WALNUT_HOME: '/home/alice/.open-walnut' })
    expect(dropBunBeBun(env)).toBe(false)
    // A real process: started with BUN_BE_BUN=1 (as a box's smoke boot starts the
    // build), the entry module runs, and a child it starts afterwards has none.
    const probe = `await import(${JSON.stringify(builtModule())});` +
      "const { spawnSync } = await import('node:child_process');" +
      "const child = spawnSync('/usr/bin/env', [], { encoding: 'utf8' }).stdout;" +
      "console.log(JSON.stringify({ own: process.env.BUN_BE_BUN ?? null, child: /^BUN_BE_BUN=/m.test(child) }))"
    const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', env: { ...process.env, BUN_BE_BUN: '1' } })
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout.trim())).toEqual({ own: null, child: false })
  })

  it("takes the RAM hint a re-run set out of the env, so a child it starts has none; the person's own stays", () => {
    // A real process started as the re-run starts the server (the variable and its marker);
    // children through child_process and Bun.$ read process.env, which no longer has them.
    const probe = `await import(${JSON.stringify(builtModule())});` +
      "const { spawnSync } = await import('node:child_process');" +
      "const child = spawnSync('/usr/bin/env', [], { encoding: 'utf8' }).stdout;" +
      "const shell = await Bun.$`/usr/bin/env`.text();" +
      "const has = (t) => /^(BUN_JSC_forceRAMSize|WALNUT_JSC_RAM_HINT_APPLIED)=/m.test(t);" +
      "console.log(JSON.stringify({ own: process.env.BUN_JSC_forceRAMSize ?? null, child: has(child), shell: has(shell) }))"
    const run = (extra: NodeJS.ProcessEnv) => {
      const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', env: { ...process.env, ...extra } })
      expect(r.status, r.stderr).toBe(0)
      return JSON.parse(r.stdout.trim())
    }
    expect(run({ BUN_JSC_forceRAMSize: '4294967296', WALNUT_JSC_RAM_HINT_APPLIED: '4294967296' })).toEqual({ own: null, child: false, shell: false })
    expect(run({ BUN_JSC_forceRAMSize: '1073741824' })).toEqual({ own: '1073741824', child: true, shell: true })
  })
})
