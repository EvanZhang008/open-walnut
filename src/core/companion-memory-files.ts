/**
 * The rest of the memory dir on the cloud companion (stage 4d of
 * docs/plan/walnut-companion-unified-replica.md): daily logs, projects, sessions,
 * knowledge, topics, compaction snapshots, agents, working memory and the repo
 * memories, read from the Mac's copy (companion-host-replica.ts, kind `memory`, the
 * entries core/host-replica-extras.ts adds for every replica), never from the box's
 * git-written disk. MEMORY.md and USER.md are the copy's two docs (companion-memory.ts).
 *
 * The readers keep the disk functions' shapes (core/memory.ts getMemory and
 * listMemories, web/routes/memory.ts buildMemoryBrowseTree, the session summaries). A
 * copy without the whole dir (no whole manifest yet, or an older Mac that sends the two
 * docs only) answers needs-the-Mac.
 *
 * Cloud companion only.
 */

import path from 'node:path'
import { COMPANION_REPLICA_HOME, companionCopyHolds, companionHostReplica } from './companion-host-replica.js'
import { companionMemoryDoc } from './companion-memory.js'
import { followerKind } from './server-role.js'
import type { MemoryEntry } from './memory.js'

/** Kept in step with core/host-replica-extras.ts MEMORY_FILES_MARKER (the Mac's side). */
const MARKER = 'files.v1'

interface Row { rel: string; updatedAt: string; createdAt: string }

/** `copy` when the box reads the whole memory dir from its copy, `needs-mac` when it cannot, null off the companion. */
export function companionMemoryFiles(): 'copy' | 'needs-mac' | null {
  if (followerKind() !== 'companion') return null
  const r = companionHostReplica()
  if (!r || !companionCopyHolds('memory') || !r.read(COMPANION_REPLICA_HOME, 'memory', MARKER)) return 'needs-mac'
  return 'copy'
}

/** Every file of the copy under `prefix` (a path under memory/, '' for all), metadata only. */
function rows(prefix: string, kind: 'f' | 'r' = 'f'): Row[] {
  const list = companionHostReplica()?.list(COMPANION_REPLICA_HOME, 'memory')
  const head = `${kind}/${prefix}`
  const out: Row[] = []
  for (const e of list?.entries ?? []) {
    if (!e.k.startsWith(head)) continue
    const m = e.m ?? {}
    out.push({ rel: e.k.slice(2), updatedAt: typeof m.updatedAt === 'string' ? m.updatedAt : '', createdAt: typeof m.createdAt === 'string' ? m.createdAt : '' })
  }
  return out
}

function body(key: string): string | null {
  return companionHostReplica()?.read(COMPANION_REPLICA_HOME, 'memory', key)?.body ?? null
}

/** core/memory.ts extractTitle and resolveCategory, the same rules. */
function titleOf(content: string, file: string): string {
  const m = content.match(/^#\s+(.+)$/m)
  return m ? m[1]!.trim() : file.replace(/\.md$/, '')
}
function categoryOf(rel: string): MemoryEntry['category'] {
  if (rel.startsWith('sessions/')) return 'session'
  if (rel.startsWith('projects/')) return 'project'
  return 'knowledge'
}

/** One memory file as core/memory.ts getMemory answers it, or null. MEMORY.md and USER.md are the two docs. */
export function copyMemoryEntry(rel: string): MemoryEntry | null {
  const clean = rel.split('\\').join('/').replace(/^\/+/, '')
  if (clean === 'MEMORY.md' || clean === 'USER.md') {
    const d = companionMemoryDoc(clean === 'MEMORY.md' ? 'global' : 'user')
    return d ? { path: clean, title: titleOf(d.content, clean), category: 'knowledge', content: d.content, createdAt: d.createdAt, updatedAt: d.updatedAt } : null
  }
  const r = companionHostReplica()?.read(COMPANION_REPLICA_HOME, 'memory', `f/${clean}`)
  if (!r) return null
  const m = r.m ?? {}
  return {
    path: clean, title: titleOf(r.body, path.posix.basename(clean)), category: categoryOf(clean), content: r.body,
    createdAt: typeof m.createdAt === 'string' ? m.createdAt : '', updatedAt: typeof m.updatedAt === 'string' ? m.updatedAt : '',
  }
}

/** core/memory.ts listMemories over the copy (sessions, projects, knowledge, or one of them). */
export function copyListMemories(category?: string): MemoryEntry[] {
  const dirs: Record<string, string> = { session: 'sessions/', project: 'projects/', knowledge: 'knowledge/' }
  const wanted = category ? (dirs[category] ? [dirs[category]!] : []) : ['sessions/', 'projects/', 'knowledge/']
  const out: MemoryEntry[] = []
  for (const prefix of wanted) {
    for (const r of rows(prefix)) {
      if (!r.rel.endsWith('.md')) continue
      const e = copyMemoryEntry(r.rel)
      if (e) out.push(e)
    }
  }
  return out
}

interface BrowseItem { path: string; title: string; updatedAt: string }

/** web/routes/memory.ts buildMemoryBrowseTree over the copy: the same sections, the same order. */
export function copyMemoryBrowseTree(): {
  global: BrowseItem | null; user: BrowseItem | null; daily: Array<BrowseItem & { date: string }>
  projects: BrowseItem[]; sessions: BrowseItem[]; knowledge: BrowseItem[]; repos: BrowseItem[]
  topics: BrowseItem[]; compaction: BrowseItem[]; special: BrowseItem[]
} {
  const g = companionMemoryDoc('global')
  const u = companionMemoryDoc('user')
  const direct = (prefix: string) => rows(prefix).filter((r) => r.rel.endsWith('.md') && !r.rel.slice(prefix.length).includes('/'))
  const daily = direct('daily/').sort((a, b) => b.rel.localeCompare(a.rel)).map((r) => {
    const date = path.posix.basename(r.rel).replace(/\.md$/, '')
    return { path: r.rel, title: date, date, updatedAt: r.updatedAt }
  })
  const listed = (category: string) => copyListMemories(category).map((e) => ({ path: e.path, title: e.title, updatedAt: e.updatedAt }))
  const sessions = listed('session').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const repos = rows('', 'r').map((r) => ({ path: `repos/${r.rel}/SKILL.md`, title: r.rel, updatedAt: r.updatedAt }))
  const topics = direct('topics/').map((r) => ({ path: r.rel, title: path.posix.basename(r.rel).replace(/\.md$/, ''), updatedAt: r.updatedAt }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const compaction = direct('compaction/').sort((a, b) => b.rel.localeCompare(a.rel))
    .map((r) => ({ path: r.rel, title: path.posix.basename(r.rel).replace(/\.md$/, ''), updatedAt: r.updatedAt }))
  const special: BrowseItem[] = []
  for (const name of ['working-memory.md', 'index.md']) {
    const r = rows(name).find((x) => x.rel === name)
    if (r) special.push({ path: name, title: name === 'working-memory.md' ? 'Working Memory' : 'Memory Index', updatedAt: r.updatedAt })
  }
  return {
    global: g ? { path: 'MEMORY.md', title: 'Global Memory', updatedAt: g.updatedAt } : null,
    user: u ? { path: 'USER.md', title: 'User Profile', updatedAt: u.updatedAt } : null,
    daily, projects: listed('project'), sessions, knowledge: listed('knowledge'), repos, topics, compaction, special,
  }
}

/** The newest `limit` session summary files (memory/sessions/*.md, by name), with their text. */
export function copySessionSummaryFiles(limit: number): Array<{ file: string; content: string }> {
  const files = rows('sessions/').filter((r) => r.rel.endsWith('.md') && !r.rel.slice('sessions/'.length).includes('/'))
    .map((r) => r.rel).sort().reverse().slice(0, limit)
  const out: Array<{ file: string; content: string }> = []
  for (const rel of files) {
    const content = body(`f/${rel}`)
    if (content !== null) out.push({ file: path.posix.basename(rel), content })
  }
  return out
}
