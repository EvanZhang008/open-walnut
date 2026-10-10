/**
 * The host server's own tunnel (docs/plan/walnut-servers-everywhere.md,
 * "Exposure"): the same supervisor the Mac runs, fed a provider definition the
 * Mac sends as data (a plugin that provides it may be installed on the Mac only).
 *
 * The settings are kept in this server's data dir, so a tunnel that was on comes
 * back after a restart while the Mac is away. The tunnel points at the public
 * port, which trusts nothing on loopback.
 */

import fs from 'node:fs'
import path from 'node:path'
import { ExposeSupervisor, httpProbe, nodeSpawn, resolveRun, type SupervisorDeps } from '../core/expose/supervisor.js'
import { validateExposeDefinition } from '../core/expose/registry.js'
import type { ExposeProviderDefinition, ExposeStatus } from '../core/expose/types.js'
import { mcpServerEnv } from '../core/mcp-servers/env.js'

export interface HostExposeSettings {
  enabled: boolean
  definition: ExposeProviderDefinition | null
  options: Record<string, string>
}

export interface HostExpose {
  apply(settings: HostExposeSettings): Promise<ExposeStatus>
  status(): ExposeStatus
  settings(): HostExposeSettings
  retry(): void
  stop(): Promise<void>
}

const OFF: HostExposeSettings = { enabled: false, definition: null, options: {} }

function parseSettings(raw: unknown): HostExposeSettings {
  const s = raw as Partial<HostExposeSettings> | null
  if (!s || typeof s !== 'object') throw new Error('expose settings are an object')
  const definition = s.definition ?? null
  if (definition !== null) validateExposeDefinition(definition)
  const options: Record<string, string> = {}
  for (const [k, v] of Object.entries(s.options && typeof s.options === 'object' ? s.options : {})) {
    if (!/^[a-z][a-z0-9_]*$/i.test(k) || typeof v !== 'string' || v.length > 200) throw new Error(`options.${k} must be a short string`)
    options[k] = v
  }
  return { enabled: s.enabled === true, definition, options }
}

export function createHostExpose(opts: { port: number; stateFile: string; deps?: Partial<SupervisorDeps>; log: SupervisorDeps['log'] }): HostExpose {
  const deps: SupervisorDeps = {
    spawn: nodeSpawn,
    probe: httpProbe,
    now: Date.now,
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    log: opts.log,
    ...opts.deps,
  }
  const supervisor = new ExposeSupervisor(deps, () => { /* status() reads it */ })
  let current: HostExposeSettings = OFF
  let override: { lastError: string; since: number } | null = null
  let chain: Promise<unknown> = Promise.resolve()

  try {
    current = parseSettings(JSON.parse(fs.readFileSync(opts.stateFile, 'utf8')))
  } catch { /* none kept, or unreadable: off until the Mac sends them */ }

  function status(): ExposeStatus {
    const def = current.definition
    if (!current.enabled || !def) return { enabled: current.enabled, provider: def?.id ?? null, state: 'off', since: 0 }
    if (override) return { enabled: true, provider: def.id, providerTitle: def.title, state: 'unavailable', since: override.since, lastError: override.lastError }
    return { enabled: true, provider: def.id, providerTitle: def.title, ...supervisor.status(), port: opts.port }
  }

  async function reconcile(): Promise<ExposeStatus> {
    const def = current.definition
    if (!current.enabled || !def) {
      override = null
      await supervisor.stop()
      return status()
    }
    let run
    try {
      run = resolveRun(def, opts.port, current.options)
    } catch (err) {
      await supervisor.stop()
      override = { lastError: err instanceof Error ? err.message : String(err), since: Date.now() }
      return status()
    }
    override = null
    run.env = mcpServerEnv(run.env)
    const now = supervisor.running()
    const same = now && now.providerId === run.providerId && now.command === run.command && JSON.stringify(now.args) === JSON.stringify(run.args)
    if (!same) await supervisor.start(run, opts.port)
    return status()
  }

  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }

  void serialize(reconcile)

  return {
    apply: (raw) => serialize(async () => {
      const next = parseSettings(raw)
      fs.mkdirSync(path.dirname(opts.stateFile), { recursive: true, mode: 0o700 })
      const tmp = `${opts.stateFile}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 })
      fs.renameSync(tmp, opts.stateFile)
      current = next
      return reconcile()
    }),
    status,
    settings: () => current,
    retry: () => supervisor.retryNow(),
    stop: () => serialize(() => supervisor.stop()),
  }
}
