/**
 * Hook names and help as the Hooks pane shows them (F19). Hook names and
 * descriptions are written by the server for developers (Title Case, shouting
 * caps, `e.g.`, dashes); the pane shows sentence-case names that are unique in
 * the list and one plain sentence of help. The raw text stays in `title`.
 */
import { firstSentence } from './EngineSettingRows';

/** Upper-case words that are names, not shouting (C8 whitelist plus common acronyms). */
const KEEP_CAPS = new Set([
  'MCP', 'TOML', 'ISO', 'HEARTBEAT', 'CLAUDE', 'CLI', 'API', 'URL', 'JSON', 'YAML', 'JSONL', 'CWD', 'FIFO', 'SSH',
  'PID', 'UI', 'AI', 'ID', 'IDS', 'OS', 'MD', 'PR', 'TTL', 'HTTP', 'WS', 'STT', 'TTS', 'CPU', 'AWS', 'IMAP', 'SQL',
  'TOCTOU', 'PGID', 'ENXIO', 'SIGTERM', 'SIGKILL',
])

/** `e.g.` and `i.e.` read as words; dashes become a comma or a semicolon. */
function plain(text: string): string {
  return text
    .replace(/\be\.g\.,?\s/gi, 'for example ')
    .replace(/\bi\.e\.,?\s/gi, 'that is, ')
    .replace(/\s+[\u2014\u2013]\s+/g, '; ')
    .replace(/[\u2014\u2013]/g, ', ')
    .replace(/\b[A-Z]{4,}\b/g, (w) => (KEEP_CAPS.has(w) ? w : w.toLowerCase()))
}

/** One plain sentence of help from a server description. */
export function hookHelp(description: string): string {
  return plain(firstSentence(plain(description).trim()))
}

/** The whole description, cleaned the same way, for the expanded rows. */
export function hookDescription(description: string): string {
  return plain(description.trim())
}

/** "Session Auto Title (session:end)" -> "Session auto title": sentence case, acronyms kept. */
export function hookBaseName(name: string): string {
  const stripped = name.replace(/\s*\([^)]*\)\s*$/, '') || name
  return stripped
    .split(/(\s+)/)
    .map((word, i) => {
      if (i === 0 || /^\s+$/.test(word)) return word
      if (/^[A-Z0-9]{2,}$/.test(word) || /[a-z][A-Z]/.test(word)) return word // CWD, AskUserQuestion
      return word.charAt(0).toLowerCase() + word.slice(1)
    })
    .join('')
}

/** `onToolUse` / `session:end` as words: "tool use", "session end". */
export function humanEvent(event: string): string {
  return event
    .replace(/^on(?=[A-Z])/, '')
    .replace(/[:._-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim()
}

/** Names for a whole list: a name two hooks share gets the event it fires on. */
export function hookNames(hooks: ReadonlyArray<{ id: string; name: string; on: readonly string[] }>): Map<string, string> {
  const base = new Map(hooks.map((h) => [h.id, hookBaseName(h.name)]))
  const count = new Map<string, number>()
  for (const n of base.values()) count.set(n, (count.get(n) ?? 0) + 1)
  const out = new Map<string, string>()
  const used = new Set<string>()
  for (const h of hooks) {
    let name = base.get(h.id)!
    if ((count.get(name) ?? 0) > 1 && h.on.length > 0) name = `${name}, on ${humanEvent(h.on[0])}`
    let unique = name
    for (let i = 2; used.has(unique); i++) unique = `${name} ${i}`
    used.add(unique)
    out.set(h.id, unique)
  }
  return out
}
