/**
 * The npm launcher starts on any Node npm installs it with. The compiled file
 * it runs needs no Node, so an old system Node must not stop Walnut: on Node 12
 * (Debian 11's and Ubuntu 22.04's apt Node) the ES module launcher with
 * optional chaining died with a SyntaxError before it could run anything.
 * lib/ is CommonJS in ES2017 syntax on Node 8 APIs; bin/open-walnut.js and
 * dist/cli.js are ES5 up to a version check that names the no-Node install.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ENTRY, LAUNCHER_LIB, LAUNCHER_NODE_FLOOR, launcherManifest } from '../../scripts/npm-packages.mjs'

const ROOT = path.resolve(__dirname, '../..')
const requireCjs = createRequire(import.meta.url)
// A parser that knows nothing newer than the target is the check (acorn, a devDependency).
const acorn = requireCjs('acorn') as { parse: (src: string, opts: Record<string, unknown>) => unknown }
const lib = (f: string) => fs.readFileSync(path.join(ROOT, 'scripts/npm-launcher', f), 'utf8')
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-floor-')))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('the launcher on an old Node', () => {
  it('lib/ parses as ES2017 scripts: no import or export, no ?. or ??, no top-level await', () => {
    for (const f of LAUNCHER_LIB) {
      expect(() => acorn.parse(lib(f), { ecmaVersion: 2017, sourceType: 'script' }), f).not.toThrow()
    }
    // The check itself: the ES module launcher that broke Node 12 does not pass.
    expect(() => acorn.parse("import fs from 'node:fs'\nconst r = process.report?.getReport?.()\n", { ecmaVersion: 2017, sourceType: 'script' })).toThrow()
  })

  it('lib/ uses no Node API newer than its floor', () => {
    const newer: Array<[RegExp, string]> = [
      [/\bfetch\(/, 'fetch (Node 18)'],
      [/AbortSignal/, 'AbortSignal (Node 15)'],
      [/\brmSync\(/, 'fs.rmSync (Node 14.14)'],
      [/recursive:\s*true/, 'recursive mkdir/rmdir (Node 10.12)'],
      [/withFileTypes/, 'readdir withFileTypes (Node 10.10)'],
      [/process\.off\(/, 'process.off (Node 10)'],
      [/Object\.fromEntries|\.flat\(|\.flatMap\(|\.matchAll\(|\.replaceAll\(/, 'an ES2019+ built-in'],
      [/createRequire|import\.meta/, 'an ES module API'],
      [/\burl\.parse\(/, 'url.parse (warns on new Node)'],
      [/require\(\s*['"]node:/, 'a node: specifier (Node 14.18)'],
      [/\.at\(/, '.at() (Node 16.6)'],
      [/Object\.hasOwn\b/, 'Object.hasOwn (Node 16.9)'],
      [/\bglobalThis\b/, 'globalThis (Node 12)'],
      [/\.finally\(/, 'Promise.prototype.finally (Node 10)'],
      [/\bfs\.promises\b|['"]fs\/promises['"]/, 'fs.promises (Node 10)'],
      [/\bfs\.copyFileSync\(/, 'fs.copyFileSync (Node 8.5)'],
      // Node 8 and 10 read the working directory to resolve one, and it may have been deleted.
      [/require\(\s*['"]\.\.?\//, 'a relative require'],
    ]
    for (const f of LAUNCHER_LIB) {
      const src = lib(f)
      for (const [rx, what] of newer) expect(rx.test(src), `${f} uses ${what}`).toBe(false)
    }
  })

  it('bin/open-walnut.js and dist/cli.js are ES5 CommonJS that checks the Node version first', () => {
    const entry = ENTRY()
    expect(() => acorn.parse(entry, { ecmaVersion: 5, sourceType: 'script', allowHashBang: true })).not.toThrow()
    expect(entry.startsWith('#!/usr/bin/env node\n')).toBe(true)
    expect(entry.indexOf(`< ${LAUNCHER_NODE_FLOOR})`)).toBeLessThan(entry.indexOf("'launch.js'))"))
    // By absolute path: Node 8 and 10 read the working directory to resolve a relative require.
    expect(entry).toContain("require(require('path').join(__dirname, '..', 'lib', 'launch.js'))")
    expect(entry).not.toMatch(/require\(\s*['"]\.\.?\//)
    expect(lib('postinstall.js')).toContain(`< ${LAUNCHER_NODE_FLOOR})`)
    // npm warns about engines and installs anyway; the floor it states is the real one.
    expect(launcherManifest('1.0.0', { license: 'MIT' }).engines).toEqual({ node: `>=${LAUNCHER_NODE_FLOOR}` })
  })

  it('a Node below the floor gets one line naming the install that needs no Node', () => {
    const pkg = path.join(tmp, 'pkg')
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true })
    fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"open-walnut","type":"commonjs"}\n')
    fs.writeFileSync(path.join(pkg, 'bin', 'open-walnut.js'), ENTRY())
    // lib/ is never loaded below the floor: a file there that would not parse proves it.
    fs.writeFileSync(path.join(pkg, 'lib', 'launch.js'), 'this is not javascript (\n')
    fs.copyFileSync(path.join(ROOT, 'scripts/npm-launcher/postinstall.js'), path.join(pkg, 'lib', 'postinstall.js'))
    const asOld = `Object.defineProperty(process, 'versions', { value: Object.assign({}, process.versions, { node: '6.17.1' }) })`
    for (const file of [path.join(pkg, 'bin', 'open-walnut.js'), path.join(pkg, 'lib', 'postinstall.js')]) {
      const r = spawnSync(process.execPath, ['-e', `${asOld}; require(${JSON.stringify(file)})`], { encoding: 'utf8' })
      expect(r.status, file).toBe(1)
      expect(r.stderr, file).toContain('Node.js 6.17.1 is too old')
      expect(r.stderr, file).toContain('releases/latest/download/install.sh | sh')
      expect(r.stderr.trim().split('\n'), file).toHaveLength(1)
    }
  })
})
