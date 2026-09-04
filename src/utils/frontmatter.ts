/**
 * Shared YAML frontmatter parser.
 * Extracts YAML frontmatter from markdown files delimited by --- fences.
 */
import yaml from 'js-yaml';

export function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { frontmatter: {}, body: raw };
  const fmText = match[1];
  const body = raw.slice(match[0].length).trim();
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = (yaml.load(fmText) as Record<string, unknown>) ?? {};
  } catch {
    frontmatter = {};
  }
  return { frontmatter, body };
}

/**
 * The description of a command template (`.claude/commands/*.md`): the
 * frontmatter `description` when there is one, else the first non-empty line of
 * the prompt with any heading marks stripped — the same fallback Claude Code
 * uses for its own command list, so the palette reads like the CLI's.
 */
export function commandDescription(raw: string): string {
  const { frontmatter, body } = parseFrontmatter(raw);
  const fm = frontmatter.description;
  if (typeof fm === 'string' && fm.trim()) return fm.trim();
  const first = body.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  return first.replace(/^#+\s*/, '').trim();
}
