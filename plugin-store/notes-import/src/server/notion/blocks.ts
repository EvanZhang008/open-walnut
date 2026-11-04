/**
 * Notion blocks (with their children already loaded) → Markdown that Walnut's notes render.
 *
 * Choices, each because of what the notes editor supports:
 * - A toggle becomes a folded callout (`> [!note]- Title`), which the notes editor shows closed
 *   with its title until clicked open (inside a list: a bold list item over its content).
 * - A Notion callout becomes a `> [!kind]` callout, its colour picking the kind.
 * - An equation becomes a `math` code block (inline: $`…`$), which the notes editor typesets.
 * - Files Notion hosts are downloaded beside the note and embedded (`![[…]]`); a type notes
 *   cannot keep links back to the block in Notion, so nothing silently disappears.
 */
import { escapeInline, plainText, richTextToMarkdown, type RichText } from './rich-text'

export interface NotionBlock {
  id: string
  type: string
  has_children?: boolean
  children?: NotionBlock[]
  [key: string]: unknown
}

export interface BlockContext {
  linkTo(id: string, title: string): string
  saveAttachment(input: { url: string; name: string; key: string }): Promise<string | null>
  /** A link back to this block in Notion, for content notes cannot hold. */
  blockUrl(blockId: string): string
  /** The title Notion gave a page or database, when known. */
  titleOf(id: string): string | undefined
  warn(message: string): void
}

interface FileValue {
  type?: 'file' | 'external' | 'file_upload'
  file?: { url?: string }
  external?: { url?: string }
  caption?: RichText[]
  name?: string
}

const LIST_TYPES = new Set(['bulleted_list_item', 'numbered_list_item', 'to_do'])

// The notes editor colours a callout by its kind (note, tip, info, warning, danger), so each Notion
// colour takes the kind of the nearest colour: orange is amber, yellow a plain note, red and pink are red.
const CALLOUT_KIND: Record<string, string> = {
  default: 'note', gray: 'note', brown: 'note',
  blue: 'info', purple: 'info',
  green: 'tip',
  yellow: 'note', orange: 'warning',
  red: 'danger', pink: 'danger',
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return text.split('\n').map((line) => (line.trim() ? pad + line : '')).join('\n')
}

function quote(text: string): string {
  return text.split('\n').map((line) => (line.trim() ? `> ${line}` : '>')).join('\n')
}

function fileName(value: FileValue, url: string, fallback: string): string {
  if (value.name) return value.name
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
    if (last) return last
  } catch { /* not a URL */ }
  return fallback
}

function fileUrl(value: FileValue): { url: string; hosted: boolean } | null {
  if (value.type === 'external' && value.external?.url) return { url: value.external.url, hosted: false }
  if (value.file?.url) return { url: value.file.url, hosted: true }
  return null
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
}

export class BlockRenderer {
  constructor(private readonly ctx: BlockContext) {}

  private inline(items: RichText[] | undefined): string {
    return richTextToMarkdown(items, this.ctx)
  }

  /** A run of sibling blocks. `listDepth` > 0 inside a list item; `toggleDepth` counts open toggles. */
  async render(blocks: NotionBlock[], listDepth = 0, toggleDepth = 0): Promise<string> {
    const parts: Array<{ text: string; list: boolean }> = []
    let numbered = 0
    for (const block of blocks) {
      numbered = block.type === 'numbered_list_item' ? numbered + 1 : 0
      const text = await this.renderOne(block, listDepth, toggleDepth, numbered)
      if (text === null || text === '') continue
      parts.push({ text, list: LIST_TYPES.has(block.type) || (block.type === 'toggle' && listDepth > 0) })
    }
    let out = ''
    parts.forEach((part, index) => {
      if (index === 0) { out = part.text; return }
      const tight = part.list && parts[index - 1].list
      out += (tight ? '\n' : '\n\n') + part.text
    })
    return out
  }

  private async children(block: NotionBlock, listDepth: number, toggleDepth: number): Promise<string> {
    return block.children?.length ? this.render(block.children, listDepth, toggleDepth) : ''
  }

  private async renderOne(block: NotionBlock, listDepth: number, toggleDepth: number, number: number): Promise<string | null> {
    const value = (block[block.type] ?? {}) as Record<string, any>
    const rich = value.rich_text as RichText[] | undefined
    switch (block.type) {
      case 'paragraph': {
        const text = this.inline(rich)
        const kids = await this.children(block, listDepth, toggleDepth)
        return [text, kids && indent(kids, 2)].filter(Boolean).join('\n\n')
      }
      case 'heading_1':
      case 'heading_2':
      case 'heading_3': {
        const level = Number(block.type.slice(-1))
        const text = this.inline(rich) || ' '
        const heading = listDepth > 0 ? `**${text}**` : `${'#'.repeat(level)} ${text}`
        const kids = await this.children(block, listDepth, toggleDepth)
        return kids ? `${heading}\n\n${kids}` : heading
      }
      case 'bulleted_list_item':
      case 'numbered_list_item':
      case 'to_do': {
        const marker = block.type === 'numbered_list_item' ? `${number}.` : '-'
        const box = block.type === 'to_do' ? (value.checked ? '[x] ' : '[ ] ') : ''
        const line = `${marker} ${box}${this.inline(rich)}`.trimEnd()
        const kids = await this.children(block, listDepth + 1, toggleDepth)
        return kids ? `${line}\n${indent(kids, marker.length + 1)}` : line
      }
      case 'toggle': {
        const title = this.inline(rich) || ' '
        if (listDepth > 0) {
          const kids = await this.children(block, listDepth + 1, toggleDepth + 1)
          return kids ? `- **${title}**\n${indent(kids, 2)}` : `- **${title}**`
        }
        const kids = await this.children(block, 0, toggleDepth + 1)
        return `> [!note]- ${title}${kids ? `\n${quote(kids)}` : ''}`
      }
      case 'quote': {
        const text = this.inline(rich)
        const kids = await this.children(block, 0, toggleDepth)
        return quote([text, kids].filter(Boolean).join('\n\n'))
      }
      case 'callout': {
        const icon = value.icon?.type === 'emoji' && value.icon.emoji ? `${value.icon.emoji} ` : ''
        const color = String(value.color ?? 'default').replace(/_background$/, '')
        const kind = CALLOUT_KIND[color] ?? 'note'
        const text = `${icon}${this.inline(rich)}`.trim()
        const kids = await this.children(block, 0, toggleDepth)
        return `> [!${kind}]\n${quote([text, kids].filter(Boolean).join('\n\n') || ' ')}`
      }
      case 'code': {
        const code = plainText(rich)
        const language = value.language && value.language !== 'plain text' ? String(value.language).replace(/\s+/g, '-') : ''
        const longest = Math.max(2, ...[...code.matchAll(/`{3,}/g)].map((m) => m[0].length))
        const fence = '`'.repeat(longest + 1)
        const caption = this.inline(value.caption)
        return `${fence}${language}\n${code}\n${fence}${caption ? `\n\n*${caption}*` : ''}`
      }
      case 'equation': {
        const expression = String(value.expression ?? '')
        const fence = '`'.repeat(Math.max(3, ...[...expression.matchAll(/`{3,}/g)].map((m) => m[0].length + 1)))
        return `${fence}math\n${expression}\n${fence}`
      }
      case 'divider':
        return '---'
      case 'table':
        return this.table(block, value)
      case 'column_list':
      case 'column':
      case 'synced_block':
        return this.children(block, listDepth, toggleDepth)
      case 'child_page':
        return this.ctx.linkTo(block.id, value.title || this.ctx.titleOf(block.id) || 'Untitled')
      case 'child_database':
        return this.ctx.linkTo(block.id, value.title || this.ctx.titleOf(block.id) || 'Untitled database')
      case 'link_to_page': {
        const id = value.page_id ?? value.database_id
        return id ? this.ctx.linkTo(id, this.ctx.titleOf(id) ?? 'Linked page') : null
      }
      case 'image':
        return this.file(block, value as FileValue, 'image')
      case 'file':
      case 'pdf':
      case 'video':
      case 'audio':
        return this.file(block, value as FileValue, block.type)
      case 'bookmark':
      case 'embed':
      case 'link_preview': {
        const url = String(value.url ?? '')
        if (!url) return null
        const caption = this.inline(value.caption)
        return `[${caption || escapeInline(url).replace(/[[\]]/g, '\\$&')}](${url.replace(/ /g, '%20').replace(/\)/g, '%29')})`
      }
      case 'table_of_contents':
      case 'breadcrumb':
      case 'template':
        return null
      default: {
        if (rich?.length) return this.inline(rich)
        this.ctx.warn(block.type === 'unsupported'
          ? 'Notion does not share some blocks (buttons, AI blocks and a few others) with other apps, so the note links to them in Notion'
          : `A "${block.type.replace(/_/g, ' ')}" block has no form in a note, so the note links to it in Notion`)
        return `*[${block.type === 'unsupported' ? 'Open this part in Notion' : `Open this ${block.type.replace(/_/g, ' ')} in Notion`}](${this.ctx.blockUrl(block.id)})*`
      }
    }
  }

  private async table(block: NotionBlock, value: Record<string, any>): Promise<string> {
    const rows = (block.children ?? []).filter((row) => row.type === 'table_row')
    if (!rows.length) return ''
    const width = Math.max(1, Number(value.table_width) || 0, ...rows.map((row) => ((row.table_row as any)?.cells ?? []).length))
    const lines: string[] = []
    const cellsOf = (row: NotionBlock) => {
      const cells = ((row.table_row as any)?.cells ?? []) as RichText[][]
      return Array.from({ length: width }, (_, i) => escapeCell(this.inline(cells[i])) || ' ')
    }
    const header = value.has_column_header ? cellsOf(rows[0]) : Array.from({ length: width }, () => ' ')
    lines.push(`| ${header.join(' | ')} |`)
    lines.push(`| ${header.map(() => '---').join(' | ')} |`)
    for (const row of value.has_column_header ? rows.slice(1) : rows) {
      const cells = cellsOf(row)
      if (value.has_row_header && cells[0].trim()) cells[0] = `**${cells[0]}**`
      lines.push(`| ${cells.join(' | ')} |`)
    }
    return lines.join('\n')
  }

  private async file(block: NotionBlock, value: FileValue, kind: string): Promise<string | null> {
    const source = fileUrl(value)
    const caption = this.inline(value.caption)
    if (!source) {
      if (value.type === 'file_upload') {
        this.ctx.warn(`A ${kind} uploaded through the API could not be read; it links back to Notion`)
        return `[${kind}](${this.ctx.blockUrl(block.id)})`
      }
      return null
    }
    const name = fileName(value, source.url, kind === 'image' ? 'image' : kind)
    if (source.hosted) {
      const saved = await this.ctx.saveAttachment({ url: source.url, name, key: block.id })
      if (saved) return `![[${saved}]]${caption ? `\n\n*${caption}*` : ''}`
      // Kept in Notion: a file type notes do not hold, or one too big to bring over.
      const label = escapeInline(name).replace(/[[\]]/g, '\\$&')
      return `[${label} (in Notion)](${this.ctx.blockUrl(block.id)})${caption ? `\n\n*${caption}*` : ''}`
    }
    // An outside file (a video on a site, a linked image): its address says more than its last segment.
    const url = source.url.replace(/ /g, '%20').replace(/\)/g, '%29')
    if (kind === 'image') return `![${caption}](${url})`
    const label = caption || escapeInline(value.name || source.url).replace(/[[\]]/g, '\\$&')
    return `[${label}](${url})`
  }
}
