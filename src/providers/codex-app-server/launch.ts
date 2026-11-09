/**
 * How the worker starts `codex app-server` itself: which binary (CODEX_PATH, the
 * one the server or the host's daemon found), whether its version is one this
 * client speaks, and the command-line overrides every session's app-server needs.
 *
 * The overrides are the ones the codex-acp patch used to add, so a session keeps
 * its provider, model catalog and model when it moves to the direct connection:
 * - the provider CODEX_CONFIG defines (`-c model_providers.<id>=…`, `-c model_provider=…`),
 *   because Codex checks a thread's provider against the app-server's own;
 * - for an endpoint whose model ids carry a prefix (WALNUT_CODEX_MODEL_PREFIX), a model
 *   catalog under the prefixed ids read from this Codex (`codex debug models`), and a
 *   prefixed model for a thread whose config names none.
 * Secrets in a provider (bearer token, headers, query) never go on the command line,
 * which every user of the host can read; they reach each thread through its config.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { codexProviderStartupArgs, tomlInline } from '../codex-model-probe.js'
import { CODEX_MODEL_PREFIX_ENV } from '../codex-engine-config.js'

/**
 * The oldest Codex this client was checked against: the protocol fields it uses
 * (thread/start, thread/resume, turn/start, turn/steer with expectedTurnId,
 * turn/interrupt, the approval requests) are the same from here to the newest
 * checked one (tests/providers/codex-app-server-schema.test.ts).
 */
export const MIN_CODEX_VERSION = '0.144.0'

const VERSION_TIMEOUT_MS = 15_000
const DEBUG_MODELS_TIMEOUT_MS = 15_000

export interface CodexLaunch {
  command: string
  args: string[]
  version: string
  /** CODEX_CONFIG parsed (the thread config), with a prefixed model filled in when one was needed. */
  threadConfig: Record<string, unknown>
  shell: boolean
}

/** A failure the worker reports with Walnut's own words (they name no secret). */
export class CodexLaunchError extends Error {
  constructor(readonly kind: 'provider_missing' | 'provider_incompatible' | 'adapter_spawn_failed', message: string) {
    super(message)
    this.name = 'CodexLaunchError'
  }
}

export function parseCodexVersion(text: string): string | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : undefined
}

/** -1, 0 or 1, comparing dotted numeric versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env, timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve(String(stdout))
    })
  })
}

export async function readCodexVersion(codexPath: string, env: NodeJS.ProcessEnv): Promise<string> {
  let out: string
  try {
    out = await run(codexPath, ['--version'], env, VERSION_TIMEOUT_MS)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EACCES') throw new CodexLaunchError('provider_missing', `Codex is not installed at ${codexPath} (${code}).`)
    throw new CodexLaunchError('adapter_spawn_failed', `Codex at ${codexPath} did not report its version (\`codex --version\` failed).`)
  }
  const version = parseCodexVersion(out)
  if (!version) throw new CodexLaunchError('provider_incompatible', `Codex at ${codexPath} printed no version Walnut can read.`)
  if (compareVersions(version, MIN_CODEX_VERSION) < 0) {
    throw new CodexLaunchError('provider_incompatible',
      `Codex ${version} is older than ${MIN_CODEX_VERSION}, the oldest version Walnut's direct Codex connection supports. `
      + 'Update Codex on this host, or set engines.codex.transport: acp in Walnut\'s config to use the ACP adapter.')
  }
  return version
}

function parseThreadConfig(env: NodeJS.ProcessEnv): Record<string, unknown> {
  if (!env.CODEX_CONFIG) return {}
  let parsed: unknown
  try { parsed = JSON.parse(env.CODEX_CONFIG) } catch { throw new CodexLaunchError('adapter_spawn_failed', 'CODEX_CONFIG is not valid JSON.') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CodexLaunchError('adapter_spawn_failed', 'CODEX_CONFIG must be a JSON object.')
  return parsed as Record<string, unknown>
}

/** The catalog for a prefixed endpoint (see the file comment); [] when none applies or it cannot be built. */
async function modelCatalogArgs(codexPath: string, startupArgs: string[], config: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<string[]> {
  const named = config.model_catalog_json
  if (typeof named === 'string' && named) return ['-c', `model_catalog_json=${tomlInline(named)}`]
  const prefix = env[CODEX_MODEL_PREFIX_ENV]
  if (!prefix) return []
  try {
    const listed = JSON.parse(await run(codexPath, [...startupArgs, 'debug', 'models'], env, DEBUG_MODELS_TIMEOUT_MS)) as { models?: unknown }
    const models = (Array.isArray(listed?.models) ? listed.models : [])
      .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && typeof (m as { slug?: unknown }).slug === 'string')
      .map((m) => {
        const slug = m.slug as string
        const entry: Record<string, unknown> = { ...m, slug: slug.startsWith(prefix) ? slug : prefix + slug, use_responses_lite: false }
        delete entry.tool_mode
        return entry
      })
    if (models.length === 0) return []
    const body = JSON.stringify({ ...listed, models })
    const file = path.join(os.tmpdir(), `walnut-codex-models-${createHash('sha256').update(body).digest('hex').slice(0, 16)}.json`)
    if (!fs.existsSync(file)) {
      // A catalog this Codex cannot read ends its app-server: it is tried first and kept only when it loads.
      const tmp = `${file}.${process.pid}.tmp`
      await fs.promises.writeFile(tmp, body, { mode: 0o600 })
      try {
        await run(codexPath, [...startupArgs, '-c', `model_catalog_json=${tomlInline(tmp)}`, 'debug', 'models'], env, DEBUG_MODELS_TIMEOUT_MS)
      } catch (error) {
        await fs.promises.rm(tmp, { force: true })
        throw error
      }
      await fs.promises.rename(tmp, file)
    }
    return ['-c', `model_catalog_json=${tomlInline(file)}`]
  } catch {
    return []
  }
}

/** With a prefix, a thread whose config names no model starts on the host's default, prefixed (see the file comment). */
function fillPrefixedModel(config: Record<string, unknown>, catalogArgs: string[], env: NodeJS.ProcessEnv): void {
  const prefix = env[CODEX_MODEL_PREFIX_ENV]
  if (!prefix || typeof config.model === 'string') return
  let model: string | undefined
  try {
    const home = env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex')
    for (const line of fs.readFileSync(path.join(home, 'config.toml'), 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.startsWith('[')) break
      const m = /^model\s*=\s*"([^"]+)"/.exec(trimmed)
      if (m) model = m[1]
    }
  } catch { /* no config.toml */ }
  if (!model) {
    const at = catalogArgs.findIndex((a) => a.startsWith('model_catalog_json='))
    try {
      const file = at >= 0 ? JSON.parse(catalogArgs[at].slice('model_catalog_json='.length)) as string : ''
      const listed = file ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { models?: Array<Record<string, unknown>> }).models ?? [] : []
      const shown = listed.filter((m) => typeof m.slug === 'string' && (m.visibility === undefined || m.visibility === 'list'))
      shown.sort((a, b) => (typeof a.priority === 'number' ? a.priority : 1e9) - (typeof b.priority === 'number' ? b.priority : 1e9))
      model = shown[0]?.slug as string | undefined
    } catch { /* unreadable catalog */ }
  }
  if (!model) {
    throw new CodexLaunchError('adapter_spawn_failed',
      'engines.codex.provider.model_prefix is set, but no model is named (engines.codex.model, the session\'s pick, or this host\'s '
      + '~/.codex/config.toml) and Codex\'s model list could not be read, so this session would start on a model id the endpoint gives no tools. '
      + 'Set engines.codex.model in Walnut\'s config.')
  }
  config.model = model.startsWith(prefix) ? model : prefix + model
}

export async function prepareCodexLaunch(env: NodeJS.ProcessEnv): Promise<CodexLaunch> {
  const codexPath = env.CODEX_PATH
  if (!codexPath) throw new CodexLaunchError('provider_missing', 'No Codex executable was found for this session (CODEX_PATH is not set).')
  const version = await readCodexVersion(codexPath, env)
  const threadConfig = parseThreadConfig(env)
  if (process.platform === 'win32') {
    // A Windows shim runs through the shell; the provider then reaches threads through their config only.
    return { command: `"${codexPath}" app-server`, args: [], version, threadConfig, shell: true }
  }
  let startupArgs: string[]
  try { startupArgs = codexProviderStartupArgs(env) } catch (error) {
    throw new CodexLaunchError('adapter_spawn_failed', (error as Error).message)
  }
  const catalogArgs = await modelCatalogArgs(codexPath, startupArgs, threadConfig, env)
  fillPrefixedModel(threadConfig, catalogArgs, env)
  return { command: codexPath, args: [...startupArgs, ...catalogArgs, 'app-server'], version, threadConfig, shell: false }
}
