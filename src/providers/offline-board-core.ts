/**
 * A team's Board, kept on the host its sessions run on, so a leader reads and
 * writes it while the Walnut server is away (docs/plan/walnut-control-plane.md,
 * "Layer 1"). The server keeps the board (core/boards/); its copy rides the
 * host's read copy (`host.slice`), and a write made here is checked the way
 * the server checks it, applied to the copy so the next read agrees, and
 * journaled. The server replays it through the same op on reconnect, where its
 * own checks decide again: an edit whose text moved on is refused and the
 * writer is told.
 *
 * Pure helpers, no state: the offline host holds the copy and the journal.
 * daemon-standalone.ts imports createBoardOffline; daemon-source.ts inlines
 * `createBoardOffline.toString()` through `__CREATE_BOARD_OFFLINE__`, so the
 * body references nothing at module scope.
 */

export interface OfflineBoardMessage { id: string; author: string; text: string; ts: string }

/** Who wrote a span of a board's html (the server's BoardHtmlSource, board-html-source.ts). */
export interface OfflineHtmlSource { start: number; end: number; by: string; sessionId?: string }

export interface OfflineSliceBoard {
  /** The board's task (a team shares its leader's). */
  taskId: string
  html: string
  version: number
  updated_at?: string
  updated_by?: string
  /** Optional provenance of the page: kept as the server sent it, never invented here. */
  updated_session_id?: string
  html_sources?: OfflineHtmlSource[]
  threads?: Record<string, OfflineBoardMessage[]>
  marks?: Record<string, { state?: string; note?: string }>
  projects?: Record<string, Record<string, unknown>>
  choices?: Record<string, Record<string, unknown>>
}

export type BoardOpError = { ok: false; code: string; message: string; detail?: unknown }

export function createBoardOffline() {
  const ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
  const HTML_MAX_BYTES = 1024 * 1024
  const MESSAGE_MAX_BYTES = 8 * 1024
  const STATUSES = ['decide', 'wip', 'wait', 'done']
  const TEXT_FIELDS: Array<[string, number]> = [['summary', 2000], ['latest', 2000], ['next', 1000], ['waiting', 120], ['meta', 80]]
  const TITLE_MAX = 200
  const BOARD_OPS = ['board_get', 'board_set', 'board_edit', 'board_post', 'board_project_set']
  const WRITE_OPS = ['board_set', 'board_edit', 'board_post', 'board_project_set']

  const bytes = (s: string): number => (typeof Buffer !== 'undefined' ? Buffer.byteLength(s, 'utf8') : s.length)
  const has = (m: Record<string, unknown> | undefined, k: string): boolean => !!m && Object.prototype.hasOwnProperty.call(m, k)
  const err = (code: string, message: string, detail?: unknown): BoardOpError => ({ ok: false, code, message, ...(detail !== undefined ? { detail } : {}) })

  /** The server's applyBoardEdits: each `old` exactly once at its turn, in order, all or none. */
  function applyEdits(html: string, edits: unknown, onSplice?: (at: number, removed: number, inserted: number) => void): { ok: true; html: string } | BoardOpError {
    if (!Array.isArray(edits) || edits.length === 0) return err('bad_request', '`edits` must be a non-empty array of { old, new }')
    let out = html
    for (let index = 0; index < edits.length; index++) {
      const e = edits[index] as { old?: unknown; new?: unknown }
      if (!e || typeof e.old !== 'string' || typeof e.new !== 'string') return err('bad_request', `edits[${index}] must be { old: string, new: string }`, { index })
      if (e.old === '') return err('bad_request', `edits[${index}].old must not be empty`, { index })
      let count = 0
      let first = -1
      for (let at = out.indexOf(e.old); at !== -1; at = out.indexOf(e.old, at + 1)) { if (first === -1) first = at; count++ }
      if (count === 0) return err('board_edit_not_found', `An edit's \`old\` text does not occur in the board (edits[${index}])`, { index })
      if (count > 1) return err('board_edit_not_unique', `An edit's \`old\` text occurs more than once in the board (edits[${index}])`, { index, count })
      out = out.slice(0, first) + e.new + out.slice(first + e.old.length)
      if (onSplice && e.old !== e.new) {
        // Only the changed middle is the writer's: the shared head and tail keep their writers.
        // Never cut inside a surrogate pair (a pair is one character).
        const o = e.old
        const n = e.new
        const limit = Math.min(o.length, n.length)
        let p = 0
        while (p < limit && o.charCodeAt(p) === n.charCodeAt(p)) p++
        if (p > 0 && /[\ud800-\udbff]/.test(o[p - 1] ?? '')) p--
        let q = 0
        while (q < limit - p && o.charCodeAt(o.length - 1 - q) === n.charCodeAt(n.length - 1 - q)) q++
        if (q > 0 && /[\udc00-\udfff]/.test(o[o.length - q] ?? '')) q--
        onSplice(first + p, o.length - p - q, n.length - p - q)
      }
    }
    return { ok: true, html: out }
  }

  const TASK_WRITER_RE = /^task:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
  const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
  /** A page writer as the server names it: a paired device is the person; anything unknown is an agent. */
  const sourceWriter = (by: unknown): string => {
    if (by === 'human' || by === 'agent') return by
    if (typeof by === 'string' && TASK_WRITER_RE.test(by)) return by
    return typeof by === 'string' && by.startsWith('device:') ? 'human' : 'agent'
  }
  const sameSource = (a: OfflineHtmlSource, b: OfflineHtmlSource): boolean => a.by === b.by && a.sessionId === b.sessionId
  const mergeSources = (spans: OfflineHtmlSource[]): OfflineHtmlSource[] => {
    const out: OfflineHtmlSource[] = []
    for (const sp of spans) {
      const last = out[out.length - 1]
      if (last && last.end === sp.start && sameSource(last, sp)) out[out.length - 1] = { ...last, end: sp.end }
      else out.push({ ...sp })
    }
    return out
  }
  const wholeSource = (length: number, by: unknown, sessionId?: unknown): OfflineHtmlSource[] =>
    length > 0
      ? [{ start: 0, end: length, by: sourceWriter(by), ...(typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId) && sourceWriter(by) !== 'human' ? { sessionId } : {}) }]
      : []
  /** The stored spans when they exactly cover `length`, else null (the server's validHtmlSources). */
  const validSources = (raw: unknown, length: number): OfflineHtmlSource[] | null => {
    if (!Array.isArray(raw)) return null
    const out: OfflineHtmlSource[] = []
    let at = 0
    for (const sp of raw) {
      if (!sp || typeof sp !== 'object' || Array.isArray(sp)) return null
      const { start, end, by, sessionId } = sp as Record<string, unknown>
      if (!Number.isInteger(start) || !Number.isInteger(end)) return null
      if (start !== at || (end as number) <= at || (end as number) > length) return null
      if (by !== 'human' && by !== 'agent' && !(typeof by === 'string' && TASK_WRITER_RE.test(by))) return null
      if (sessionId !== undefined && !(typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId))) return null
      out.push({ start: start as number, end: end as number, by, ...(sessionId !== undefined ? { sessionId: sessionId as string } : {}) })
      at = end as number
    }
    return at === length ? mergeSources(out) : null
  }
  /** The board's page spans, or its last writer for the whole page when it has none it can trust. */
  const sourcesOf = (board: OfflineSliceBoard): OfflineHtmlSource[] =>
    validSources(board.html_sources, board.html.length) ?? wholeSource(board.html.length, board.updated_by, board.updated_session_id)
  const spliceSources = (spans: OfflineHtmlSource[], at: number, removed: number, inserted: number, by: unknown): OfflineHtmlSource[] => {
    const cut = at + removed
    const delta = inserted - removed
    const before: OfflineHtmlSource[] = []
    const after: OfflineHtmlSource[] = []
    for (const sp of spans) {
      if (sp.start < at) before.push({ ...sp, end: Math.min(sp.end, at) })
      if (sp.end > cut) after.push({ ...sp, start: Math.max(sp.start, cut) + delta, end: sp.end + delta })
    }
    const added: OfflineHtmlSource[] = inserted > 0 ? [{ start: at, end: at + inserted, by: sourceWriter(by) }] : []
    return mergeSources([...before, ...added, ...after])
  }

  /**
   * Check one write against the board as this host sees it now. Ok: the args
   * to journal (`version` dropped: the server checks the text itself on
   * replay). `by` is the writer's `task:<id>` ('agent' for a session with no
   * task); any session may write any board this host keeps, as online.
   */
  function prepare(board: OfflineSliceBoard | undefined, op: string, args: Record<string, unknown>, by: string): { ok: true; args: Record<string, unknown> } | BoardOpError {
    if (op === 'board_set') {
      if (typeof args.html !== 'string' || !args.html) return err('bad_request', '`html` must be a non-empty string')
      if (bytes(args.html) > HTML_MAX_BYTES) return err('board_too_large', `Board html is larger than ${HTML_MAX_BYTES} bytes`)
      if (board && typeof args.version === 'number' && args.version !== board.version) {
        return err('board_version_conflict', 'The board changed since that version: re-read it and retry', { version: board.version })
      }
      return { ok: true, args: { html: args.html } }
    }
    if (!board) return err('no_board', 'This task has no board yet')
    if (op === 'board_edit') {
      if (typeof args.version === 'number' && args.version !== board.version) {
        return err('board_version_conflict', 'The board changed since that version: re-read it and retry', { version: board.version })
      }
      const r = applyEdits(board.html, args.edits)
      if (!r.ok) return r
      if (bytes(r.html) > HTML_MAX_BYTES) return err('board_too_large', `Board html is larger than ${HTML_MAX_BYTES} bytes`)
      return { ok: true, args: { edits: args.edits } }
    }
    if (op === 'board_post') {
      const thread = typeof args.thread === 'string' ? args.thread : ''
      if (!ITEM_ID_RE.test(thread)) return err('bad_id', 'Invalid thread id')
      const text = typeof args.text === 'string' ? args.text.trim() : ''
      if (!text) return err('bad_request', '`text` must be a non-empty string')
      if (bytes(text) > MESSAGE_MAX_BYTES) return err('message_too_long', `Message text is longer than ${MESSAGE_MAX_BYTES} bytes`)
      return { ok: true, args: { thread, text } }
    }
    if (op === 'board_project_set') {
      const id = typeof args.id === 'string' ? args.id : ''
      if (!ITEM_ID_RE.test(id)) return err('bad_id', 'Invalid project id')
      const status = typeof args.status === 'string' ? args.status.trim() : undefined
      if (status !== undefined && status !== '' && STATUSES.indexOf(status) === -1) {
        return err('bad_status', 'A project status is one of decide, wip, wait, done (or "" to clear)')
      }
      const prev = (has(board.projects, id) ? board.projects![id] : undefined) as Record<string, unknown> | undefined
      const removing = args.delete === true
      const nextStatus = removing ? undefined : status !== undefined ? (status || undefined) : prev?.status
      if (prev && prev.status && prev.status_by === 'human' && nextStatus !== prev.status && args.override_user !== true) {
        return err('status_set_by_user', `The user set project "${id}" to ${String(prev.status)}. Leave status out to keep their pick, or pass override_user: true to replace it.`,
          { project: id, status: prev.status })
      }
      if (typeof args.title === 'string' && args.title.trim().length > TITLE_MAX) {
        return err('bad_request', `A project title is at most ${TITLE_MAX} characters`)
      }
      const out: Record<string, unknown> = { id }
      for (const k of ['title', 'status', 'tasks', 'delete', 'override_user']) if (args[k] !== undefined) out[k] = args[k]
      for (const [k, max] of TEXT_FIELDS) {
        if (args[k] === undefined) continue
        // null clears the field, as online.
        if (args[k] !== null && typeof args[k] !== 'string') return err('bad_request', `\`${k}\` must be a string`)
        if (typeof args[k] === 'string' && (args[k] as string).trim().length > max) return err('bad_request', `A project's \`${k}\` is at most ${max} characters`)
        out[k] = args[k]
      }
      if (out.tasks !== undefined && !(Array.isArray(out.tasks) && out.tasks.every((t) => typeof t === 'string' && t))) {
        return err('bad_request', '`tasks` must be an array of task ids')
      }
      void by
      return { ok: true, args: out }
    }
    return err('bad_request', `${op} is not a board write`)
  }

  /** One journaled write applied to a copy (the args prepare() returned). */
  function apply(board: OfflineSliceBoard | undefined, op: string, args: Record<string, unknown>, by: string, nowIso: string, boardTaskId: string, newId: () => string): OfflineSliceBoard | undefined {
    if (op === 'board_set') {
      const base: OfflineSliceBoard = board ?? { taskId: boardTaskId, html: '', version: 0, threads: {}, marks: {}, projects: {}, choices: {} }
      // The whole page is this writer's (a device is the person); no session is guessed.
      const { updated_session_id: _sid, ...rest } = base
      const html = String(args.html)
      return { ...rest, html, version: base.version + 1, updated_at: nowIso, updated_by: by, html_sources: wholeSource(html.length, by) }
    }
    if (!board) return board
    if (op === 'board_edit') {
      let sources = sourcesOf(board)
      const r = applyEdits(board.html, args.edits, (at, removed, inserted) => { sources = spliceSources(sources, at, removed, inserted, by) })
      if (!r.ok) return board
      const { updated_session_id: _sid, ...rest } = board
      return { ...rest, html: r.html, version: board.version + 1, updated_at: nowIso, updated_by: by, html_sources: sources }
    }
    if (op === 'board_post') {
      const thread = String(args.thread)
      const list = (has(board.threads, thread) ? board.threads![thread] : []) || []
      const message: OfflineBoardMessage = { id: newId(), author: by, text: String(args.text), ts: nowIso }
      return { ...board, threads: { ...(board.threads ?? {}), [thread]: [...list, message] } }
    }
    if (op === 'board_project_set') {
      const id = String(args.id)
      const projects = { ...(board.projects ?? {}) }
      const prev = (has(projects, id) ? projects[id] : {}) as Record<string, unknown>
      const p: Record<string, unknown> = { ...prev, updated_at: nowIso, updated_by: by }
      if (typeof args.title === 'string') { if (args.title.trim()) p.title = args.title.trim(); else delete p.title }
      if (typeof args.status === 'string') {
        const s = args.status.trim()
        if (s !== prev.status) { if (s) { p.status = s; p.status_by = by; p.status_at = nowIso } else { delete p.status; delete p.status_by; delete p.status_at } }
      }
      if (Array.isArray(args.tasks)) { if (args.tasks.length) p.tasks = args.tasks; else delete p.tasks }
      for (const [k] of TEXT_FIELDS) {
        if (typeof args[k] !== 'string' && args[k] !== null) continue
        const v = typeof args[k] === 'string' ? (args[k] as string).trim() : ''
        if (v) p[k] = v; else delete p[k]
      }
      const empty = !p.title && !p.status && !(Array.isArray(p.tasks) && p.tasks.length) && !TEXT_FIELDS.some(([k]) => p[k])
      if (args.delete === true || empty) delete projects[id]
      else projects[id] = p
      return { ...board, projects }
    }
    return board
  }

  return { BOARD_OPS, WRITE_OPS, prepare, apply, applyEdits }
}

export type BoardOffline = ReturnType<typeof createBoardOffline>
