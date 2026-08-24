import path from 'node:path'
import { appUrl } from './app-route.js'
import { buildPlugin, type BuildPluginOptions, type PluginBuildResult } from './build.js'
import { apiBaseUrl, ApiError, apiRequest } from './http.js'
import { linkPlugin } from './link.js'
import { assertValid, validatePlugin, type ValidationResult } from './manifest.js'
import { canOpenBrowser, npmInstall, openUrl } from './process.js'
import { assertScaffoldTemplate, DEFAULT_TEMPLATE, scaffoldPlugin, type ScaffoldTemplate } from './scaffold.js'

/** What the running Walnut reports about one plugin. */
export interface PluginRuntimeStatus {
  id: string
  state?: string
  error?: string
}

/** Every side effect of the flow, so a test can install nothing and open nothing. */
export interface DevDependencies {
  install(root: string): Promise<void>
  validate(root: string): Promise<ValidationResult>
  build(options: BuildPluginOptions): Promise<PluginBuildResult>
  link(root: string): Promise<string>
  discover(pluginId: string): Promise<void>
  reload(pluginId: string): Promise<void>
  status(pluginId: string): Promise<PluginRuntimeStatus | undefined>
  openUrl(url: string): Promise<void>
  write(text: string): void
  baseUrl(): string
  canOpen(): boolean
}

/** `active` loaded, `offline` nothing answered, `failed` Walnut answered and refused. */
export type DevState = 'active' | 'offline' | 'failed'

export interface DevReport {
  state: DevState
  detail?: string
  plugin?: PluginRuntimeStatus
}

export interface DevOptions {
  root?: string
  /** Run `npm install` first, which is what `new --dev` does. */
  install?: boolean
  /** Open the App URL, honoured only for an interactive non-CI terminal. */
  open?: boolean
  deps?: Partial<DevDependencies>
}

export interface DevSession {
  root: string
  pluginId: string
  /** Only a plugin with a web surface has an App to open. */
  appUrl?: string
  state: DevState
  report: DevReport
  stop(): Promise<void>
}

async function fetchStatus(pluginId: string): Promise<PluginRuntimeStatus | undefined> {
  const data = await apiRequest<{ plugins?: PluginRuntimeStatus[] }>('/api/plugin-runtime')
  return (data.plugins ?? []).find((plugin) => plugin.id === pluginId)
}

export function defaultDevDependencies(): DevDependencies {
  return {
    install: npmInstall,
    validate: (root) => validatePlugin(root),
    build: (options) => buildPlugin(options),
    link: (root) => linkPlugin(root),
    // Discover is what makes a FIRST link load without restarting Walnut; a bare reload would 404.
    discover: async (pluginId) => {
      await apiRequest('/api/plugin-runtime/discover', {
        method: 'POST',
        body: JSON.stringify({ pluginId }),
      })
    },
    reload: async (pluginId) => {
      await apiRequest(`/api/plugin-runtime/${encodeURIComponent(pluginId)}/reload`, { method: 'POST' })
    },
    status: fetchStatus,
    openUrl,
    write: (text) => { process.stdout.write(text) },
    baseUrl: apiBaseUrl,
    canOpen: canOpenBrowser,
  }
}

function resolveDeps(overrides?: Partial<DevDependencies>): DevDependencies {
  return { ...defaultDevDependencies(), ...overrides }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Discover, reload, then read the state back: a reload can return 200 while the plugin quarantines. */
export async function syncPlugin(pluginId: string, deps: DevDependencies): Promise<DevReport> {
  try {
    try {
      await deps.discover(pluginId)
    } catch (error) {
      // No such route (older build) or 501 (a replica) both still reload a known plugin; a 404 that carried an error is a real miss.
      const cannotDiscover = error instanceof ApiError && (error.routeMissing || error.status === 501)
      if (!cannotDiscover) throw error
      deps.write('note: this Walnut has no discover route; a brand-new link needs a restart\n')
    }
    await deps.reload(pluginId)
    const plugin = await deps.status(pluginId)
    if (!plugin) {
      return { state: 'failed', detail: `${pluginId} is not in the running Walnut's plugin list` }
    }
    if (plugin.state !== 'active') {
      const reason = plugin.error ? `: ${plugin.error}` : ''
      return { state: 'failed', detail: `${pluginId} is ${plugin.state ?? 'unknown'}${reason}`, plugin }
    }
    return { state: 'active', plugin }
  } catch (error) {
    if (error instanceof ApiError && error.offline) return { state: 'offline', detail: error.message }
    return { state: 'failed', detail: describe(error) }
  }
}

/** One line naming which of the three outcomes happened, and why. */
export function reportLine(pluginId: string, report: DevReport, baseUrl: string): string {
  if (report.state === 'active') return `active: ${pluginId}\n`
  if (report.state === 'offline') {
    return `offline: ${report.detail ?? `Walnut is not answering at ${baseUrl}`}; the link loads on Walnut's next start\n`
  }
  return `failed: ${report.detail ?? `Walnut could not load ${pluginId}`}\n`
}

/** install → validate → build (watch, first success) → link → discover → reload → status → App URL → rebuild syncs. */
export async function runDev(options: DevOptions = {}): Promise<DevSession> {
  const deps = resolveDeps(options.deps)
  const root = path.resolve(options.root ?? process.cwd())

  if (options.install) {
    deps.write('installing dependencies with npm install\n')
    await deps.install(root)
  }

  const manifest = assertValid(await deps.validate(root))
  const pluginId = manifest.id
  const baseUrl = deps.baseUrl()
  const url = manifest.web ? appUrl(pluginId, baseUrl) : undefined

  // Serialize syncs so a save landing mid-sync queues instead of racing the link.
  let queue: Promise<void> = Promise.resolve()
  const enqueue = (run: () => Promise<void>): Promise<void> => {
    queue = queue.then(run, run)
    return queue
  }

  // A save before the first link has nothing to reload; the first sync covers it.
  let linked = false
  const build = await deps.build({
    root,
    watch: true,
    onRebuild: () => enqueue(async () => {
      if (!linked) return
      deps.write('rebuilt\n')
      const rebuilt = await syncPlugin(pluginId, deps)
      deps.write(reportLine(pluginId, rebuilt, baseUrl))
    }),
  })

  // From here the watcher is live, so every failure has to take it down with it.
  try {
    const target = await deps.link(root)
    linked = true
    deps.write(`linked: ${target}\n`)

    let report: DevReport = { state: 'failed', detail: `${pluginId} was never synced` }
    await enqueue(async () => {
      report = await syncPlugin(pluginId, deps)
      deps.write(reportLine(pluginId, report, baseUrl))
    })

    if (url) {
      deps.write(`App: ${url}\n`)
      if (options.open) {
        if (report.state !== 'active') deps.write('not opening the App yet; Walnut has not loaded this plugin\n')
        else if (!deps.canOpen()) deps.write('not opening a browser; this is not an interactive terminal\n')
        else await deps.openUrl(url)
      }
    }

    deps.write('watching for changes; press Ctrl+C to stop\n')

    return {
      root,
      pluginId,
      appUrl: url,
      state: report.state,
      report,
      stop: async () => { await build.stop?.() },
    }
  } catch (error) {
    await build.stop?.()
    throw error
  }
}

export interface NewOptions {
  id: string
  directory?: string
  template?: ScaffoldTemplate
  /** Install, link, watch, and reload right after scaffolding. */
  dev?: boolean
  /** Only meaningful with `dev`; `--no-install` turns it off. */
  install?: boolean
  open?: boolean
  deps?: Partial<DevDependencies>
  scaffold?(id: string, destination: string, options: { template: ScaffoldTemplate }): Promise<string>
}

export interface NewResult {
  root: string
  session?: DevSession
}

/** `walnut-plugin new <id> [--dev]`: scaffold, then optionally go straight live. */
export async function runNew(options: NewOptions): Promise<NewResult> {
  const deps = resolveDeps(options.deps)
  const template = assertScaffoldTemplate(options.template ?? DEFAULT_TEMPLATE)
  const scaffold = options.scaffold ?? scaffoldPlugin
  const root = await scaffold(options.id, options.directory ?? options.id, { template })
  deps.write(`${root}\n`)
  if (!options.dev) return { root }
  const session = await runDev({
    root,
    install: options.install !== false,
    open: options.open,
    deps,
  })
  return { root, session }
}
