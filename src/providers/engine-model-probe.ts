/**
 * Draft-time engine model catalog — a one-shot ACP handshake against an
 * engine's adapter (initialize → session/new → read the advertised models →
 * kill), so the DRAFT composer can list real models before any session exists.
 *
 * The live path discovers models the same way, but only after establish; a
 * draft has no session to ask, and "models are discovered at session start"
 * rendered as an empty picker (user report 2026-08-31). This probe is the
 * missing read: same adapter argv (resolveAcpArtifacts), same operator env
 * overlay (engines.<id>.env + mergeAcpSpawnEnv), so what it lists is exactly
 * what the launched session will offer.
 *
 * Request-path safety: the probe carries its own deadline and answers from a
 * cache (successes 10 min, failures 45 s) with in-flight dedupe — an open
 * picker can never stack adapter spawns or hang a route.
 */

import { spawn } from 'node:child_process'
import readline from 'node:readline'
import fs from 'node:fs'
import os from 'node:os'
import { engineCaps, isAcpEngine } from '../core/agents/engine-registry.js'
import type { SessionEngine } from '../core/types.js'
import {
  resolveAcpArtifacts,
  resolveSystemCodexPath,
  buildAcpAdapterEnv,
  engineEnvOverlayFromConfig,
} from './acp-session.js'
import {
  mergeAcpSpawnEnv,
  snapshotAcpModels,
  snapshotAcpConfigOptions,
  type AcpModelInfo,
} from './acp-worker/protocol.js'
import { log } from '../logging/index.js'

export interface EngineModelCatalog {
  engine: SessionEngine
  models: AcpModelInfo[]
  currentModelId?: string
  fetchedAt: number
  source: 'probe' | 'mock'
}

const PROBE_TIMEOUT_MS = 10_000
const SUCCESS_TTL_MS = 10 * 60_000
/** Failures stay cached briefly: a misconfigured engine (no creds) must not
 *  re-spawn its adapter on every picker open, but must recover fast after the
 *  operator fixes the config. */
const FAILURE_TTL_MS = 45_000

interface CacheEntry {
  at: number
  result?: EngineModelCatalog
  error?: string
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<EngineModelCatalog>>()

/** Test hook: drop all cached catalogs (mirrors engine-probe's reset). */
export function resetEngineModelCatalogCache(): void {
  cache.clear()
  inflight.clear()
}

/** Same fixture switch as engine-probe: fixtures force-install every engine
 *  and have no real adapters, so the catalog answers with the mock adapter's
 *  models (tests/providers/mock-acp-agent.mjs advertises the same two). */
function mockCatalog(engine: SessionEngine): EngineModelCatalog {
  return {
    engine,
    models: [
      { modelId: 'mock-gpt-best', name: 'Mock GPT Best', description: 'Best mock model' },
      { modelId: 'mock-gpt-fast', name: 'Mock GPT Fast', description: 'Fast mock model' },
    ],
    currentModelId: 'mock-gpt-best',
    fetchedAt: Date.now(),
    source: 'mock',
  }
}

export interface ProbeAdapterOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

/**
 * Speak just enough ACP to read the model catalog out of session/new, then
 * kill the adapter. Exported for tests (they point adapterCmd at the mock
 * agent); production goes through getEngineModelCatalog.
 */
export function probeAdapterModels(
  adapterCmd: string[],
  options: ProbeAdapterOptions = {},
): Promise<{ models: AcpModelInfo[]; currentModelId?: string }> {
  const [cmd, ...args] = adapterCmd
  if (!cmd) return Promise.reject(new Error('empty adapter command'))
  const cwd = options.cwd ?? os.homedir()
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let settled = false
    let stderrTail = ''
    const finish = (err: Error | null, result?: { models: AcpModelInfo[]; currentModelId?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Adapter processes double-fork nothing; a plain SIGTERM with a SIGKILL
      // chaser is enough, and both timers must not hold the event loop open.
      try { child.kill() } catch { /* already gone */ }
      const chaser = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 2_000)
      chaser.unref()
      if (err) reject(err)
      else resolve(result!)
    }
    const timer = setTimeout(() => {
      finish(new Error(`adapter did not answer session/new within ${Math.round(timeoutMs / 1000)}s${stderrTail ? ` — ${stderrTail}` : ''}`))
    }, timeoutMs)
    child.once('error', (e) => finish(new Error(`adapter spawn failed: ${e.message}`)))
    // 'close' not 'exit': close fires after the stdio streams flushed, so the
    // stderr tail is actually populated when the error message is built.
    child.once('close', (code) => {
      finish(new Error(`adapter exited (code ${code}) before answering${stderrTail ? ` — ${stderrTail}` : ''}`))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString()}`.slice(-400).replace(/\s+/g, ' ').trim()
    })
    // EPIPE arrives as an async 'error' EVENT (the write() try/catch only sees
    // sync throws) — an adapter that dies right after initialize would
    // otherwise turn a picker open into an uncaughtException on the server.
    child.stdin.on('error', () => { /* close handler reports the death */ })
    child.stdout.on('error', () => {})
    child.stderr?.on('error', () => {})

    const send = (msg: Record<string, unknown>) => {
      try { child.stdin.write(`${JSON.stringify(msg)}\n`) } catch { /* close handler reports */ }
    }
    const rl = readline.createInterface({ input: child.stdout })
    rl.on('error', () => {})
    rl.on('line', (line) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(line) as Record<string, unknown> } catch { return }
      // The adapter may ask things mid-handshake (fs reads, permissions) — a
      // probe grants nothing, but it must ANSWER or the adapter hangs on us.
      if (typeof msg.method === 'string' && msg.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported by the model probe' } })
        return
      }
      if (msg.id === 1) {
        if (msg.error) {
          finish(new Error(`initialize failed: ${describeRpcError(msg.error)}`))
          return
        }
        send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } })
        return
      }
      if (msg.id === 2) {
        if (msg.error) {
          finish(new Error(`session/new failed: ${describeRpcError(msg.error)}`))
          return
        }
        const snapshot = snapshotAcpModels(msg.result)
        if (snapshot.availableModels.length > 0) {
          finish(null, { models: snapshot.availableModels, currentModelId: snapshot.currentModelId })
          return
        }
        // Some adapters advertise models only as the `model` config option —
        // its choices are the same catalog under another name.
        const modelOption = snapshotAcpConfigOptions(msg.result).find((option) => option.id === 'model')
        if (modelOption) {
          finish(null, {
            models: modelOption.options.map((choice) => ({ modelId: choice.value, name: choice.name, ...(choice.description ? { description: choice.description } : {}) })),
            currentModelId: modelOption.currentValue,
          })
          return
        }
        finish(null, { models: [] })
      }
    })
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      },
    })
  })
}

function describeRpcError(error: unknown): string {
  if (error && typeof error === 'object') {
    const { message, code } = error as { message?: unknown; code?: unknown }
    if (typeof message === 'string' && message) return message
    if (code !== undefined) return `rpc error ${String(code)}`
  }
  return 'unknown rpc error'
}

/** argv for engines whose adapter comes from walnut config (source 'config') —
 *  same read AcpSession does on the establish path. */
async function configuredAdapterCmd(engine: SessionEngine): Promise<string[] | undefined> {
  if (engineCaps(engine).acpAdapter?.source !== 'config') return undefined
  try {
    const { getConfig } = await import('../core/config-manager.js')
    const config = await getConfig()
    const raw = (config as { engines?: Record<string, { adapter_cmd?: unknown } | undefined> })
      .engines?.[engine]?.adapter_cmd
    if (!Array.isArray(raw)) return undefined
    return raw.filter((arg): arg is string => typeof arg === 'string' && arg !== '')
  } catch {
    return undefined
  }
}

async function probeEngine(engine: SessionEngine, cwd?: string): Promise<EngineModelCatalog> {
  // A draft can point at a folder that doesn't exist yet ("Create folder &
  // start") — probe from $HOME then instead of failing the spawn on ENOENT.
  const probeCwd = cwd && fs.existsSync(cwd) ? cwd : undefined
  const { adapterCmd } = resolveAcpArtifacts(engine, {
    configuredAdapterCmd: await configuredAdapterCmd(engine),
  })
  // Same env contract as a real launch: operator overlay ('' = unset) under
  // walnut's managed keys. Codex additionally needs CODEX_PATH — its adapter
  // is a bundled package that would silently fall back to its own vendored
  // codex without it.
  let overlay: Record<string, string> | undefined
  try {
    const { getConfig } = await import('../core/config-manager.js')
    overlay = engineEnvOverlayFromConfig(await getConfig(), engine)
  } catch { /* unreadable config = no overlay, same as the launch path */ }
  const managed = engine === 'codex'
    ? buildAcpAdapterEnv(resolveSystemCodexPath(), { sessionId: `model-probe-${engine}` })
    : buildAcpAdapterEnv(undefined, { sessionId: `model-probe-${engine}` })
  const env = mergeAcpSpawnEnv(process.env, { ...(overlay ?? {}), ...(managed ?? {}) })
  const { models, currentModelId } = await probeAdapterModels(adapterCmd, { env, cwd: probeCwd })
  return { engine, models, currentModelId, fetchedAt: Date.now(), source: 'probe' }
}

/**
 * The engine's model catalog for DRAFT surfaces, cached + deduped. Throws for
 * non-ACP engines (claude's catalog has its own host-level pipeline) and when
 * the adapter can't answer (not installed / no credentials) — the route maps
 * that to an honest error body instead of an empty list.
 *
 * `cwd` should be the DRAFT's folder: opencode/goose resolve provider+model
 * config per project, so a $HOME probe could list a catalog the launch in
 * that folder won't offer. Cache is keyed per engine+cwd for the same reason.
 * `options.env` swaps ONLY the fixture-switch read (WALNUT_ENGINE_PROBE_ALL)
 * for tests — the adapter spawn always builds its env from real config.
 */
export async function getEngineModelCatalog(
  engine: SessionEngine,
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<EngineModelCatalog> {
  if (!isAcpEngine(engine)) {
    throw new Error(`engine '${engine}' does not advertise a provider model catalog`)
  }
  const probeEnv = options.env ?? process.env
  if (probeEnv.WALNUT_ENGINE_PROBE_ALL === '1') return mockCatalog(engine)
  const key = `${engine}|${options.cwd ?? ''}`
  const cached = cache.get(key)
  if (cached) {
    const age = Date.now() - cached.at
    if (cached.result && age < SUCCESS_TTL_MS) return cached.result
    if (cached.error && age < FAILURE_TTL_MS) throw new Error(cached.error)
  }
  const running = inflight.get(key)
  if (running) return running
  const probe = probeEngine(engine, options.cwd)
    .then((result) => {
      cache.set(key, { at: Date.now(), result })
      return result
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      cache.set(key, { at: Date.now(), error: message })
      log.session.warn('engine model probe failed', { engine, cwd: options.cwd, error: message })
      throw err instanceof Error ? err : new Error(message)
    })
    .finally(() => { inflight.delete(key) })
  inflight.set(key, probe)
  return probe
}
