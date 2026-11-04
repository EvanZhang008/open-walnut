/**
 * A database row's properties → short Markdown values, for the row note's property table and
 * the database note's table of rows. Relations link to the related rows' notes.
 */
import { escapeInline, plainText, richTextToMarkdown, type InlineContext, type RichText } from './rich-text'

export type NotionProperty = { type?: string; id?: string; [key: string]: any }

function date(value: { start?: string; end?: string | null } | null | undefined): string {
  if (!value?.start) return ''
  return value.end ? `${value.start} → ${value.end}` : value.start
}

function fileLabel(file: any): string {
  const url = file?.external?.url ?? file?.file?.url
  const name = escapeInline(String(file?.name ?? 'file'))
  // A hosted file's URL expires within the hour: name it only.
  return file?.type === 'external' && url ? `[${name}](${String(url).replace(/ /g, '%20')})` : name
}

export function propertyToMarkdown(prop: NotionProperty | undefined, ctx: InlineContext): string {
  if (!prop?.type) return ''
  const v = prop[prop.type]
  switch (prop.type) {
    case 'title':
    case 'rich_text':
      return richTextToMarkdown(v as RichText[], ctx)
    case 'number':
      return v === null || v === undefined ? '' : String(v)
    case 'select':
    case 'status':
      return v?.name ? escapeInline(v.name) : ''
    case 'multi_select':
      return (v ?? []).map((o: any) => escapeInline(String(o.name ?? ''))).filter(Boolean).join(', ')
    case 'date':
      return date(v)
    case 'people':
      return (v ?? []).map((p: any) => escapeInline(String(p.name ?? p.person?.email ?? 'someone'))).join(', ')
    case 'files':
      return (v ?? []).map(fileLabel).join(', ')
    case 'checkbox':
      return v ? '✓' : '☐'
    case 'url':
      return v ? `[${escapeInline(String(v)).replace(/[[\]]/g, '\\$&')}](${String(v).replace(/ /g, '%20')})` : ''
    case 'email':
    case 'phone_number':
      return v ? escapeInline(String(v)) : ''
    case 'formula': {
      if (!v?.type) return ''
      const inner = v[v.type]
      if (v.type === 'date') return date(inner)
      if (v.type === 'boolean') return inner ? '✓' : '☐'
      return inner === null || inner === undefined ? '' : escapeInline(String(inner))
    }
    case 'relation':
      return (v ?? []).map((r: any) => (r?.id ? ctx.linkTo(r.id, ctx.titleOf?.(r.id) ?? '') : '')).filter(Boolean).join(', ')
    case 'rollup': {
      if (!v?.type) return ''
      if (v.type === 'array') return (v.array ?? []).map((item: NotionProperty) => propertyToMarkdown(item, ctx)).filter(Boolean).join(', ')
      if (v.type === 'date') return date(v.date)
      const inner = v[v.type]
      return inner === null || inner === undefined ? '' : escapeInline(String(inner))
    }
    case 'created_time':
    case 'last_edited_time':
      return v ? String(v).slice(0, 10) : ''
    case 'created_by':
    case 'last_edited_by':
      return v?.name ? escapeInline(v.name) : ''
    case 'unique_id':
      return v?.number === undefined || v?.number === null ? '' : `${v.prefix ? `${v.prefix}-` : ''}${v.number}`
    case 'verification':
      return v?.state ? escapeInline(String(v.state)) : ''
    case 'button':
      return ''
    default:
      return Array.isArray(v) ? escapeInline(plainText(v as RichText[])) : ''
  }
}

/** The title property's text, whatever the property is named. */
export function titleOfProperties(properties: Record<string, NotionProperty> | undefined): string {
  for (const prop of Object.values(properties ?? {})) {
    if (prop?.type === 'title') return plainText(prop.title as RichText[]).trim()
  }
  return ''
}
