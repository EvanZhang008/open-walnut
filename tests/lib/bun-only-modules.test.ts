/**
 * The modules built on bun's own APIs, on a runtime without them: the terminal's
 * pty (src/lib/pty.ts) and the plugin bundler (src/lib/transpile.ts). Walnut
 * runs only on bun, so on Node each refuses, naming the runtime, instead of
 * reaching for a module that is no longer installed (node-pty, esbuild). The
 * server then starts with the terminal off (src/web/terminal/register.ts), and
 * the plugin reports why it did not load.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** Import a module as a process on Node would: no process.versions.bun while it loads and runs. */
async function onNode<T>(load: () => Promise<T>, use: (mod: T) => Promise<void>): Promise<void> {
  const bun = process.versions.bun
  vi.resetModules()
  delete (process.versions as { bun?: string }).bun
  try {
    await use(await load())
  } finally {
    ;(process.versions as { bun?: string }).bun = bun
    vi.resetModules()
  }
}

let tmp: string | null = null
afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = null })

describe('the pty', () => {
  it('is bun\'s built-in one', async () => {
    const { loadPty } = await import('../../src/lib/pty.js')
    expect(typeof (await loadPty()).spawn).toBe('function')
  })

  it('refuses on Node', async () => {
    await onNode(() => import('../../src/lib/pty.js'), async ({ loadPty }) => {
      await expect(loadPty()).rejects.toThrow(/needs bun's built-in pty.*runs on Node/)
    })
  })
})

describe('the plugin bundler', () => {
  const request = (dir: string) => ({
    entry: path.join(dir, 'index.ts'),
    outfile: path.join(dir, 'out', 'bundle.mjs'),
    banner: '// banner',
    resolveParent: () => undefined,
  })

  it('bundles TypeScript with Bun.build', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-transpile-'))
    fs.writeFileSync(path.join(tmp, 'index.ts'), 'export const n: number = 41 + 1\n')
    const { bundleEsm } = await import('../../src/lib/transpile.js')
    await bundleEsm(request(tmp))
    const out = fs.readFileSync(path.join(tmp, 'out', 'bundle.mjs'), 'utf8')
    // bun puts its own `// @bun` pragma first; the banner comes before any code.
    expect(out.split('\n').slice(0, 2)).toEqual(['// @bun', '// banner'])
    expect(out).toContain('var n = 41 + 1')
    expect(out).not.toContain(': number')
  })

  it('refuses on Node and writes nothing', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-transpile-'))
    fs.writeFileSync(path.join(tmp, 'index.ts'), 'export const n = 1\n')
    await onNode(() => import('../../src/lib/transpile.js'), async ({ bundleEsm }) => {
      await expect(bundleEsm(request(tmp!))).rejects.toThrow(/needs bun's bundler.*runs on Node/)
    })
    expect(fs.existsSync(path.join(tmp, 'out'))).toBe(false)
  })
})

describe('how a process runs bun itself (bunCommand)', () => {
  const HOME = { OPEN_WALNUT_HOME: '/tmp/walnut-home' }

  it('from source: this bun, with BUN_BE_BUN dropped so no walnut file it starts inherits it', async () => {
    const { bunCommand } = await import('../../src/lib/runtime.js')
    const run = bunCommand({ ...HOME, BUN_BE_BUN: '1' })
    expect(run.command).toBe(process.execPath)
    expect(run.env).toEqual(HOME)
  })

  it('inside the compiled file: the walnut file itself, told to act as bun', async () => {
    const { setSingleFile } = await import('../../src/lib/single-file.js')
    const { bunCommand } = await import('../../src/lib/runtime.js')
    setSingleFile({ root: '/rt', daemonVersion: 'd', modules: {} })
    try {
      const env = { ...HOME }
      const run = bunCommand(env)
      expect(run.command).toBe(process.execPath)
      expect(run.env).toEqual({ ...HOME, BUN_BE_BUN: '1' })
      expect(env).toEqual(HOME)
    } finally {
      delete (globalThis as Record<string, unknown>).__WALNUT_SINGLE_FILE__
    }
  })

  it('decides from the executable: a walnut file running a dist build is told to be bun, a bun binary never', async () => {
    const { bunCommand, execNeedsBunBeBun } = await import('../../src/lib/runtime.js')
    // Neither singleFile() nor the entry says "compiled" here: only the executable's name does.
    expect(bunCommand(HOME, '/srv/app/walnut')).toEqual({ command: '/srv/app/walnut', env: { ...HOME, BUN_BE_BUN: '1' } })
    for (const bun of ['/usr/local/bin/bun', '/opt/bun/bin/bun-debug', 'C:\\bun\\bun.exe']) {
      expect(execNeedsBunBeBun(bun), bun).toBe(false)
      expect(bunCommand({ ...HOME, BUN_BE_BUN: '1' }, bun).env).toEqual(HOME)
    }
    expect(execNeedsBunBeBun('/home/alice/.local/share/open-walnut/versions/0.7.0/walnut')).toBe(true)
  })
})
