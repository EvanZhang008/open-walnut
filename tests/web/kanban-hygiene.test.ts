/**
 * Ratchet over every kanban file of the slice (C26, C49, C85): no em or en
 * dash, no emoji, no console.log in web code, no inline svg in the kanban
 * components (icons come from Icons.tsx), and no file over 500 lines. A file
 * that does not exist yet is skipped, so packages can land in any order.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const MAX_LINES = 500;
// U+2014 em dash, U+2013 en dash: escaped so this file passes its own check.
const DASH = /[\u2014\u2013]/;
const PICTO = /\p{Extended_Pictographic}/u;

function walk(dir: string, keep: (rel: string) => boolean): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      out.push(...walk(rel, keep));
    } else if (keep(rel)) {
      out.push(rel);
    }
  }
  return out;
}

const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

function kanbanFiles(): string[] {
  const files = new Set<string>([
    ...walk('web/src/components/board/kanban', () => true),
    ...walk('web/src/styles', (r) => /\/board-kanban[^/]*\.css$/.test(r)),
    ...walk('src/core/boards', (r) => /\/board-lanes\.ts$|\/board-kanban[^/]*\.ts$/.test(r)),
    ...walk('tests', (r) => /kanban[^/]*$/i.test(path.basename(r))),
    ...['src/web/routes/board-kanban-v1.ts', 'src/ops/board-kanban-ops.ts', 'src/data/skills/walnut-board/SKILL.md',
      'web/src/components/board/board-kanban-reload.ts'].filter(exists),
  ]);
  return [...files].sort();
}

function lineHits(text: string, re: RegExp): string[] {
  return text.split('\n').flatMap((line, i) => (re.test(line) ? [`${i + 1}: ${line.trim().slice(0, 80)}`] : []));
}

describe('kanban hygiene', () => {
  const files = kanbanFiles();

  it('finds the files it guards', () => {
    expect(files).toContain('src/core/boards/board-lanes.ts');
    expect(files).toContain('web/src/components/board/kanban/kanban-model.ts');
    expect(files).toContain('tests/web/kanban-hygiene.test.ts');
  });

  it.each(files)('%s: no em or en dash, no emoji', (rel) => {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    expect(lineHits(text, DASH), 'em or en dash').toEqual([]);
    expect(lineHits(text, PICTO), 'emoji').toEqual([]);
  });

  it.each(files)('%s: at most 500 lines', (rel) => {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').length;
    expect(lines).toBeLessThanOrEqual(MAX_LINES + 1); // a trailing newline adds one empty element
  });

  it('web kanban code logs through @/utils/log, never console.log', () => {
    const web = files.filter((f) => f.startsWith('web/src/'));
    const hits = web.flatMap((f) => lineHits(fs.readFileSync(path.join(ROOT, f), 'utf8'), /console\.log\s*\(/).map((h) => `${f}:${h}`));
    expect(hits).toEqual([]);
  });

  it('kanban components draw no inline svg (icons come from Icons.tsx)', () => {
    const tsx = files.filter((f) => f.startsWith('web/src/components/board/kanban/') && f.endsWith('.tsx'));
    const hits = tsx.flatMap((f) => lineHits(fs.readFileSync(path.join(ROOT, f), 'utf8'), /<svg[\s>]/).map((h) => `${f}:${h}`));
    expect(hits).toEqual([]);
  });

  it('kanban components use no text arrows, and Add task / Add lane draw ICON_PLUS (G25)', () => {
    const tsx = files.filter((f) => f.startsWith('web/src/components/board/kanban/') && f.endsWith('.tsx'))
    // Arrows (U+2190 to U+21FF) and the small triangles (U+25B2 to U+25C5); the kebab's U+22EE is allowed.
    const arrows = tsx.flatMap((f) => lineHits(fs.readFileSync(path.join(ROOT, f), 'utf8'), /[\u2190-\u21ff\u25b2-\u25c5]/).map((h) => `${f}:${h}`))
    expect(arrows).toEqual([])
    const adders = tsx.filter((f) => /['">]\s*Add (task|lane)\b/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))
    for (const f of adders) expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), f).toContain('ICON_PLUS')
  })

  it('a count of cards is never written as "N cards" by hand: cardsText says "1 card" (N15)', () => {
    const web = files.filter((f) => f.startsWith('web/src/components/board/kanban/'))
    const hits = web.flatMap((f) => lineHits(fs.readFileSync(path.join(ROOT, f), 'utf8'), /\$\{[^}]+\} cards\b/).map((h) => `${f}:${h}`))
    expect(hits).toEqual([])
  })

  it('Icons.tsx has ICON_PLUS with the same 16 viewBox as its neighbours', () => {
    const icons = fs.readFileSync(path.join(ROOT, 'web/src/components/common/Icons.tsx'), 'utf8');
    const line = icons.split('\n').find((l) => l.startsWith('export const ICON_PLUS ='));
    expect(line).toBeDefined();
    expect(line).toContain('viewBox="0 0 16 16"');
    expect(line).toContain('stroke="currentColor"');
    expect(line).toContain('strokeWidth="1.8"');
  });
});
