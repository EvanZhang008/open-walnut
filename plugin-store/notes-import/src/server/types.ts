/**
 * The import framework's shapes. A source (Notion first; a folder of Markdown, Apple Notes or
 * Google Docs later) only lists what it has and turns one item into Markdown. Everything else
 * (where each note goes, what changed since the last run, attachments, links between notes,
 * progress, the undo journal) is the importer's, the same for every source.
 */

export interface SourceItem {
  /** The source's own id, stable across runs: what a re-import matches a note by. */
  id: string
  kind: 'page' | 'database'
  title: string
  /** Another item's id, or null for an item whose parent was not shared (a root). */
  parentId: string | null
  /** Changes whenever the item's own content does; equal values mean nothing to fetch. */
  editedAt: string
  createdAt?: string
  /** Where it lives in the source, for the note's frontmatter and links back. */
  url?: string
}

export interface RenderContext {
  /** Markdown for a link to another item: a note link when it is imported, else a link to the source. */
  linkTo(id: string, title: string): string
  /** Download a file into the note's `_attachment` folder; the vault path, or null when it cannot be kept. */
  saveAttachment(input: { url: string; name: string; key: string }): Promise<string | null>
  /** An item the source found while rendering (a sub-page) that discovery missed. */
  discovered(item: SourceItem): void
  warn(message: string): void
  signal: AbortSignal
}

export interface RenderedNote {
  /** The Markdown body, without frontmatter. */
  body: string
  /** Shown as a two-column table above the body (a database row's properties). */
  properties?: Array<[string, string]>
}

export interface SourceAccount {
  workspace: string
  user: string
}

export interface NoteSource {
  id: string
  label: string
  /** Every item the connection can see, parents before children where the source knows them. */
  discover(signal: AbortSignal, onCount: (count: number) => void): Promise<SourceItem[]>
  render(item: SourceItem, context: RenderContext): Promise<RenderedNote>
  /** One item by id, for one imported before that discovery did not list; null when it is gone or not shared. */
  lookup?(id: string, signal: AbortSignal): Promise<SourceItem | null>
}

export class SourceAuthError extends Error {
  readonly code = 'source_auth'
}
