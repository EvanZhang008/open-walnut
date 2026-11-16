/**
 * The Markdown companion of a drawing: the note that makes a `.excalidraw` scene visible to Notes
 * (tree, search, backlinks) without a second drawing format. Pure: tests/core/drawings/companion.test.ts.
 *
 * File: beside the scene, `<name>.drawing.md` for `<name>.excalidraw`. Format:
 *
 *   ---
 *   id: n_...                     (stamped like every note)
 *   kind: walnut-drawing
 *   drawing: <name>.excalidraw
 *   ---
 *   <!-- walnut-drawing:begin revision=<scene revision> ... -->
 *   # <title>
 *   [Open the editable drawing](/apps/walnut-drawing~main?path=<vault path>)
 *   ## Text in the drawing
 *   - <each text in the drawing, top to bottom>
 *   <!-- walnut-drawing:end -->
 *
 * Walnut owns ONLY the text between the two markers. A person may write above or below them or add
 * tags to the frontmatter: a regeneration replaces the marked block and leaves every other byte as
 * it was. A note at the companion path is ours only when its frontmatter says `kind:
 * walnut-drawing` and `drawing:` names this scene (isOwnCompanion); any other note there is never
 * written, and the save reports it instead. The frontmatter is written when the companion is
 * created, and its `drawing:` line again only when Notes moves the drawing (retargetCompanion).
 */

import yaml from 'js-yaml'

export const COMPANION_KIND = 'walnut-drawing'
export const COMPANION_SUFFIX = '.drawing.md'
const BEGIN = '<!-- walnut-drawing:begin'
const END = '<!-- walnut-drawing:end -->'
const MAX_TEXT_ITEMS = 2000
const MAX_TEXT_BYTES = 200_000

/** The route of the Drawing app that opens one scene. */
export function drawingAppLink(scenePath: string): string {
  return `/apps/walnut-drawing~main?path=${encodeURIComponent(scenePath)}`
}

/** A scene's companion path: `a/b/Name.excalidraw` -> `a/b/Name.drawing.md`. */
export function companionPathFor(scenePath: string): string {
  return scenePath.replace(/\.excalidraw$/i, '') + COMPANION_SUFFIX
}

/** Text from the drawing can never close or open a marker of ours. */
function neutralize(text: string): string {
  return text.replace(/<!--/g, '< !--').replace(/-->/g, '-- >')
}

export interface CompanionInput {
  scenePath: string
  title: string
  revision: string
  texts: string[]
}

/** The marked block Walnut owns, for one revision of the scene. */
export function companionBlock({ scenePath, title, revision, texts }: CompanionInput): string {
  const sceneName = scenePath.split('/').pop() ?? scenePath
  const lines = [
    `${BEGIN} revision=${revision}. Walnut rewrites only the text between these two markers, from ${neutralize(sceneName)}; write your own notes outside them. -->`,
    `# ${neutralize(title)}`,
    '',
    `[Open the editable drawing](${drawingAppLink(scenePath)})`,
    '',
    '## Text in the drawing',
    '',
  ]
  let bytes = 0
  let shown = 0
  for (const text of texts) {
    if (shown >= MAX_TEXT_ITEMS || bytes > MAX_TEXT_BYTES) break
    const line = `- ${neutralize(text)}`
    lines.push(line)
    bytes += line.length
    shown++
  }
  if (shown === 0) lines.push('_No text in the drawing yet._')
  else if (shown < texts.length) lines.push(`- _(${texts.length - shown} more in the drawing)_`)
  lines.push(END)
  return lines.join('\n')
}

/** The revision a companion's block was generated from, or null when it has no block of ours. */
export function companionRevision(content: string): string | null {
  const at = content.indexOf(BEGIN)
  if (at < 0 || content.indexOf(END, at) < 0) return null
  const lineEnd = content.indexOf('\n', at)
  const m = /revision=([A-Za-z0-9]+)/.exec(content.slice(at, lineEnd < 0 ? undefined : lineEnd))
  return m ? m[1]! : null
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

function frontmatterOf(content: string): Record<string, unknown> | null {
  const m = FRONTMATTER_RE.exec(content)
  if (!m) return null
  try {
    const data = yaml.load(m[1]!)
    return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null
  } catch {
    return null
  }
}

function sceneNameOf(scenePath: string): string {
  return scenePath.split('/').pop() ?? scenePath
}

/**
 * Whether `content` is the companion Walnut made for this scene: its frontmatter says
 * `kind: walnut-drawing` AND `drawing: <this scene's file name>`. Markers alone are not enough
 * (a person may paste a block into a note of their own), and neither is the kind alone.
 */
export function isOwnCompanion(content: string, scenePath: string): boolean {
  const data = frontmatterOf(content)
  return !!data && data.kind === COMPANION_KIND && data.drawing === sceneNameOf(scenePath)
}

/** The companion's `drawing:` pointed at a moved scene's new file name; every other byte kept. */
export function retargetCompanion(content: string, toScenePath: string): string {
  const m = FRONTMATTER_RE.exec(content)
  if (!m) return content
  const line = yaml.dump({ drawing: sceneNameOf(toScenePath) }, { lineWidth: -1 }).trimEnd()
  const inner = m[1]!.replace(/^drawing:.*$/m, line)
  return content.slice(0, m.index) + m[0].replace(m[1]!, inner) + content.slice(m.index + m[0].length)
}

export type CompanionMerge =
  | { kind: 'write'; content: string; created: boolean }
  | { kind: 'unchanged' }
  | { kind: 'foreign'; reason: string }

/**
 * The companion's next bytes. `current` is the file on disk (null when there is none). Only the
 * marked block of OUR companion changes (isOwnCompanion); any other note is left alone and reported.
 */
export function mergeCompanion(current: string | null, input: CompanionInput): CompanionMerge {
  const block = companionBlock(input)
  if (current === null) {
    const front = yaml.dump({ kind: COMPANION_KIND, drawing: sceneNameOf(input.scenePath) }, { lineWidth: -1 }).trimEnd()
    return { kind: 'write', content: `---\n${front}\n---\n${block}\n`, created: true }
  }
  if (!isOwnCompanion(current, input.scenePath)) {
    return { kind: 'foreign', reason: `${companionPathFor(input.scenePath)} is a note that Walnut did not make for this drawing, so Walnut left it unchanged` }
  }
  const begin = current.indexOf(BEGIN)
  const end = begin < 0 ? -1 : current.indexOf(END, begin)
  if (begin >= 0 && end >= 0) {
    const next = current.slice(0, begin) + block + current.slice(end + END.length)
    return next === current ? { kind: 'unchanged' } : { kind: 'write', content: next, created: false }
  }
  // Ours, but its block was removed by hand: add a fresh block after what the person kept.
  return { kind: 'write', content: `${current.replace(/\s*$/, '')}\n\n${block}\n`, created: false }
}
