/**
 * Notion as an import source: discovery through search (every page and data source the
 * connection was given), rendering through the blocks API, databases as a note with a table of
 * their rows plus one note per row.
 *
 * Search can lag behind a page created a moment ago and never lists a page reached only through
 * a block it cannot see, so rendering also reports every sub-page and database row it meets that
 * discovery did not (`discovered`): the importer then brings those in too.
 */
import type { NoteSource, RenderContext, RenderedNote, SourceAccount, SourceItem } from '../types'
import { BlockRenderer, type NotionBlock } from './blocks'
import { NotionError, type NotionClient } from './client'
import { propertyToMarkdown, titleOfProperties, type NotionProperty } from './properties'
import { dashed, plainText, richTextToMarkdown, type InlineContext, type RichText } from './rich-text'

interface NotionParent {
  type?: string
  page_id?: string
  database_id?: string
  data_source_id?: string
  block_id?: string
  workspace?: boolean
}

interface NotionPage {
  object: 'page'
  id: string
  url?: string
  created_time?: string
  last_edited_time?: string
  in_trash?: boolean
  archived?: boolean
  parent?: NotionParent
  properties?: Record<string, NotionProperty>
}

interface NotionDataSource {
  object: 'data_source'
  id: string
  title?: RichText[]
  description?: RichText[]
  created_time?: string
  last_edited_time?: string
  in_trash?: boolean
  archived?: boolean
  parent?: NotionParent
  database_parent?: NotionParent
  properties?: Record<string, { name?: string; type?: string }>
}

const MAX_DEPTH = 12
/** Related pages read for their title in one render, at most. */
const MAX_RELATION_LOOKUPS = 50

function fnv(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

export function notionUrl(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, '')}`
}

export class NotionSource implements NoteSource {
  readonly id = 'notion'
  readonly label = 'Notion'
  private pages = new Map<string, NotionPage>()
  private dataSources = new Map<string, NotionDataSource[]>() // by database id
  private titles = new Map<string, string>()
  private blockParents = new Map<string, string | null>()

  constructor(private readonly client: NotionClient) {}

  async account(signal?: AbortSignal): Promise<SourceAccount> {
    const me = await this.client.request<{ name?: string; bot?: { workspace_name?: string; owner?: { user?: { name?: string } } } }>('GET', '/v1/users/me', undefined, signal)
    return { workspace: me?.bot?.workspace_name || 'your workspace', user: me?.name || 'Notion connection' }
  }

  titleOf(id: string): string | undefined {
    return this.titles.get(dashed(id))
  }

  /** The page (or database) a block sits in, walking up through nested blocks. */
  private async pageOfBlock(blockId: string, signal: AbortSignal, depth = 0): Promise<string | null> {
    const id = dashed(blockId)
    if (this.blockParents.has(id)) return this.blockParents.get(id) ?? null
    if (depth > 20) return null
    const block = await this.client.request<{ parent?: NotionParent }>('GET', `/v1/blocks/${id}`, undefined, signal)
    const parent = block?.parent
    let result: string | null = null
    if (parent?.type === 'page_id' && parent.page_id) result = dashed(parent.page_id)
    else if (parent?.type === 'database_id' && parent.database_id) result = dashed(parent.database_id)
    else if (parent?.type === 'block_id' && parent.block_id) result = await this.pageOfBlock(parent.block_id, signal, depth + 1)
    this.blockParents.set(id, result)
    return result
  }

  private async parentOf(parent: NotionParent | undefined, signal: AbortSignal): Promise<string | null> {
    if (!parent) return null
    if (parent.type === 'page_id' && parent.page_id) return dashed(parent.page_id)
    if ((parent.type === 'database_id' || parent.type === 'data_source_id') && parent.database_id) return dashed(parent.database_id)
    if (parent.type === 'data_source_id' && parent.data_source_id) {
      for (const [databaseId, sources] of this.dataSources) {
        if (sources.some((source) => dashed(source.id) === dashed(parent.data_source_id!))) return databaseId
      }
      return null
    }
    if (parent.type === 'block_id' && parent.block_id) return this.pageOfBlock(parent.block_id, signal)
    return null
  }

  private pageItem(page: NotionPage, parentId: string | null): SourceItem {
    const title = titleOfProperties(page.properties) || 'Untitled'
    return {
      id: dashed(page.id),
      kind: 'page',
      title,
      parentId,
      editedAt: page.last_edited_time ?? '',
      createdAt: page.created_time,
      url: page.url ?? notionUrl(page.id),
    }
  }

  private rowsOf(databaseId: string): NotionPage[] {
    const out: NotionPage[] = []
    for (const page of this.pages.values()) {
      const parent = page.parent
      if (!parent) continue
      const direct = parent.database_id ? dashed(parent.database_id) : null
      const viaSource = parent.data_source_id
        ? (this.dataSources.get(databaseId) ?? []).some((source) => dashed(source.id) === dashed(parent.data_source_id!))
        : false
      if (direct === databaseId || viaSource) out.push(page)
    }
    return out.sort((a, b) => (a.created_time ?? '').localeCompare(b.created_time ?? '') || a.id.localeCompare(b.id))
  }

  private databaseEdited(databaseId: string): string {
    const sources = this.dataSources.get(databaseId) ?? []
    const rows = this.rowsOf(databaseId)
    const latest = [...sources.map((s) => s.last_edited_time ?? ''), ...rows.map((r) => r.last_edited_time ?? '')].sort().pop() ?? ''
    // The table lists every row, so a row added, removed or renamed changes the database note.
    return `${latest}#${fnv(rows.map((r) => `${r.id}:${r.last_edited_time}`).join(','))}`
  }

  async discover(signal: AbortSignal, onCount: (count: number) => void): Promise<SourceItem[]> {
    this.pages.clear()
    this.dataSources.clear()
    this.titles.clear()
    const sources = await this.client.all<NotionDataSource>('POST', '/v1/search', { filter: { property: 'object', value: 'data_source' } }, signal, onCount)
    for (const source of sources) {
      if (source.in_trash || source.archived) continue
      const databaseId = source.parent?.database_id ? dashed(source.parent.database_id) : dashed(source.id)
      this.dataSources.set(databaseId, [...(this.dataSources.get(databaseId) ?? []), source])
      if (!this.titles.has(databaseId)) this.titles.set(databaseId, plainText(source.title).trim() || 'Untitled database')
    }
    const pages = await this.client.all<NotionPage>('POST', '/v1/search', { filter: { property: 'object', value: 'page' } }, signal, (n) => onCount(sources.length + n))
    for (const page of pages) {
      if (page.in_trash || page.archived) continue
      this.pages.set(dashed(page.id), page)
      this.titles.set(dashed(page.id), titleOfProperties(page.properties) || 'Untitled')
    }
    const items: SourceItem[] = []
    for (const [databaseId, list] of this.dataSources) {
      const first = list[0]
      items.push({
        id: databaseId,
        kind: 'database',
        title: this.titles.get(databaseId) ?? 'Untitled database',
        parentId: await this.parentOf(first.database_parent, signal),
        editedAt: this.databaseEdited(databaseId),
        createdAt: first.created_time,
        url: notionUrl(databaseId),
      })
    }
    for (const page of this.pages.values()) items.push(this.pageItem(page, await this.parentOf(page.parent, signal)))
    const known = new Set(items.map((item) => item.id))
    // A parent the connection cannot see makes its child a root.
    for (const item of items) if (item.parentId && !known.has(item.parentId)) item.parentId = null
    return items
  }

  async lookup(id: string, signal: AbortSignal): Promise<SourceItem | null> {
    // A database found only as a block (an inline one, or a view of another database, which a
    // search for data sources does not list) is asked for as a database: Notion answers its id on
    // the pages route with a 400 ("is a database, not a page").
    const page = await this.client.request<NotionPage>('GET', `/v1/pages/${dashed(id)}`, undefined, signal).catch((error) => {
      if (error instanceof NotionError && error.status === 400) return undefined
      throw error
    })
    if (page === undefined) return this.lookupDatabase(dashed(id), signal)
    if (!page || page.in_trash || page.archived) return null
    this.pages.set(dashed(page.id), page)
    this.titles.set(dashed(page.id), titleOfProperties(page.properties) || 'Untitled')
    return this.pageItem(page, await this.parentOf(page.parent, signal))
  }

  private async lookupDatabase(id: string, signal: AbortSignal): Promise<SourceItem | null> {
    const database = await this.client.request<{ title?: RichText[]; parent?: NotionParent; in_trash?: boolean; archived?: boolean; created_time?: string; last_edited_time?: string }>('GET', `/v1/databases/${id}`, undefined, signal)
    if (!database || database.in_trash || database.archived) return null
    const title = plainText(database.title ?? []).trim() || this.titles.get(id) || 'Untitled database'
    this.titles.set(id, title)
    return {
      id,
      kind: 'database',
      title,
      parentId: await this.parentOf(database.parent, signal),
      editedAt: database.last_edited_time ?? '',
      createdAt: database.created_time ?? '',
      url: notionUrl(id),
    }
  }

  /** A block's children, with their own children, all the way down (sub-pages are their own notes). */
  private async tree(blockId: string, signal: AbortSignal, depth = 0): Promise<NotionBlock[]> {
    const blocks = await this.client.all<NotionBlock>('GET', `/v1/blocks/${blockId}/children`, undefined, signal)
    if (depth >= MAX_DEPTH) return blocks
    await Promise.all(blocks.map(async (block) => {
      if (!block.has_children || block.type === 'child_page' || block.type === 'child_database') return
      const from = block.type === 'synced_block' ? (block.synced_block as any)?.synced_from?.block_id : null
      block.children = await this.tree(from ?? block.id, signal, depth + 1)
    }))
    return blocks
  }

  private async loadDatabase(databaseId: string, context: RenderContext): Promise<void> {
    if (this.dataSources.has(databaseId)) return
    const database = await this.client.request<{ title?: RichText[]; data_sources?: Array<{ id: string; name?: string }> }>('GET', `/v1/databases/${databaseId}`, undefined, context.signal)
    if (!database) return
    if (database.title?.length) this.titles.set(databaseId, plainText(database.title).trim())
    const list: NotionDataSource[] = []
    for (const ref of database.data_sources ?? []) {
      const source = await this.client.request<NotionDataSource>('GET', `/v1/data_sources/${ref.id}`, undefined, context.signal)
      if (!source) continue
      list.push(source)
      const rows = await this.client.all<NotionPage>('POST', `/v1/data_sources/${ref.id}/query`, {}, context.signal)
      for (const row of rows) {
        if (row.in_trash || row.archived) continue
        this.pages.set(dashed(row.id), row)
        this.titles.set(dashed(row.id), titleOfProperties(row.properties) || 'Untitled')
      }
    }
    this.dataSources.set(databaseId, list)
  }

  async render(item: SourceItem, context: RenderContext): Promise<RenderedNote> {
    const blockContext = {
      linkTo: (id: string, title: string) => context.linkTo(dashed(id), title),
      saveAttachment: context.saveAttachment,
      blockUrl: (blockId: string) => `${notionUrl(item.id)}#${blockId.replace(/-/g, '')}`,
      titleOf: (id: string) => this.titleOf(id),
      warn: context.warn,
    }
    // An item found as a block (a sub-page search did not list) carries the block's times: read the
    // page itself, so what is stored is the page's own edited time, the one a later run compares.
    if (item.kind === 'page' && !this.pages.has(item.id)) {
      const page = await this.client.request<NotionPage>('GET', `/v1/pages/${item.id}`, undefined, context.signal)
      if (page) {
        this.pages.set(item.id, page)
        item.editedAt = page.last_edited_time ?? item.editedAt
        item.createdAt = page.created_time ?? item.createdAt
        item.url = page.url ?? item.url
      }
    }
    if (item.kind === 'database') {
      const note = await this.renderDatabase(item, context, blockContext)
      item.editedAt = this.databaseEdited(item.id)
      return note
    }

    const blocks = await this.tree(item.id, context.signal)
    this.reportChildren(item.id, blocks, context)
    const body = await new BlockRenderer(blockContext).render(blocks)
    const page = this.pages.get(item.id)
    const properties: Array<[string, string]> = []
    if (page?.parent && (page.parent.type === 'database_id' || page.parent.type === 'data_source_id')) {
      await this.nameRelations([page], context.signal)
      for (const [name, prop] of Object.entries(page.properties ?? {})) {
        if (prop?.type === 'title') continue
        const value = propertyToMarkdown(prop, blockContext)
        if (value) properties.push([name, value])
      }
    }
    return { body, ...(properties.length ? { properties } : {}) }
  }

  /**
   * Related pages the run has no title for (one in Notion's trash, one not shared with the
   * connection's search): read each once, so a link to it keeps its name. Only reads.
   */
  private async nameRelations(rows: NotionPage[], signal: AbortSignal): Promise<void> {
    const unknown = new Set<string>()
    for (const row of rows) {
      for (const prop of Object.values(row.properties ?? {})) {
        if (prop?.type !== 'relation') continue
        for (const r of (prop.relation ?? []) as Array<{ id?: string }>) if (r?.id && !this.titles.has(dashed(r.id))) unknown.add(dashed(r.id))
      }
    }
    for (const id of [...unknown].slice(0, MAX_RELATION_LOOKUPS)) {
      const page = await this.client.request<NotionPage>('GET', `/v1/pages/${id}`, undefined, signal).catch(() => null)
      this.titles.set(id, page ? titleOfProperties(page.properties) || '' : '')
    }
  }

  private reportChildren(parentId: string, blocks: NotionBlock[], context: RenderContext): void {
    const visit = (list: NotionBlock[]) => {
      for (const block of list) {
        if (block.type === 'child_page' || block.type === 'child_database') {
          const id = dashed(block.id)
          const title = String((block[block.type] as any)?.title ?? '') || (block.type === 'child_page' ? 'Untitled' : 'Untitled database')
          if (!this.titles.has(id)) this.titles.set(id, title)
          context.discovered({
            id,
            kind: block.type === 'child_page' ? 'page' : 'database',
            title: this.titles.get(id) ?? title,
            parentId,
            editedAt: String(block.last_edited_time ?? ''),
            createdAt: String(block.created_time ?? ''),
            url: notionUrl(id),
          })
        }
        if (block.children) visit(block.children)
      }
    }
    visit(blocks)
  }

  private async renderDatabase(item: SourceItem, context: RenderContext, blockContext: InlineContext): Promise<RenderedNote> {
    await this.loadDatabase(item.id, context)
    const sources = this.dataSources.get(item.id) ?? []
    const rows = this.rowsOf(item.id)
    for (const row of rows) context.discovered(this.pageItem(row, item.id))
    await this.nameRelations(rows, context.signal)
    const sections: string[] = []
    const description = sources.map((s) => richTextToMarkdown(s.description, blockContext)).filter(Boolean)
    if (description.length) sections.push(description.join('\n\n'))
    for (const source of sources.length ? sources : [null]) {
      const own = source ? rows.filter((row) => !row.parent?.data_source_id || dashed(row.parent.data_source_id) === dashed(source.id)) : rows
      if (sources.length > 1 && source) sections.push(`## ${plainText(source.title).trim() || 'Untitled'}`)
      sections.push(this.table(own, blockContext))
    }
    return { body: sections.filter(Boolean).join('\n\n') }
  }

  private table(rows: NotionPage[], ctx: InlineContext): string {
    if (!rows.length) return '*This database has no rows.*'
    const columns: string[] = []
    for (const row of rows) {
      for (const [name, prop] of Object.entries(row.properties ?? {})) {
        if (prop?.type !== 'title' && !columns.includes(name)) columns.push(name)
      }
    }
    const shown = columns.slice(0, 6)
    const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>') || ' '
    const lines = [
      `| Name | ${shown.map(cell).join(' | ')} |`.replace('|  |', '|'),
      `| --- | ${shown.map(() => '---').join(' | ')} |`.replace('|  |', '|'),
    ]
    for (const row of rows) {
      const title = titleOfProperties(row.properties) || 'Untitled'
      const values = shown.map((name) => cell(propertyToMarkdown(row.properties?.[name], ctx)))
      lines.push(`| ${cell(ctx.linkTo(dashed(row.id), title))} | ${values.join(' | ')} |`.replace('|  |', '|'))
    }
    const more = columns.length > shown.length ? `\n\n*${columns.length - shown.length} more properties are on each row's note.*` : ''
    return lines.join('\n') + more
  }
}
