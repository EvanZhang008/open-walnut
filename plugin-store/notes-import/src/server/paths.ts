/**
 * Where each imported item lives in the vault.
 *
 * A page with sub-pages (and every database) is a folder holding a note of the same name:
 * `Parent/Parent.md`, its children beside it in `Parent/`. A page without sub-pages is a plain
 * note. Two siblings with the same title get " (2)", " (3)" by creation order. A note that was
 * imported before keeps the path it has now (found by its `notion_id`, wherever the person or an
 * organize run moved it), and its new children go next to it.
 */
import type { SourceItem } from './types'

const MAX_NAME = 120
// File systems cap a name at 255 bytes; leave room for " (12)", ".md" and an attachment suffix.
const MAX_NAME_BYTES = 180
const encoder = new TextEncoder()

/** A title as a file or folder name: no path separators, nothing a wiki link cannot hold. */
export function safeName(title: string, fallback = 'Untitled'): string {
  let name = String(title ?? '')
    .replace(/[\\/]/g, ' - ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[[\]|#^<>:"*?]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
  if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME).trim()
  while (encoder.encode(name).length > MAX_NAME_BYTES) name = Array.from(name).slice(0, -1).join('').trim()
  return name || fallback
}

/** A folder the person typed: each segment made safe, empty segments dropped. */
export function safeFolder(folder: string): string {
  return String(folder ?? '')
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => safeName(part, ''))
    .filter(Boolean)
    .join('/')
}

/**
 * `folder` spelled as a folder the notes already have, part by part (`projects/new` is
 * `Projects/new` beside `Projects`): a Mac's disk takes the two spellings for one folder.
 */
export function matchCase(folder: string, existing: Iterable<string>): string {
  const byLower = new Map<string, string>()
  for (const f of existing) if (!byLower.has(f.toLowerCase())) byLower.set(f.toLowerCase(), f)
  const parts = folder.split('/')
  let out = ''
  for (const part of parts) {
    const next = out ? `${out}/${part}` : part
    const found = byLower.get(next.toLowerCase())
    out = found ?? next
  }
  return out
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

export function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.endsWith('.md') ? base.slice(0, -3) : base
}

/** The folder an item's children go into. */
export function containerOf(notePath: string): string {
  const dir = dirOf(notePath)
  const stem = stemOf(notePath)
  // A folder note (`P/P.md`) holds its children in its own folder; a plain note gets one.
  if (dir.slice(dir.lastIndexOf('/') + 1) === stem) return dir
  return dir ? `${dir}/${stem}` : stem
}

export class PathPlanner {
  /** Lower-cased taken names per folder ("folder/name"), notes and folders alike. */
  private taken = new Set<string>()
  /** Notes already in the folder (lower-cased), so an adopted folder never takes one's place. */
  private files = new Set<string>()
  readonly paths = new Map<string, string>()

  constructor(
    private readonly root: string,
    /** Where already-imported items are now, by item id. */
    private readonly existing: Map<string, string>,
    /** Every path already in the target folder, so a new note never lands on someone's note. */
    occupied: Iterable<string>,
  ) {
    for (const path of occupied) {
      this.take(path)
      if (path.endsWith('.md')) this.files.add(path.toLowerCase())
    }
    for (const [id, path] of existing) {
      this.paths.set(id, path)
      this.take(path)
    }
  }

  private take(path: string): void {
    const dir = dirOf(path)
    this.taken.add(`${dir}/${stemOf(path)}`.toLowerCase())
    // Every folder on the way is taken too, as a name in its parent.
    let current = dir
    while (current) {
      this.taken.add(`${dirOf(current)}/${stemOf(current)}`.toLowerCase())
      current = dirOf(current)
    }
  }

  private free(dir: string, name: string, ownFolder: boolean): string {
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? name : `${name} (${n})`
      const key = `${dir}/${candidate}`.toLowerCase()
      // A folder note takes the folder name; a plain note must not collide with a folder or a note.
      if (!this.taken.has(key)) {
        this.taken.add(key)
        if (ownFolder) this.taken.add(`${dir}/${candidate}/${candidate}`.toLowerCase())
        return candidate
      }
    }
  }

  /** Plan every item, parents first. `hasChildren` says which items become folder notes. */
  plan(items: SourceItem[], hasChildren: Set<string>): void {
    const byId = new Map(items.map((item) => [item.id, item]))
    const children = new Map<string, string[]>()
    for (const item of items) if (item.parentId) children.set(item.parentId, [...(children.get(item.parentId) ?? []), item.id])
    const order = [...items].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id))
    const visiting = new Set<string>()
    const visit = (item: SourceItem): string => {
      const known = this.paths.get(item.id)
      if (known) return known
      if (visiting.has(item.id)) return this.place(item, this.root, hasChildren)
      visiting.add(item.id)
      // A page whose sub-pages an earlier, stopped run already wrote goes back into their folder.
      const adopted = this.adopt(item, children.get(item.id))
      if (adopted) { visiting.delete(item.id); return adopted }
      const parent = item.parentId ? byId.get(item.parentId) : undefined
      const parentPath = parent ? visit(parent) : this.paths.get(item.parentId ?? '')
      const dir = parentPath ? containerOf(parentPath) : this.root
      visiting.delete(item.id)
      return this.place(item, dir, hasChildren)
    }
    for (const item of order) visit(item)
  }

  /**
   * The folder note for `item` in the folder its already-imported sub-pages are in
   * (`Home/Child A.md` or `Home/Child A/Child A.md` → `Home/Home.md`), when that folder is inside
   * the import and no note holds that place yet.
   */
  private adopt(item: SourceItem, childIds: string[] | undefined): string | null {
    for (const id of childIds ?? []) {
      const childPath = this.existing.get(id)
      if (!childPath) continue
      const slot = containerOf(childPath) === dirOf(childPath) ? dirOf(childPath) : childPath.replace(/\.md$/, '')
      const container = dirOf(slot)
      if (!container || !container.startsWith(`${this.root}/`)) continue
      const path = `${container}/${stemOf(container)}.md`
      if (this.files.has(path.toLowerCase())) continue
      this.paths.set(item.id, path)
      this.take(path)
      return path
    }
    return null
  }

  /** One item found mid-run, under a parent already planned. */
  planOne(item: SourceItem): string {
    const known = this.paths.get(item.id)
    if (known) return known
    const parentPath = item.parentId ? this.paths.get(item.parentId) : undefined
    return this.place(item, parentPath ? containerOf(parentPath) : this.root, new Set(item.kind === 'database' ? [item.id] : []))
  }

  /**
   * Turn a plain note planned this run into a folder note (`dir/Name.md` → `dir/Name/Name.md`),
   * once rendering found sub-pages discovery missed. Its children already go into `dir/Name/`.
   * Answers the new path, or null when it is a folder note already.
   */
  promote(id: string): string | null {
    const path = this.paths.get(id)
    if (!path) return null
    const dir = dirOf(path)
    const stem = stemOf(path)
    if (dir.slice(dir.lastIndexOf('/') + 1) === stem) return null
    const next = `${dir ? `${dir}/` : ''}${stem}/${stem}.md`
    this.taken.add(`${dir ? `${dir}/` : ''}${stem}/${stem}`.toLowerCase())
    this.paths.set(id, next)
    return next
  }

  /**
   * A new note's path turned out taken when it was written (a note made there meanwhile, one the
   * folder listing missed): the item gets the next free name beside it. Answers the new path.
   */
  replan(item: SourceItem): string {
    const was = this.paths.get(item.id)
    if (!was) return this.planOne(item)
    this.take(was)
    this.files.add(was.toLowerCase())
    const dir = dirOf(was)
    const name = this.free(dir, safeName(item.title, item.kind === 'database' ? 'Untitled database' : 'Untitled'), false)
    const path = `${dir ? `${dir}/` : ''}${name}.md`
    this.paths.set(item.id, path)
    return path
  }

  private place(item: SourceItem, dir: string, hasChildren: Set<string>): string {
    const ownFolder = item.kind === 'database' || hasChildren.has(item.id)
    const name = this.free(dir, safeName(item.title, item.kind === 'database' ? 'Untitled database' : 'Untitled'), ownFolder)
    const prefix = dir ? `${dir}/` : ''
    const path = ownFolder ? `${prefix}${name}/${name}.md` : `${prefix}${name}.md`
    this.paths.set(item.id, path)
    return path
  }
}
