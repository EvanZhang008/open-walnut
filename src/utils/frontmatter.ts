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
