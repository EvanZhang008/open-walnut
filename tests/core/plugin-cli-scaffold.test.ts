import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPlugin } from '../../packages/plugin-cli/src/build.js'
import {
  assertScaffoldTemplate,
  DEFAULT_TEMPLATE,
  hostToolName,
  isScaffoldTemplate,
  SCAFFOLD_TEMPLATES,
  scaffoldFiles,
  scaffoldPlugin,
  type ScaffoldTemplate,
} from '../../packages/plugin-cli/src/scaffold.js'
import { linkPlugin } from '../../packages/plugin-cli/src/link.js'
import { appPath, appUrl } from '../../packages/plugin-cli/src/app-route.js'
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
  skill: string
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
    skill: await fs.readFile(path.join(root, 'skills', id, 'SKILL.md'), 'utf8'),
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
  })

  it('web template contributes ONE App and nothing else', async () => {
    const project = await scaffold('app-only-plugin', 'web')
    const entry = await fs.readFile(path.join(project.root, 'src', 'web.tsx'), 'utf8')

    // One surface per plugin, so the sample must not teach the retired nav + page + panel trio.
    expect(entry).toContain("walnut.ui.app({ id: 'main'")
    expect(entry).toContain('component: App')
    expect(entry).not.toContain('walnut.ui.nav(')
    expect(entry).not.toContain('walnut.ui.page(')
    expect(entry).not.toContain('walnut.ui.panel(')

    // The host owns the route, so the sample reads it off the returned handle instead of hardcoding it.
    expect(entry).toContain('app.path')
    expect(entry).not.toContain('/plugins/app-only-plugin')
    expect(entry).not.toContain(appPath('app-only-plugin'))

    // App props are the host's, and a sample App may ignore them.
    expect(entry).toContain('function App()')
    expect(entry).not.toContain('panelKey')

    expect(project.readme).toContain(appPath('app-only-plugin'))
    expect(appUrl('app-only-plugin', 'http://127.0.0.1:3456')).toBe(
      'http://127.0.0.1:3456/apps/app-only-plugin~main',
    )
  })

  it('ships a working Skill and the scripts an author runs', async () => {
    const project = await scaffold('skilled-plugin', 'both')

    // `skills/<id>/SKILL.md` is the layout the loader discovers, and `files` already packs `skills`.
    expect(project.skill).toMatch(/^---\nname: skilled-plugin\ndescription: /)
    expect(project.skill).toContain('# Skilled Plugin')
    expect(project.skill).toContain(appPath('skilled-plugin'))
    expect(project.packageJson.files).toContain('skills')

    expect(project.packageJson.scripts).toMatchObject({
      build: 'walnut-plugin build',
      dev: 'walnut-plugin dev',
      validate: 'walnut-plugin validate',
      link: 'walnut-plugin link',
      'publish-check': 'walnut-plugin publish-check',
      test: 'walnut-plugin test',
    })
    expect(project.readme).toContain('npm run dev')
    expect(project.readme).toContain('npm run publish-check')
    expect(project.readme).toContain('The first link needs no restart.')
  })

  it('a server-only plugin gets a Skill with no App claim in it', async () => {
    const project = await scaffold('quiet-plugin', 'server')

    expect(project.skill).toContain('`quiet_plugin_ping`')
    expect(project.skill).not.toContain('/apps/')
    expect(project.readme).not.toContain('/apps/')
  })

  it('tells the model the host-namespaced tool name, not the local one', async () => {
    // Host rule (src/core/integration-loader.ts pluginToolName): fold every non-word char of the id to `_`, then prefix the local name.
    expect(hostToolName('tool-name.plugin', 'ping')).toBe('tool_name_plugin_ping')
    expect(hostToolName('plain', 'ping')).toBe('plain_ping')
    expect(hostToolName('plain', 'plain_ping')).toBe('plain_ping')

    const project = await scaffold('tool-name-plugin', 'both')
    const entry = await fs.readFile(path.join(project.root, 'src', 'server.ts'), 'utf8')

    // The local registration keeps the short name; only the call site is namespaced.
    expect(entry).toContain("name: 'ping'")
    expect(entry).toContain("'tool_name_plugin_ping'")

    expect(project.skill).toContain('`tool_name_plugin_ping`')
    expect(project.skill).toContain('the local name `ping` is not what you call')
    expect(project.skill).not.toMatch(/A `ping` tool/)
  })

  it('depends on publishable versions only, never a local path', async () => {
    const project = await scaffold('publishable-plugin', 'both')
    const deps: Record<string, string> = {
      ...(project.packageJson.dependencies ?? {}),
      ...project.packageJson.devDependencies,
    }

    // A `file:`/`link:`/relative dependency would make the scaffold unpublishable and machine-specific.
    for (const [name, range] of Object.entries(deps)) {
      expect(range, name).toMatch(/^\^\d+\.\d+\.\d+/)
      expect(range, name).not.toMatch(/^(file:|link:|portal:|\.|\/|[a-zA-Z]:\\)/)
      expect(range, name).not.toContain(REPO_ROOT)
    }
    expect(deps['@open-walnut/plugin-api']).toBe(PLUGIN_API_RANGE)
    expect(deps['@open-walnut/plugin-cli']).toBe(CLI_RANGE)
  })

  it('never overwrites an existing Skill', async () => {
    const parent = await temporaryRoot()
    const root = path.join(parent, 'kept-skill-plugin')
    await fs.mkdir(path.join(root, 'skills', 'kept-skill-plugin'), { recursive: true })
    await fs.writeFile(path.join(root, 'skills', 'kept-skill-plugin', 'SKILL.md'), 'mine\n')

    await expect(scaffoldPlugin('kept-skill-plugin', root)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await fs.readFile(path.join(root, 'skills', 'kept-skill-plugin', 'SKILL.md'), 'utf8')).toBe('mine\n')
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

  it('never overwrites an existing source entry, and writes nothing at all', async () => {
    const parent = await temporaryRoot()
    const root = path.join(parent, 'existing-plugin')
    await fs.mkdir(path.join(root, 'src'), { recursive: true })
    await fs.writeFile(path.join(root, 'src', 'server.ts'), 'keep me\n')

    await expect(scaffoldPlugin('existing-plugin', root)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await fs.readFile(path.join(root, 'src', 'server.ts'), 'utf8')).toBe('keep me\n')
    // The collision is found BEFORE the first write, so there is no half-scaffolded project to clean up.
    expect(existsSync(path.join(root, 'manifest.json'))).toBe(false)
    expect(existsSync(path.join(root, 'package.json'))).toBe(false)
    expect(existsSync(path.join(root, 'tsconfig.json'))).toBe(false)
    expect(existsSync(path.join(root, 'README.md'))).toBe(false)
    expect(existsSync(path.join(root, '.gitignore'))).toBe(false)
    expect(existsSync(path.join(root, 'skills'))).toBe(false)
    expect(existsSync(path.join(root, 'src', 'web.tsx'))).toBe(false)
  })

  it('names every file it would write, and refuses over any one of them', async () => {
    expect(scaffoldFiles('listed-plugin', 'both')).toEqual([
      'manifest.json',
      'package.json',
      'tsconfig.json',
      '.gitignore',
      'README.md',
      path.join('src', 'server.ts'),
      path.join('src', 'web.tsx'),
      path.join('skills', 'listed-plugin', 'SKILL.md'),
    ])
    expect(scaffoldFiles('listed-plugin', 'server')).not.toContain(path.join('src', 'web.tsx'))
    expect(scaffoldFiles('listed-plugin', 'web')).not.toContain(path.join('src', 'server.ts'))

    // Every planned file is a tripwire, not just the two the old code happened to write first.
    for (const file of scaffoldFiles('listed-plugin', 'both')) {
      const parent = await temporaryRoot()
      const root = path.join(parent, 'listed-plugin')
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await fs.writeFile(path.join(root, file), 'mine\n')

      await expect(scaffoldPlugin('listed-plugin', root)).rejects.toMatchObject({ code: 'EEXIST' })
      expect(await fs.readFile(path.join(root, file), 'utf8')).toBe('mine\n')
      const others = scaffoldFiles('listed-plugin', 'both').filter((other) => other !== file)
      expect(others.filter((other) => existsSync(path.join(root, other)))).toEqual([])
    }
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
