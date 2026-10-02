/**
 * The tag display rules (tag-display-rules.ts) as the server holds them: the user's rules in
 * config.yaml (`tag_display`, a map of pattern to shown/value/hidden), and plugin defaults in
 * memory for as long as the plugin that set them is running.
 *
 * A change is announced as `task:tag-display-changed` (never CONFIG_CHANGED, which also reloads
 * every plugin's settings and rechecks the heartbeat: a plugin declaring its defaults at start
 * would set that off on every boot).
 */

import { bus, EventNames } from './event-bus.js'
import { getConfig, updateConfig } from './config-manager.js'
import {
  BUILTIN_TAG_DISPLAY_RULES,
  DEFAULT_TAG_DISPLAY_RULES,
  isMachineTagPattern,
  isTagDisplay,
  normalizeTagPattern,
  type TagDisplay,
  type TagDisplayRule,
} from './tag-display-rules.js'

export type { TagDisplay, TagDisplayRule } from './tag-display-rules.js'

/** pluginId → pattern → the display its latest call set (the token says which call). */
const pluginDefaults = new Map<string, Map<string, { display: TagDisplay; token: symbol }>>()
const pluginNames = new Map<string, string>()

function announce(source: string): void {
  bus.emit(EventNames.TASK_TAG_DISPLAY_CHANGED, {}, ['web-ui'], { source })
}

/** A pattern in stored form, or an error a caller can show. */
export function checkTagPattern(raw: unknown): string {
  const pattern = normalizeTagPattern(raw)
  if (!pattern) throw new Error('A tag rule names one tag, or a key as "<key>:*".')
  if (isMachineTagPattern(pattern)) throw new Error('walnut: tags are Walnut\'s own types (they have pills of their own) and never show as tags.')
  return pattern
}

function checkDisplay(raw: unknown): TagDisplay {
  if (isTagDisplay(raw)) return raw
  throw new Error('display must be "shown", "value" or "hidden".')
}

/** A plugin's default for a pattern; the returned function takes it back. The user's own rule
 *  for the same pattern always wins. */
export function setPluginTagDisplay(pluginId: string, rawPattern: unknown, rawDisplay: unknown, pluginName?: string): () => void {
  const pattern = checkTagPattern(rawPattern)
  const display = checkDisplay(rawDisplay)
  if (pluginName) pluginNames.set(pluginId, pluginName)
  const own = pluginDefaults.get(pluginId) ?? new Map<string, { display: TagDisplay; token: symbol }>()
  pluginDefaults.set(pluginId, own)
  const changed = own.get(pattern)?.display !== display
  const token = Symbol(pattern)
  own.set(pattern, { display, token })
  if (changed) announce(`plugin/${pluginId}`)
  let released = false
  return () => {
    if (released) return
    released = true
    const current = pluginDefaults.get(pluginId)
    // A later call for the same pattern owns it now; releasing this one leaves that in place.
    if (current?.get(pattern)?.token !== token) return
    current.delete(pattern)
    if (current.size === 0) pluginDefaults.delete(pluginId)
    announce(`plugin/${pluginId}`)
  }
}

function userRules(raw: unknown): TagDisplayRule[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const rules: TagDisplayRule[] = []
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const pattern = normalizeTagPattern(key)
    if (!pattern || isMachineTagPattern(pattern) || !isTagDisplay(value)) continue
    rules.push({ pattern, display: value, source: 'user' })
  }
  return rules
}

/** Every rule in force: Walnut's own, the user's, plugin defaults, then Walnut's defaults. */
export async function listTagDisplayRules(): Promise<TagDisplayRule[]> {
  const config = await getConfig()
  const plugins: TagDisplayRule[] = []
  for (const [pluginId, rules] of pluginDefaults) {
    const pluginName = pluginNames.get(pluginId)
    for (const [pattern, { display }] of rules) plugins.push({ pattern, display, source: 'plugin', pluginId, ...(pluginName ? { pluginName } : {}) })
  }
  return [...BUILTIN_TAG_DISPLAY_RULES, ...userRules(config.tag_display), ...plugins, ...DEFAULT_TAG_DISPLAY_RULES]
}

// The only writer of `tag_display`: its read-modify-write is serialized here.
let userQueue: Promise<unknown> = Promise.resolve()

/** Set the user's rule for a pattern (`null` removes it, so a plugin default or Walnut's
 *  default applies again). Answers the rules now in force. */
export function setUserTagDisplay(rawPattern: unknown, rawDisplay: unknown): Promise<TagDisplayRule[]> {
  const pattern = checkTagPattern(rawPattern)
  const display = rawDisplay === null ? null : checkDisplay(rawDisplay)
  const run = userQueue.then(async () => {
    const config = await getConfig()
    const current = Object.fromEntries(userRules(config.tag_display).map((rule) => [rule.pattern, rule.display]))
    if ((current[pattern] ?? null) !== display) {
      if (display === null) delete current[pattern]
      else current[pattern] = display
      await updateConfig({ tag_display: current })
      announce('user')
    }
    return listTagDisplayRules()
  })
  userQueue = run.catch(() => undefined)
  return run
}

/** Test seam: forget every plugin default (module state outlives a test). */
export function _resetTagDisplayForTesting(): void {
  pluginDefaults.clear()
  pluginNames.clear()
  userQueue = Promise.resolve()
}
