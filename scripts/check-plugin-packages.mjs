#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const packageDirs = {
  api: path.join(repoRoot, 'packages', 'plugin-api'),
  cli: path.join(repoRoot, 'packages', 'plugin-cli'),
}

function run(args, cwd, capture = false) {
  const result = spawnSync(npm, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: 300_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${npm} ${args.join(' ')} failed (${result.status})${capture ? `\n${result.stderr || result.stdout}` : ''}`)
  }
  return result.stdout ?? ''
}

function parsePack(raw) {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end < start) throw new Error('npm pack did not return JSON')
  const records = JSON.parse(raw.slice(start, end + 1))
  if (!Array.isArray(records) || records.length !== 1) throw new Error('npm pack returned an unexpected result')
  return records[0]
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function main() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-plugin-packages-'))
  const packDir = path.join(scratch, 'tarballs')
  const bootstrapDir = path.join(scratch, 'bootstrap')
  const pluginDir = path.join(scratch, 'packed-consumer')
  let passed = false

  try {
    await fs.mkdir(packDir)
    await fs.mkdir(bootstrapDir)
    await fs.writeFile(
      path.join(bootstrapDir, 'package.json'),
      '{"name":"walnut-plugin-package-check","version":"0.0.0","private":true}\n',
    )

    const apiPack = parsePack(run([
      'pack', packageDirs.api, '--pack-destination', packDir, '--ignore-scripts', '--json',
    ], repoRoot, true))
    const cliPack = parsePack(run([
      'pack', packageDirs.cli, '--pack-destination', packDir, '--ignore-scripts', '--json',
    ], repoRoot, true))

    for (const packed of [apiPack, cliPack]) {
      const files = packed.files.map((file) => file.path)
      const leaked = files.filter((file) =>
        file.startsWith('src/')
        || file.endsWith('.map')
        || (file.endsWith('.ts') && !file.endsWith('.d.ts'))
        || file === 'tsconfig.json'
        || file === 'tsup.config.ts')
      assert(leaked.length === 0, `${packed.name} tarball contains private build files: ${leaked.join(', ')}`)
    }

    const apiTarball = path.join(packDir, apiPack.filename)
    const cliTarball = path.join(packDir, cliPack.filename)
    run(['install', '--ignore-scripts', '--no-audit', '--no-fund', apiTarball, cliTarball], bootstrapDir)

    const cliEntry = path.join(
      bootstrapDir,
      'node_modules',
      '@open-walnut',
      'plugin-cli',
      'dist',
      'cli.js',
    )
    const scaffold = spawnSync(process.execPath, [
      cliEntry,
      'new',
      'packed-consumer',
      '--directory',
      pluginDir,
      '--template',
      'both',
    ], { cwd: scratch, encoding: 'utf8', stdio: 'inherit', timeout: 60_000 })
    if (scaffold.error) throw scaffold.error
    if (scaffold.status !== 0) throw new Error(`packed walnut-plugin new failed (${scaffold.status})`)

    await fs.writeFile(path.join(pluginDir, 'src', 'public-contract.ts'), `
import { PureComponent, useDebugValue } from '@open-walnut/plugin-api/react'
import { useFormStatus } from '@open-walnut/plugin-api/react-dom'
import type { Disposable, WalnutTask } from '@open-walnut/plugin-api/server'
import type { TaskPhase, WalnutTaskSummary } from '@open-walnut/plugin-api/web'

export const publicContract = {
  PureComponent,
  useDebugValue,
  useFormStatus,
} satisfies Record<string, unknown>
export type PublicContractTypes = Disposable | WalnutTask | WalnutTaskSummary | TaskPhase
`)

    run([
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--save-dev',
      apiTarball,
      cliTarball,
    ], pluginDir)
    const runtimeProbe = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { WalnutPluginError } from '@open-walnut/plugin-api/server'
const error = new WalnutPluginError({ code: 'probe', message: 'runtime export' })
if (!(error instanceof Error) || error.code !== 'probe') process.exit(1)`,
    ], { cwd: pluginDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
    if (runtimeProbe.error) throw runtimeProbe.error
    assert(runtimeProbe.status === 0, `Plugin API runtime import failed: ${runtimeProbe.stderr || runtimeProbe.stdout}`)
    run(['run', 'test'], pluginDir)

    const [serverBundle, webBundle, generatedPackage, distFiles] = await Promise.all([
      fs.readFile(path.join(pluginDir, 'dist', 'server.mjs'), 'utf8'),
      fs.readFile(path.join(pluginDir, 'dist', 'web.mjs'), 'utf8'),
      fs.readFile(path.join(pluginDir, 'package.json'), 'utf8').then(JSON.parse),
      fs.readdir(path.join(pluginDir, 'dist')),
    ])
    const output = `${serverBundle}\n${webBundle}`
    assert(!output.includes(repoRoot), 'external Plugin bundle contains the Walnut checkout path')
    assert(!output.includes('packages/plugin-api/src'), 'external Plugin bundle imports Plugin API source')
    assert(!/from\s*["']react(?:\/[^"']*)?["']/.test(webBundle), 'web bundle retained a bare React import')
    assert(webBundle.includes('__WALNUT_PLUGIN_HOST__'), 'web bundle does not use Walnut shared React')
    assert(distFiles.sort().join(',') === 'server.mjs,web.mjs', `unexpected Plugin outputs: ${distFiles.join(', ')}`)
    assert(String(generatedPackage.devDependencies?.['@open-walnut/plugin-api']).startsWith('file:'), 'scaffold did not consume the packed Plugin API')
    assert(String(generatedPackage.devDependencies?.['@open-walnut/plugin-cli']).startsWith('file:'), 'scaffold did not consume the packed Plugin CLI')

    passed = true
    process.stdout.write('Plugin package tarballs passed clean-consumer verification.\n')
  } finally {
    if (passed && process.env.WALNUT_KEEP_PLUGIN_PACKAGE_CHECK !== '1') {
      await fs.rm(scratch, { recursive: true, force: true })
    } else {
      process.stderr.write(`Plugin package check files: ${scratch}\n`)
    }
  }
}

await main()
