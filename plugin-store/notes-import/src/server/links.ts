/**
 * Links between notes in the vault's own form: `[[path|Title]]` (with `\\|` inside a table) and
 * `![[file]]` embeds. When notes move, every link to them is rewritten to the new path.
 */

/**
 * Walnut's notes editor saved wiki links escaped (`\[\[path|Title\]\]`, its markdown writer's escape
 * of every `[`) until it was fixed, so a note edited in Walnut may hold that form: it reads it as the
 * same link, and so must anything that moves notes and fixes links. One pass reads both forms, so a
 * link is rewritten once.
 */
const ANY_LINK_RE = /(!?)(?:\\\[\\\[((?:[^\]\n\\]|\\[^\n])+?)\\\]\\\]|\[\[([^\]|\\]+)((?:\\?\|)[^\]]*)?\]\])/g

/**
 * Rewrite `[[old…]]` links and `![[old…]]` embeds to the new vault paths (keys with or without
 * `.md`). A link saved escaped that is rewritten comes back in the bare form; every other link,
 * escaped or not, stays as it was, and a note with none to rewrite comes back unchanged.
 */
export function rewriteLinks(content: string, moves: Map<string, string>): string {
  if (!moves.size || (!content.includes('[[') && !content.includes('\\[\\['))) return content
  const relink = (bang: string, linked: string, rest: string) => {
    // A link to a heading or block of a note (`Note#Plan`, `Note#^id`) follows the note.
    const cut = linked.indexOf('#')
    const target = cut < 0 ? linked : linked.slice(0, cut)
    const anchor = cut < 0 ? '' : linked.slice(cut)
    const key = target.trim()
    const asMd = key.endsWith('.md') ? key : `${key}.md`
    const moved = moves.get(key) ?? moves.get(asMd)
    if (!moved) return null
    const to = key.endsWith('.md') || !moved.endsWith('.md') ? moved : moved.slice(0, -3)
    return `${bang}[[${to}${anchor}${rest}]]`
  }
  return content.replace(ANY_LINK_RE, (whole, bang: string, escaped: string | undefined, target: string | undefined, rest: string | undefined) => {
    if (target !== undefined) return relink(bang, target, rest ?? '') ?? whole
    const bare = escaped!.replace(/\\([^|])/g, '$1')
    const cut = bare.search(/\\?\|/)
    return relink(bang, cut < 0 ? bare : bare.slice(0, cut), cut < 0 ? '' : bare.slice(cut)) ?? whole
  })
}

/**
 * Links and embeds to notes that are gone (`paths`, vault paths with `.md`) become their words: the
 * title a link shows, else the note's name. Every other link stays as it was.
 */
export function unlinkNotes(content: string, paths: Set<string>): string {
  if (!paths.size || (!content.includes('[[') && !content.includes('\\[\\['))) return content
  const words = (linked: string, rest: string): string | null => {
    const cut = linked.indexOf('#')
    const key = (cut < 0 ? linked : linked.slice(0, cut)).trim()
    if (!paths.has(key.endsWith('.md') ? key : `${key}.md`)) return null
    const alias = rest.replace(/^\\?\|/, '').trim()
    return alias || key.replace(/\.md$/, '').split('/').pop() || key
  }
  return content.replace(ANY_LINK_RE, (whole, _bang: string, escaped: string | undefined, target: string | undefined, rest: string | undefined) => {
    if (target !== undefined) return words(target, rest ?? '') ?? whole
    const bare = escaped!.replace(/\\([^|])/g, '$1')
    const cut = bare.search(/\\?\|/)
    return words(cut < 0 ? bare : bare.slice(0, cut), cut < 0 ? '' : bare.slice(cut)) ?? whole
  })
}

/** What a link to a page outside the import looks like (see the importer's `linkTo`). */
export const OUTSIDE_MARK = '](https://www.notion.so/'

/**
 * Links to pages that were outside the import when the note was written, made links to the
 * notes those pages have now. `linkTo(id, title)` answers the note link for a page id
 * (dashed), or null while it still has none.
 */
export function linkOutside(content: string, linkTo: (id: string, title: string) => string | null): string {
  if (!content.includes(OUTSIDE_MARK)) return content
  return content.split('\n').map((line) => {
    if (!line.includes(OUTSIDE_MARK)) return line
    const inTable = line.trimStart().startsWith('|')
    return line.replace(/\[((?:[^\]\\]|\\.)*)\]\(https:\/\/www\.notion\.so\/([0-9a-f]{32})\)/g, (whole, label: string, hex: string) => {
      const plain = label.replace(/\\(.)/g, '$1')
      const title = plain === 'Page in Notion' ? '' : plain.endsWith(' (in Notion)') ? plain.slice(0, -' (in Notion)'.length) : null
      if (title === null) return whole
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
      const link = linkTo(id, title)
      return link === null ? whole : inTable ? link.replace(/(?<!\\)\|/g, '\\|') : link
    })
  }).join('\n')
}
