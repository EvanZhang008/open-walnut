/**
 * The compiled file must not depend on the machine that built it. bun bakes a
 * CommonJS module's `__dirname` in as the builder's absolute path, so a package
 * that reads its own files through it (tiktoken's wasm) worked on the build
 * machine and failed everywhere else (scripts/build-binary.mjs).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error: a .mjs build script without types
import { assertNoBuildPaths, copyInfraApp, moduleRoots, packageCopies, runtimeDirname, treeDirOf } from '../../scripts/binary-build-checks.mjs'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tmpFile(content: string | Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-paths-'))
  dirs.push(dir)
  const file = path.join(dir, 'walnut')
  fs.writeFileSync(file, content)
  return file
}

describe('runtimeDirname', () => {
  it('points __dirname at the package dir inside the runtime tree', () => {
    const out = runtimeDirname('const p = path.join(__dirname, "./tiktoken_bg.wasm");', 'node_modules/tiktoken/lite')
    expect(out).toContain('var __walnut_dirname = globalThis.__WALNUT_SINGLE_FILE__.root + "/node_modules/tiktoken/lite";')
    expect(out).toContain('path.join(__walnut_dirname, "./tiktoken_bg.wasm")')
    expect(out).not.toMatch(/\b__dirname\b/)
  })

  it('evaluates to the runtime tree path', () => {
    const out = runtimeDirname('module.exports = __dirname', 'node_modules/pino/lib')
    const g = globalThis as { __WALNUT_SINGLE_FILE__?: unknown }
    g.__WALNUT_SINGLE_FILE__ = { root: '/data/local/runtime/0.1.0-abc' }
    try {
      const mod = { exports: '' }
      new Function('module', out)(mod)
      expect(mod.exports).toBe('/data/local/runtime/0.1.0-abc/node_modules/pino/lib')
    } finally {
      delete g.__WALNUT_SINGLE_FILE__
    }
  })

  it('leaves a module without __dirname, and longer names, untouched', () => {
    expect(runtimeDirname('const a = 1', 'node_modules/x')).toBe('const a = 1')
    expect(runtimeDirname('const __dirname_x = 1; f(__dirname_x)', 'node_modules/x')).toBe('const __dirname_x = 1; f(__dirname_x)')
  })
})

describe('treeDirOf', () => {
  it('names the package dir in the runtime tree, whatever checkout the module resolved into', () => {
    // A deploy clone links each node_modules entry to the checkout's, so bun hands the
    // plugin the checkout's real path: outside the repo being built.
    expect(treeDirOf('/Users/acme/src/walnut/node_modules/tiktoken/lite/tiktoken.cjs')).toBe('node_modules/tiktoken/lite')
    expect(treeDirOf('/tmp/open-walnut-build.abc/node_modules/pino/lib/tools.js')).toBe('node_modules/pino/lib')
    expect(treeDirOf('/x/node_modules/@scope/pkg/dist/a.js')).toBe('node_modules/@scope/pkg/dist')
    // A nested copy keeps every node_modules on its way, so it reads its own files.
    expect(treeDirOf('/x/node_modules/pino/node_modules/thread-stream/index.js')).toBe('node_modules/pino/node_modules/thread-stream')
  })

  it('maps a module bun resolved through a linked entry, nested copies included, back to its place in the tree', () => {
    // The deploy clone layout: each top-level entry links to the checkout's own.
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'build-paths-links-')))
    dirs.push(base)
    const checkout = path.join(base, 'node_modules', 'checkout')
    const clone = path.join(base, 'clone')
    for (const rel of ['node_modules/tiktoken/lite', 'node_modules/b/node_modules/tiktoken/lite', 'node_modules/@s/p/dist']) {
      fs.mkdirSync(path.join(checkout, rel), { recursive: true })
    }
    fs.mkdirSync(path.join(clone, 'node_modules', '@s'), { recursive: true })
    for (const e of ['tiktoken', 'b']) fs.symlinkSync(path.join(checkout, 'node_modules', e), path.join(clone, 'node_modules', e))
    fs.symlinkSync(path.join(checkout, 'node_modules', '@s', 'p'), path.join(clone, 'node_modules', '@s', 'p'))
    const roots = moduleRoots(clone)
    const real = (rel: string) => fs.realpathSync(path.join(clone, rel))
    expect(treeDirOf(path.join(real('node_modules/tiktoken/lite'), 'tiktoken.cjs'), roots)).toBe('node_modules/tiktoken/lite')
    expect(treeDirOf(path.join(real('node_modules/b/node_modules/tiktoken/lite'), 'tiktoken.cjs'), roots)).toBe('node_modules/b/node_modules/tiktoken/lite')
    expect(treeDirOf(path.join(real('node_modules/@s/p/dist'), 'a.js'), roots)).toBe('node_modules/@s/p/dist')
    // Its checkout path holds a node_modules of its own: the first-segment fallback
    // would have named node_modules/checkout/... here.
    expect(real('node_modules/tiktoken/lite')).toContain('/node_modules/checkout/')
  })

  it('never yields a path of the build machine', () => {
    const dir = treeDirOf(path.join(os.homedir(), 'checkout', 'node_modules', 'tiktoken', 'lite', 'tiktoken.cjs'))
    expect(dir).toBe('node_modules/tiktoken/lite')
    const file = tmpFile(runtimeDirname('module.exports = __dirname', dir))
    expect(() => assertNoBuildPaths(file, [os.homedir()])).not.toThrow()
  })

  it('answers null outside node_modules', () => {
    expect(treeDirOf('/repo/src/a.js')).toBeNull()
    expect(treeDirOf('/repo/node_modules/a.js')).toBeNull()
  })
})

describe('packageCopies', () => {
  it('finds every installed copy of a package, nested ones of another version too', () => {
    // A nested tiktoken of another version must get its own wasm, not silently load the top-level one.
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'build-paths-copies-')))
    dirs.push(repo)
    const pkg = (rel: string, version: string) => {
      fs.mkdirSync(path.join(repo, rel, 'lite'), { recursive: true })
      fs.writeFileSync(path.join(repo, rel, 'package.json'), JSON.stringify({ name: 'tiktoken', version }))
    }
    pkg('node_modules/tiktoken', '1.0.0')
    pkg('node_modules/b/node_modules/tiktoken', '0.9.0')
    pkg('node_modules/@s/c/node_modules/d/node_modules/tiktoken', '0.8.0')
    fs.mkdirSync(path.join(repo, 'node_modules', 'other', 'lite'), { recursive: true })
    expect(packageCopies(repo, 'tiktoken')).toEqual([
      'node_modules/@s/c/node_modules/d/node_modules/tiktoken',
      'node_modules/b/node_modules/tiktoken',
      'node_modules/tiktoken',
    ])
    // Each copy's tree path is the dir treeDirOf gives its modules.
    const roots = moduleRoots(repo)
    for (const copy of packageCopies(repo, 'tiktoken')) {
      expect(treeDirOf(path.join(repo, copy, 'lite', 'tiktoken.cjs'), roots)).toBe(`${copy}/lite`)
    }
  })
})

describe('assertNoBuildPaths', () => {
  const root = '/home/builder/work/walnut'

  it('passes a file without the build roots', () => {
    expect(() => assertNoBuildPaths(tmpFile(Buffer.from('code /usr/lib/x \0 more')), [root])).not.toThrow()
  })

  it('names every build-machine path the file carries', () => {
    const body = `var __dirname="${root}/node_modules/thread-stream",x;\0var __dirname="${root}/node_modules/pino/lib";`
    expect(() => assertNoBuildPaths(tmpFile(body), [root])).toThrow(/node_modules\/thread-stream[\s\S]*node_modules\/pino\/lib/)
  })

  it('ignores a root that is only a prefix of another directory name', () => {
    expect(() => assertNoBuildPaths(tmpFile(`${root}-other/file`), [root])).not.toThrow()
  })
})

describe('copyInfraApp', () => {
  // 2026-10-26: the npm package shipped infra/ so an npm install could deploy the
  // AWS companion, but the compiled file's runtime tree had none, so every
  // compiled install answered "This Walnut install has no CDK app".
  it('puts the CDK app in the runtime tree as package.json files ships it, without built output', () => {
    const repo = path.resolve(__dirname, '../..')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-tree-'))
    dirs.push(root)
    const entries = copyInfraApp(repo, root)
    expect(entries).toContain('infra/bun.lock')
    for (const rel of ['infra/cdk.json', 'infra/bun.lock', 'infra/package.json', 'infra/tsconfig.json', 'infra/bin/walnut-cloud.ts', 'infra/lib/walnut-cloud-stack.ts']) {
      expect(fs.existsSync(path.join(root, rel)), rel).toBe(true)
    }
    const all = fs.readdirSync(path.join(root, 'infra'), { recursive: true }).map(String)
    expect(all.filter((f) => /\.(js|d\.ts)$/.test(f) || f.startsWith('node_modules') || f.startsWith('cdk.out'))).toEqual([])
  })
})
