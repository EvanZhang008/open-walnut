/**
 * The data-location manifest: every place the server keeps state, in WALNUT_HOME and
 * outside it, with its class (types.ts). It is the one list a standby copy of the
 * leader will follow; today only tests and docs/reference/data-locations.md read it.
 *
 * Unknown top-level names in WALNUT_HOME count as `leader-data`. The home is also the
 * user's notes vault, so folders and files the user made sit beside Walnut's own, and
 * losing one of the user's notes is worse than copying something extra. That default
 * is no excuse for the code: the source ratchet and the real-server test
 * (tests/core/home-manifest/) fail on any path Walnut itself writes that no entry names.
 *
 * Pure: no I/O, no import of constants.ts.
 */
import { TOP_LEVEL_ENTRIES } from './home-entries.js'
import { ANY_DEPTH_ENTRIES, NESTED_ENTRIES } from './home-nested-entries.js'
import { OUTSIDE_ENTRIES } from './outside-entries.js'
import type { DataClass, DataEntry, HomeEntry, OutsideEntry, OutsideRoot } from './types.js'

export type { DataClass, DataEntry, DataKind, HomeEntry, OutsideEntry, OutsideRoot } from './types.js'

/** The class of a top-level name no entry knows (see the header). */
export const UNKNOWN_HOME_PATH_CLASS: DataClass = 'leader-data'

const HOME_ENTRIES: readonly HomeEntry[] = [...TOP_LEVEL_ENTRIES, ...NESTED_ENTRIES, ...ANY_DEPTH_ENTRIES]

/** Every entry under WALNUT_HOME. */
export function homeEntries(): readonly HomeEntry[] {
  return HOME_ENTRIES
}

/** Every entry outside WALNUT_HOME. */
export function outsideHomeEntries(): readonly OutsideEntry[] {
  return OUTSIDE_ENTRIES
}

const SQLITE_SIBLINGS = ['-wal', '-shm', '-journal']
/**
 * A copy beside a file (an ad-hoc `.backup-<time>`, a write temp `.tmp-<pid>`, a
 * forensic `.corrupt-<time>`, a `.bak.<n>` snapshot) is classed like the file it copies.
 */
const COPY_SUFFIX = /\.(bak|backup|tmp|conflicted|corrupt|unreadable|migrated)([.-][^/]*)?$/

function normalize(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+|\/+$/g, '')
}

/** How well `entry` names `rel`: -1 for not at all; a pattern beats any path, a longer path beats a shorter. */
function score(entry: DataEntry, rel: string): number {
  if (entry.match?.test(rel)) return 1_000_000 + entry.path.length
  if (entry.path === '') return entry.kind === 'dir' && !entry.match ? 0 : -1
  if (rel === entry.path) return entry.path.length + 0.5
  if (entry.kind === 'sqlite' && SQLITE_SIBLINGS.some((s) => rel === entry.path + s)) return entry.path.length + 0.5
  if (entry.kind === 'dir' && rel.startsWith(`${entry.path}/`)) return entry.path.length
  return -1
}

function best<T extends DataEntry>(entries: readonly T[], rel: string): T | undefined {
  let found: T | undefined
  let top = -1
  for (const entry of entries) {
    const s = score(entry, rel)
    if (s > top) { top = s; found = entry }
  }
  return found
}

/** Covers `rel` only as the fallback of a mixed dir (cache/, local/, sync/, tmp/). */
const fallbackOnly = (entry: DataEntry, rel: string) => 'listsChildren' in entry && entry.listsChildren === true && entry.path !== rel

function classifyIn<T extends DataEntry>(entries: readonly T[], raw: string): T | undefined {
  const rel = normalize(raw)
  if (!rel) return undefined
  const direct = best(entries, rel)
  if ((!direct || fallbackOnly(direct, rel)) && COPY_SUFFIX.test(rel)) {
    const original = rel.replace(COPY_SUFFIX, '')
    const copied = classifyIn(entries, original)
    if (copied && !fallbackOnly(copied, original)) return copied
  }
  return direct
}

/**
 * The entry that classifies `relPath` (relative to WALNUT_HOME), or undefined for a
 * top-level name no entry knows. Longest path wins; a file under a classified dir
 * inherits it unless a more specific entry exists; a pattern entry (lock files, write
 * temps) wins over the dir it sits in; a sqlite entry owns its -wal/-shm/-journal
 * siblings; a copy (`.bak`, `.backup-<time>`, `.tmp-<pid>`) is classed like its original.
 */
export function classifyHomePath(relPath: string): HomeEntry | undefined {
  return classifyIn(HOME_ENTRIES, relPath)
}

/** The class of `relPath`, with the unknown default for a name no entry knows. */
export function homePathClass(relPath: string): DataClass {
  return classifyHomePath(relPath)?.class ?? UNKNOWN_HOME_PATH_CLASS
}

/**
 * True when no entry names `relPath` itself: it gets the unknown default, or only a mixed
 * dir's fallback. Walnut's own paths must never be unnamed (the source ratchet and the
 * real-server test in tests/ use this one rule).
 */
export function isUnnamedHomePath(relPath: string): boolean {
  const rel = normalize(relPath)
  const entry = classifyHomePath(rel)
  return !entry || fallbackOnly(entry, rel)
}

/** The entry that classifies `relPath` under an outside root, or undefined. */
export function classifyOutsidePath(root: OutsideRoot, relPath: string): OutsideEntry | undefined {
  const rel = normalize(relPath)
  const entries = OUTSIDE_ENTRIES.filter((e) => e.root === root)
  return rel ? classifyIn(entries, rel) : entries.find((e) => e.path === '' && !e.match)
}

export interface OutsideRootContext {
  env: Record<string, string | undefined>
  /** The account's home dir. */
  userHome: string
  /** The runtime dir (LOG_DIR). */
  daemonDir: string
  /** The engine's home (CLAUDE_HOME). */
  claudeHome: string
}

/** Where an outside root is on this machine (pure: the caller hands in the facts). */
function outsideRootDir(root: OutsideRoot, ctx: OutsideRootContext): string {
  const join = (...parts: string[]) => parts.join('/').replace(/\/+/g, '/')
  switch (root) {
    case 'xdg-state': {
      const xdg = ctx.env.XDG_STATE_HOME
      return xdg && xdg.startsWith('/') ? xdg : join(ctx.userHome, '.local', 'state')
    }
    case 'xdg-data': return join(ctx.userHome, '.local', 'share')
    case 'claude-home': return ctx.claudeHome
    case 'daemon-dir': return ctx.daemonDir
    case 'user-home': return ctx.userHome
  }
}

/** The outside entry that classifies an absolute path, trying each root (deepest root first). */
export function classifyOutsideAbsolute(absPath: string, ctx: OutsideRootContext): OutsideEntry | undefined {
  const roots = (['xdg-state', 'xdg-data', 'claude-home', 'daemon-dir', 'user-home'] as const)
    .map((root) => ({ root, dir: outsideRootDir(root, ctx).replace(/\/+$/, '') }))
    .sort((a, b) => b.dir.length - a.dir.length)
  for (const { root, dir } of roots) {
    if (absPath !== dir && !absPath.startsWith(`${dir}/`)) continue
    const found = classifyOutsidePath(root, absPath.slice(dir.length + 1))
    if (found) return found
  }
  return undefined
}
