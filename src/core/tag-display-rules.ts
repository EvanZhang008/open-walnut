/**
 * How a task's tags show, as one rule set the server and the web share (browser-safe: it
 * imports only its browser-safe sibling tag-model.ts, so the web imports this file as is).
 *
 * Every tag is a key:value pair (tag-model.ts) and an ordinary tag: it is searched, filtered and
 * edited like any other. Showing is a separate, display-only rule, set per tag (`label:urgent`)
 * or per key (`ticket-id:*` covers every tag whose key is `ticket-id`), and says one of:
 *   - shown: the pill reads the whole tag (`sev:2`);
 *   - value: the pill reads only the value (`V1234567890` for `ticket:V1234567890`), and its
 *     tooltip the whole tag;
 *   - hidden: the tag stays off the pills on task rows, cards, table cells, detail badges and
 *     the session header; the tag editor still lists it, marked.
 *
 * Who decides, strongest first:
 *   1. Walnut's own machine tags (`walnut:*`) never show: each is a type with a pill of its own
 *      (Imported), and no rule can change that.
 *   2. The user's rules (config `tag_display`), the exact tag before its key.
 *   3. Plugin defaults, a plugin saying how its own tags show, the exact tag before its key.
 *      Two plugins disagreeing on one pattern: the quieter wins (hidden, then value).
 *   4. Walnut's defaults: a label reads as its value (`urgent`, not `label:urgent`), and the
 *      task's own dates (`created:`, `updated:`) stay hidden. A user or plugin rule overrides.
 *   5. Everything else shows whole.
 *
 * A tag may also be a link (TagLinkRule): a URL with `{value}` where the tag's value goes, set
 * per tag or per key by a plugin (a ticket plugin links `ticket:*` to its tracker) or by the
 * user, whose rule wins; the user's empty link takes a plugin's away. The pill opens it.
 */

import { LABEL_KEY, isTagKey, normalizeTag } from './tag-model.js'

export type TagDisplay = 'shown' | 'value' | 'hidden'

export const TAG_DISPLAYS: readonly TagDisplay[] = ['shown', 'value', 'hidden']

export interface TagDisplayRule {
  /** An exact tag, or `<key>:*`. */
  pattern: string
  display: TagDisplay
  source: 'builtin' | 'default' | 'user' | 'plugin'
  /** For a plugin default: which plugin set it, and its display name. */
  pluginId?: string
  pluginName?: string
}

export interface TagLinkRule {
  /** An exact tag, or `<key>:*`. */
  pattern: string
  /** An http(s) URL with `{value}` where the tag's value goes (URL-encoded). The user's `''`
   *  means no link, over a plugin's. */
  link: string
  source: 'user' | 'plugin'
  pluginId?: string
  pluginName?: string
}

/** Walnut's machine tags: types with a pill of their own (see EXTERNAL_SESSION_IMPORT_TAG). */
export const MACHINE_TAG_NAMESPACE = 'walnut'
export const BUILTIN_TAG_DISPLAY_RULES: readonly TagDisplayRule[] = [
  { pattern: `${MACHINE_TAG_NAMESPACE}:*`, display: 'hidden', source: 'builtin' },
]
/** Walnut's defaults, the weakest rules: any user or plugin rule for the same tags wins. */
export const DEFAULT_TAG_DISPLAY_RULES: readonly TagDisplayRule[] = [
  { pattern: `${LABEL_KEY}:*`, display: 'value', source: 'default' },
  { pattern: 'created:*', display: 'hidden', source: 'default' },
  { pattern: 'updated:*', display: 'hidden', source: 'default' },
]

const MAX_PATTERN_LENGTH = 200
const NAMESPACE_SUFFIX = ':*'
const QUIETNESS: Record<TagDisplay, number> = { shown: 0, value: 1, hidden: 2 }

export function isTagDisplay(raw: unknown): raw is TagDisplay {
  return raw === 'shown' || raw === 'value' || raw === 'hidden'
}

/** A tag's namespace (its key): the text before its first colon, when both sides have text (the
 *  same split the tag chip draws as prefix and value). */
export function tagNamespace(tag: string): string | undefined {
  const colon = tag.indexOf(':')
  return colon > 0 && colon < tag.length - 1 ? tag.slice(0, colon) : undefined
}

/** The tag's value: the text after its key, or the whole tag when it has none. */
export function tagValue(tag: string): string {
  const namespace = tagNamespace(tag)
  return namespace ? tag.slice(namespace.length + 1) : tag
}

/** The pattern a display switch for this tag sets: its key, except for a label, which is a
 *  word of its own (`label:oncall` and `label:bug` are not one thing) and so its own pattern. */
export function patternForTag(tag: string): string {
  const namespace = tagNamespace(tag)
  return namespace && namespace !== LABEL_KEY ? `${namespace}${NAMESPACE_SUFFIX}` : tag
}

/** The key a `<key>:*` pattern names, else undefined (an exact tag). */
export function patternNamespace(pattern: string): string | undefined {
  if (!pattern.endsWith(NAMESPACE_SUFFIX)) return undefined
  const namespace = pattern.slice(0, -NAMESPACE_SUFFIX.length)
  return namespace && !namespace.includes(':') ? namespace : undefined
}

/** A rule key in its stored form, or null when it is not one: an exact tag in its stored form
 *  (a plain word is the label it is stored as) or `<key>:*` with a valid key. */
export function normalizeTagPattern(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const pattern = raw.trim()
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH || /[\u0000-\u001f\u007f]/.test(pattern)) return null
  if (pattern.endsWith(NAMESPACE_SUFFIX)) {
    const namespace = patternNamespace(pattern)?.trim().toLowerCase()
    return namespace && isTagKey(namespace) ? `${namespace}${NAMESPACE_SUFFIX}` : null
  }
  return normalizeTag(pattern, { derived: true }) ?? null
}

const MAX_LINK_LENGTH = 500
const VALUE_SLOT = '{value}'

/** A link template in stored form, or null when it is not one: an http(s) URL that names
 *  `{value}`, or `''` (no link). */
export function normalizeTagLink(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const link = raw.trim()
  if (link === '') return ''
  if (link.length > MAX_LINK_LENGTH || /[\s\u0000-\u001f\u007f]/.test(link) || !link.includes(VALUE_SLOT)) return null
  try {
    const url = new URL(link.split(VALUE_SLOT).join('v'))
    return url.protocol === 'https:' || url.protocol === 'http:' ? link : null
  } catch {
    return null
  }
}

/** The URL a tag's pill opens under a template: its value, URL-encoded, in every `{value}`. */
export function tagHref(template: string, tag: string): string | undefined {
  return template ? template.split(VALUE_SLOT).join(encodeURIComponent(tagValue(tag))) : undefined
}

/** True for a pattern no rule may change: Walnut's machine tags. */
export function isMachineTagPattern(pattern: string): boolean {
  const namespace = patternNamespace(pattern) ?? tagNamespace(pattern)
  return namespace === MACHINE_TAG_NAMESPACE
}

export interface CompiledTagDisplay {
  display(tag: string): TagDisplay
  /** Not hidden: the tag has a pill (whole or value only). */
  shown(tag: string): boolean
  /** The pill reads only the tag's value. */
  valueOnly(tag: string): boolean
  /** The rule that decided, or undefined when none did (the tag shows whole by default). */
  ruleFor(tag: string): TagDisplayRule | undefined
  /** The URL the tag's pill opens, or undefined (no link rule, or the user's empty one). */
  linkFor(tag: string): string | undefined
  /** The link rule that decided, the user's empty one included. */
  linkRuleFor(tag: string): TagLinkRule | undefined
}

interface Layer { exact: Map<string, TagDisplayRule>; namespace: Map<string, TagDisplayRule> }

const emptyLayer = (): Layer => ({ exact: new Map(), namespace: new Map() })

function place(layer: Layer, rule: TagDisplayRule, pattern: string, quieterWins: boolean): void {
  const namespace = patternNamespace(pattern)
  const map = namespace ? layer.namespace : layer.exact
  const key = namespace ?? pattern
  const existing = map.get(key)
  if (quieterWins && existing && QUIETNESS[existing.display] >= QUIETNESS[rule.display]) return
  map.set(key, rule.pattern === pattern ? rule : { ...rule, pattern })
}

const defaultLayer = emptyLayer()
for (const rule of DEFAULT_TAG_DISPLAY_RULES) place(defaultLayer, rule, rule.pattern, false)

interface LinkLayer { exact: Map<string, TagLinkRule>; namespace: Map<string, TagLinkRule> }

/** Index a rule list once, so a board of rows asks per tag in constant time. Walnut's own
 *  rules apply whether or not the list carries them (an older server's list does not). */
export function compileTagDisplay(rules: readonly TagDisplayRule[], links: readonly TagLinkRule[] = []): CompiledTagDisplay {
  const userLinks: LinkLayer = { exact: new Map(), namespace: new Map() }
  const pluginLinks: LinkLayer = { exact: new Map(), namespace: new Map() }
  for (const rule of links) {
    if (rule.source !== 'user' && rule.source !== 'plugin') continue
    const pattern = normalizeTagPattern(rule.pattern)
    const link = normalizeTagLink(rule.link)
    if (!pattern || isMachineTagPattern(pattern) || link === null || (link === '' && rule.source !== 'user')) continue
    const layer = rule.source === 'user' ? userLinks : pluginLinks
    const namespace = patternNamespace(pattern)
    const map = namespace ? layer.namespace : layer.exact
    const key = namespace ?? pattern
    // The user's last rule for a pattern wins; between plugins, the first one set stays.
    if (rule.source === 'plugin' && map.has(key)) continue
    map.set(key, { ...rule, pattern, link })
  }
  const linkRuleFor = (tag: string): TagLinkRule | undefined => {
    const namespace = tagNamespace(tag)
    if (namespace === MACHINE_TAG_NAMESPACE) return undefined
    for (const layer of [userLinks, pluginLinks]) {
      const found = layer.exact.get(tag) ?? (namespace ? layer.namespace.get(namespace) : undefined)
      if (found) return found
    }
    return undefined
  }

  const user = emptyLayer()
  const plugin = emptyLayer()
  for (const rule of rules) {
    if (rule.source !== 'user' && rule.source !== 'plugin') continue
    const pattern = normalizeTagPattern(rule.pattern)
    if (!pattern || isMachineTagPattern(pattern) || !isTagDisplay(rule.display)) continue
    // One user rule per pattern (the last one read wins); among plugins, the quieter wins.
    place(rule.source === 'user' ? user : plugin, rule, pattern, rule.source === 'plugin')
  }
  const builtin = BUILTIN_TAG_DISPLAY_RULES[0]!
  const ruleFor = (tag: string): TagDisplayRule | undefined => {
    const namespace = tagNamespace(tag)
    if (namespace === MACHINE_TAG_NAMESPACE) return builtin
    for (const layer of [user, plugin, defaultLayer]) {
      const found = layer.exact.get(tag) ?? (namespace ? layer.namespace.get(namespace) : undefined)
      if (found) return found
    }
    return undefined
  }
  const display = (tag: string): TagDisplay => ruleFor(tag)?.display ?? 'shown'
  return {
    display,
    shown: (tag) => display(tag) !== 'hidden',
    valueOnly: (tag) => display(tag) === 'value',
    ruleFor,
    linkFor: (tag) => {
      const rule = linkRuleFor(tag)
      return rule ? tagHref(rule.link, tag) : undefined
    },
    linkRuleFor,
  }
}

/** The shown tags of a task, in their order. */
export function shownTags(tags: readonly string[] | undefined, compiled: CompiledTagDisplay): string[] {
  return (tags ?? []).filter((tag) => compiled.shown(tag))
}
