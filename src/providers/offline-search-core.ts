/**
 * `search` on a host while the Walnut server cannot answer
 * (docs/plan/walnut-control-plane.md "Search while the Mac is away"): a keyword
 * search of what this host keeps, the tasks and sessions of its slice (with the
 * writes made here) and its copy of the memory. The server's semantic ranking
 * and its transcript index stay on the server; while it answers, search is
 * the server's.
 *
 * Rows have the server's SearchResult shape (type, title, snippet, taskId,
 * sessionId, path, score, matchField), so a caller reads them the same way.
 * Ranking follows the replica's note_search: every word first; when no row has
 * them all, the rows with the most of them; then a title hit over a body hit,
 * and the whole phrase over scattered words. A finished task ranks below an
 * open one with the same words.
 *
 * Text-injected into the source twin by fn.toString() (daemon-source.ts): no
 * imports, and nothing from module scope.
 */

export interface OfflineSearchTask {
  id: string
  title: string
  description?: string
  summary?: string
  note?: string
  phase?: string
  parent_task_id?: string
}

export interface OfflineSearchSession { id: string; title?: string; taskId?: string; taskTitle?: string }

/** A memory document of the host's copy: MEMORY.md, USER.md. */
export interface OfflineSearchDoc { path: string; title: string; content: string }

export interface OfflineSearchRow {
  type: 'task' | 'memory' | 'session'
  title: string
  snippet: string
  path?: string
  taskId?: string
  sessionId?: string
  parentTaskId?: string
  score: number
  matchField: string
  coveredTermHits: number
}

export type OfflineSearchResult =
  | { ok: true; results: OfflineSearchRow[]; tokens: string[]; types: string[] }
  | { ok: false; error: string }

export function createOfflineSearch() {
  const TYPES = ['task', 'memory', 'session']
  const MAX_TOKENS = 12
  const MAX_QUERY = 500
  const DEFAULT_LIMIT = 20
  const MAX_LIMIT = 100
  const SNIPPET = 90

  function snippetOf(text: string, term: string): string {
    const flat = text.replace(/\s+/g, ' ').trim()
    if (!flat) return ''
    const at = term ? flat.toLowerCase().indexOf(term) : -1
    if (at < 0) return flat.length > SNIPPET * 2 ? flat.slice(0, SNIPPET * 2) + '...' : flat
    const start = Math.max(0, at - SNIPPET)
    const end = Math.min(flat.length, at + term.length + SNIPPET)
    return (start > 0 ? '...' : '') + flat.slice(start, end) + (end < flat.length ? '...' : '')
  }

  /** How a row's fields hold the words: matched words, a score, and where the first body hit is. */
  function scoreOf(head: string, fields: Array<{ name: string; text: string }>, tokens: string[], phrase: string) {
    const h = head.toLowerCase()
    const bodies = fields.map((f) => ({ name: f.name, text: f.text, low: f.text.toLowerCase() }))
    let matched = 0
    let score = 0
    let first = ''
    let field = ''
    let inTitle = false
    for (const t of tokens) {
      const inHead = h.indexOf(t) !== -1
      const body = bodies.find((b) => b.low.indexOf(t) !== -1)
      if (!inHead && !body) continue
      matched++
      if (inHead) inTitle = true
      score += (inHead ? 3 : 0) + (body ? 1 : 0)
      if (body && !first) { first = t; field = body.name }
    }
    if (matched > 0) {
      if (h.indexOf(phrase) !== -1) score += 5
      else if (bodies.some((b) => b.low.indexOf(phrase) !== -1)) score += 2
    }
    const hit = bodies.find((b) => b.name === field)
    // The field a reader is shown as the match: the title when it holds a word.
    return { matched, score, first, field: inTitle || !field ? 'title' : field, body: hit ? hit.text : '' }
  }

  function run(input: {
    q: unknown
    types?: unknown
    limit?: unknown
    tasks: OfflineSearchTask[]
    sessions: OfflineSearchSession[]
    memory: OfflineSearchDoc[]
  }): OfflineSearchResult {
    const q = typeof input.q === 'string' ? input.q.trim().slice(0, MAX_QUERY) : ''
    if (!q) return { ok: false, error: 'q is required' }
    let types = TYPES
    if (input.types !== undefined) {
      const asked = typeof input.types === 'string' ? input.types.split(',') : Array.isArray(input.types) ? input.types : null
      if (!asked) return { ok: false, error: 'types must be a comma-separated list of task, memory, session' }
      const wanted = asked.map((t) => String(t).trim()).filter(Boolean)
      const bad = wanted.filter((t) => TYPES.indexOf(t) === -1)
      if (bad.length > 0) return { ok: false, error: `invalid types: ${bad.join(', ')} (valid: ${TYPES.join(', ')})` }
      if (wanted.length > 0) types = TYPES.filter((t) => wanted.indexOf(t) !== -1)
    }
    const rawLimit = typeof input.limit === 'number' ? input.limit : typeof input.limit === 'string' ? Number(input.limit) : NaN
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : DEFAULT_LIMIT))
    const phrase = q.toLowerCase()
    const tokens = phrase.split(/\s+/).filter(Boolean).slice(0, MAX_TOKENS)

    const rows: OfflineSearchRow[] = []
    if (types.indexOf('task') !== -1) {
      for (const t of input.tasks) {
        if (!t || typeof t.id !== 'string' || typeof t.title !== 'string') continue
        const fields = [
          { name: 'description', text: t.description ?? '' },
          { name: 'summary', text: t.summary ?? '' },
          { name: 'note', text: t.note ?? '' },
        ].filter((f) => f.text)
        const s = scoreOf(t.title + '\n' + t.id, fields, tokens, phrase)
        if (s.matched === 0) continue
        rows.push({
          type: 'task', title: t.title, taskId: t.id,
          ...(t.parent_task_id ? { parentTaskId: t.parent_task_id } : {}),
          snippet: s.first ? snippetOf(s.body, s.first) : t.title,
          score: s.score - (t.phase === 'COMPLETE' ? 0.5 : 0),
          matchField: s.field, coveredTermHits: s.matched,
        })
      }
    }
    if (types.indexOf('session') !== -1) {
      for (const se of input.sessions) {
        if (!se || typeof se.id !== 'string') continue
        const title = se.title || se.taskTitle || se.id
        const fields = se.taskTitle && se.taskTitle !== title ? [{ name: 'task_title', text: se.taskTitle }] : []
        const s = scoreOf(title, fields, tokens, phrase)
        if (s.matched === 0) continue
        rows.push({
          type: 'session', title, sessionId: se.id, ...(se.taskId ? { taskId: se.taskId } : {}),
          snippet: s.first ? snippetOf(s.body, s.first) : title,
          score: s.score, matchField: s.field, coveredTermHits: s.matched,
        })
      }
    }
    if (types.indexOf('memory') !== -1) {
      for (const d of input.memory) {
        if (!d || typeof d.content !== 'string') continue
        const s = scoreOf(d.title, [{ name: 'content', text: d.content }], tokens, phrase)
        if (s.matched === 0) continue
        rows.push({
          type: 'memory', title: d.title, path: d.path,
          snippet: snippetOf(d.content, s.first || tokens[0] || ''),
          score: s.score, matchField: s.field, coveredTermHits: s.matched,
        })
      }
    }
    const best = rows.reduce((m, r) => Math.max(m, r.coveredTermHits), 0)
    const order = (r: OfflineSearchRow) => TYPES.indexOf(r.type)
    const results = rows
      .filter((r) => r.coveredTermHits === best)
      .sort((a, b) => b.score - a.score || order(a) - order(b) || a.title.localeCompare(b.title))
      .slice(0, limit)
    return { ok: true, results, tokens, types }
  }

  return { run }
}

export type OfflineSearch = ReturnType<typeof createOfflineSearch>
