/**
 * The root AGENTS.md (CLAUDE.md is a symlink to it) is loaded by every Claude Code session and
 * every subagent working in this repo, on every request. On 2026-11-11 it had grown to about
 * 214 KB (roughly 50k tokens), one of the largest fixed costs of the month's model bill, so it
 * now holds only the rules every session needs before it touches anything, one line each, with
 * a pointer to the file that keeps the full rule.
 *
 * This guard keeps it that way: the file stays under 40,000 bytes, and every docs, skill or test
 * path it points to exists, so a one-line rule never points at nothing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const FILE = path.join(ROOT, 'AGENTS.md');
const MAX_BYTES = 40_000;

const WHERE_DETAIL_GOES = [
  'Put detail in the file that owns the area and leave one line with a pointer in AGENTS.md:',
  '  docs/reference/*.md (production-server, tasks-and-teams, user-status, org-and-inbox,',
  '  session-lifecycle, agent-guards, session-daemon, logs-and-debugging, message-hints,',
  '  testing-pipeline, ...), the skills in .claude/skills/, or a per-directory AGENTS.md',
  '  (src/core, web/src, tests, src/logging).',
].join('\n');

/** Repo-relative paths under docs/, .claude/skills/, tests/, src/, scripts/ or web/ named in a link or in backticks. */
function referencedPaths(text: string): string[] {
  const found = new Set<string>();
  const candidates: string[] = [];
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) candidates.push(m[1]);
  for (const m of text.matchAll(/`([^`\s]+)`/g)) candidates.push(m[1]);
  for (let raw of candidates) {
    raw = raw.replace(/^\.\//, '').replace(/#.*$/, '').replace(/:\d+$/, '');
    if (!/^(docs|\.claude\/skills|tests|src|scripts|web)\//.test(raw)) continue;
    if (/[*<>{}]/.test(raw)) continue; // a pattern or placeholder, not a file
    found.add(raw);
  }
  return [...found].sort();
}

describe('root AGENTS.md', () => {
  const text = fs.readFileSync(FILE, 'utf8');

  it(`stays under ${MAX_BYTES} bytes`, () => {
    const bytes = Buffer.byteLength(text, 'utf8');
    expect(bytes, `AGENTS.md is ${bytes} bytes, over the ${MAX_BYTES} cap.\n${WHERE_DETAIL_GOES}`).toBeLessThanOrEqual(MAX_BYTES);
  });

  it('points only at docs, skills and tests that exist', () => {
    const paths = referencedPaths(text);
    expect(paths.length).toBeGreaterThan(10);
    const missing = paths.filter((p) => !fs.existsSync(path.join(ROOT, p)));
    expect(missing, `AGENTS.md names paths that do not exist; fix the pointer or restore the file:\n${missing.join('\n')}`).toEqual([]);
  });

  it('finds links and backticked paths, and skips patterns', () => {
    expect(referencedPaths('see [x](./docs/a.md#top), `tests/b.test.ts:12`, `docs/<x>.md`, `src/c.ts`, `notes/d.md`, `.claude/skills/s/SKILL.md`'))
      .toEqual(['.claude/skills/s/SKILL.md', 'docs/a.md', 'src/c.ts', 'tests/b.test.ts']);
  });
});
