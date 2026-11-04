/**
 * Notion rich text → Markdown inline text.
 *
 * Mentions of pages and databases become links through the context (a note link when that page
 * is imported, else a link back to Notion), dates become their text, people become @name. The
 * text Notion gives is plain, so the few characters that would turn into Markdown or HTML by
 * accident (a wiki link's brackets, a tag-like `<`) are escaped; everything else reads as typed.
 */

export interface RichText {
  type?: 'text' | 'mention' | 'equation'
  plain_text?: string
  href?: string | null
  annotations?: { bold?: boolean; italic?: boolean; strikethrough?: boolean; underline?: boolean; code?: boolean }
  text?: { content?: string; link?: { url?: string } | null }
  mention?: {
    type?: string
    page?: { id?: string }
    database?: { id?: string }
    user?: { name?: string }
    date?: { start?: string; end?: string | null }
    link_preview?: { url?: string }
    link_mention?: { href?: string; title?: string }
    template_mention?: { template_mention_date?: string; template_mention_user?: string }
  }
  equation?: { expression?: string }
}

export interface InlineContext {
  linkTo(id: string, title: string): string
  /** The title of a page the run knows, for a link that carries only an id. */
  titleOf?(id: string): string | undefined
}

/** Escape what would change meaning in Markdown: wiki brackets and HTML-looking tags. */
export function escapeInline(text: string): string {
  return text
    .replace(/\[\[/g, '\\[\\[')
    .replace(/\]\]/g, '\\]\\]')
    .replace(/<(?=[A-Za-z/!?])/g, '&lt;')
}

function wrap(text: string, marker: string): string {
  // Markdown emphasis cannot start or end on whitespace: keep the spaces outside.
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)
  if (!match || !match[2]) return text
  return `${match[1]}${marker}${match[2]}${marker}${match[3]}`
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

function linkUrl(url: string): string {
  return url.replace(/ /g, '%20').replace(/\)/g, '%29').replace(/\(/g, '%28')
}

export function richTextToMarkdown(items: RichText[] | undefined, context: InlineContext): string {
  if (!items?.length) return ''
  let out = ''
  for (const item of items) {
    const plain = item.plain_text ?? item.text?.content ?? ''
    if (item.type === 'mention' && item.mention) {
      const m = item.mention
      if (m.type === 'page' && m.page?.id) { out += context.linkTo(m.page.id, plain); continue }
      if (m.type === 'database' && m.database?.id) { out += context.linkTo(m.database.id, plain); continue }
      if (m.type === 'user') { out += escapeInline(plain.startsWith('@') ? plain : `@${plain || m.user?.name || 'someone'}`); continue }
      if (m.type === 'date' && m.date?.start) { out += escapeInline(m.date.end ? `${m.date.start} → ${m.date.end}` : m.date.start); continue }
      const href = item.href ?? m.link_preview?.url ?? m.link_mention?.href
      if (href) { out += `[${escapeInline(plain || href).replace(/[[\]]/g, '\\$&')}](${linkUrl(href)})`; continue }
      out += escapeInline(plain)
      continue
    }
    if (item.type === 'equation') {
      out += `$${codeSpan(item.equation?.expression ?? plain)}$`
      continue
    }
    if (!plain) continue
    const a = item.annotations ?? {}
    let text = a.code ? codeSpan(plain) : escapeInline(plain)
    if (!a.code) {
      if (a.bold && a.italic) text = wrap(text, '***')
      else if (a.bold) text = wrap(text, '**')
      else if (a.italic) text = wrap(text, '*')
      if (a.strikethrough) text = wrap(text, '~~')
    }
    const href = item.href ?? item.text?.link?.url
    if (href) {
      // A link to another Notion page inside the workspace reads like a mention.
      const pageId = notionPageIdFromUrl(href)
      text = pageId ? context.linkTo(pageId, plain) : `[${text.replace(/[[\]]/g, '\\$&')}](${linkUrl(href)})`
    }
    out += text
  }
  return out
}

/** The page id in a link to a Notion page (`/Title-<32 hex>`, `/<32 hex>`, `?p=<32 hex>`), else null. */
export function notionPageIdFromUrl(href: string): string | null {
  let url: URL
  try { url = new URL(href, 'https://www.notion.so') } catch { return null }
  if (href.startsWith('/')) {
    // a relative link inside Notion
  } else if (!/(^|\.)notion\.(so|site)$/.test(url.hostname)) {
    return null
  }
  const fromQuery = url.searchParams.get('p')
  const candidate = fromQuery ?? url.pathname.split('/').pop() ?? ''
  const hex = /([0-9a-f]{32})$/i.exec(candidate.replace(/-/g, ''))?.[1]
  return hex ? dashed(hex) : null
}

export function dashed(id: string): string {
  const hex = id.replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) return id
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function plainText(items: RichText[] | undefined): string {
  return (items ?? []).map((item) => item.plain_text ?? item.text?.content ?? '').join('')
}
