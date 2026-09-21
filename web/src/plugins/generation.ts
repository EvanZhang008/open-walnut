import { apiGetText } from '@/api/client'
import { log } from '@/utils/log'
import { appRegistry } from '@/apps/registry'
import { createWebPluginApi } from './host-api'
import { WebPluginContext, disposable } from './disposable'
import { pluginUiRegistry } from './registry'
import type { Disposable, PluginWebModuleDescriptor, WalnutWebApiHost } from './types'

export type RefreshError = { id: string; error: string }

export interface WebPluginModule {
  activate?: (api: WalnutWebApiHost) => void | Disposable | Promise<void | Disposable>
  deactivate?: () => void | Promise<void>
  default?:
    | ((api: WalnutWebApiHost) => void | Disposable | Promise<void | Disposable>)
    | {
        activate(api: WalnutWebApiHost): void | Disposable | Promise<void | Disposable>
        deactivate?(): void | Promise<void>
      }
}

export type ModuleImporter = (
  source: string,
  descriptor: PluginWebModuleDescriptor,
) => Promise<WebPluginModule>

/** Kept on the loaded generation: the only bundle known to activate is the one that already did. */
interface PreparedModule {
  activate: (api: WalnutWebApiHost) => void | Disposable | Promise<void | Disposable>
  deactivate: (() => void | Promise<void>) | null
}

interface Generation {
  descriptor: PluginWebModuleDescriptor
  prepared: PreparedModule
}

interface LoadedPlugin extends Generation {
  context: WebPluginContext
  ownerToken: number
}

/** Work from a previous generation that blew its deadline and is STILL running. */
interface PendingWork {
  settled: boolean
  what: 'starting up' | 'shutting down'
  /** The generation this one displaced, so a settle can put it back instead of only retrying. */
  restore: Generation | null
}

const DEFAULT_CLEANUP_BUDGET_MS = 5_000

const loaded = new Map<string, LoadedPlugin>()
const pendingWork = new Map<string, PendingWork>()
/** A build that failed to start. Retrying the same hash just repeats it, so wait for a new one. */
const skippedBuild = new Map<string, string>()
const owners = new Map<string, number>()
let ownerSequence = 0
let activationTimeoutMs = 10_000
let cleanupBudgetMs = DEFAULT_CLEANUP_BUDGET_MS
let refreshAfterSettlement: () => void = () => undefined

export function setGenerationRefreshHandler(refresh: () => void): void {
  refreshAfterSettlement = refresh
}

export function managedPluginIds(): string[] {
  return [...new Set([...loaded.keys(), ...pendingWork.keys(), ...skippedBuild.keys()])]
}

const browserImporter: ModuleImporter = async (source, descriptor) => {
  const blob = new Blob([
    source,
    `\n//# sourceURL=walnut-plugin://${descriptor.id}/${descriptor.hash}.mjs\n`,
  ], { type: 'text/javascript' })
  const url = URL.createObjectURL(blob)
  try {
    return await import(/* @vite-ignore */ url) as WebPluginModule
  } finally {
    URL.revokeObjectURL(url)
  }
}

let moduleImporter: ModuleImporter = browserImporter

export function loadedPluginIds(): string[] {
  return [...loaded.keys()]
}

export function loadedHash(pluginId: string): string | undefined {
  return loaded.get(pluginId)?.descriptor.hash
}

export function isLoaded(pluginId: string): boolean {
  return loaded.has(pluginId)
}

/** Loaded descriptors ONLY: a module nothing is running must not be advertised as running. */
export function runningModules(offered: PluginWebModuleDescriptor[]): PluginWebModuleDescriptor[] {
  const result: PluginWebModuleDescriptor[] = []
  for (const descriptor of offered) {
    const current = loaded.get(descriptor.id)
    if (current) result.push(current.descriptor)
  }
  const offeredIds = new Set(offered.map((descriptor) => descriptor.id))
  for (const [pluginId, plugin] of loaded) {
    if (!offeredIds.has(pluginId)) result.push(plugin.descriptor)
  }
  return result
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function record(errors: RefreshError[], id: string, error: unknown): string {
  const message = messageOf(error)
  errors.push({ id, error: message })
  return message
}

function functionsFrom(module: WebPluginModule): {
  activate: ((api: WalnutWebApiHost) => void | Disposable | Promise<void | Disposable>) | null
  deactivate: (() => void | Promise<void>) | null
} {
  if (typeof module.activate === 'function') {
    return {
      activate: module.activate,
      deactivate: typeof module.deactivate === 'function' ? module.deactivate : null,
    }
  }
  if (typeof module.default === 'function') {
    return { activate: module.default, deactivate: null }
  }
  if (module.default && typeof module.default.activate === 'function') {
    return {
      activate: module.default.activate.bind(module.default),
      deactivate: typeof module.default.deactivate === 'function'
        ? module.default.deactivate.bind(module.default)
        : null,
    }
  }
  return { activate: null, deactivate: null }
}

function claimOwner(pluginId: string): number {
  const token = ++ownerSequence
  owners.set(pluginId, token)
  return token
}

function releaseOwner(pluginId: string, token: number): void {
  if (owners.get(pluginId) !== token) return
  owners.delete(pluginId)
  pluginUiRegistry.removeOwner(pluginId)
  appRegistry.removeOwner(pluginId)
}

/** Rows left behind by a generation that never made it into `loaded`. */
export function sweepUnownedRows(pluginId: string): void {
  if (owners.has(pluginId)) return
  pluginUiRegistry.removeOwner(pluginId)
  appRegistry.removeOwner(pluginId)
}

function trackPending(
  promise: Promise<void>,
  what: PendingWork['what'],
  restore: Generation | null,
): PendingWork {
  const pending: PendingWork = { settled: false, what, restore }
  const settle = () => {
    pending.settled = true
    if ([...pendingWork.values()].includes(pending)) refreshAfterSettlement()
  }
  void promise.then(settle, settle)
  return pending
}

/** 409 is the server replacing the bundle under this request; 404/401/403 answer the same forever. */
const RETRYABLE_MODULE_STATUS = new Set([408, 409, 425, 429])

function isTransientFetchFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status
  // No status at all is an abort, a timeout, or the admission queue giving up, all of which clear.
  if (typeof status !== 'number') return true
  return status === 0 || status >= 500 || RETRYABLE_MODULE_STATUS.has(status)
}

type PreflightResult =
  | { ok: true; prepared: PreparedModule }
  | { ok: false; error: unknown; transient: boolean }

/** A top-level await that never settles would otherwise hold the refresh queue open forever. */
async function evaluateWithDeadline(
  work: Promise<WebPluginModule>,
  pluginId: string,
): Promise<WebPluginModule> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `Web Plugin "${pluginId}" module evaluation timed out after ${activationTimeoutMs}ms`,
        )), activationTimeoutMs)
      }),
    ])
  } catch (error) {
    void work.then(undefined, () => undefined)
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Everything that can fail without costing a working plugin, done before anything is torn down. */
async function preflight(descriptor: PluginWebModuleDescriptor): Promise<PreflightResult> {
  let source: string
  try {
    source = await apiGetText(descriptor.url, undefined, { timeoutMs: 15_000 })
  } catch (error) {
    return { ok: false, error, transient: isTransientFetchFailure(error) }
  }
  try {
    const module = await evaluateWithDeadline(moduleImporter(source, descriptor), descriptor.id)
    const functions = functionsFrom(module)
    if (!functions.activate) throw new Error('Web Plugin module must export activate(walnut)')
    return { ok: true, prepared: { activate: functions.activate, deactivate: functions.deactivate } }
  } catch (error) {
    // A bundle that will not evaluate, by syntax or by hanging, evaluates the same way next time,
    // and retrying it would pile up abandoned evaluations. The next build is the fix.
    return { ok: false, error, transient: false }
  }
}

type DeadlineResult =
  | { kind: 'done'; value: void | Disposable }
  | { kind: 'failed'; error: unknown }
  | { kind: 'pending'; error: Error; settled: Promise<void> }

/** `pending` is the one outcome where the plugin's own code is STILL running after we gave up. */
async function activateWithDeadline(
  activate: (api: WalnutWebApiHost) => void | Disposable | Promise<void | Disposable>,
  api: WalnutWebApiHost,
  pluginId: string,
  context: WebPluginContext,
): Promise<DeadlineResult> {
  let activation: Promise<void | Disposable>
  try {
    activation = Promise.resolve(activate(api))
  } catch (error) {
    return { kind: 'failed', error }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), activationTimeoutMs)
  })
  try {
    const outcome = await Promise.race([
      activation.then(
        (value): { kind: 'done'; value: void | Disposable } => ({ kind: 'done', value }),
        (error): { kind: 'failed'; error: unknown } => ({ kind: 'failed', error }),
      ),
      deadline,
    ])
    if (outcome !== 'timeout') return outcome
    // A late return is still a live resource, so hand it to the context the caller is about to
    // dispose. The store tracks its disposal, so `quiet()` is what says the generation is gone.
    const settled = activation
      .then((late) => { if (late) context.own(late) }, () => undefined)
      .then(() => context.quiet())
    return {
      kind: 'pending',
      error: new Error(`Web Plugin "${pluginId}" activation timed out after ${activationTimeoutMs}ms`),
      settled,
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type ActivationOutcome =
  | { ok: true; plugin: LoadedPlugin }
  | { ok: false; error: unknown; blocked: boolean }

async function activateGeneration(generation: Generation): Promise<ActivationOutcome> {
  const { descriptor, prepared } = generation
  const context = new WebPluginContext()
  const ownerToken = claimOwner(descriptor.id)
  // Registered before the await, so an activation that throws or hangs still runs deactivate().
  if (prepared.deactivate) context.own(disposable(prepared.deactivate))
  const outcome = await activateWithDeadline(
    prepared.activate,
    createWebPluginApi(descriptor.id, descriptor.name, context),
    descriptor.id,
    context,
  )
  if (outcome.kind === 'done') {
    if (outcome.value) context.own(outcome.value)
    return { ok: true, plugin: { descriptor, prepared, context, ownerToken } }
  }
  const report = await context.disposeWithin(cleanupBudgetMs)
  for (const failure of report.errors) {
    log.error('plugins', 'native Web Plugin cleanup failed after a failed activation', {
      pluginId: descriptor.id,
      error: messageOf(failure),
    })
  }
  releaseOwner(descriptor.id, ownerToken)
  // Either half still running means the plugin's own code is live somewhere we cannot see.
  if (outcome.kind === 'pending') {
    pendingWork.set(descriptor.id, trackPending(outcome.settled, 'starting up', null))
    return { ok: false, error: outcome.error, blocked: true }
  }
  if (report.unsettled) {
    pendingWork.set(descriptor.id, trackPending(context.quiet(), 'shutting down', null))
    return { ok: false, error: outcome.error, blocked: true }
  }
  return { ok: false, error: outcome.error, blocked: false }
}

async function restoreGeneration(generation: Generation, errors: RefreshError[]): Promise<void> {
  const restored = await activateGeneration(generation)
  if (restored.ok) {
    loaded.set(generation.descriptor.id, restored.plugin)
    log.warn('plugins', 'restored the previous native Web Plugin build', {
      pluginId: generation.descriptor.id,
      hash: generation.descriptor.hash,
    })
    return
  }
  log.error('plugins', 'could not restore the previous native Web Plugin build', {
    pluginId: generation.descriptor.id,
    error: record(errors, generation.descriptor.id, restored.error),
  })
}

/** Tear down the running generation within one budget. False means it is still shutting down. */
async function retire(pluginId: string, errors: RefreshError[]): Promise<boolean> {
  const current = loaded.get(pluginId)
  if (!current) {
    sweepUnownedRows(pluginId)
    return true
  }
  loaded.delete(pluginId)
  const report = await current.context.disposeWithin(cleanupBudgetMs)
  for (const failure of report.errors) {
    log.error('plugins', 'native Web Plugin cleanup failed', {
      pluginId,
      error: record(errors, pluginId, failure),
    })
  }
  releaseOwner(pluginId, current.ownerToken)
  if (report.unsettled) {
    pendingWork.set(pluginId, trackPending(current.context.quiet(), 'shutting down', null))
    return false
  }
  return true
}

export async function unload(pluginId: string, errors: RefreshError[]): Promise<void> {
  await retire(pluginId, errors)
  const pending = pendingWork.get(pluginId)
  if (pending) pending.restore = null
  if (pending?.settled) pendingWork.delete(pluginId)
  skippedBuild.delete(pluginId)
  sweepUnownedRows(pluginId)
}

/** Preflight, then retire, then activate, then put the old one back: one live generation, always. */
export async function swapPlugin(
  descriptor: PluginWebModuleDescriptor,
  errors: RefreshError[],
): Promise<boolean> {
  // A different hash is a new build, and a new build deserves its own attempt.
  if (skippedBuild.get(descriptor.id) !== descriptor.hash) skippedBuild.delete(descriptor.id)

  const pending = pendingWork.get(descriptor.id)
  if (pending) {
    if (!pending.settled) {
      record(errors, descriptor.id, new Error(
        `Web Plugin "${descriptor.id}" is still ${pending.what}, so the new build was not started`,
      ))
      return true
    }
    pendingWork.delete(descriptor.id)
    // It finally stopped, so the build it displaced can have its place back.
    if (pending.restore) await restoreGeneration(pending.restore, errors)
    if (pendingWork.has(descriptor.id)) return true
  }

  if (loadedHash(descriptor.id) === descriptor.hash) return false
  if (skippedBuild.get(descriptor.id) === descriptor.hash) {
    record(errors, descriptor.id, new Error(
      `Web Plugin "${descriptor.id}" build ${descriptor.hash} failed to start, so it is skipped until a new build arrives`,
    ))
    return false
  }

  const candidate = await preflight(descriptor)
  if (!candidate.ok) {
    if (!candidate.transient) skippedBuild.set(descriptor.id, descriptor.hash)
    log.error('plugins', 'native Web Plugin module preflight failed, keeping the running build', {
      pluginId: descriptor.id,
      hash: descriptor.hash,
      error: record(errors, descriptor.id, candidate.error),
    })
    return candidate.transient
  }

  const previous = loaded.get(descriptor.id)
  if (previous && !await retire(descriptor.id, errors)) {
    const pending = pendingWork.get(descriptor.id)
    if (pending) pending.restore = previous
    // Two live copies of whatever that disposer holds is worse than a reload arriving late.
    record(errors, descriptor.id, new Error(
      `Web Plugin "${descriptor.id}" cleanup did not finish within ${cleanupBudgetMs}ms, so the new build was not started`,
    ))
    return true
  }

  const started = await activateGeneration({ descriptor, prepared: candidate.prepared })
  if (started.ok) {
    loaded.set(descriptor.id, started.plugin)
    return false
  }
  log.error('plugins', 'native Web Plugin activation failed', {
    pluginId: descriptor.id,
    error: record(errors, descriptor.id, started.error),
  })
  skippedBuild.set(descriptor.id, descriptor.hash)
  if (started.blocked) {
    // Restoring on top of a candidate that is still running would double-open it, so the previous
    // build rides along on the pending record and goes back in as soon as this one stops.
    const entry = pendingWork.get(descriptor.id)
    if (entry && previous) entry.restore = { descriptor: previous.descriptor, prepared: previous.prepared }
    return true
  }
  if (previous) await restoreGeneration(previous, errors)
  return false
}

export async function resetGenerationsForTesting(): Promise<void> {
  refreshAfterSettlement = () => undefined
  for (const pluginId of loadedPluginIds()) await unload(pluginId, [])
  loaded.clear()
  owners.clear()
  pendingWork.clear()
  skippedBuild.clear()
  moduleImporter = browserImporter
  activationTimeoutMs = 10_000
  cleanupBudgetMs = DEFAULT_CLEANUP_BUDGET_MS
}

export function setWebPluginImporterForTesting(importer: ModuleImporter): void {
  moduleImporter = importer
}

export function setWebPluginActivationTimeoutForTesting(timeoutMs: number): void {
  activationTimeoutMs = timeoutMs
}

export function setWebPluginCleanupBudgetForTesting(timeoutMs: number): void {
  cleanupBudgetMs = timeoutMs
}
