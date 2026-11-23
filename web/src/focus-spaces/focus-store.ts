/**
 * Focus spaces, browser side: the saved spaces and the one the person is in, as the server
 * holds them (/api/v1/focus-spaces, src/core/focus-spaces/). One app-wide copy: read once,
 * then follow `focus-space:changed`, read again after a reconnect. A focus whose `until`
 * passed ends here at that moment too, without waiting for the server's word.
 *
 * A test run's writes stay in its own copy on the server and publish nothing, so its window
 * takes each write's own answer (as quiet.ts does).
 */
import { useSyncExternalStore } from 'react'
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '@/api/client'
import { wsClient } from '@/api/ws'
import { testRunLabel } from '@/api/test-run'
import { fetchConfig, fetchFreshConfig } from '@/api/config'
import { experimentalEnabled, type ExperimentalFlags } from '@open-walnut/core'
import { log } from '@/utils/log'
import type { ActiveFocus, FocusAppMode, FocusBy, FocusScope, FocusSpace } from '@open-walnut/focus-scope'

// One set of types with the server (src/core/focus-spaces/scope.ts).
export type { ActiveFocus, FocusAppMode, FocusBy, FocusSpace }

/** A plugin with an App, and what its manifest declares for spaces (`focusSpaces`). */
export interface FocusApp {
  pluginId: string
  name: string
  declared?: 'scoped' | 'shared'
}

export interface FocusSnapshot {
  loaded: boolean
  spaces: readonly FocusSpace[]
  active: ActiveFocus | null
  apps: readonly FocusApp[]
}

const BASE = '/api/v1/focus-spaces'
let state: FocusSnapshot = { loaded: false, spaces: [], active: null, apps: [] }
const listeners = new Set<() => void>()
let bound = false
let reads = 0
let expiry: ReturnType<typeof setTimeout> | null = null

function emit(next: FocusSnapshot): void {
  state = next
  if (expiry) { clearTimeout(expiry); expiry = null }
  const until = next.active?.until
  if (until !== undefined) {
    // setTimeout holds at most ~24.8 days; a focus is at most 24 hours.
    expiry = setTimeout(() => { if (state.active?.until === until) emit({ ...state, active: null }) }, Math.max(0, until - Date.now()))
  }
  for (const l of listeners) l()
}

function live(active: ActiveFocus | null | undefined): ActiveFocus | null {
  return active && (active.until === undefined || active.until > Date.now()) ? active : null
}

const NONE: Omit<FocusSnapshot, 'loaded'> = { spaces: [], active: null, apps: [] }

/** Whether the experiment is on, by the page's config (null: unknown, so ask the route). */
async function experimentOn(fresh: boolean): Promise<boolean | null> {
  try {
    const cfg = await (fresh ? fetchFreshConfig() : fetchConfig())
    return experimentalEnabled((cfg as { experimental?: ExperimentalFlags }).experimental ?? {}, 'focus_workspace')
  } catch { return null }
}

/**
 * Read the server's state; the newest read wins. With the experiment off nothing is asked:
 * the route's 404 would be a failed request in every page's console (2026-11-22: it failed
 * every browser spec that checks the console). A 404 still reads as none.
 */
export async function loadFocus(opts: { freshConfig?: boolean } = {}): Promise<void> {
  const seq = ++reads
  const on = await experimentOn(!!opts.freshConfig)
  if (seq !== reads) return
  if (on === false) { emit({ loaded: true, ...NONE }); return }
  try {
    const body = await apiGet<{ spaces?: FocusSpace[]; active?: ActiveFocus | null; apps?: FocusApp[] }>(BASE, undefined, { quietStatuses: [404], timeoutMs: 10_000 })
    if (seq !== reads) return
    emit({ loaded: true, spaces: body.spaces ?? [], active: live(body.active), apps: body.apps ?? [] })
  } catch (err) {
    if (seq !== reads) return
    const status = (err as { status?: number }).status
    if (status !== 404) log.warn('focus-spaces', 'focus state load failed', { error: String(err) })
    emit({ loaded: true, spaces: status === 404 ? [] : state.spaces, active: status === 404 ? null : state.active, apps: status === 404 ? [] : state.apps })
  }
}

function bind(): void {
  if (bound) return
  bound = true
  wsClient.onEvent('focus-space:changed', (data: unknown) => {
    // A test run's own focus is only in its GET; the event carries the user's.
    if (testRunLabel()) { void loadFocus(); return }
    reads++ // a read still out predates this event
    const active = (data as { active?: ActiveFocus | null } | null)?.active ?? null
    emit({ ...state, active: live(active) })
  })
  wsClient.onEvent('_ws:reconnected', () => { void loadFocus({ freshConfig: true }) })
  wsClient.onEvent('config:changed', (data: unknown) => {
    const { key } = (data ?? {}) as { key?: string }
    if (!key || key === 'experimental') void loadFocus({ freshConfig: true })
  })
  void loadFocus()
}

function subscribe(fn: () => void): () => void {
  bind()
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function focusSnapshot(): FocusSnapshot {
  return state
}

/** The state, live. Reading it starts the first load. */
export function useFocusSnapshot(): FocusSnapshot {
  return useSyncExternalStore(subscribe, focusSnapshot, focusSnapshot)
}

function withSpace(space: FocusSpace): readonly FocusSpace[] {
  const at = state.spaces.findIndex((s) => s.id === space.id)
  return at < 0 ? [...state.spaces, space] : state.spaces.map((s, i) => (i === at ? space : s))
}

export async function createFocusSpace(input: { name: string; projects?: string[]; tasks?: string[]; apps?: Record<string, FocusAppMode> }): Promise<FocusSpace> {
  const { space } = await apiPost<{ space: FocusSpace }>(BASE, input)
  emit({ ...state, spaces: withSpace(space) })
  return space
}

export async function updateFocusSpace(id: string, input: Partial<Pick<FocusSpace, 'name' | 'projects' | 'tasks' | 'apps'>>): Promise<FocusSpace> {
  const { space } = await apiPatch<{ space: FocusSpace }>(`${BASE}/${encodeURIComponent(id)}`, input)
  emit({ ...state, spaces: withSpace(space) })
  if (state.active?.spaceId === id) void loadFocus() // the focus follows the edit on the server
  return space
}

export async function deleteFocusSpace(id: string): Promise<void> {
  await apiDelete(`${BASE}/${encodeURIComponent(id)}`)
  emit({ ...state, spaces: state.spaces.filter((s) => s.id !== id), active: state.active?.spaceId === id ? null : state.active })
}

export type EnterFocusInput =
  | { spaceId: string; until?: number; by?: FocusBy }
  | { scope: FocusScope; name: string; until?: number; by?: FocusBy }

export async function enterFocus(input: EnterFocusInput): Promise<ActiveFocus> {
  const { active } = await apiPut<{ active: ActiveFocus }>(`${BASE}/active`, input)
  reads++
  emit({ ...state, active: live(active) })
  return active
}

/** Leave the focus; `onlyBy` leaves only one that source entered. Returns the focus that ended. */
export async function leaveFocus(onlyBy?: FocusBy): Promise<ActiveFocus | null> {
  const { ended } = await apiDelete<{ ended: ActiveFocus | null }>(`${BASE}/active${onlyBy ? `?only_by=${onlyBy}` : ''}`)
  if (ended) {
    reads++
    emit({ ...state, active: null })
  }
  return ended
}

/** Tests: start over. */
export function _resetFocusStoreForTest(): void {
  state = { loaded: false, spaces: [], active: null, apps: [] }
  reads = 0
  if (expiry) { clearTimeout(expiry); expiry = null }
}
