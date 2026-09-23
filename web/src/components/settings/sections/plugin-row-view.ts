/**
 * Pure wording for one plugin row in Settings: Plugins (tags, help line, the
 * origin sentence that goes in the row's title). No React: unit tested in
 * tests/web/settings-addons-format.test.ts.
 */
import { plainText } from '../plugin-update-view'

export type RowTone = 'neutral' | 'warning' | 'success'
export interface RowTag { text: string; tone: RowTone }

/** Word overrides for config field names (`base_url` -> `base URL`). */
const WORDS: Record<string, string> = {
  url: 'URL', uri: 'URI', api: 'API', id: 'ID', ids: 'IDs', imap: 'IMAP', smtp: 'SMTP', ssh: 'SSH',
  oauth: 'OAuth', http: 'HTTP', https: 'HTTPS', json: 'JSON', aws: 'AWS', s3: 'S3', sdk: 'SDK', cli: 'CLI',
}

/** `base_url` -> `base URL`, `clientId` -> `client ID`, `API_KEY` -> `API key`. */
export function humanizeField(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter(Boolean)
  return words.map((w) => WORDS[w.toLowerCase()] ?? w.toLowerCase()).join(' ')
}

/** `a`, `a and b`, `a, b and c`. */
export function joinWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** `Needs setup: base URL.` (the warning help of a row that is missing config). */
export function needsSetupHelp(missing: readonly string[] | undefined): string {
  const fields = (missing ?? []).map(humanizeField).filter(Boolean)
  return fields.length > 0 ? `Needs setup: ${joinWords(fields)}.` : 'Needs setup.'
}

/** First sentence of a description or a reason, in settings punctuation. */
export function firstSentence(text: string | undefined | null): string {
  const t = plainText((text ?? '').trim())
  if (!t) return ''
  const m = t.match(/^(.+?[.!?])(\s|$)/)
  return (m ? m[1] : t).trim()
}

export interface RowFacts {
  status: string
  state?: string
  /** The restart-pending run state (plugin-update-types RESTART_PENDING_STATE). */
  restartPending?: boolean
}

/** The status tags of a plugin row. No `On`/`Off` tag: the switch says that. */
export function rowTags(row: RowFacts): RowTag[] {
  const tags: RowTag[] = []
  if (row.restartPending || row.status === 'pending-restart') tags.push({ text: 'Restart to activate', tone: 'warning' })
  switch (row.status) {
    case 'needs-config': tags.push({ text: 'Needs setup', tone: 'warning' }); break
    case 'needs-dependency': tags.push({ text: 'Needs another plugin', tone: 'warning' }); break
    case 'unsupported': tags.push({ text: 'Needs newer Walnut', tone: 'neutral' }); break
    case 'failed':
    case 'quarantined': tags.push({ text: 'Failed', tone: 'warning' }); break
    default: break
  }
  return tags
}

/** `Built in. Adds task sync.`: where the code comes from plus what it adds, for the row title. */
export function originSentence(origin: string, adds?: readonly string[], capabilities?: readonly string[]): string {
  const what = adds?.length ? adds : capabilities
  const head = plainText(origin).replace(/[.\s]+$/, '')
  if (!what?.length) return `${head}.`
  return `${head}. Adds ${joinWords(what.map((w) => w.toLowerCase()))}.`
}

/**
 * State of a provider sub-row under a base plugin (mail) that has no
 * connection report of its own (N06). The row never shows just a name: it
 * says whether the provider is set up and what it signs in with.
 */
export function providerFallbackState(row: { status: string; configurable?: boolean; missingConfig?: string[] }): {
  tag?: RowTag
  help: string
} {
  switch (row.status) {
    case 'needs-config':
      return { tag: { text: 'Not set up', tone: 'neutral' }, help: 'Add the missing settings under Configure.' }
    case 'failed':
    case 'quarantined':
      return { tag: { text: 'Failed', tone: 'warning' }, help: "Couldn't start. Try again from its own row." }
    case 'needs-dependency':
      return { tag: { text: 'Needs another plugin', tone: 'warning' }, help: 'Install what it needs from its own row.' }
    default:
      // Never invent a credential line (F16): without a report there is only
      // "on", said plainly (N3-19), not as a sentence about a missing report.
      return { help: 'On.' }
  }
}
