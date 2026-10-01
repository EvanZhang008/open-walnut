/**
 * Which tags a task SHOWS, as one rule set the server and the web share (browser-safe: no
 * imports, so the web imports this file as is).
 *
 * Every tag is an ordinary tag: it is searched, filtered and edited like any other. Showing is
 * a separate, display-only rule, set per tag (`urgent`) or per namespace (`ticket-id:*` covers
 * every tag whose text before its first colon is `ticket-id`). A hidden tag stays off the pills
 * on task rows, cards, table cells and detail badges; the tag editor still lists it, marked.
 *
 * Who decides, strongest first:
 *   1. Walnut's own machine tags (`walnut:*`) never show: each is a type with a pill of its own
 *      (Imported), and no rule can change that.
 *   2. The user's rules (config `tag_display`), the exact tag before its namespace.
 *   3. Plugin defaults, a plugin saying how its own tags show, the exact tag before its
 *      namespace. Two plugins disagreeing on one pattern: hidden wins.
 *   4. Everything else shows.
 */

export type TagDisplay = 'shown' | 'hidden'

export interface TagDisplayRule {
  /** An exact tag, or `<namespace>:*`. */
  pattern: string
  display: TagDisplay
  source: 'builtin' | 'user' | 'plugin'
  /** For a plugin default: which plugin set it, and its display name. */
  pluginId?: string
  pluginName?: string
}

/** Walnut's machine tags: types with a pill of their own (see EXTERNAL_SESSION_IMPORT_TAG). */
export const MACHINE_TAG_NAMESPACE = 'walnut'
export const BUILTIN_TAG_DISPLAY_RULES: readonly TagDisplayRule[] = [
  { pattern: `${MACHINE_TAG_NAMESPACE}:*`, display: 'hidden', source: 'builtin' },
]

const MAX_PATTERN_LENGTH = 200
const NAMESPACE_SUFFIX = ':*'

/** A tag's namespace: the text before its first colon, when both sides have text (the same
 *  split the tag chip draws as prefix and value). */
export function tagNamespace(tag: string): string | undefined {
  const colon = tag.indexOf(':')
  return colon > 0 && colon < tag.length - 1 ? tag.slice(0, colon) : undefined
}

/** The pattern a show/hide switch for this tag sets: its namespace when it has one, else itself. */
export function patternForTag(tag: string): string {
  const namespace = tagNamespace(tag)
  return namespace ? `${namespace}${NAMESPACE_SUFFIX}` : tag
}

/** The namespace a `<namespace>:*` pattern names, else undefined (an exact tag). */
export function patternNamespace(pattern: string): string | undefined {
  if (!pattern.endsWith(NAMESPACE_SUFFIX)) return undefined
  const namespace = pattern.slice(0, -NAMESPACE_SUFFIX.length)
  return namespace && !namespace.includes(':') ? namespace : undefined
}

/** A rule key in its stored form, or null when it is not one: an exact tag (trimmed, one line,
 *  bounded) or `<namespace>:*` with a namespace that has no colon of its own. */
export function normalizeTagPattern(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const pattern = raw.trim()
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH || /[\u0000-\u001f\u007f]/.test(pattern)) return null
  if (pattern.endsWith(NAMESPACE_SUFFIX) && !patternNamespace(pattern)) return null
  return pattern
}

/** True for a pattern no rule may change: Walnut's machine tags. */
export function isMachineTagPattern(pattern: string): boolean {
  const namespace = patternNamespace(pattern) ?? tagNamespace(pattern)
  return namespace === MACHINE_TAG_NAMESPACE
}

export interface CompiledTagDisplay {
  display(tag: string): TagDisplay
  shown(tag: string): boolean
  /** The rule that decided, or undefined when none did (the tag shows by default). */
  ruleFor(tag: string): TagDisplayRule | undefined
}

/** Index a rule list once, so a board of rows asks per tag in constant time. */
export function compileTagDisplay(rules: readonly TagDisplayRule[]): CompiledTagDisplay {
  const user = { exact: new Map<string, TagDisplayRule>(), namespace: new Map<string, TagDisplayRule>() }
  const plugin = { exact: new Map<string, TagDisplayRule>(), namespace: new Map<string, TagDisplayRule>() }
  for (const rule of rules) {
    if (rule.source === 'builtin') continue
    const pattern = normalizeTagPattern(rule.pattern)
    if (!pattern || isMachineTagPattern(pattern) || (rule.display !== 'shown' && rule.display !== 'hidden')) continue
    const layer = rule.source === 'user' ? user : plugin
    const namespace = patternNamespace(pattern)
    const map = namespace ? layer.namespace : layer.exact
    const key = namespace ?? pattern
    const existing = map.get(key)
    // One user rule per pattern (the last one read wins); among plugins, hidden wins.
    if (rule.source === 'plugin' && existing && existing.display === 'hidden') continue
    map.set(key, rule)
  }
  const builtin = BUILTIN_TAG_DISPLAY_RULES[0]!
  const ruleFor = (tag: string): TagDisplayRule | undefined => {
    const namespace = tagNamespace(tag)
    if (namespace === MACHINE_TAG_NAMESPACE) return builtin
    return user.exact.get(tag)
      ?? (namespace ? user.namespace.get(namespace) : undefined)
      ?? plugin.exact.get(tag)
      ?? (namespace ? plugin.namespace.get(namespace) : undefined)
  }
  const display = (tag: string): TagDisplay => ruleFor(tag)?.display ?? 'shown'
  return { display, shown: (tag) => display(tag) === 'shown', ruleFor }
}

/** The shown tags of a task, in their order. */
export function shownTags(tags: readonly string[] | undefined, compiled: CompiledTagDisplay): string[] {
  return (tags ?? []).filter((tag) => compiled.shown(tag))
}
