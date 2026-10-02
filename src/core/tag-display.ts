/**
 * The tag display rules (tag-display-rules.ts) as the server holds them: the user's rules in
 * config.yaml (`tag_display`, a map of pattern to shown/value/hidden; `tag_links`, a map of
 * pattern to a link template), and plugin defaults in memory for as long as the plugin that set
 * them is running.
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
  normalizeTagLink,
  normalizeTagPattern,
  type TagDisplay,
  type TagDisplayRule,
  type TagLinkRule,
} from './tag-display-rules.js'

export type { TagDisplay, TagDisplayRule, TagLinkRule } from './tag-display-rules.js'

/** A rule or link the caller got wrong: the message says how (an HTTP 400, never a 500). */
export class TagRuleInputError extends Error {}

/** pluginId → pattern → the display its latest call set (the token says which call). */
const pluginDefaults = new Map<string, Map<string, { display: TagDisplay; token: symbol }>>()
/** pluginId → pattern → the link template its latest call set. */
const pluginLinks = new Map<string, Map<string, { link: string; token: symbol }>>()
const pluginNames = new Map<string, string>()

function announce(source: string): void {
  bus.emit(EventNames.TASK_TAG_DISPLAY_CHANGED, {}, ['web-ui'], { source })
}

/** A pattern in stored form, or an error a caller can show. */
export function checkTagPattern(raw: unknown): string {
  const pattern = normalizeTagPattern(raw)
  if (!pattern) throw new TagRuleInputError('A tag rule names one tag, or a key as "<key>:*".')
  if (isMachineTagPattern(pattern)) throw new TagRuleInputError('walnut: tags are Walnut\'s own types (they have pills of their own) and never show as tags.')
  return pattern
}

function checkDisplay(raw: unknown): TagDisplay {
  if (isTagDisplay(raw)) return raw
  throw new TagRuleInputError('display must be "shown", "value" or "hidden".')
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

function checkLink(raw: unknown, allowEmpty: boolean): string {
  const link = normalizeTagLink(raw)
  if (link === null || (link === '' && !allowEmpty)) throw new TagRuleInputError('A tag link is an http(s) URL with {value} where the tag\'s value goes, like https://tracker.example.com/{value}.')
  return link
}

/** A plugin's link for a pattern (`{value}` = the tag's value); the returned function takes it
 *  back. The user's own link for the same pattern always wins. */
export function setPluginTagLink(pluginId: string, rawPattern: unknown, rawLink: unknown, pluginName?: string): () => void {
  const pattern = checkTagPattern(rawPattern)
  const link = checkLink(rawLink, false)
  if (pluginName) pluginNames.set(pluginId, pluginName)
  const own = pluginLinks.get(pluginId) ?? new Map<string, { link: string; token: symbol }>()
  pluginLinks.set(pluginId, own)
  const changed = own.get(pattern)?.link !== link
  const token = Symbol(pattern)
  own.set(pattern, { link, token })
  if (changed) announce(`plugin/${pluginId}`)
  let released = false
  return () => {
    if (released) return
    released = true
    const current = pluginLinks.get(pluginId)
    if (current?.get(pattern)?.token !== token) return
    current.delete(pattern)
    if (current.size === 0) pluginLinks.delete(pluginId)
    announce(`plugin/${pluginId}`)
  }
}

function userLinks(raw: unknown): TagLinkRule[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const rules: TagLinkRule[] = []
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const pattern = normalizeTagPattern(key)
    const link = normalizeTagLink(value)
    if (!pattern || isMachineTagPattern(pattern) || link === null) continue
    rules.push({ pattern, link, source: 'user' })
  }
  return rules
}

/** Every link in force: the user's, then plugin defaults. */
export async function listTagLinkRules(): Promise<TagLinkRule[]> {
  const config = await getConfig()
  const plugins: TagLinkRule[] = []
  for (const [pluginId, links] of pluginLinks) {
    const pluginName = pluginNames.get(pluginId)
    for (const [pattern, { link }] of links) plugins.push({ pattern, link, source: 'plugin', pluginId, ...(pluginName ? { pluginName } : {}) })
  }
  return [...userLinks(config.tag_links), ...plugins]
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

/** Set the user's link for a pattern: a template, `''` for no link (over a plugin's), or `null`
 *  to remove the user's rule. Answers the links now in force. */
export function setUserTagLink(rawPattern: unknown, rawLink: unknown): Promise<TagLinkRule[]> {
  const pattern = checkTagPattern(rawPattern)
  const link = rawLink === null ? null : checkLink(rawLink, true)
  const run = userQueue.then(async () => {
    const config = await getConfig()
    const current = Object.fromEntries(userLinks(config.tag_links).map((rule) => [rule.pattern, rule.link]))
    if ((current[pattern] ?? null) !== link) {
      if (link === null) delete current[pattern]
      else current[pattern] = link
      await updateConfig({ tag_links: current })
      announce('user')
    }
    return listTagLinkRules()
  })
  userQueue = run.catch(() => undefined)
  return run
}

export interface TagDisplayState {
  rules: TagDisplayRule[]
  links: TagLinkRule[]
}

/** The rules and links in force: what GET /api/v1/tasks/meta/tag-display answers. */
export async function readTagDisplayState(): Promise<TagDisplayState> {
  return { rules: await listTagDisplayRules(), links: await listTagLinkRules() }
}

/**
 * One change by the user, as PUT /api/v1/tasks/meta/tag-display takes it: `{ pattern, display }`
 * and/or `{ pattern, link }` (null removes the user's rule). A bad display is refused before a
 * link in the same body is written. Answers the state now in force.
 */
export async function applyUserTagChange(raw: unknown): Promise<TagDisplayState> {
  const body = (raw && typeof raw === 'object' ? raw : {}) as { pattern?: unknown; display?: unknown; link?: unknown }
  const withDisplay = !('link' in body) || 'display' in body
  if (withDisplay && body.display !== null) checkDisplay(body.display)
  if ('link' in body) await setUserTagLink(body.pattern, body.link)
  if (withDisplay) await setUserTagDisplay(body.pattern, body.display)
  return readTagDisplayState()
}

/** Test seam: forget every plugin default (module state outlives a test). */
export function _resetTagDisplayForTesting(): void {
  pluginDefaults.clear()
  pluginLinks.clear()
  pluginNames.clear()
  userQueue = Promise.resolve()
}
