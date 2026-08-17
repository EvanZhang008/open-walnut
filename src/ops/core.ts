/**
 * Core read ops + memory/notes + the `api` passthrough.
 *
 * search / project_list / session_list / walnut_status are ported
 * byte-compatible from the original hand-written MCP tools. The rest are the
 * first curated additions (the workflows the personal-walnut skill previously
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

defineOp({
  name: 'note_read',
  title: 'Read a note',
  description:
    'Read one note from the user\'s notes vault by path (e.g. "Projects/Example" — the .md ' +
    'suffix is optional). Returns { content, contentHash, updatedAt }; keep contentHash for a ' +
    'later note_write.',
  input: {
    path: z.string().min(1).describe('Vault-relative note path'),
  },
  handler: async (args, call) =>
    call('GET', `/notes/content/${String(args.path).split('/').map(encodeURIComponent).join('/')}`),
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'note_write',
  title: 'Create or update a note',
  description:
    'Write a note. Existing note: pass expectedHash (the contentHash from note_read) for ' +
    'optimistic locking — a conflict means someone edited it since you read it. New note: omit ' +
    'expectedHash; creation refuses to overwrite an existing note.',
  input: {
    path: z.string().min(1).describe('Vault-relative note path'),
    content: z.string().describe('Full markdown content'),
    expectedHash: z.string().optional().describe('contentHash from note_read (update only)'),
  },
  handler: async (args, call) => {
    const { path, content, expectedHash } = args
    const encoded = String(path).split('/').map(encodeURIComponent).join('/')
    if (expectedHash === undefined) {
      return call('POST', '/notes', { path, content })
    }
    return call('PUT', `/notes/content/${encoded}`, { content, expectedHash })
  },
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'note_search',
  title: 'Search notes',
  description:
    'Search the notes vault (hybrid keyword + semantic by default). Returns ranked results with ' +
    'paths — read a hit with note_read.',
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
    'Escape hatch for an endpoint with no named operation. Agents may use it only for GET reads; ' +
    'writes require a named operation. `path` must start with /api/. Prefer named operations because ' +
    'they carry validation, authorization, and product semantics.',
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
