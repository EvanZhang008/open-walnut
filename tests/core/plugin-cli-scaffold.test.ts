import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPlugin } from '../../packages/plugin-cli/src/build.js'
import {
  assertScaffoldTemplate,
  DEFAULT_TEMPLATE,
  isScaffoldTemplate,
  SCAFFOLD_TEMPLATES,
  scaffoldPlugin,
  type ScaffoldTemplate,
} from '../../packages/plugin-cli/src/scaffold.js'
import { linkPlugin } from '../../packages/plugin-cli/src/link.js'
import {
  CLI_RANGE,
  CLI_VERSION,
  ENGINE_FLOOR,
  PLUGIN_API_RANGE,
} from '../../packages/plugin-cli/src/version.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..')
const CLI_PACKAGE = path.join(REPO_ROOT, 'packages', 'plugin-cli')

/**
 * Bundling a web entry rewrites `react` to the host shim, which the CLI locates
 * with `require.resolve('@open-walnut/plugin-api/react')` — that only answers
 * once the API package is built. The file-shape assertions never need it; only
 * the bundle ones do.
 */
const canBundleWeb = existsSync(path.join(REPO_ROOT, 'packages', 'plugin-api', 'dist', 'react.js'))

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-plugin-scaffold-'))
  roots.push(root)
  return root
}

interface ScaffoldedProject {
  root: string
  manifest: Record<string, any>
  packageJson: Record<string, any>
  tsconfig: Record<string, any>
  readme: string
}

async function scaffold(id: string, template?: ScaffoldTemplate): Promise<ScaffoldedProject> {
  const parent = await temporaryRoot()
  const root = path.join(parent, id)
  await scaffoldPlugin(id, root, template ? { template } : {})
  const read = async (file: string) => JSON.parse(await fs.readFile(path.join(root, file), 'utf8'))
  return {
    root,
    manifest: await read('manifest.json'),
    packageJson: await read('package.json'),
    tsconfig: await read('tsconfig.json'),
    readme: await fs.readFile(path.join(root, 'README.md'), 'utf8'),
  }
}

function outputPaths(outputs: Array<{ path: string }>): string[] {
  return outputs.map((output) => output.path)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('Plugin CLI scaffold', () => {
  it('offers exactly three templates and defaults to both surfaces', () => {
    expect([...SCAFFOLD_TEMPLATES]).toEqual(['server', 'web', 'both'])
    expect(DEFAULT_TEMPLATE).toBe('both')
    expect(isScaffoldTemplate('both')).toBe(true)
    expect(isScaffoldTemplate('webview')).toBe(false)
  })

  it('rejects an unknown template and writes nothing', async () => {
    expect(() => assertScaffoldTemplate('serverless')).toThrow(/Unknown template "serverless"/)
    // The message must name every accepted value, so a typo is self-correcting.
    expect(() => assertScaffoldTemplate('serverless')).toThrow(/server, web, both/)

    const parent = await temporaryRoot()
    const root = path.join(parent, 'rejected-plugin')
    await expect(
      scaffoldPlugin('rejected-plugin', root, { template: 'nope' as ScaffoldTemplate }),
    ).rejects.toThrow(/Unknown template/)
    expect(existsSync(root)).toBe(false)
  })

  it('server template ships no React, no JSX, and no web entry', async () => {
    const project = await scaffold('server-only-plugin', 'server')

    expect(project.manifest).toMatchObject({
      id: 'server-only-plugin',
      name: 'Server Only Plugin',
      apiVersion: 1,
      engines: { walnut: ENGINE_FLOOR },
      server: 'dist/server.mjs',
      build: { server: 'src/server.ts' },
    })
    expect(project.manifest.web).toBeUndefined()
    expect(project.manifest.build.web).toBeUndefined()

    expect(project.packageJson.devDependencies).toEqual({
      '@open-walnut/plugin-api': PLUGIN_API_RANGE,
      '@open-walnut/plugin-cli': CLI_RANGE,
      '@types/node': expect.stringMatching(/^\^/),
      typescript: expect.stringMatching(/^\^/),
    })
    expect(project.tsconfig.compilerOptions.jsx).toBeUndefined()
    expect(project.tsconfig.compilerOptions.lib).toEqual(['ES2022'])
    expect(project.tsconfig.include).toEqual(['src/**/*.ts'])

    expect(existsSync(path.join(project.root, 'src', 'server.ts'))).toBe(true)
    expect(existsSync(path.join(project.root, 'src', 'web.tsx'))).toBe(false)
    expect(project.readme).toContain('src/server.ts')
    expect(project.readme).not.toContain('src/web.tsx')

    const result = await buildPlugin({ root: project.root })
    expect(outputPaths(result.outputs)).toEqual(['dist/server.mjs'])
  })

  it('web template adds the React toolchain and only imports the public SDK', async () => {
    const project = await scaffold('web-only-plugin', 'web')

    expect(project.manifest).toMatchObject({
      web: 'dist/web.mjs',
      build: { web: 'src/web.tsx' },
    })
    expect(project.manifest.server).toBeUndefined()
    expect(project.manifest.build.server).toBeUndefined()

    expect(project.packageJson.devDependencies).toMatchObject({
      '@types/react': expect.stringMatching(/^\^19/),
      '@types/react-dom': expect.stringMatching(/^\^19/),
      react: expect.stringMatching(/^\^19/),
      'react-dom': expect.stringMatching(/^\^19/),
    })
    expect(project.tsconfig.compilerOptions.jsx).toBe('react-jsx')
    expect(project.tsconfig.compilerOptions.lib).toEqual(['ES2022', 'DOM'])
    expect(project.tsconfig.include).toEqual(['src/**/*.ts', 'src/**/*.tsx'])

    expect(existsSync(path.join(project.root, 'src', 'server.ts'))).toBe(false)
    const entry = await fs.readFile(path.join(project.root, 'src', 'web.tsx'), 'utf8')
    // A sample that reaches into host internals teaches the wrong thing: only the
    // published SDK and the React shim are allowed.
    const imported = [...entry.matchAll(/from '([^']+)'/g)].map((match) => match[1])
    expect(imported.sort()).toEqual(['@open-walnut/plugin-api/web', 'react'])
    expect(entry).toContain('/plugins/web-only-plugin')
  })

  it('both template is the default and produces both entries', async () => {
    const project = await scaffold('full-plugin')

    expect(project.manifest).toMatchObject({
      server: 'dist/server.mjs',
      web: 'dist/web.mjs',
      build: { server: 'src/server.ts', web: 'src/web.tsx' },
    })
    expect(existsSync(path.join(project.root, 'src', 'server.ts'))).toBe(true)
    expect(existsSync(path.join(project.root, 'src', 'web.tsx'))).toBe(true)
    expect(project.packageJson.devDependencies).toMatchObject({
      '@types/node': expect.any(String),
      '@types/react': expect.any(String),
      '@types/react-dom': expect.any(String),
      react: expect.any(String),
      'react-dom': expect.any(String),
    })
  })

  it.skipIf(!canBundleWeb)('bundles the web and server entries of a built project', async () => {
    const web = await scaffold('bundled-web-plugin', 'web')
    expect(outputPaths((await buildPlugin({ root: web.root })).outputs)).toEqual(['dist/web.mjs'])

    const both = await scaffold('bundled-full-plugin', 'both')
    expect(outputPaths((await buildPlugin({ root: both.root })).outputs).sort()).toEqual([
      'dist/server.mjs',
      'dist/web.mjs',
    ])
    const bundle = await fs.readFile(path.join(both.root, 'dist', 'web.mjs'), 'utf8')
    expect(bundle).toContain('activate')
  })

  it('takes every version it writes from its own package metadata', async () => {
    const cliPackage = JSON.parse(await fs.readFile(path.join(CLI_PACKAGE, 'package.json'), 'utf8'))
    expect(CLI_VERSION).toBe(cliPackage.version)
    expect(PLUGIN_API_RANGE).toBe(cliPackage.dependencies['@open-walnut/plugin-api'])
    expect(ENGINE_FLOOR).toBe(cliPackage.walnut.engineFloor)
    expect(CLI_RANGE).toBe(`^${cliPackage.version}`)

    // Ratchet: a release bumps package.json only, so neither entry point may
    // carry its own copy of a version or a Walnut floor.
    const cliSource = await fs.readFile(path.join(CLI_PACKAGE, 'src', 'cli.ts'), 'utf8')
    expect(cliSource).toContain('.version(CLI_VERSION)')
    const scaffoldSource = await fs.readFile(path.join(CLI_PACKAGE, 'src', 'scaffold.ts'), 'utf8')
    expect(scaffoldSource).not.toMatch(/'>=\d/)
  })

  it('repairs a stale development symlink', async () => {
    const parent = await temporaryRoot()
    const root = path.join(parent, 'linked-plugin')
    const home = path.join(parent, 'home')
    await scaffoldPlugin('linked-plugin', root, { template: 'server' })
    const target = path.join(home, 'plugins', 'linked-plugin')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.symlink(path.join(parent, 'missing-plugin'), target, 'dir')

    const previousHome = process.env.OPEN_WALNUT_HOME
    process.env.OPEN_WALNUT_HOME = home
    try {
      expect(await linkPlugin(root)).toBe(target)
      expect(await fs.realpath(target)).toBe(await fs.realpath(root))
    } finally {
      if (previousHome === undefined) delete process.env.OPEN_WALNUT_HOME
      else process.env.OPEN_WALNUT_HOME = previousHome
    }
  })

  it('never overwrites an existing source entry', async () => {
    const parent = await temporaryRoot()
    const root = path.join(parent, 'existing-plugin')
    await fs.mkdir(path.join(root, 'src'), { recursive: true })
    await fs.writeFile(path.join(root, 'src', 'server.ts'), 'keep me\n')

    await expect(scaffoldPlugin('existing-plugin', root)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await fs.readFile(path.join(root, 'src', 'server.ts'), 'utf8')).toBe('keep me\n')
  })

  it('never overwrites an existing manifest', async () => {
    const parent = await temporaryRoot()
    const root = path.join(parent, 'manifest-plugin')
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, 'manifest.json'), '{"id":"mine"}\n')

    await expect(scaffoldPlugin('manifest-plugin', root)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')).toBe('{"id":"mine"}\n')
    // The failed write must not have left a half-written project behind it.
    expect(existsSync(path.join(root, 'package.json'))).toBe(false)
  })
})
