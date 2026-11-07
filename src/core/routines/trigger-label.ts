/**
 * A trigger's name is a short label: a few plain words saying what it watches
 * ("PR 123 review comments", "Session cookie watch"). It is what every surface
 * calls the trigger: the task's waiting line, the trigger card, trigger_list,
 * the Routines page, notices.
 *
 * It is never the prompt's opening words. The prompt is an instruction to the
 * session that receives a fire, so its first words read as news: trigger
 * mw4cbqgj-bcdc was named "The session-cookie-watch check fired. Never print
 * cookie...", a task's waiting line copied that, and its lead read it as "the
 * cookie was deleted again", which was false (2026-11-06).
 *
 * A self-contained factory: the server names triggers with it, and so does a
 * host's daemon creating one while the server is away (offline-host-core.ts).
 * daemon-source.ts inlines `createTriggerLabel.toString()`, so the factory body
 * references NOTHING at module scope (types are erased).
 */

export interface TriggerLabelInput {
  /** The label the author gave (trigger_create `name`); kept unless it is the prompt's opening. */
  name?: unknown
  /** The one or two sentences for the user (required on every trigger): a missing name comes from it. */
  description?: unknown
  /** The fire's instruction: only used to tell a name that was cut from it. */
  prompt?: unknown
  /** The check command: its script's name is the label of last resort (an old trigger with no description). */
  run?: unknown
}

export interface TriggerLabels {
  /** The label to store: the author's, else one made from the description. Never empty. */
  label(input: TriggerLabelInput): string
  /** A label made from the description alone (empty when it has none). */
  fromDescription(description: string): string
  /** True when `name` is the prompt's opening, as Walnut named triggers before labels. */
  isFromPrompt(name: string, prompt: string): boolean
  /** The widest label, in display columns (a CJK character takes two). */
  max: number
}

export function createTriggerLabel(): TriggerLabels {
  // Columns, not characters: a CJK character is as wide as two Latin ones on every card.
  const MAX = 48
  // An author's own label is cut only past this; a derived one at MAX.
  const NAME_MAX = 60
  const FALLBACK = 'Unnamed trigger'

  function flat(s: unknown): string {
    return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''
  }
  function width(s: string): number {
    let n = 0
    // Astral characters (most emoji) are wide too.
    for (const ch of s) n += (ch.codePointAt(0) ?? 0) > 0xFFFF || /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1
    return n
  }
  // Words a label must not end on: a cut there reads as a sentence that goes on.
  const DANGLING = /(?:\s+(?:a|an|the|and|or|of|to|for|with|in|on|at|by|from|is|are|was|that|whether|if|when|its|their|this|it))+$|[\u7684\u548C\u4E0E\u53CA\u5728\u628A\u88AB\u3001\uFF0C,;\uFF1B:\uFF1A\-\u2013\u2014/(\uFF08]+$/i

  // A CJK character: a break between two of them is as good as a space.
  const CJK = /[\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60]/

  /** `s` cut to `max` columns at a break, never inside a word or an id like "ce39140c-9661-..."; cut where it stands only when it has no break at all. */
  function clamp(s: string, max: number): string {
    if (width(s) <= max) return s
    const chars = [...s]
    let n = 0
    let cols = 0
    while (n < chars.length && cols + width(chars[n]) <= max) cols += width(chars[n++])
    // Back to the last break: a space, or a CJK character's edge.
    let at = n
    while (at > 0 && !(chars[at] === ' ' || CJK.test(chars[at - 1]) || CJK.test(chars[at] ?? ''))) at--
    return chars.slice(0, at > 0 ? at : n).join('').trim()
  }
  function tidy(s: string): string {
    let out = s.trim()
    for (let i = 0; i < 3; i++) out = out.replace(DANGLING, '').replace(/^[\s,;:\uFF0C\uFF1B\uFF1A\u3001]+/, '').replace(/[\s.\u3002!\uFF01?\uFF1F\u2026]+$/, '').trim()
    return out
  }

  // Shorter than this, a clause names nothing ("Fires", "\u68C0\u67E5"): the next one joins it.
  const MIN = 14

  function fromDescription(description: string): string {
    const all = flat(description)
    if (!all) return ''
    // Sentences: a period before a space and a capital or digit, or CJK end marks.
    // Split keeping each separator, so a joined run reads as written ("Dr. Smith", "e.g. PR 123").
    const sentences = all.split(/((?<=[.!?])\s+(?=[A-Z0-9"'(\[])|[\u3002\uFF01\uFF1F\uFF1B;])/)
    let s = ''
    for (let i = 0; i < sentences.length; i += 2) {
      s = `${s}${i ? sentences[i - 1] : ''}${sentences[i]}`
      if (width(strip(s)) >= MIN) break
    }
    // "\u67E5\u4E00\u6B21 X" (check once) left by the cadence's removal: the verb alone.
    s = strip(s).replace(/^(\u53EA\u8BFB\u68C0\u67E5|\u68C0\u67E5|\u67E5\u770B|\u67E5|\u770B)\u4E00\u6B21\s*/, '$1 ')
    // The first clause, or the first few when it is too short: what is watched, not what happens then.
    const clauses = s.split(/(\s*[,;:\uFF0C\uFF1B\uFF1A]\s+|\s*[\uFF0C\uFF1B\uFF1A]\s*|\s+(?=(?:when|once|until|then|and then|so that)\s)|\s+[\u2013\u2014-]\s+)/i)
    let out = ''
    for (let i = 0; i < clauses.length; i += 2) {
      out = `${out}${i ? clauses[i - 1] : ''}${clauses[i]}`
      if (width(tidy(out)) >= MIN) break
    }
    out = tidy(clamp(tidy(out), MAX))
    // A lowercase first word is a sentence's start; an identifier ("walnut-dev", "iOS") keeps its case.
    return /^[a-z]+(?:\s|$)/.test(out) ? out[0].toUpperCase() + out.slice(1) : out
  }

  /** Details in brackets, and the cadence, which the card shows on its own. The verb stays: it says this is a watch. */
  function strip(text: string): string {
    let s = text
    for (let i = 0; i < 2; i++) s = s.replace(/\s*[\uFF08(][^()\uFF08\uFF09]*[)\uFF09]/g, '')
    return s
      .replace(/\b(?:once\s+)?every\s+(?:\d+(?:\.\d+)?\s*|few\s+|other\s+)?(?:seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?)\b/gi, '')
      .replace(/\b(?:twice[- ]daily|twice a day|hourly|nightly)\b/gi, '')
      .replace(/\u6BCF\s*(?:\d+(?:\.\d+)?|[\u4E00\u4E8C\u4E09\u56DB\u4E94\u516D\u4E03\u516B\u4E5D\u5341\u4E24\u534A]+)?\s*\u4E2A?\s*(?:\u79D2\u949F?|\u5206\u949F|\u5C0F\u65F6)/g, '')
      .replace(/\s+/g, ' ')
      // A removed cadence leaves no space before the mark that followed it ("Fires hourly; ...").
      .replace(/\s+([,;:.])/g, '$1')
      .trim()
  }

  /** The check script's own name ("session-cookie-watch" for `bash .../session-cookie-watch/check.sh`). */
  function fromRun(run: string): string {
    const paths = flat(run).match(/[^\s'"]*\/[^\s'"]+\.(?:sh|py|js|mjs|ts|rb)\b/g) ?? []
    const parts = (paths[paths.length - 1] ?? '').split('/').filter(Boolean)
    const file = (parts.pop() ?? '').replace(/\.[a-z]+$/, '')
    const own = /^(?:check|run|watch|poll|main|index|script)$/i.test(file) ? parts.pop() ?? '' : file
    return clamp(own, MAX)
  }

  function isFromPrompt(name: string, prompt: string): boolean {
    let n = flat(name)
    const p = flat(prompt)
    if (!n || !p) return false
    // Older servers prefixed "Trigger: "; every version cut with "..." (cron normalize: 40, trigger_create: 60).
    n = n.replace(/^Trigger:\s*/i, '')
    const cut = /(?:\.\.\.|\u2026)$/.test(n)
    n = n.replace(/\s*(?:\.\.\.|\u2026)$/, '')
    if (!n || !p.startsWith(n)) return false
    // Only the two shapes Walnut made: the whole prompt, or a cut marked "...". A label the
    // author wrote that happens to open the prompt has neither, and stays.
    return cut || n.length === p.length
  }

  function label(input: TriggerLabelInput): string {
    const name = flat(input.name)
    const prompt = flat(input.prompt)
    // The author's own words as written; only one past NAME_MAX is cut.
    if (name && !(prompt && isFromPrompt(name, prompt))) return width(name) <= NAME_MAX ? name : tidy(clamp(name, NAME_MAX)) || name
    return fromDescription(flat(input.description)) || fromRun(flat(input.run)) || FALLBACK
  }

  return { label, fromDescription, isFromPrompt, max: MAX }
}
