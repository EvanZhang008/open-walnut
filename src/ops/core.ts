/**
 * Core read ops + memory/notes + the `api` passthrough.
 *
 * search / project_list / session_list / walnut_status are ported
 * byte-compatible from the original hand-written MCP tools. The rest are the
 * first curated additions (the workflows the walnut skill previously
 * taught via raw curl): session transcript, global/user memory read+write,
 * notes read/write/search.
 *
 * `api` is the capability floor (docs/plan/unified-cli-mcp.md): any /api/...
 * endpoint not yet promoted to a named op stays reachable, so the unified
 * surface NEVER has less capability than the server.
 */

import { z } from 'zod'
import { defineOp } from './registry.js'

// ── Reads (ported from the original MCP tools) ──────────────────────────────

defineOp({
  name: 'search',
  title: 'Search Walnut',
  description:
    'Global search across the user\'s tasks, memory, AND session transcripts (string + semantic ' +
    'legs; sessions are searched by default). Session transcripts are the ground truth for "who ' +
    'did X / which task changed Y" questions — task titles and summaries routinely under-describe ' +
    'the actual work. Also use this to check whether something already exists before creating a task.',
  input: {
    q: z.string().min(1).describe('Search query'),
    types: z.string().optional().describe('Comma-separated subset of: task,memory,session (default: all three)'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
  },
  bind: { method: 'GET', path: '/search' },
  // Cold embedding model + three semantic legs measured >10s; the default
  // 10s timeout made "search is broken" out of "search is warming up".
  timeoutMs: 30_000,
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'project_list',
  title: 'List Walnut projects',
  description:
    'Project registry rows with per-project task counts, favorite flags, and the Inbox counts. ' +
    'Project is the only grouping layer; a task with no project lives in the Inbox.',
  input: {},
  bind: { method: 'GET', path: '/projects' },
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'session_list',
  title: 'List Walnut coding sessions',
  description:
    'The user\'s tracked AI coding sessions (id, title, owning task, host, process_status, ' +
    'model, message_count). Read-only — use it to see what else is running before starting work.',
  input: {
    status: z.enum(['running', 'idle', 'stopped', 'error']).optional().describe('Filter by process status'),
  },
  bind: { method: 'GET', path: '/sessions' },
  mapResult: ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>
    const rows = Array.isArray(b.sessions) ? b.sessions : []
    const running = rows.filter((s) => (s as { process_status?: unknown }).process_status === 'running').length
    return {
      ...b,
      // Reads change nothing, but this is where the task/session distinction is
      // easiest to teach: these rows are the things actually doing work.
      outcome: `${rows.length} session(s) listed, ${running} of them working right now. `
        + 'A session is a live process doing work; its task row is just the record it hangs on.',
      next: 'Talk to one with session_send (never yourself), or start one for a task with session_start.',
    }
  },
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'walnut_status',
  title: 'Walnut server status',
  description:
    'Server health and identity: mode (LIVE primary vs REPLICA cloud companion), version, ' +
    'server time, last sync time. Call this first if another tool reports a connection problem.',
  input: {},
  bind: { method: 'GET', path: '/status' },
  tags: { readonly: true, remote: 'allow' },
})

// ── Curated additions: sessions ──────────────────────────────────────────────

defineOp({
  name: 'session_transcript',
  title: 'Read a session transcript',
  description:
    'Slim transcript tail of one coding session (what the user sees in the session panel). ' +
    'Pass fresh=true to force a live re-read on the primary box instead of the last export. ' +
    'Use session_list first to find the session id.',
  input: {
    id: z.string().min(1).describe('Session id'),
    fresh: z.boolean().optional().describe('Force a live transcript read (primary box only)'),
  },
  handler: async (args, call) => {
    const { id, fresh } = args
    return call('GET', `/sessions/${encodeURIComponent(String(id))}/transcript${fresh ? '?fresh=1' : ''}`)
  },
  tags: { readonly: true, remote: 'allow' },
})

// ── Curated additions: memory ────────────────────────────────────────────────

defineOp({
  name: 'memory_read',
  title: 'Read Walnut memory (MEMORY.md / USER.md)',
  description:
    'Read one of the user\'s standing memory documents: "global" = MEMORY.md (project/world ' +
    'knowledge index), "user" = USER.md (who the user is). Returns { memory: { content, ... } }.',
  input: {
    doc: z.enum(['global', 'user']).describe('Which memory document'),
  },
  bind: { method: 'GET', path: '/memory/:doc' },
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'memory_write',
  title: 'Write Walnut memory (MEMORY.md / USER.md)',
  description:
    'Replace the FULL content of a memory document ("global" = MEMORY.md, "user" = USER.md). ' +
    'Read it first (memory_read) and write back the complete revised text — this is a whole-file ' +
    'replace, not an append.',
  input: {
    doc: z.enum(['global', 'user']).describe('Which memory document'),
    content: z.string().describe('Complete new document content'),
  },
  bind: { method: 'PUT', path: '/memory/:doc', body: ['content'] },
  tags: { readonly: false, remote: 'allow' },
})

// ── Curated additions: notes ─────────────────────────────────────────────────

type OpCall = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => Promise<unknown>

/** Vault path → URL path (each segment encoded, separators kept). */
function encodeVaultPath(notePath: string): string {
  return notePath.split('/').map(encodeURIComponent).join('/')
}

/** A frontmatter note id, as note_search returns it. */
function looksLikeNoteId(value: string): boolean {
  return /^n_[a-z0-9]+$/i.test(value)
}

/**
 * Resolve the `path` / `id` pair every note op accepts into ONE vault path.
 *
 * note_search answers with `id` as the FIRST field of each hit, so agents hand
 * that id back — and the old path-only ops replied "invalid path" (reported
 * 2026-09-01). Rules: an explicit `id` always resolves through
 * /notes/resolve; a `path` that is really an id or a title does too, so the
 * caller is never punished for pasting the field they had.
 */
async function resolveNoteTarget(args: Record<string, unknown>, call: OpCall): Promise<string> {
  const id = typeof args.id === 'string' ? args.id.trim() : ''
  const path = typeof args.path === 'string' ? args.path.trim() : ''
  if (!id && !path) throw new Error('pass path (vault-relative note path) or id (from note_search)')
  const ref = id || path
  if (!id && !looksLikeNoteId(path)) return path
  const resolved = await call('GET', `/notes/resolve?ref=${encodeURIComponent(ref)}`)
  const resolvedPath = (resolved as { path?: unknown }).path
  if (typeof resolvedPath !== 'string' || !resolvedPath) throw new Error(`cannot resolve note reference: ${ref}`)
  return resolvedPath
}

/** GET one note, resolving a title/id path form when the direct read misses. */
async function readNote(
  args: Record<string, unknown>,
  call: OpCall,
): Promise<{ path: string; content: string; contentHash: string; updatedAt?: string }> {
  let notePath = await resolveNoteTarget(args, call)
  let body: unknown
  try {
    body = await call('GET', `/notes/content/${encodeVaultPath(notePath)}`)
  } catch (err) {
    // A path that does not exist may still be a TITLE ("Work achievement
    // datapoint"). Answering a name question with ENOENT is the bug; try the
    // resolver once before giving up.
    const message = err instanceof Error ? err.message : String(err)
    if (!/not_found|404/.test(message)) throw err
    notePath = await resolveNoteTarget({ id: notePath }, call)
    body = await call('GET', `/notes/content/${encodeVaultPath(notePath)}`)
  }
  const { content, contentHash, updatedAt } = (body ?? {}) as Record<string, unknown>
  if (typeof content !== 'string' || typeof contentHash !== 'string') {
    throw new Error(`unexpected note_read response for ${notePath}`)
  }
  return { path: notePath, content, contentHash, updatedAt: typeof updatedAt === 'string' ? updatedAt : undefined }
}

defineOp({
  name: 'note_read',
  title: 'Read a note',
  description:
    'Read one note from the user\'s notes vault by path (e.g. "Projects/Example" — the .md ' +
    'suffix is optional) OR by the id note_search returns. Returns { content, contentHash, ' +
    'updatedAt }; keep contentHash for a later note_write or note_edit.',
  input: {
    path: z.string().min(1).optional().describe('Vault-relative note path (or a note title)'),
    id: z.string().min(1).optional().describe('Frontmatter note id from note_search (n_...) — use either id or path'),
  },
  handler: async (args, call) => {
    const note = await readNote(args, call)
    return { path: note.path, content: note.content, contentHash: note.contentHash, updatedAt: note.updatedAt }
  },
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'note_write',
  title: 'Create or update a note',
  description:
    'Write a note WHOLE. Existing note: pass expectedHash (the contentHash from note_read) for ' +
    'optimistic locking — a conflict means someone edited it since you read it. New note: omit ' +
    'expectedHash; creation refuses to overwrite an existing note. For a small change inside a ' +
    'big note use note_edit instead of shipping the whole body back.',
  input: {
    path: z.string().min(1).describe('Vault-relative note path'),
    content: z.string().describe('Full markdown content'),
    expectedHash: z.string().optional().describe('contentHash from note_read (update only)'),
  },
  handler: async (args, call) => {
    const { path, content, expectedHash } = args
    const encoded = encodeVaultPath(String(path))
    if (expectedHash === undefined) {
      try {
        return await call('POST', '/notes', { path, content })
      } catch (err) {
        // The server's create-only 409 says "Note already exists", which reads
        // as a dead end. It is really a missing argument: say which one.
        const message = err instanceof Error ? err.message : String(err)
        if (/already exists/i.test(message)) {
          throw new Error(
            `note exists; pass expectedHash from note_read to update ${String(path)} `
            + '(note_read → contentHash → note_write), or use note_edit for a partial change',
          )
        }
        throw err
      }
    }
    return call('PUT', `/notes/content/${encoded}`, { content, expectedHash })
  },
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'note_edit',
  title: 'Edit part of a note',
  description:
    'Replace one exact string inside a note, leaving the rest untouched — the partial-edit op. ' +
    'Use this instead of note_read + note_write for any change to a large note: the whole body ' +
    'never travels back through the command line (an 80KB note forced @file payloads and caused ' +
    'a real escaping corruption). old_str must match the file byte-for-byte, including indentation, ' +
    'and must appear exactly once unless replace_all is true. Reads the note itself, so ' +
    'expectedHash is optional: pass the contentHash you read earlier and the edit refuses to run ' +
    'if the note changed since. Returns { path, replacements, contentHash, updatedAt }.',
  input: {
    path: z.string().min(1).optional().describe('Vault-relative note path (or a note title)'),
    id: z.string().min(1).optional().describe('Frontmatter note id from note_search (n_...) — use either id or path'),
    old_str: z.string().min(1).describe('Exact text to replace (must match the note byte-for-byte)'),
    new_str: z.string().describe('Replacement text ("" deletes old_str)'),
    replace_all: z.boolean().optional().describe('Replace every occurrence instead of requiring exactly one'),
    expectedHash: z.string().optional().describe('contentHash from note_read — the edit aborts if the note changed'),
  },
  handler: async (args, call) => {
    const oldStr = String(args.old_str)
    const newStr = String(args.new_str ?? '')
    const replaceAll = args.replace_all === true
    const note = await readNote(args, call)
    if (typeof args.expectedHash === 'string' && args.expectedHash && args.expectedHash !== note.contentHash) {
      throw new Error(
        `conflict: ${note.path} changed since you read it (expectedHash ${args.expectedHash}, `
        + `current ${note.contentHash}) — note_read it again and redo the edit on the current text`,
      )
    }
    const occurrences = note.content.split(oldStr).length - 1
    if (occurrences === 0) {
      throw new Error(
        `old_str not found in ${note.path} — it must match the note byte-for-byte `
        + '(whitespace and line breaks included). note_read the note and copy the exact text',
      )
    }
    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `old_str appears ${occurrences} times in ${note.path} — include enough surrounding text to `
        + 'make it unique, or pass replace_all: true',
      )
    }
    const next = replaceAll
      ? note.content.split(oldStr).join(newStr)
      : note.content.replace(oldStr, newStr)
    // The hash just read is the lock: a concurrent write between the read and
    // this PUT loses the race with a 409 instead of silently clobbering.
    const written = await call('PUT', `/notes/content/${encodeVaultPath(note.path)}`, {
      content: next,
      expectedHash: note.contentHash,
    })
    return { path: note.path, replacements: replaceAll ? occurrences : 1, ...(written as Record<string, unknown>) }
  },
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'note_attach',
  title: 'Attach an image to a note',
  description:
    'Save an image INTO the vault beside a note (an `_attachment/` folder next to it, the Obsidian ' +
    'convention) and return the vault-relative path to embed as `![[<path>]]`. mediaType is one of ' +
    'image/png, image/jpeg, image/gif, image/webp; data is the raw base64 (no data: prefix), max ~10MB. ' +
    'Base64 does not fit on a command line: write the JSON to a file and call ' +
    '`walnut tools call note_attach @/tmp/attach.json`. Embedding the returned path is a separate ' +
    'note_edit / note_write.',
  input: {
    notePath: z.string().min(1).describe('Vault-relative path of the note the image belongs to'),
    data: z.string().min(1).describe('Base64-encoded image bytes (no "data:...;base64," prefix)'),
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']).describe('Image MIME type'),
  },
  bind: { method: 'POST', path: '/notes/attachment', body: ['notePath', 'data', 'mediaType'] },
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'note_search',
  title: 'Search notes',
  description:
    'Search the notes vault (hybrid keyword + semantic by default). Returns ranked results with ' +
    'both `id` and `path` — read a hit with note_read using EITHER field.',
  input: {
    q: z.string().min(1).describe('Search query'),
    mode: z.enum(['hybrid', 'string', 'semantic']).optional().describe('Search mode (default hybrid)'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results (default 30)'),
  },
  bind: { method: 'GET', path: '/notes/search' },
  timeoutMs: 30_000,
  tags: { readonly: true, remote: 'allow' },
})

// ── The capability floor: generic passthrough ────────────────────────────────

defineOp({
  name: 'api',
  title: 'Call any Walnut API endpoint',
  description:
    'Escape hatch for an endpoint with no named operation. `path` must start with /api/. Prefer named ' +
    'operations because they carry validation, authorization, and product semantics.',
  input: {
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).describe('HTTP method'),
    path: z.string().min(1).describe('Absolute API path starting with /api/'),
    body: z.record(z.string(), z.unknown()).optional().describe('JSON body for write methods'),
  },
  handler: async (args, call) => {
    const method = String(args.method) as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    const path = String(args.path)
    if (!path.startsWith('/api/')) {
      throw new Error('api passthrough only accepts paths starting with /api/')
    }
    // A path starting with /api/ is server-root-absolute by the executor's
    // contract (rawRequest), so non-v1 routes are reachable too.
    return call(method, path, args.body)
  },
  tags: { readonly: false, remote: 'allow' },
})
