/**
 * Notes on a host replica (docs/plan/walnut-replica-servers-impl.md WP6, C5):
 * the replica keeps no second vault. Its notes routes run only while the Mac is
 * away (they are `leader` rows, forwarded while it answers), and they read the
 * copy the host daemon already keeps (host-replica-core.ts), through the
 * follower link's owner-scoped reads ('replica-reads-v1'):
 *
 *   tree      from `replica.list {kind:'notes'}` (the manifest), built once per
 *             manifest hash, in the disk tree's order and JSON shape
 *   content   one `replica.read`
 *   links, backlinks, tags, flat list, keyword search
 *             from an index built with `replica.readMany` (4 MB per answer) and
 *             kept per manifest hash; a new manifest reads only the entries
 *             whose body hash moved
 *
 * The leader (the Mac) never constructs this: its notes routes read the disk vault.
 * The companion builds one over its own copy (core/companion-notes.ts, stage 4b of
 * docs/plan/walnut-companion-unified-replica.md), active once the copy is held.
 *
 * What the Mac leaves out of the copy (a folder or a note the user left out, a note too
 * large to copy: the manifest's `keep`) is never answered from it: `leftOut` says which
 * paths, `copyState` whether the copy is held, off, or leaves anything out at all
 * (core/replication/keep-rule.ts, the rule every side applies).
 */
import path from 'node:path'
import { isAttachmentFile, type TreeNode } from '../core/notes-tree.js'
import { parseFrontmatter } from '../core/parse-frontmatter.js'
import { leftOut as leftOutBy } from '../core/replication/keep-rule.js'

/** A manifest entry as the daemon answers it (host-replica-core.ts list). */
export interface CopyEntry { k: string; h: string; n?: number; m?: Record<string, unknown> }

/** What the Mac leaves out of this copy (host-replica-core.ts list `keep`): folders and notes, and the notes too large. */
export interface CopyKeep { exclude: string[]; tooBig: string[] }

/** The copy's state: held (a whole manifest arrived), off (the Mac turned notes off here), partial (it leaves notes out). */
export interface CopyState {
  held: boolean
  off: boolean
  partial: boolean
  /** The memory or skills the Mac turned off for this replica (a search here leaves them out). */
  offKinds: string[]
  /** The folders and notes the Mac leaves out of this copy (replication/keep-rule.ts entries). */
  exclude: string[]
}

/** The follower link's replica reads, for the notes kind. */
export interface NotesCopyReader {
  list(): Promise<{ entries: CopyEntry[]; asOf: string | null; manifestHash: string; off?: boolean; keep?: CopyKeep | null; offKinds?: string[] }>
  read(key: string): Promise<{ k: string; h: string; m?: Record<string, unknown>; body: string } | null>
  readMany(keys: string[]): Promise<{ files: Array<{ k: string; h: string; body: string }>; missing: string[]; more: string[] }>
}

export type LinkStatus = 'resolved' | 'unresolved' | 'ambiguous'

export interface CopyBacklink { id: string; path: string; title: string; name: string; snippet: string; status: LinkStatus; candidates?: string[] }
export interface CopyForwardLink { dstId: string | null; dstName: string; status: LinkStatus; title?: string; path?: string }

/** One note of the copy, parsed for links and tags. */
interface Parsed {
  h: string
  tags: string[]
  links: Array<{ target: string; context: string }>
  body: string
}

// The same rules as the leader's indexer (core/notes-indexer.ts).
const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g
const INLINE_TAG_RE = /(^|[\s(])#([A-Za-z][A-Za-z0-9/_-]*)/g
/** Notes parsed between two turns of the event loop while an index builds. */
const PARSE_SLICE = 50
/** A manifest asked again at most this often (the tree's warm path makes no daemon call). */
const LIST_TTL_MS = 2_000

export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-')
}

function tagsOf(content: string): { tags: string[]; body: string } {
  const set = new Set<string>()
  let data: Record<string, unknown> = {}
  let body = content
  try { const fm = parseFrontmatter(content); data = fm.data as Record<string, unknown>; body = fm.body } catch { /* plain text */ }
  const fm = data.tags
  if (Array.isArray(fm)) { for (const t of fm) if (typeof t === 'string' && normalizeTag(t)) set.add(normalizeTag(t)) }
  else if (typeof fm === 'string') { for (const t of fm.split(/[,\s]+/)) if (normalizeTag(t)) set.add(normalizeTag(t)) }
  const noCode = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
  INLINE_TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_TAG_RE.exec(noCode)) !== null) { const slug = normalizeTag(m[2]!); if (slug) set.add(slug) }
  return { tags: [...set], body }
}

function parse(h: string, content: string): Parsed {
  const { tags, body } = tagsOf(content)
  const links: Parsed['links'] = []
  WIKI_LINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WIKI_LINK_RE.exec(body)) !== null) {
    const target = m[1]!.trim()
    if (!target) continue
    links.push({ target, context: body.slice(Math.max(0, m.index - 30), Math.min(body.length, m.index + m[0].length + 30)) })
  }
  return { h, tags, links, body }
}

/** The disk tree's shape and order (core/notes-tree.ts walk), from the manifest's keys. */
export function treeFromKeys(keys: string[]): TreeNode[] {
  interface Dir { folders: Map<string, Dir>; files: string[] }
  const root: Dir = { folders: new Map(), files: [] }
  for (const k of keys) {
    const parts = k.split('/')
    // Hidden entries and Office lock files never show (the disk walk skips them).
    if (parts.some((p) => !p || p.startsWith('.') || p.startsWith('~$'))) continue
    let dir = root
    for (const p of parts.slice(0, -1)) {
      let next = dir.folders.get(p)
      if (!next) { next = { folders: new Map(), files: [] }; dir.folders.set(p, next) }
      dir = next
    }
    dir.files.push(parts[parts.length - 1]!)
  }
  const build = (dir: Dir, rel: string): TreeNode[] => {
    const folders = [...dir.folders.keys()].sort((a, b) => a.localeCompare(b))
    const files = [...dir.files].sort((a, b) => a.localeCompare(b))
    const out: TreeNode[] = []
    for (const name of folders) {
      const p = rel ? `${rel}/${name}` : name
      out.push({ name, path: p, type: 'folder', children: build(dir.folders.get(name)!, p) })
    }
    for (const name of files) {
      const p = rel ? `${rel}/${name}` : name
      if (name.endsWith('.md')) out.push({ name, path: p, type: 'file', kind: 'note' })
      else if (isAttachmentFile(name)) out.push({ name, path: p, type: 'file', kind: 'attachment' })
    }
    return out
  }
  return build(root, '')
}

function titleOf(e: CopyEntry): string {
  const t = e.m && typeof e.m.title === 'string' ? e.m.title : ''
  return t || path.posix.basename(e.k, '.md')
}

function idOf(e: CopyEntry): string {
  return e.m && typeof e.m.id === 'string' ? e.m.id : ''
}

/** A vault-relative note path as the routes take it (no leading slash, `.md` added). */
export function noteKey(raw: string): string | null {
  const cleaned = raw.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || cleaned === '.' || cleaned.split('/').some((s) => s === '..')) return null
  return cleaned.endsWith('.md') ? cleaned : `${cleaned}.md`
}

export interface NotesSource {
  /** `{"tree":[...]}`, byte for byte what the disk tree serializes for the same notes. */
  tree(): Promise<{ json: string; notes: number }>
  content(rawPath: string): Promise<{ content: string; updatedAt: string | null; contentHash: string; id?: string } | null>
  backlinks(rawPath: string): Promise<{ backlinks: CopyBacklink[] }>
  links(rawPath: string): Promise<{ links: CopyForwardLink[] }>
  list(): Promise<{ notes: Array<{ id: string; title: string; path: string; name: string }> }>
  tags(): Promise<{ tags: Array<{ tag: string; count: number }> }>
  notesForTag(tag: string): Promise<{ notes: Array<{ id: string; title: string; path: string; snippet: string; modified: string | undefined }> }>
  search(q: string, limit: number): Promise<{ results: Array<{ id: string; path: string; title: string; snippet: string; matchType: 'exact'; score: number }>; degraded: 'offline-keyword' }>
  /**
   * One note reference (a frontmatter id, a vault path, a title) to its path, by the
   * disk route's rules (notes-v2.ts resolveNoteRef): `status` 404 for no match, 409 for a
   * title several notes share, 400 for an empty or unsafe one.
   */
  resolve(ref: string): Promise<{ id: string | null; path: string; title: string | null; matchedBy: 'id' | 'path' | 'name' } | { status: 400 | 404 | 409; message: string }>
  /** The copy's age (the manifest's asOf), for x-walnut-offline. */
  asOf(): string | null
  /** Held, turned off, or leaving notes out (the manifest's own word). */
  copyState(): Promise<CopyState>
  /** The note at `rawPath` is one the Mac keeps from this copy (left out, or too large). */
  leftOut(rawPath: string): Promise<boolean>
  /** Drop the listed manifest: a write the box keeps over its copy shows in the next read (the companion). */
  forget?(): void
}

export function createCopyNotesSource(reader: NotesCopyReader, opts: { now?: () => number; listTtlMs?: number } = {}): NotesSource {
  const now = opts.now ?? Date.now
  const ttl = opts.listTtlMs ?? LIST_TTL_MS
  type Manifest = { entries: CopyEntry[]; byKey: Map<string, CopyEntry>; asOf: string | null; hash: string; at: number; off: boolean; keep: CopyKeep | null; offKinds?: string[] }
  let manifest: Manifest | null = null
  let manifestInFlight: Promise<Manifest> | null = null
  /** Bumped by forget(): a list started before it never becomes the manifest. */
  let gen = 0
  let treeMemo: { hash: string; json: string; notes: number } | null = null
  const parsed = new Map<string, Parsed>()
  let indexHash = ''
  let indexInFlight: Promise<void> | null = null

  function getManifest(): Promise<Manifest> {
    if (manifest && now() - manifest.at < ttl) return Promise.resolve(manifest)
    if (manifestInFlight) return manifestInFlight
    const started = gen
    const p: Promise<Manifest> = reader.list().then((r) => {
      const byKey = new Map(r.entries.map((e) => [e.k, e]))
      const keep = r.keep && (r.keep.exclude?.length || r.keep.tooBig?.length) ? { exclude: r.keep.exclude ?? [], tooBig: r.keep.tooBig ?? [] } : null
      const m = { entries: r.entries, byKey, asOf: r.asOf, hash: r.manifestHash, at: now(), off: r.off === true, keep, offKinds: r.offKinds ?? [] }
      if (started === gen) manifest = m
      return m
    }).finally(() => { if (manifestInFlight === p) manifestInFlight = null })
    manifestInFlight = p
    return p
  }

  /** Parse every entry whose body hash moved since the last index (4 MB per readMany). */
  async function ensureIndex(): Promise<Manifest> {
    const m = await getManifest()
    // A build for an older manifest may be in flight: wait for it, then build
    // for this one, so an answer never comes from the older parse.
    while (indexHash !== m.hash && indexInFlight) await indexInFlight.catch(() => undefined)
    if (indexHash === m.hash) return m
    if (!indexInFlight) {
      indexInFlight = (async () => {
        for (const k of [...parsed.keys()]) if (!m.byKey.has(k)) parsed.delete(k)
        let want = m.entries.filter((e) => parsed.get(e.k)?.h !== e.h).map((e) => e.k)
        while (want.length > 0) {
          const r = await reader.readMany(want)
          // Parse in slices, giving the event loop back between them: a whole
          // vault at once held every route for most of a second (13 MB, 3,000 notes).
          for (let i = 0; i < r.files.length; i++) {
            const f = r.files[i]!
            parsed.set(f.k, parse(f.h, f.body))
            if (i % PARSE_SLICE === PARSE_SLICE - 1) await new Promise<void>((done) => setImmediate(done))
          }
          // Keys the copy lost between list and read are simply not indexed.
          if (r.more.length >= want.length) break
          want = r.more
        }
        indexHash = m.hash
      })().finally(() => { indexInFlight = null })
    }
    await indexInFlight
    return m
  }

  /** Lowercased names and paths of one manifest, built once per manifest (a scan per link held the loop ~1 s at 3,000 notes). */
  let namesMemo: { hash: string; names: Map<string, string[]>; lowerKeys: Map<string, string> } | null = null
  function namesOf(m: Manifest) {
    if (namesMemo && namesMemo.hash === m.hash) return namesMemo
    const names = new Map<string, string[]>()
    const lowerKeys = new Map<string, string>()
    for (const e of m.entries) {
      const low = e.k.toLowerCase()
      if (!lowerKeys.has(low)) lowerKeys.set(low, e.k)
      for (const n of new Set([titleOf(e).toLowerCase(), path.posix.basename(e.k, '.md').toLowerCase()])) {
        const list = names.get(n)
        if (list) list.push(e.k)
        else names.set(n, [e.k])
      }
    }
    namesMemo = { hash: m.hash, names, lowerKeys }
    return namesMemo
  }

  /** Name form `[[Title]]`: a note whose title or file name is the text (any folder); path form: that path. */
  function resolve(m: Manifest, target: string, srcKey: string): { status: LinkStatus; keys: string[] } {
    const base = target.split('#')[0]!.trim().replace(/\.md$/i, '')
    if (!base) return { status: 'unresolved', keys: [] }
    const memo = namesOf(m)
    if (base.includes('/')) {
      const hit = m.byKey.has(`${base}.md`) ? `${base}.md` : memo.lowerKeys.get(`${base.toLowerCase()}.md`)
      return hit ? { status: 'resolved', keys: [hit] } : { status: 'unresolved', keys: [] }
    }
    const keys = (memo.names.get(base.toLowerCase()) ?? []).filter((k) => k !== srcKey)
    return { status: keys.length === 1 ? 'resolved' : keys.length > 1 ? 'ambiguous' : 'unresolved', keys }
  }

  const idFor = (e: CopyEntry) => idOf(e) || e.k

  return {
    async tree() {
      const m = await getManifest()
      if (!treeMemo || treeMemo.hash !== m.hash) {
        const tree = treeFromKeys(m.entries.map((e) => e.k))
        treeMemo = { hash: m.hash, json: JSON.stringify({ tree }), notes: m.entries.length }
      }
      return { json: treeMemo.json, notes: treeMemo.notes }
    },

    async content(rawPath) {
      const k = noteKey(rawPath)
      if (!k) return null
      const r = await reader.read(k)
      if (!r) return null
      const updatedAt = r.m && typeof r.m.updatedAt === 'string' ? r.m.updatedAt : null
      const id = r.m && typeof r.m.id === 'string' ? r.m.id : undefined
      return { content: r.body, updatedAt, contentHash: r.h, ...(id ? { id } : {}) }
    },

    async backlinks(rawPath) {
      const k = noteKey(rawPath)
      if (!k) return { backlinks: [] }
      const m = await ensureIndex()
      const out: CopyBacklink[] = []
      for (const e of m.entries) {
        const p = parsed.get(e.k)
        if (!p || e.k === k) continue
        for (const l of p.links) {
          const r = resolve(m, l.target, e.k)
          if (!r.keys.includes(k)) continue
          out.push({
            id: idFor(e), path: e.k, title: titleOf(e), name: path.posix.basename(e.k, '.md'), snippet: l.context,
            status: r.status, ...(r.status === 'ambiguous' ? { candidates: r.keys.map((x) => idFor(m.byKey.get(x)!)) } : {}),
          })
        }
      }
      return { backlinks: out }
    },

    async links(rawPath) {
      const k = noteKey(rawPath)
      const m = await ensureIndex()
      const p = k ? parsed.get(k) : undefined
      if (!p) return { links: [] }
      return {
        links: p.links.map((l) => {
          const r = resolve(m, l.target, k!)
          const dst = r.status === 'resolved' ? m.byKey.get(r.keys[0]!) : undefined
          return { dstId: dst ? idFor(dst) : null, dstName: l.target, status: r.status, ...(dst ? { title: titleOf(dst), path: dst.k } : {}) }
        }),
      }
    },

    async list() {
      const m = await getManifest()
      return { notes: m.entries.map((e) => ({ id: idOf(e), title: titleOf(e), path: e.k, name: path.posix.basename(e.k, '.md') })) }
    },

    async tags() {
      const m = await ensureIndex()
      const counts = new Map<string, number>()
      for (const e of m.entries) for (const t of parsed.get(e.k)?.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1)
      return { tags: [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)) }
    },

    async notesForTag(raw) {
      const tag = normalizeTag(raw)
      const m = await ensureIndex()
      const rows = m.entries.filter((e) => parsed.get(e.k)?.tags.includes(tag))
      const modified = (e: CopyEntry) => (e.m && typeof e.m.updatedAt === 'string' ? e.m.updatedAt : undefined)
      rows.sort((a, b) => (modified(b) ?? '').localeCompare(modified(a) ?? ''))
      return { notes: rows.map((e) => ({ id: idOf(e), title: titleOf(e), path: e.k, snippet: (parsed.get(e.k)?.body ?? '').slice(0, 160).trim(), modified: modified(e) })) }
    },

    async search(q, limit) {
      const tokens = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 12)
      if (tokens.length === 0) return { results: [], degraded: 'offline-keyword' }
      const m = await ensureIndex()
      const phrase = q.trim().toLowerCase()
      const hits: Array<{ e: CopyEntry; matched: number; score: number; first: string; body: string }> = []
      for (const e of m.entries) {
        const body = parsed.get(e.k)?.body ?? ''
        const low = body.toLowerCase()
        const head = `${titleOf(e)}\n${e.k}`.toLowerCase()
        let matched = 0
        let score = 0
        let first = ''
        for (const t of tokens) {
          const inHead = head.includes(t)
          const inBody = low.includes(t)
          if (!inHead && !inBody) continue
          matched++
          score += (inHead ? 3 : 0) + (inBody ? 1 : 0)
          if (!first && inBody) first = t
        }
        if (matched === 0) continue
        if (titleOf(e).toLowerCase().includes(phrase)) score += 5
        else if (low.includes(phrase)) score += 2
        hits.push({ e, matched, score, first, body })
      }
      // Every word first (as the leader's string leg); else the notes with the most of them.
      const best = hits.reduce((n, h) => Math.max(n, h.matched), 0)
      const kept = hits.filter((h) => h.matched === best).sort((a, b) => b.score - a.score || a.e.k.localeCompare(b.e.k))
      return {
        degraded: 'offline-keyword',
        results: kept.slice(0, Math.max(1, Math.min(100, limit))).map((h) => {
          const flat = h.body.replace(/\s+/g, ' ')
          const at = h.first ? flat.toLowerCase().indexOf(h.first) : -1
          const snippet = at < 0 ? flat.slice(0, 180).trim() : flat.slice(Math.max(0, at - 90), at + h.first.length + 90).trim()
          return { id: idFor(h.e), path: h.e.k, title: titleOf(h.e), snippet, matchType: 'exact' as const, score: h.score }
        }),
      }
    },

    async resolve(raw) {
      const ref = raw.trim()
      if (!ref) return { status: 400, message: 'ref (note id, path, or title) is required' }
      const m = await getManifest()
      // 1. A frontmatter id: the only form that cannot also be a path.
      const byId = m.entries.find((e) => idOf(e) === ref)
      if (byId) return { id: ref, path: byId.k, title: null, matchedBy: 'id' }
      // 2. A note at that path.
      const k = noteKey(ref)
      if (!k) return { status: 400, message: 'invalid path' }
      const at = m.byKey.get(k)
      if (at) return { id: idOf(at) || null, path: at.k, title: null, matchedBy: 'path' }
      // 3. A title or file name, as [[wikilinks]] resolve (any case, any folder).
      const base = ref.replace(/\.md$/i, '').toLowerCase()
      const named = m.entries.filter((e) => titleOf(e).toLowerCase() === base || e.k.toLowerCase() === `${base}.md` || path.posix.basename(e.k, '.md').toLowerCase() === base)
      if (named.length === 1) return { id: idOf(named[0]!) || null, path: named[0]!.k, title: ref, matchedBy: 'name' }
      if (named.length > 1) {
        return { status: 409, message: `"${ref}" matches ${named.length} notes: ${named.slice(0, 5).map((e) => e.k).join(', ')}. Pass one exact path or id.` }
      }
      if (ref.startsWith('n_')) return { status: 404, message: `No note with id ${ref} in this copy of the notes` }
      return { status: 404, message: `Note not found: ${ref}` }
    },

    asOf: () => manifest?.asOf ?? null,

    async copyState() {
      const m = await getManifest()
      return { held: m.asOf !== null, off: m.off, partial: m.keep !== null, offKinds: m.offKinds ?? [], exclude: m.keep?.exclude ?? [] }
    },

    async leftOut(rawPath) {
      const k = noteKey(rawPath)
      const m = await getManifest()
      if (!k || !m.keep) return false
      const lower = k.toLowerCase()
      return leftOutBy(k, m.keep.exclude) || m.keep.tooBig.some((t) => t.toLowerCase() === lower)
    },

    forget() {
      // Kept for its asOf, never served again: the next read lists anew.
      gen++
      if (manifest) manifest = { ...manifest, at: -Infinity }
      manifestInFlight = null
    },
  }
}

/** The follower link's replica reads, for the notes kind (what a replica builds its NotesSource on). */
export function notesCopyReaderOver(request: (cmd: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>): NotesCopyReader {
  const ask = async (cmd: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const r = await request(cmd, { kind: 'notes', ...params }, 30_000)
    if (r.ok !== true && r.errorKind !== 'not_found') throw new Error(typeof r.error === 'string' ? r.error : `${cmd} failed`)
    return r
  }
  return {
    async list() {
      const r = await ask('replica.list', {})
      const keep = r.keep && typeof r.keep === 'object' ? r.keep as Partial<CopyKeep> : null
      return {
        entries: (r.entries as CopyEntry[]) ?? [], asOf: (r.asOf as string | null) ?? null, manifestHash: String(r.manifestHash ?? ''),
        off: r.off === true,
        ...(Array.isArray(r.offKinds) ? { offKinds: (r.offKinds as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
        keep: keep ? { exclude: Array.isArray(keep.exclude) ? keep.exclude.filter((x): x is string => typeof x === 'string') : [], tooBig: Array.isArray(keep.tooBig) ? keep.tooBig.filter((x): x is string => typeof x === 'string') : [] } : null,
      }
    },
    async read(key) {
      const r = await ask('replica.read', { key })
      return r.ok === true ? { k: String(r.k), h: String(r.h), ...(r.m ? { m: r.m as Record<string, unknown> } : {}), body: String(r.body) } : null
    },
    async readMany(keys) {
      const r = await ask('replica.readMany', { keys })
      return { files: (r.files as Array<{ k: string; h: string; body: string }>) ?? [], missing: (r.missing as string[]) ?? [], more: (r.more as string[]) ?? [] }
    },
  }
}

export interface ReplicaNotesSourceOptions {
  /** The source answers only while this holds (the companion: once its copy arrived whole). */
  active?: () => boolean
  /** False: searches go on to the server's own search (the companion keeps a copy of the Mac's index). */
  search?: boolean
  /**
   * A read of what the copy leaves out goes to the Mac while it answers (the companion, whose
   * notes reads run here whoever answers; core/companion-notes.ts). `here` answers from this
   * copy (the Mac did not take it). A host replica has none: its dispatcher forwards first.
   */
  forward?: (req: import('express').Request, res: import('express').Response, here: () => void) => void
}

let replicaSource: NotesSource | null = null
let sourceOpts: ReplicaNotesSourceOptions = {}

/**
 * A replica's boot: its notes read from a copy. A host replica's is the daemon's copy;
 * the companion's is its own (core/companion-notes.ts), active once it is held.
 */
export function installReplicaNotesSource(source: NotesSource | null, opts: ReplicaNotesSourceOptions = {}): void {
  replicaSource = source
  sourceOpts = source ? opts : {}
}

/** The copy source a replica's notes reads take now, else null (the Mac reads its disk vault). */
export function replicaNotesSource(): NotesSource | null {
  if (!replicaSource) return null
  if (sourceOpts.active && !sourceOpts.active()) return null
  return replicaSource
}

/** Whether the source answers searches (a host replica's does; the companion's leaves them to its own search). */
export function replicaNotesSourceSearches(): boolean {
  return sourceOpts.search !== false
}

/** How a read of what the copy leaves out reaches the Mac (the companion's forward), or null. */
export function replicaNotesForward(): ReplicaNotesSourceOptions['forward'] | null {
  return sourceOpts.forward ?? null
}
