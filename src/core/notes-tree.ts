/**
 * The notes vault tree (`GET /api/notes-v2`), built once and kept warm.
 *
 * The tree is a pure function of every directory's LISTING under NOTES_DIR, so
 * two facts drive this module:
 *
 * 1. A directory's mtime changes exactly when an entry is added, removed or
 *    renamed in it, and never when a file's bytes change. Checking whether a
 *    cached tree is still current is therefore one `stat` per directory, all
 *    in parallel, instead of a full re-walk. Typing into a note never rebuilds.
 *
 * 2. The walk is parallel: every directory's `readdir` + `stat` is issued at
 *    once, so a build costs about `depth` event-loop rounds rather than one per
 *    directory. The old sequential walk paid one round trip through a busy event
 *    loop for each of ~300 directories, which turned a 50 ms scan into 4.5 s
 *    when the server was loaded (2026-09-24, "clicking a note takes 10 s").
 *
 * Mutating routes call `invalidateNotesTree()` so their own follow-up read is
 * never served from a snapshot taken before the write; the vault watcher does
 * the same for changes made by other programs (Obsidian, git-sync, agents). Each
 * invalidation also re-warms the cache shortly after, so the next click finds it
 * ready. `scheduleNotesTreeWarmup()` builds the first snapshot a little while
 * after boot, off the startup burst.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { NOTES_DIR } from '../constants.js'
import { log } from '../logging/index.js'

export interface TreeNode {
  name: string
  path: string       // relative to NOTES_DIR, forward slashes
  type: 'file' | 'folder'
  // 'note' = markdown (default; open in editor). 'attachment' = image/pdf
  // (preview via /attachment, never markdown-load). Absent on folders.
  kind?: 'note' | 'attachment'
  children?: TreeNode[]
}

// Attachment file types surfaced in the tree (Obsidian _attachment folders hold
// these). `kind: 'attachment'` lets the FE preview them via /attachment instead of
// loading them as markdown. Match case-insensitively (real vaults have `.PDF`).
// Office docs are listed (not rendered): clicking opens them in the local app
// (Word/Excel) via /reveal, or downloads through /attachment as a fallback.
export const ATTACHMENT_EXTS = new Set([
  // heic/heif: what an iPhone camera actually writes. Excluding them meant
  // every photo imported straight off a phone answered 400 "File type not
  // allowed" and rendered as a broken embed.
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'pdf',
  'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt',
])

export function isAttachmentFile(name: string): boolean {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return name.includes('.') && ATTACHMENT_EXTS.has(ext)
}

export interface NotesTreeSnapshot {
  tree: TreeNode[]
  /** `JSON.stringify({ tree })`, serialized once per build. */
  json: string
  /** Every directory the walk visited (absolute path) → its mtime at scan time. */
  dirs: Map<string, number>
  builtAt: number
  buildMs: number
}

/** How long after the last invalidation the cache re-warms itself. Coalesces bursts. */
export const REWARM_DEBOUNCE_MS = 500
/** Default delay for the boot-time warmup: after the startup burst, before the first click. */
export const WARMUP_DELAY_MS = 20_000

let snapshot: NotesTreeSnapshot | null = null
let buildInFlight: Promise<NotesTreeSnapshot> | null = null
let validateInFlight: Promise<NotesTreeSnapshot> | null = null
let rewarmTimer: ReturnType<typeof setTimeout> | null = null
let warmupTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Walk one directory: its listing and its mtime are read together, then every
 * child directory is walked concurrently. `dirs` collects the mtimes that
 * `isCurrent()` later re-checks.
 */
async function walk(dirPath: string, relBase: string, dirs: Map<string, number>): Promise<TreeNode[]> {
  let entries: import('fs').Dirent[]
  let mtimeMs: number
  try {
    const [list, stat] = await Promise.all([
      fsp.readdir(dirPath, { withFileTypes: true }),
      fsp.stat(dirPath),
    ])
    entries = list
    mtimeMs = stat.mtimeMs
  } catch (err: any) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  dirs.set(dirPath, mtimeMs)

  // Sort: folders first, then alphabetical
  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1
    if (!a.isDirectory() && b.isDirectory()) return 1
    return a.name.localeCompare(b.name)
  })

  const nodes = await Promise.all(entries.map(async (entry): Promise<TreeNode | null> => {
    if (entry.name.startsWith('.')) return null // skip hidden files
    if (entry.name.startsWith('~$')) return null // Office owner/lock temp files
    const relPath = relBase ? `${relBase}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      const children = await walk(path.join(dirPath, entry.name), relPath, dirs)
      return { name: entry.name, path: relPath, type: 'folder', children }
    }
    if (entry.name.endsWith('.md')) {
      return { name: entry.name, path: relPath, type: 'file', kind: 'note' }
    }
    if (isAttachmentFile(entry.name)) {
      // Attachments (images/pdf) — shown with their own icon; clicking previews.
      return { name: entry.name, path: relPath, type: 'file', kind: 'attachment' }
    }
    return null
  }))
  return nodes.filter((n): n is TreeNode => n !== null)
}

function countNotes(nodes: TreeNode[]): number {
  let n = 0
  for (const node of nodes) {
    if (node.type === 'folder') n += countNotes(node.children ?? [])
    else if (node.kind !== 'attachment') n++
  }
  return n
}

/** Uncached parallel walk of an arbitrary directory (the raw scan, no snapshot). */
export async function scanTree(dirPath: string, relBase: string): Promise<TreeNode[]> {
  return walk(dirPath, relBase, new Map())
}

/**
 * True when no directory the snapshot saw has changed its listing since. One
 * parallel `stat` per directory; a vanished directory counts as changed. A
 * snapshot that saw no directory at all (the vault root was missing) is never
 * current: the root may exist now.
 */
async function isCurrent(snap: NotesTreeSnapshot): Promise<boolean> {
  if (snap.dirs.size === 0) return false
  const checks = await Promise.all([...snap.dirs].map(async ([dir, mtimeMs]) => {
    try {
      return (await fsp.stat(dir)).mtimeMs === mtimeMs
    } catch {
      return false
    }
  }))
  return checks.every(Boolean)
}

function build(reason: string): Promise<NotesTreeSnapshot> {
  if (buildInFlight) return buildInFlight
  const startedAt = Date.now()
  buildInFlight = (async () => {
    const dirs = new Map<string, number>()
    const tree = await walk(NOTES_DIR, '', dirs)
    const snap: NotesTreeSnapshot = {
      tree,
      json: JSON.stringify({ tree }),
      dirs,
      builtAt: Date.now(),
      buildMs: Date.now() - startedAt,
    }
    snapshot = snap
    // The boot warmup is logged at info (one line per start) so ops can see the
    // first click was served warm; the routine rebuilds stay at debug.
    const entry = { reason, dirs: dirs.size, notes: countNotes(tree), ms: snap.buildMs }
    if (reason === 'warmup') log.memory.info('notes-tree: warmed', entry)
    else log.memory.debug('notes-tree: built', entry)
    return snap
  })().finally(() => {
    buildInFlight = null
  })
  return buildInFlight
}

/**
 * The current vault tree. Served from the snapshot when every directory's mtime
 * still matches; rebuilt otherwise. Concurrent callers share one build and one
 * validation.
 */
export async function getNotesTree(): Promise<NotesTreeSnapshot> {
  if (buildInFlight) return buildInFlight
  const snap = snapshot
  if (!snap) return build('cold')
  if (!validateInFlight) {
    validateInFlight = (async () => {
      if (await isCurrent(snap) && snapshot === snap) return snap
      return build('stale')
    })().finally(() => {
      validateInFlight = null
    })
  }
  return validateInFlight
}

/** The snapshot as it stands, without touching the disk (null before the first build). */
export function peekNotesTree(): NotesTreeSnapshot | null {
  return snapshot
}

/**
 * Drop the snapshot after a change to the vault's shape (a note created, deleted
 * or moved, a folder made, an attachment saved) and re-warm it shortly after,
 * so a click that follows finds the tree ready. Bursts coalesce into one build.
 */
export function invalidateNotesTree(): void {
  snapshot = null
  if (rewarmTimer) clearTimeout(rewarmTimer)
  rewarmTimer = setTimeout(() => {
    rewarmTimer = null
    if (snapshot || buildInFlight) return
    void build('rewarm').catch((err) => {
      log.memory.debug('notes-tree: rewarm failed', { error: err instanceof Error ? err.message : String(err) })
    })
  }, REWARM_DEBOUNCE_MS)
  rewarmTimer.unref?.()
}

/**
 * Build the first snapshot `delayMs` after boot: late enough to stay out of the
 * startup burst, early enough that the first click on a note is served warm.
 * Returns a cancel function for shutdown.
 */
export function scheduleNotesTreeWarmup(delayMs: number = WARMUP_DELAY_MS): () => void {
  if (warmupTimer) clearTimeout(warmupTimer)
  const timer = setTimeout(() => {
    if (warmupTimer === timer) warmupTimer = null
    if (snapshot || buildInFlight) return
    void build('warmup').catch((err) => {
      log.memory.debug('notes-tree: warmup failed', { error: err instanceof Error ? err.message : String(err) })
    })
  }, delayMs)
  timer.unref?.()
  warmupTimer = timer
  return () => {
    clearTimeout(timer)
    if (warmupTimer === timer) warmupTimer = null
  }
}

/** Forget everything, including pending timers. Tests and server shutdown. */
export function resetNotesTreeCache(): void {
  snapshot = null
  if (rewarmTimer) { clearTimeout(rewarmTimer); rewarmTimer = null }
  if (warmupTimer) { clearTimeout(warmupTimer); warmupTimer = null }
}
