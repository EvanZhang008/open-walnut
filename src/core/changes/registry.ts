/**
 * Change providers: who can read a change's status (model.ts). Walnut ships GitHub's; a plugin adds
 * its own service with `walnut.registry.changeProvider(...)`, and the handle it gets back withdraws
 * it. The watcher (watch.ts) asks the first provider whose `handles` takes a link; core holds no rule
 * of any one service.
 */

import type { Disposable } from '../plugins/disposable.js'
import { toDisposable } from '../plugins/disposable.js'
import type { ChangeErrorCode, ChangeLink, ChangeSnapshot, ChangeStageDetail } from './model.js'

export type { ChangeLink } from './model.js'

/** What a provider found for one link: the snapshot's content (the watcher stamps the rest), and
 *  optionally when to read it next (else the watcher picks from what it waits on). */
export type ChangeReadResult =
  | { ok: true; snapshot: Omit<ChangeSnapshot, 'provider' | 'url' | 'checkedAt' | 'nextAt' | 'followedSince' | 'error'>; nextInMs?: number }
  | { ok: false; code: ChangeErrorCode; message: string }

export interface ChangeReadContext {
  /** Aborted when the read's deadline passes. */
  signal: AbortSignal
}

export interface ChangeProviderSpec {
  /** Unique id; a plugin's is prefixed with the plugin id. */
  id: string
  /** Whether this provider reads the link. Cheap and synchronous: it runs for every change link. */
  handles(link: ChangeLink): boolean
  /** Read many at once; one answer per link URL (a missing one counts as not read this time). The
   *  previous snapshot rides along, so a provider can skip what cannot have moved. */
  read(links: ReadonlyArray<ChangeLink & { prev?: ChangeSnapshot }>, ctx: ChangeReadContext): Promise<Map<string, ChangeReadResult>>
  /** One stage's steps and blockers, read live when the card opens it. */
  stageDetail?(link: ChangeLink, stage: string, ctx: ChangeReadContext): Promise<ChangeStageDetail | null>
}

export interface RegisteredChangeProvider extends ChangeProviderSpec {
  owner: string
}

const providers = new Map<string, RegisteredChangeProvider>()

/** Add a provider. Throws on a bad spec or a taken id (a plugin's mistake, shown at its load). */
export function registerChangeProvider(owner: string, spec: ChangeProviderSpec): Disposable {
  if (!spec?.id || typeof spec.handles !== 'function' || typeof spec.read !== 'function') {
    throw new Error(`changeProvider: needs an id, handles() and read(), got ${JSON.stringify({ id: spec?.id })}`)
  }
  if (providers.has(spec.id)) throw new Error(`changeProvider "${spec.id}" is already registered`)
  const entry: RegisteredChangeProvider = { ...spec, owner }
  providers.set(spec.id, entry)
  return toDisposable(() => { if (providers.get(spec.id) === entry) providers.delete(spec.id) })
}

/** The provider that reads a link: plugins first (they know their own hosts), then Walnut's. */
export function changeProviderFor(link: ChangeLink): RegisteredChangeProvider | undefined {
  const all = [...providers.values()]
  const ordered = [...all.filter((p) => p.owner !== 'core'), ...all.filter((p) => p.owner === 'core')]
  for (const p of ordered) {
    try { if (p.handles(link)) return p } catch { /* a broken handles() costs only its own links */ }
  }
  return undefined
}

export function listChangeProviders(): readonly RegisteredChangeProvider[] {
  return [...providers.values()]
}

/** For tests. */
export function _resetChangeProvidersForTesting(): void {
  providers.clear()
}
