/**
 * `walnut.ui.statusItem`: a plugin's live item in the console rail, above Voice.
 *
 * Items describe NOW, so they live in memory only: a restart activates the plugin again
 * and it publishes again. Every change broadcasts the WHOLE list (a handful of small
 * records), so a client replaces its copy and never merges a delta into a stale one.
 *
 * Three rules make an item safe to show:
 *   - identity: the host stamps `pluginId`/`pluginName`; a plugin names only its own id.
 *   - buttons run only the plugin's OWN ops, prefixed host-side (the notice-button rule),
 *     because the console route runs whatever op name it is handed.
 *   - ownership: the api generation that set an item owns it. Disable, reload and
 *     uninstall dispose the generation and the item goes with it; a replaced generation
 *     disposing late cannot remove the item its successor just set.
 */
import { bus } from '../event-bus.js'
import { toDisposable, type Disposable } from './disposable.js'
import { pluginOpName } from './ids.js'

export const STATUS_ITEMS_EVENT = 'plugin:status-items'
export const MAX_STATUS_ITEMS_PER_PLUGIN = 2
export const MAX_STATUS_ITEM_ACTIONS = 3
const DEFAULT_ORDER = 500
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/
const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const MAX_TITLE = 80
const MAX_DETAIL = 200
const MAX_ACTION_LABEL = 40
/** Below this a timestamp is seconds, not milliseconds: refuse it instead of drawing an expired ring. */
const MIN_EPOCH_MS = 1e11

const TONES = ['neutral', 'accent', 'success', 'warning'] as const
const GLYPHS = ['check', 'alert', 'stand', 'pause'] as const
export type StatusItemTone = typeof TONES[number]
export type StatusItemGlyph = typeof GLYPHS[number]

export interface StatusItemButton {
  kind: 'op'
  label: string
  pluginId: string
  op: string
  args?: Record<string, unknown>
  primary?: true
}

export interface PluginStatusItem {
  /** `<pluginId>:<id>`, unique across plugins. */
  key: string
  pluginId: string
  pluginName: string
  id: string
  order: number
  title: string
  detail?: string
  tone: StatusItemTone
  timer?: { startedAt: number; endsAt: number; mode: 'fill' | 'drain' }
  glyph?: StatusItemGlyph
  actions: StatusItemButton[]
  app?: string
  updatedAt: number
}

export interface StatusItemsSnapshot {
  items: PluginStatusItem[]
}

type ItemBody = Pick<PluginStatusItem, 'title' | 'detail' | 'tone' | 'timer' | 'glyph' | 'actions' | 'app'>

interface Entry {
  item: PluginStatusItem
  owner: string
  /** The body as last set, to skip a broadcast when nothing changed. */
  fingerprint: string
}

const entries = new Map<string, Entry>()

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function epochMs(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_EPOCH_MS) {
    throw new Error(`Status item timer.${field} must be epoch milliseconds`)
  }
  return value
}

/** A plugin's `set` input → the stored body. Throws a sentence the plugin author can act on. */
export function normalizeStatusItemState(pluginId: string, raw: unknown): ItemBody {
  if (!isPlainObject(raw)) throw new Error('Status item state must be an object')
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!title || title.length > MAX_TITLE) throw new Error(`Status item title must be 1-${MAX_TITLE} characters`)

  let detail: string | undefined
  if (raw.detail !== undefined) {
    if (typeof raw.detail !== 'string' || raw.detail.length > MAX_DETAIL) {
      throw new Error(`Status item detail must be a string of at most ${MAX_DETAIL} characters`)
    }
    detail = raw.detail.trim() || undefined
  }

  const tone = raw.tone ?? 'neutral'
  if (!TONES.includes(tone as StatusItemTone)) throw new Error(`Status item tone must be one of ${TONES.join(', ')}`)

  let timer: ItemBody['timer']
  if (raw.timer !== undefined) {
    if (!isPlainObject(raw.timer)) throw new Error('Status item timer must be an object')
    const startedAt = epochMs(raw.timer.startedAt, 'startedAt')
    const endsAt = epochMs(raw.timer.endsAt, 'endsAt')
    if (endsAt <= startedAt) throw new Error('Status item timer.endsAt must be after timer.startedAt')
    const mode = raw.timer.mode ?? 'drain'
    if (mode !== 'fill' && mode !== 'drain') throw new Error("Status item timer.mode must be 'fill' or 'drain'")
    timer = { startedAt, endsAt, mode }
  }

  let glyph: StatusItemGlyph | undefined
  if (raw.glyph !== undefined) {
    if (!GLYPHS.includes(raw.glyph as StatusItemGlyph)) throw new Error(`Status item glyph must be one of ${GLYPHS.join(', ')}`)
    glyph = raw.glyph as StatusItemGlyph
  }

  const actions: StatusItemButton[] = []
  if (raw.actions !== undefined) {
    if (!Array.isArray(raw.actions)) throw new Error('Status item actions must be an array')
    if (raw.actions.length > MAX_STATUS_ITEM_ACTIONS) {
      throw new Error(`A status item carries at most ${MAX_STATUS_ITEM_ACTIONS} actions (got ${raw.actions.length})`)
    }
    for (const action of raw.actions as unknown[]) {
      if (!isPlainObject(action)) throw new Error('Status item action must be an object')
      const label = typeof action.label === 'string' ? action.label.trim() : ''
      if (!label || label.length > MAX_ACTION_LABEL) throw new Error(`Status item action label must be 1-${MAX_ACTION_LABEL} characters`)
      if (typeof action.op !== 'string') throw new Error('Status item action op must be a string')
      const args = action.args
      if (args !== undefined && !isPlainObject(args)) throw new Error('Status item action args must be a plain object')
      actions.push({
        kind: 'op',
        label,
        pluginId,
        op: pluginOpName(pluginId, action.op),
        ...(args !== undefined ? { args: structuredClone(args) } : {}),
        ...(action.primary === true ? { primary: true as const } : {}),
      })
    }
    if (actions.filter((action) => action.primary).length > 1) throw new Error('At most one status item action may be primary')
  }

  let app: string | undefined
  if (raw.app !== undefined) {
    if (typeof raw.app !== 'string' || !APP_ID_PATTERN.test(raw.app)) throw new Error('Status item app must be one of your App ids')
    app = raw.app
  }

  return {
    title,
    ...(detail ? { detail } : {}),
    tone: tone as StatusItemTone,
    ...(timer ? { timer } : {}),
    ...(glyph ? { glyph } : {}),
    actions,
    ...(app ? { app } : {}),
  }
}

/** Every live item, rail order: `order`, then plugin name, then id. */
export function listStatusItems(): PluginStatusItem[] {
  return [...entries.values()]
    .map((entry) => structuredClone(entry.item))
    .sort((a, b) => a.order - b.order || a.pluginName.localeCompare(b.pluginName) || a.id.localeCompare(b.id))
}

function publish(): void {
  const snapshot: StatusItemsSnapshot = { items: listStatusItems() }
  bus.emit(STATUS_ITEMS_EVENT, snapshot, ['web-ui'], { source: 'plugin-status-items' })
}

let generationSeq = 0

export function createPluginUi(options: {
  pluginId: string
  pluginName: string
  own: <T extends Disposable>(registration: T) => T
  assertLive: (registration: string) => void
}) {
  const { pluginId, pluginName } = options
  const owner = `${pluginId}#${++generationSeq}`
  const registered = new Set<string>()

  return {
    statusItem(input: { id: string; order?: number }) {
      options.assertLive('ui.statusItem')
      const id = input?.id
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
        throw new Error('Status item id must be 1-40 characters of a-z, 0-9, - and _')
      }
      if (registered.has(id)) throw new Error(`Status item "${id}" is already registered`)
      if (registered.size >= MAX_STATUS_ITEMS_PER_PLUGIN) {
        throw new Error(`A plugin shows at most ${MAX_STATUS_ITEMS_PER_PLUGIN} status items`)
      }
      const order = input.order ?? DEFAULT_ORDER
      if (typeof order !== 'number' || !Number.isFinite(order)) throw new Error('Status item order must be a number')
      const key = `${pluginId}:${id}`
      let disposed = false

      const remove = (): void => {
        const entry = entries.get(key)
        if (!entry || entry.owner !== owner) return
        entries.delete(key)
        publish()
      }
      registered.add(id)
      const registration = options.own(toDisposable(() => {
        disposed = true
        registered.delete(id)
        remove()
      }))

      return {
        set(state: unknown): void {
          if (disposed) throw new Error(`Status item "${id}" was disposed`)
          options.assertLive(`ui.statusItem("${id}").set`)
          const body = normalizeStatusItemState(pluginId, state)
          const fingerprint = JSON.stringify(body)
          const previous = entries.get(key)
          if (previous && previous.owner === owner && previous.fingerprint === fingerprint) return
          entries.set(key, { owner, fingerprint, item: { key, pluginId, pluginName, id, order, ...body, updatedAt: Date.now() } })
          publish()
        },
        clear(): void {
          if (!disposed) remove()
        },
        dispose(): void {
          void registration.dispose()
        },
      }
    },
  }
}

export function _resetStatusItemsForTesting(): void {
  entries.clear()
}
