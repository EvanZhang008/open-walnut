/**
 * The mark of a meta line: words built from a record's facts and joined by " · " ("Claude Code ·
 * Opus", "1,234 requests · 5.6M tokens"), the way every meta line in the app reads
 * (.claude/skills/walnut-ui-requirements/standard.md, "On a line of words"). Copy written in the
 * code (a label, a heading, a help sentence) joins its words with commas instead, so the Settings
 * copy audit (settings-panes-addons.spec.ts) lets the spaced " · " through only on an element
 * that carries this mark, and nothing else: any other glyph there is still copy to fix.
 */
export const META_LINE = { 'data-meta-line': '' } as const;
