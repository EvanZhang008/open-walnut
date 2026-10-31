/**
 * Codex 0.166 refuses any resume or turn whose thread provider is not the
 * app-server's OWN configured provider (modelProviderMismatch), and the
 * per-thread config override codex-acp sends never reaches that check. On
 * 2026-10-30 every Codex session whose provider came from Walnut's CODEX_CONFIG
 * broke on its next worker: the load after an interrupt failed, the fallback
 * thread's first turn failed, and the user saw "ACP provider protocol operation
 * failed". Walnut's patch to codex-acp
 * (patches/@agentclientprotocol%2Fcodex-acp@<version>.patch) passes the provider
 * to `codex app-server` as startup `-c` overrides. These tests run the installed
 * adapter against a stand-in `codex` that records its argv.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const ADAPTER = path.join(ROOT, 'node_modules/@agentclientprotocol/codex-acp/dist/index.js')

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

async function appServerArgv(codexConfig: string | undefined): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-acp-argv-'))
  dirs.push(dir)
  const out = path.join(dir, 'argv.json')
  const fake = path.join(dir, 'codex')
  // A shell stand-in, one argument per line: no Node on PATH needed. Written
  // to a temp name and renamed, so a half-written file is never read.
  fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${out}.tmp' && mv '${out}.tmp' '${out}'\n`, { mode: 0o755 })
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_PATH: fake, CODEX_HOME: dir }
  delete env.CODEX_CONFIG
  delete env.MODEL_PROVIDER
  if (codexConfig !== undefined) env.CODEX_CONFIG = codexConfig
  const child = spawn(process.execPath, [ADAPTER], { env, stdio: ['pipe', 'ignore', 'ignore'] })
  try {
    const deadline = Date.now() + 20_000
    while (!fs.existsSync(out)) {
      if (Date.now() > deadline) throw new Error('the adapter never started codex')
      await new Promise((r) => setTimeout(r, 50))
    }
    return fs.readFileSync(out, 'utf8').split('\n').filter((line) => line !== '')
  } finally {
    child.kill('SIGKILL')
  }
}

describe('codex-acp starts app-server with the CODEX_CONFIG provider', () => {
  it('lifts model_provider and its model_providers entry to startup overrides', async () => {
    const config = {
      model_provider: 'local-proxy',
      model_context_window: 1000000,
      developer_instructions: 'stays per thread',
      model_providers: {
        'local-proxy': { name: 'Local proxy', base_url: 'http://127.0.0.1:8402/openai/v1', wire_api: 'responses', requires_openai_auth: false, env_http_headers: { 'api-version': 'API_VERSION', 'odd.key': 'ODD' }, retries: [1, 2] },
      },
    }
    const argv = await appServerArgv(JSON.stringify(config))
    expect(argv[argv.length - 1]).toBe('app-server')
    expect(argv).toEqual([
      '-c', 'model_providers.local-proxy={name = "Local proxy", base_url = "http://127.0.0.1:8402/openai/v1", wire_api = "responses", requires_openai_auth = false, env_http_headers = {api-version = "API_VERSION", "odd.key" = "ODD"}, retries = [1, 2]}',
      '-c', 'model_provider="local-proxy"',
      'app-server',
    ])
    // Only the provider rides the command line; instructions stay per thread.
    expect(argv.join(' ')).not.toContain('stays per thread')
  }, 30_000)

  it('keeps provider secrets off the command line, and never names a provider it could not pass', async () => {
    // Any user of the host can read a command line (ps); the thread config still carries these.
    const argv = await appServerArgv(JSON.stringify({
      model_provider: 'gw',
      model_providers: { gw: { name: 'Gateway', base_url: 'https://gw.example/v1', experimental_bearer_token: 'tok-SECRET-1', http_headers: { Authorization: 'Bearer SECRET-2' }, query_params: { key: 'SECRET-3' }, env_http_headers: { 'X-Team': 'TEAM_ENV' } } },
    }))
    expect(argv).toEqual([
      '-c', 'model_providers.gw={name = "Gateway", base_url = "https://gw.example/v1", env_http_headers = {X-Team = "TEAM_ENV"}}',
      '-c', 'model_provider="gw"',
      'app-server',
    ])
    expect(argv.join(' ')).not.toMatch(/SECRET/)
    // A provider name that is not a bare TOML key is not passed, and so not named either.
    expect(await appServerArgv(JSON.stringify({ model_provider: 'a.b', model_providers: { 'a.b': { name: 'x' } } }))).toEqual(['app-server'])
    // A provider defined elsewhere (config.toml, built in) is still named.
    expect(await appServerArgv(JSON.stringify({ model_provider: 'openai' }))).toEqual(['-c', 'model_provider="openai"', 'app-server'])
  }, 60_000)

  it('starts plain app-server without CODEX_CONFIG or a provider in it', async () => {
    expect(await appServerArgv(undefined)).toEqual(['app-server'])
    expect(await appServerArgv(JSON.stringify({ developer_instructions: 'x' }))).toEqual(['app-server'])
  }, 30_000)

  it('the patch is registered for the installed codex-acp version', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { patchedDependencies?: Record<string, string> }
    const installed = (JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/@agentclientprotocol/codex-acp/package.json'), 'utf8')) as { version: string }).version
    const patch = pkg.patchedDependencies?.[`@agentclientprotocol/codex-acp@${installed}`]
    expect(patch, `codex-acp ${installed} has no Walnut patch: re-apply walnutProviderStartupArgs with bun patch`).toBeTruthy()
    expect(fs.readFileSync(path.join(ROOT, patch!), 'utf8')).toContain('walnutProviderStartupArgs')
    expect(fs.readFileSync(ADAPTER, 'utf8')).toContain('walnutProviderStartupArgs(config2)')
  })

  it('the patched adapter moves the daemon version, so every host gets it', () => {
    // A patch edit leaves package.json alone: only the bundle's own bytes tell a
    // host its codex-acp.mjs is stale. Both hash lists must name it.
    const bundle = 'node_modules/@agentclientprotocol/codex-acp/dist/index.js'
    expect(fs.readFileSync(path.join(ROOT, 'src/providers/daemon-version-check.ts'), 'utf8')).toContain(`'${bundle}'`)
    expect(fs.readFileSync(path.join(ROOT, 'scripts/build-daemon.sh'), 'utf8')).toContain(`  ${bundle}\n`)
  })
})
