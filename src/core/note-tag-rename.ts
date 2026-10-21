/**
 * One note's text with a tag renamed (frontmatter `tags` and inline `#tag`), or null when
 * the note does not carry it. The rule the notes routes' tag rename applies to every
 * carrying note (web/routes/notes-v2.ts renameNoteTag), and the cloud companion to the
 * notes of its copy (core/companion-notes.ts). `from` and `to` are normalized tags.
 */

import { parseFrontmatter } from './parse-frontmatter.js'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function renameTagInContent(content: string, from: string, to: string, normalize: (raw: string) => string): string | null {
  const { data, body, raw } = parseFrontmatter(content)
  let changed = false
  // Negative lookahead on the FULL tag charset (see INLINE_TAG_RE): `\b`
  // treats `-`/`/` as boundaries, so renaming #work also hit #work-log.
  const inlineRe = new RegExp(`(^|[\\s(])#${escapeRegExp(from)}(?![A-Za-z0-9/_-])`, 'g')

  // 1) frontmatter tags[]
  let newRaw = raw
  if (raw && Array.isArray(data.tags)) {
    const replaced = (data.tags as unknown[]).map((t) =>
      typeof t === 'string' && normalize(t) === from ? to : t,
    )
    if (JSON.stringify(replaced) !== JSON.stringify(data.tags)) {
      // Rewrite only the tag tokens, and ONLY on lines that belong to the
      // `tags:` key (inline array or block list): an unscoped rewrite also
      // hit bare words in other fields (`title: my work notes`).
      const tokenRe = new RegExp(`(^|[\\s,\\[])#?${escapeRegExp(from)}(?=$|[\\s,\\]])`, 'g')
      let inTagsBlock = false
      newRaw = raw
        .split('\n')
        .map((line) => {
          const key = line.match(/^([A-Za-z_][\w-]*):/)
          if (key) inTagsBlock = key[1] === 'tags'
          else if (!/^\s*(-\s|#)/.test(line) && line.trim() !== '') inTagsBlock = false
          const isTagsLine = inTagsBlock || /^tags:/.test(line)
          return isTagsLine ? line.replace(tokenRe, (_m, pre) => `${pre}${to}`) : line
        })
        .join('\n')
      changed = changed || newRaw !== raw
    }
  }

  // 2) inline #from -> #to in body
  const newBody = body.replace(inlineRe, (_m, pre) => `${pre}#${to}`)
  if (newBody !== body) changed = true

  return changed ? (newRaw || raw) + newBody : null
}
