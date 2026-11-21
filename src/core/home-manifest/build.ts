/** Short constructors for manifest entries, so each entry stays one line. */
import type { DataClass, DataKind, HomeEntry, OutsideEntry, OutsideRoot } from './types.js'

export interface EntryOptions {
  sensitive?: boolean
  match?: RegExp
  listsChildren?: true
  legacy?: true
}

function homeAt(cls: DataClass) {
  return (id: string, path: string, kind: DataKind, what: string, o: EntryOptions = {}): HomeEntry => ({
    id, path, kind, class: cls, sensitive: o.sensitive === true, what,
    ...(o.match ? { match: o.match } : {}),
    ...(o.listsChildren ? { listsChildren: true as const } : {}),
    ...(o.legacy ? { legacy: true as const } : {}),
  })
}

/** Moves with the leader. */
export const lead = homeAt('leader-data')
/** Stays on this machine. */
export const mach = homeAt('machine')
/** Derived or disposable: never copied. */
export const rebuild = homeAt('rebuildable')

export function outside(
  cls: DataClass, root: OutsideRoot, id: string, path: string, kind: DataKind, what: string, o: { sensitive?: boolean; match?: RegExp } = {},
): OutsideEntry {
  return { id, root, path, kind, class: cls, sensitive: o.sensitive === true, what, ...(o.match ? { match: o.match } : {}) }
}
