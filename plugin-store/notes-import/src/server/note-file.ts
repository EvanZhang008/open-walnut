/**
 * The bytes of one imported note: frontmatter that ties it to its source item, then the body.
 * No `id:` is written, so the vault keeps the note's own id across re-imports.
 *
 * `<source>_hash` is a hash of the body as the importer wrote it. A note whose body no longer
 * matches it was edited by the person, which a re-import must keep, even on a machine with no
 * record of the run that wrote it.
 */
import type { SourceItem } from './types'

export function yamlString(value: string): string {
  return JSON.stringify(value)
}

export function composeNote(sourceId: string, item: SourceItem, body: string, properties?: Array<[string, string]>): string {
  const parts: string[] = []
  if (properties?.length) {
    const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
    parts.push(['| Property | Value |', '| --- | --- |', ...properties.map(([k, v]) => `| ${cell(k)} | ${cell(v)} |`)].join('\n'))
  }
  if (body.trim()) parts.push(body.trim())
  const text = `${parts.join('\n\n')}\n`
  const lines = [
    '---',
    `title: ${yamlString(item.title)}`,
    `source: ${sourceId}`,
    `${sourceId}_id: ${item.id}`,
    ...(item.url ? [`${sourceId}_url: ${yamlString(item.url)}`] : []),
    `${sourceId}_edited: ${yamlString(item.editedAt)}`,
    ...(item.createdAt ? [`created: ${yamlString(item.createdAt)}`] : []),
    `${sourceId}_hash: ${yamlString(bodyHash(text))}`,
    '---',
    '',
  ]
  return `${lines.join('\n')}${text}`
}

/** FNV-1a over the body text: enough to tell an edited body from the one written. */
export function bodyHash(body: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < body.length; i++) { h ^= body.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

/**
 * True when the note is still as the importer wrote it: its body matches the stamped hash and its
 * frontmatter holds only the importer's keys (and the notes app's own `id`). A tag, an alias or any
 * other key the person added makes it theirs.
 */
export function bodyIsAsWritten(content: string, sourceId: string): boolean {
  const stamped = frontmatterValue(content, `${sourceId}_hash`)
  if (!stamped || stamped !== bodyHash(bodyOf(content))) return false
  const own = new Set(['id', 'title', 'source', 'created', `${sourceId}_id`, `${sourceId}_url`, `${sourceId}_edited`, `${sourceId}_hash`])
  const end = content.indexOf('\n---', 3)
  for (const line of content.slice(4, end).split('\n')) {
    const key = /^([^\s:#][^:]*):/.exec(line)?.[1]
    if (key ? !own.has(key.trim()) : line.trim() !== '') return false
  }
  return true
}

/**
 * The same note with a new body written by the importer itself (a link fixed after a move):
 * the stamp follows, so the note still counts as unedited.
 */
export function withBody(content: string, sourceId: string, body: string): string {
  const head = content.slice(0, content.length - bodyOf(content).length)
  const key = `${sourceId}_hash`
  const stamped = new RegExp(`^${key}:.*$`, 'm')
  return (stamped.test(head) ? head.replace(stamped, () => `${key}: ${yamlString(bodyHash(body))}`) : head) + body
}

export function frontmatterValue(content: string, key: string): string | undefined {
  if (!content.startsWith('---')) return undefined
  const end = content.indexOf('\n---', 3)
  if (end < 0) return undefined
  return new RegExp(`^${key}:\\s*"?([^"\\n]*)"?\\s*$`, 'm').exec(content.slice(0, end))?.[1]
}

/** The source item id a note was imported from, read from its frontmatter. */
export function importedIdOf(content: string, sourceId: string): string | null {
  if (!content.startsWith('---')) return null
  const end = content.indexOf('\n---', 3)
  if (end < 0) return null
  const head = content.slice(0, end)
  const match = new RegExp(`^${sourceId}_id:\\s*"?([^"\\s]+)"?\\s*$`, 'm').exec(head)
  return match?.[1] ?? null
}

/** The body without frontmatter. */
export function bodyOf(content: string): string {
  if (!content.startsWith('---')) return content
  const end = content.indexOf('\n---', 3)
  if (end < 0) return content
  return content.slice(content.indexOf('\n', end + 1) + 1)
}
