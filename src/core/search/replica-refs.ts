/**
 * The search index copy's doc keys (core/replication/search-replica*.ts).
 *
 * A file kind's ref is an absolute path on the box that indexed it, and the
 * companion keeps the same files under another data home (git-sync). So a key
 * names a file by its place under the data home (`note:~/notes/a.md`), and
 * each side maps that to its own absolute path. Task and session refs are ids,
 * the same on every box. A file outside the data home has no place on the
 * other box and is not copied.
 */

import path from 'node:path'

const FILE_KINDS = new Set(['memory', 'note', 'skill'])

export function replicaKey(kind: string, ref: string, home: string): string | null {
  if (!kind || kind.includes(':') || !ref) return null
  if (!FILE_KINDS.has(kind)) return `${kind}:${ref}`
  const rel = path.relative(home, ref)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return `${kind}:~/${rel.split(path.sep).join('/')}`
}

export function refOfReplicaKey(key: string, home: string): { kind: string; ref: string } | null {
  const at = key.indexOf(':')
  if (at <= 0) return null
  const kind = key.slice(0, at)
  const rest = key.slice(at + 1)
  if (!rest) return null
  if (!FILE_KINDS.has(kind)) return { kind, ref: rest }
  if (!rest.startsWith('~/')) return null
  const parts = rest.slice(2).split('/')
  if (parts.some((p) => !p || p === '.' || p === '..')) return null
  return { kind, ref: path.join(home, ...parts) }
}
