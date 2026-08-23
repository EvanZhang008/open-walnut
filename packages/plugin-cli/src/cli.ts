import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Command } from 'commander'
import { buildPlugin } from './build.js'
import { apiRequest } from './http.js'
import { assertValid, readManifest, validatePlugin } from './manifest.js'
import {
  assertScaffoldTemplate,
  DEFAULT_TEMPLATE,
  SCAFFOLD_TEMPLATES,
  scaffoldPlugin,
} from './scaffold.js'
import { linkPlugin } from './link.js'
import { publishCheck } from './publish-check.js'
import { CLI_VERSION } from './version.js'

function printValidation(result: Awaited<ReturnType<typeof validatePlugin>>): void {
  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`)
  for (const error of result.errors) process.stderr.write(`error: ${error}\n`)
  if (result.errors.length === 0) process.stdout.write(`valid: ${result.manifest?.id}\n`)
}

async function reloadPlugin(id: string): Promise<void> {
  await apiRequest(`/api/plugin-runtime/${encodeURIComponent(id)}/reload`, { method: 'POST' })
}

async function spawnCommand(command: string, args: string[], cwd: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env })
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
}

export function createProgram(): Command {
  const program = new Command()
    .name('walnut-plugin')
    .description('Build and develop Open Walnut plugins')
    .version(CLI_VERSION)

  program.command('new')
    .description('Create a plugin project')
    .argument('<id>', 'Plugin id, e.g. my-plugin')
    .option('-d, --directory <path>', 'Where to create the project (default: the plugin id)')
    .option(
      '-t, --template <template>',
      `Surfaces to scaffold: ${SCAFFOLD_TEMPLATES.join(' | ')}`,
      DEFAULT_TEMPLATE,
    )
    .action(async (id, options) => {
      const template = assertScaffoldTemplate(String(options.template))
      const root = await scaffoldPlugin(id, options.directory ?? id, { template })
      process.stdout.write(`${root}\n`)
    })

  program.command('validate')
    .description('Check manifest.json and its entry paths')
    .option('-r, --root <path>', 'Plugin root', process.cwd())
    .action(async (options) => {
      const result = await validatePlugin(path.resolve(options.root))
      printValidation(result)
      if (result.errors.length > 0) process.exitCode = 1
    })

  program.command('build')
    .description("Bundle the manifest's entries into dist/")
    .option('-r, --root <path>', 'Plugin root', process.cwd())
    .option('-w, --watch', 'Rebuild on change')
    .action(async (options) => {
      const result = await buildPlugin({ root: options.root, watch: options.watch })
      for (const output of result.outputs) process.stdout.write(`${output.path}\t${output.bytes}\n`)
      if (options.watch) await new Promise(() => undefined)
    })

  program.command('link')
    .description('Symlink this project into ~/.open-walnut/plugins, then reload it')
    .option('-r, --root <path>', 'Plugin root', process.cwd())
    .action(async (options) => {
      const root = path.resolve(options.root)
      const manifest = await readManifest(root)
      await buildPlugin({ root })
      const target = await linkPlugin(root)
      process.stdout.write(`linked: ${target}\n`)
      try { await reloadPlugin(manifest.id); process.stdout.write('reloaded\n') }
      catch { process.stdout.write('Walnut is offline; link will load on next start\n') }
    })

  program.command('status')
    .description('Print what the running Walnut knows about this plugin')
    .option('-r, --root <path>', 'Plugin root', process.cwd())
    .action(async (options) => {
      const manifest = await readManifest(path.resolve(options.root))
      const data = await apiRequest<{ plugins: Array<Record<string, unknown>>; tombstones: Array<Record<string, unknown>> }>('/api/plugin-runtime')
      const plugin = data.plugins.find((item) => item.id === manifest.id)
      const tombstone = data.tombstones.find((item) => item.id === manifest.id)
      if (!plugin && !tombstone) {
        process.stderr.write(`not found: ${manifest.id}\n`)
        process.exitCode = 3
        return
      }
      process.stdout.write(JSON.stringify(plugin ?? tombstone, null, 2) + '\n')
    })

  program.command('dev')
    .description('Build, link, then rebuild and reload on every change')
    .option('-r, --root <path>', 'Plugin root', process.cwd())
    .action(async (options) => {
      const root = path.resolve(options.root)
      const manifest = await readManifest(root)
      await buildPlugin({ root })
      await linkPlugin(root)
      const result = await buildPlugin({
        root,
        watch: true,
        onRebuild: async () => {
          try { await reloadPlugin(manifest.id); process.stdout.write('rebuilt and reloaded\n') }
          catch { process.stdout.write('rebuilt; Walnut is offline\n') }
        },
      })
      const stop = async () => { await result.stop?.(); process.exit(0) }
      process.once('SIGINT', () => { void stop() })
      process.once('SIGTERM', () => { void stop() })
      await new Promise(() => undefined)
    })

  program.command('test')
    .description("Validate, build, then run the project's plugin:test script")
    .option('-r, --root <path>', 'Plugin root', process.cwd())
    .action(async (options) => {
      const root = path.resolve(options.root)
      const validation = await validatePlugin(root)
      printValidation(validation)
      assertValid(validation)
      await buildPlugin({ root })
      const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
      const script = packageJson.scripts?.['plugin:test']
      if (script) {
        const code = await spawnCommand(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'plugin:test'], root)
        if (code !== 0) process.exitCode = code
      } else {
        process.stdout.write('no plugin:test script; validate + build passed\n')
      }
    })

  program.command('publish-check')
    .description('Production build plus the checks a release must pass')
    .option('-r, --root <path>', 'Plugin root', process.cwd())
    .action(async (options) => {
      const result = await publishCheck(path.resolve(options.root))
      for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`)
      process.stdout.write(`publish-ready: ${result.id}\n`)
    })

  return program
}

createProgram().parseAsync().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
