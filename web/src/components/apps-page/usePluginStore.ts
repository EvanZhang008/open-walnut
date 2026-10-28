/**
 * Everything the Apps page knows and does about plugins, shared by the card grid and a
 * plugin's detail page: the registry, the installed sources, account links, update
 * status, and every action (switch, Update, Remove, install, dependencies).
 *
 * Turning a plugin off persists: the disable route writes `plugins.<id>.enabled: false`
 * to config.yaml (integration-loader.disableLoadedPlugin), so it stays off across a
 * restart, and turning it on writes `enabled: true` before reloading it.
 *
 * Update status (linked checkouts, git and npm sources) comes from ONE batch request
 * through `usePluginUpdates`, never from the registry. Built-in rows take no part in it.
 *
 * Installing a plugin gives it full access to Walnut and this machine, so the trust switch
 * stays a per-install stop: it resets after every successful add, and a catalog entry
 * never pre-ticks it (a curated listing is not the user's consent).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useEvent } from '@/hooks/useWebSocket'
import { PLUGINS_CHANGED_EVENT, emitPluginsChanged } from '@/utils/plugin-events'
import { coalesceRefresh, type CoalescedRefresh } from '@/utils/coalesce-refresh'
import { usePluginUpdates } from '@/hooks/usePluginUpdates'
import { saveErrorMessage, useSettingsSaved } from '@/components/settings/settings-pane-context'
import { runBundledAction } from '@/components/settings/sections/plugin-bundled-actions'
import type { DependencyPlanItem } from '@/components/settings/sections/PluginDependencyRows'
import type { PluginSource } from '@/components/settings/sections/PluginSourcesGroup'
import type { ConnectionReport } from '@/components/settings/PluginConnectionPanel'
import { failureFeedback, resolveRowState, successFeedback, type Feedback } from '@/components/settings/plugin-update-view'
import { sourceRowKey, type UpdateState, type UpdateStatusRow } from '@/components/settings/plugin-update-types'
import { isLinkedRow, isUpdatableRow, type RegistryResponse, type RegistryRow } from './plugin-store-model'

/** The state a source's update row would carry from the server's `updated` answer. */
function updatedState(body: Record<string, unknown>): UpdateState {
  const state = body.state as UpdateState | undefined
  if (state && typeof state.kind === 'string') return state
  return { kind: 'current' }
}

/**
 * The state a 409 refusal proves: the server just saw the checkout dirty or diverged, so
 * the row may say so before the next check. Falls back to the body's own counts.
 */
function refusedState(body: Record<string, unknown>): UpdateState | null {
  const state = body.state as UpdateState | undefined
  if (state && (state.kind === 'dirty' || state.kind === 'diverged')) return state
  if (body.code === 'dirty') return { kind: 'dirty', behind: typeof body.behind === 'number' ? body.behind : null }
  if (body.code === 'diverged') {
    return {
      kind: 'diverged',
      behind: typeof body.behind === 'number' ? body.behind : 1,
      ahead: typeof body.ahead === 'number' ? body.ahead : 1,
    }
  }
  return null
}

/**
 * The home directory paths fold to `~`. The registry may say it outright; failing that, a
 * server-shortened `checkoutDisplay` (`~/code/x` for `/home/me/code/x`) implies it.
 */
export function homeDirFor(source: RegistryRow['source'], homeDir: string | undefined): string | undefined {
  if (homeDir) return homeDir
  const full = source.checkout ?? source.path
  const display = source.checkoutDisplay
  if (!full || !display || !display.startsWith('~')) return undefined
  const tail = display.slice(1)
  return full.endsWith(tail) ? full.slice(0, full.length - tail.length) : undefined
}

/** The last registry this window read: coming back to the page shows the list at once. */
let lastRegistry: RegistryResponse | null = null

export type PluginStore = ReturnType<typeof usePluginStore>

export function usePluginStore() {
  const [registry, setRegistry] = useState<RegistryResponse | null>(() => lastRegistry)
  const [sources, setSources] = useState<PluginSource[]>([])
  const [busy, setBusy] = useState<string | null>(null) // 'add' | 'link' | plugin id | source slug | busy key
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [restartNeeded, setRestartNeeded] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  // Account links, by plugin id: which plugins have one, and their latest state.
  const [connections, setConnections] = useState<Record<string, ConnectionReport>>({})
  // What the last Update on a plugin said, keyed by row id (a plugin id, or `source-<slug>`
  // for a Sources card). It never expires on a timer; the next action replaces it.
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({})
  // Turning off a plugin others run on is refused (409) until the user has seen the list.
  const [cascadeAsk, setCascadeAsk] = useState<{ target: { id: string; name: string }; dependents: string[] } | null>(null)
  // What an install turned out to need. Nothing has been installed for it yet: this list IS the question.
  const [pending, setPending] = useState<{ slug: string; plan: DependencyPlanItem[]; rowId?: string } | null>(null)
  // Optimistic switch per plugin: the thumb moves at once; a failure puts it back and
  // leaves `Couldn't save` until the next flip. A cascade question keeps it ON and busy.
  const [pendingToggle, setPendingToggle] = useState<Record<string, boolean>>({})
  const [toggleError, setToggleError] = useState<Record<string, string>>({})
  const saved = useSettingsSaved()

  // One read at a time: a second call while one is in flight shares it (N3-18).
  const refreshInFlight = useRef<Promise<void> | null>(null)
  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return refreshInFlight.current
    const run = refreshOnce().finally(() => { refreshInFlight.current = null })
    refreshInFlight.current = run
    return run
  }, [])
  async function refreshOnce() {
    // Independent reads: a plugin-sources (or connections) failure must not blank the plugin list.
    const [registryRes, sourcesRes, connectionsRes] = await Promise.allSettled([
      fetch('/api/plugin-runtime/registry'),
      fetch('/api/plugin-sources'),
      fetch('/api/integrations/connections'),
    ])
    if (registryRes.status === 'fulfilled' && registryRes.value.ok) {
      try { lastRegistry = await registryRes.value.json(); setRegistry(lastRegistry) } catch { /* keep the last list */ }
    }
    if (sourcesRes.status === 'fulfilled' && sourcesRes.value.ok) {
      try { setSources(await sourcesRes.value.json()) } catch { /* keep the last list */ }
    }
    if (connectionsRes.status === 'fulfilled' && connectionsRes.value.ok) {
      try {
        const body = await connectionsRes.value.json() as { connections?: ConnectionReport[] }
        setConnections(Object.fromEntries((body.connections ?? []).map((c) => [c.pluginId, c])))
      } catch { /* keep the last map */ }
    }
  }

  // Every "reload the lists" signal goes through ONE coalescer (N2-10).
  const coalesced = useRef<CoalescedRefresh | null>(null)
  if (!coalesced.current) coalesced.current = coalesceRefresh(refresh)
  const requestRefresh = useCallback(() => coalesced.current!.request(), [])

  const onConnectionReport = useCallback((report: ConnectionReport) => {
    setConnections((prev) => ({ ...prev, [report.pluginId]: report }))
  }, [])

  useEffect(() => {
    void refresh()
    const onChanged = () => void requestRefresh()
    window.addEventListener(PLUGINS_CHANGED_EVENT, onChanged)
    return () => {
      window.removeEventListener(PLUGINS_CHANGED_EVENT, onChanged)
      coalesced.current?.cancel()
    }
  }, [refresh, requestRefresh])

  // A change made anywhere else (another tab, the author CLI, a reload) arrives as this event.
  useEvent('plugin:runtime-changed', () => { void requestRefresh() })

  const rows = registry?.rows ?? []
  const installed = rows.filter((row) => row.installed)
  const available = rows.filter((row) => !row.installed)

  /** A plugin's display name. Ids belong in URLs, not in sentences a person reads. */
  const nameOf = (pluginId: string) => rows.find((row) => row.id === pluginId)?.name ?? pluginId

  // ── Update status ──
  const updatable = installed.filter(isUpdatableRow)
  const updates = usePluginUpdates()
  // "Checking for updates…" only when the first GET is genuinely slow (3 s).
  const [slowLoad, setSlowLoad] = useState(false)
  useEffect(() => {
    if (updates.loaded || updatable.length === 0) { setSlowLoad(false); return }
    const timer = setTimeout(() => setSlowLoad(true), 3_000)
    return () => clearTimeout(timer)
  }, [updates.loaded, updatable.length])

  /** The update row shared by every plugin from one checkout, or one source's row. */
  const rowKeyFor = (row: RegistryRow): string | undefined =>
    updates.rowKeyOf[row.id]
      ?? (row.sourceSlug ? sourceRowKey(row.sourceSlug) : undefined)
      ?? (isLinkedRow(row) ? `linked:${row.id}` : undefined)

  /** `undefined` is the pending placeholder (first GET not back yet). */
  const stateFor = (row: RegistryRow): UpdateState | undefined => {
    if (!isUpdatableRow(row)) return undefined
    const rowKey = rowKeyFor(row)
    return resolveRowState({
      known: rowKey ? updates.rows[rowKey]?.state : undefined,
      loaded: updates.loaded,
      refreshing: updates.refreshing,
      scanSkipped: row.linkedScanSkipped === true,
    })
  }

  /** Display names of the OTHER installed plugins served from the same checkout (N3-4). */
  const siblingNamesOf = (row: RegistryRow): string[] => {
    const rowKey = rowKeyFor(row)
    if (!rowKey || !isLinkedRow(row)) return []
    return installed
      .filter((other) => other.id !== row.id && isLinkedRow(other) && rowKeyFor(other) === rowKey)
      .map((other) => other.name)
      .sort((a, b) => a.localeCompare(b))
  }

  const setRowFeedback = (rowId: string, next: Feedback | null) => {
    setFeedback((prev) => {
      const copy = { ...prev }
      if (next) copy[rowId] = next; else delete copy[rowId]
      return copy
    })
  }

  /** Rows whose Update was pressed and is still running (the `Updating…` label is theirs only). */
  const [pressedRows, setPressedRows] = useState<Record<string, true>>({})
  const markPressed = (rowId: string, on: boolean) => {
    setPressedRows((prev) => {
      if (on ? prev[rowId] : !prev[rowId]) return prev
      const copy = { ...prev }
      if (on) copy[rowId] = true; else delete copy[rowId]
      return copy
    })
  }

  /** Header Check now: every row's feedback goes with it. */
  const checkAll = () => {
    setFeedback({})
    void updates.checkAll()
  }

  /** Re-check ONE row (and its checkout siblings, which share the row key). */
  const checkRow = (row: RegistryRow) => {
    const rowKey = rowKeyFor(row)
    if (!rowKey) return
    setRowFeedback(row.id, null)
    const target = isLinkedRow(row)
      ? { kind: 'linked' as const, pluginId: row.id }
      : { kind: 'source' as const, slug: row.sourceSlug ?? rowKey.replace(/^source:/, '') }
    void updates.checkRow(rowKey, target)
  }

  /** Install one source the way the form's Add does. Throws the server's message. */
  const installSource = async (payload: Record<string, string>, opts: { rowId?: string } = {}) => {
    const res = await fetch('/api/plugin-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await res.json()
    if (!res.ok) {
      const failure = new Error(body.error ?? `HTTP ${res.status}`) as Error & { gitCause?: string; sentence?: string }
      if (typeof body.cause === 'string') failure.gitCause = body.cause
      if (typeof body.sentence === 'string') failure.sentence = body.sentence
      throw failure
    }
    const count = body.plugins?.length ?? 0
    const what = body.resolved ? ` (${body.resolved})` : ''
    // Only this source was installed. Anything its plugins need is a second question.
    const plan = (body.pendingDependencies ?? []) as DependencyPlanItem[]
    setPending(plan.length > 0 && body.slug ? { slug: body.slug as string, plan, ...(opts.rowId ? { rowId: opts.rowId } : {}) } : null)
    setNotice(count > 0
      ? `Added${what}: found ${count} plugin${count === 1 ? '' : 's'}. New plugins are active now; open one that needs setup to finish it.`
      : `Added${what}, but no plugins found (no manifest.json at the root or in top-level folders).`)
    updates.reload()
    emitPluginsChanged()
    await requestRefresh()
    return body as { plugins?: Array<{ id?: string | null }>; slug?: string }
  }

  /**
   * Update (or Restore) one source. The result lands on the pressed row as a feedback
   * line, and the shared update row flips so every view of this slug agrees.
   */
  const handleUpdate = async (slug: string, kind: 'git' | 'npm', feedbackId: string) => {
    const rowKey = sourceRowKey(slug)
    updates.setBusy(rowKey, 'updating')
    markPressed(feedbackId, true)
    setRowFeedback(feedbackId, null)
    setError(null)
    try {
      const res = await fetch(`/api/plugin-sources/${encodeURIComponent(slug)}/update`, { method: 'POST' })
      const body = await res.json().catch(() => ({} as Record<string, unknown>)) as Record<string, unknown>
      if (!res.ok) {
        setRowFeedback(feedbackId, failureFeedback(res.status, body, `HTTP ${res.status}`))
        return
      }
      // Feedback, state and button flip in ONE render (N2-6); the list reload runs after.
      setRowFeedback(feedbackId, successFeedback(kind, body, nameOf))
      const checkedAt = typeof body.checkedAt === 'string' ? body.checkedAt : new Date().toISOString()
      const previous: UpdateStatusRow | undefined = updates.rows[rowKey]
      updates.applyRow(rowKey, { ...previous, state: updatedState(body), checkedAt }, checkedAt)
      updates.setBusy(rowKey, null)
      markPressed(feedbackId, false)
      if (previous?.state.kind === 'missing') updates.reload()
      if (body.updated) emitPluginsChanged()
      await requestRefresh()
    } catch (err) {
      setRowFeedback(feedbackId, failureFeedback(0, null, err instanceof Error ? err.message : String(err)))
    } finally {
      updates.setBusy(rowKey, null)
      markPressed(feedbackId, false)
    }
  }

  /**
   * Fast-forward a linked checkout and reload what runs from it. Refused with 409 when the
   * tree is dirty or the branch has diverged: the row takes that state (the server just
   * saw it) and says why; neither is an error to retry.
   */
  const handleLinkedUpdate = async (row: RegistryRow) => {
    const rowKey = rowKeyFor(row)
    if (!rowKey) return
    updates.setBusy(rowKey, 'updating')
    markPressed(row.id, true)
    setRowFeedback(row.id, null)
    setError(null)
    const stamp = (body: Record<string, unknown>) =>
      typeof body.checkedAt === 'string' ? body.checkedAt : new Date().toISOString()
    try {
      const res = await fetch(`/api/plugin-runtime/${encodeURIComponent(row.id)}/linked/update`, { method: 'POST' })
      const body = await res.json().catch(() => ({} as Record<string, unknown>)) as Record<string, unknown>
      if (!res.ok) {
        setRowFeedback(row.id, failureFeedback(res.status, body, `HTTP ${res.status}`))
        const refused = res.status === 409 ? refusedState(body) : null
        if (refused) {
          const checkedAt = stamp(body)
          updates.applyRow(rowKey, { ...updates.rows[rowKey], state: refused, checkedAt }, checkedAt)
        }
        return
      }
      setRowFeedback(row.id, successFeedback('linked', body, nameOf))
      const checkedAt = stamp(body)
      updates.applyRow(rowKey, { ...updates.rows[rowKey], state: updatedState(body), checkedAt }, checkedAt)
      updates.setBusy(rowKey, null)
      markPressed(row.id, false)
      if (((body.reloaded ?? []) as string[]).length > 0) emitPluginsChanged()
      await requestRefresh()
    } catch (err) {
      setRowFeedback(row.id, failureFeedback(0, null, err instanceof Error ? err.message : String(err)))
    } finally {
      updates.setBusy(rowKey, null)
      markPressed(row.id, false)
    }
  }

  const handleRemove = async (slug: string) => {
    setBusy(slug)
    setError(null)
    try {
      const res = await fetch(`/api/plugin-sources/${slug}`, { method: 'DELETE' })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      if (body.restartRequired) setRestartNeeded(true)
      updates.reload()
      emitPluginsChanged()
      await requestRefresh()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(null)
    }
  }

  /**
   * Bundled store: Install writes `enabled: true` and loads it live; Remove turns it off,
   * forgets it and deletes its config, so it goes back to Get more.
   */
  const handleBundled = (row: { id: string; name: string }, action: 'install' | 'remove', busyKey = row.id) =>
    runBundledAction(row, action, {
      busyKey, setBusy, setError, setNotice, nameOf,
      onChanged: async () => { emitPluginsChanged(); await requestRefresh() },
    })

  /**
   * ON goes through `reload` and OFF through `disable`; both write the `enabled` flag to
   * config.yaml first, which is what makes the switch survive a restart. OFF can be refused
   * with 409 `has-dependents`: that is a question, so it opens the confirmation and the
   * same call is repeated with `cascade` once the user agrees.
   */
  const handleToggle = async (
    row: { id: string; name: string },
    next: boolean,
    { cascade = false, busyKey }: { cascade?: boolean; busyKey?: string } = {},
  ) => {
    setBusy(busyKey ?? row.id)
    setError(null)
    setNotice(null)
    setPendingToggle((prev) => ({ ...prev, [row.id]: next }))
    setToggleError((prev) => {
      if (!(row.id in prev)) return prev
      const { [row.id]: _gone, ...rest } = prev
      return rest
    })
    try {
      const res = await fetch(
        `/api/plugin-runtime/${encodeURIComponent(row.id)}/${next ? 'reload' : 'disable'}`,
        cascade
          ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cascade: true }) }
          : { method: 'POST' },
      )
      const body = await res.json().catch(() => ({} as { error?: string; code?: string; dependents?: string[] }))
      if (res.status === 409 && body.code === 'has-dependents') {
        setCascadeAsk({ target: row, dependents: body.dependents ?? [] })
        return
      }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setCascadeAsk(null)
      saved.notifySaved()
      emitPluginsChanged()
      await requestRefresh()
    } catch (err) {
      const message = saveErrorMessage(err)
      setToggleError((prev) => ({ ...prev, [row.id]: message }))
      saved.notifySaveFailed(message, `plugin:${row.id}`)
    } finally {
      setPendingToggle((prev) => {
        if (!(row.id in prev)) return prev
        const { [row.id]: _gone, ...rest } = prev
        return rest
      })
      setBusy(null)
    }
  }

  /**
   * Install the dependencies of one source, AFTER the consent list was shown. The panel that
   * lists the source URLs is the only caller: a catalog entry is not the user's consent.
   */
  const installDependencies = async (slug: string, busyKey: string) => {
    setBusy(busyKey)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch(`/api/plugin-sources/${encodeURIComponent(slug)}/dependencies`, { method: 'POST' })
      const body = await res.json().catch(() => ({} as { error?: string }))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      const added = (body.installed ?? []) as Array<{ id: string; action?: string }>
      const skipped = (body.skipped ?? []) as Array<{ id: string; reason: string; command?: string; state?: string; error?: string }>
      setPending(null)
      setNotice([
        added.length > 0 ? `Installed ${added.map((entry) => nameOf(entry.id)).join(', ')}.` : 'Nothing was installed.',
        ...skipped.map((entry) => entry.command
          ? `${nameOf(entry.id)} has to be linked by hand: ${entry.command}`
          : `${nameOf(entry.id)} was skipped (${entry.error ?? entry.state ?? entry.reason}).`),
      ].join(' '))
      emitPluginsChanged()
      await requestRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleClearQuarantine = async (row: RegistryRow) => {
    setBusy(row.id)
    setError(null)
    try {
      const res = await fetch(`/api/plugin-runtime/${encodeURIComponent(row.id)}/clear-quarantine`, { method: 'POST' })
      const body = await res.json().catch(() => ({} as { error?: string }))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      emitPluginsChanged()
      await requestRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const copy = (text: string, key: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 2000)
  }

  // Slugs whose installed plugin owns the Update verb. A source whose files are gone
  // (`missing`) is not owned: the thing to restore is the source, so Sources carries Restore.
  const ownedSlugs = new Set(installed
    .map((row) => row.sourceSlug)
    .filter((slug): slug is string => Boolean(slug) && updates.rows[sourceRowKey(slug!)]?.state.kind !== 'missing'))

  return {
    registry, rows, installed, available, sources, connections, onConnectionReport,
    busy, setBusy, error, setError, notice, setNotice, restartNeeded, copiedKey, copy,
    feedback, setRowFeedback, cascadeAsk, setCascadeAsk, pending, setPending,
    pendingToggle, toggleError, nameOf, requestRefresh,
    updates, updatable, slowLoad, rowKeyFor, stateFor, siblingNamesOf, pressedRows, checkAll, checkRow,
    installSource, handleUpdate, handleLinkedUpdate, handleRemove, handleBundled, handleToggle,
    installDependencies, handleClearQuarantine, ownedSlugs,
  }
}
