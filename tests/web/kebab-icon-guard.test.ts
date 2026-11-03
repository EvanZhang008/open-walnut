/**
 * Every task kebab button draws its dots with <KebabIcon />, never the ⋮ character.
 * The character's ink comes from the system's font, so it sat on the header's center
 * line on the Mac and 2px high on Linux (2026-11-03, session-header-alignment on CI).
 * Found from the source: any element with the task-kebab-btn class, in any component,
 * is checked, so a new kebab is caught without being listed here.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../web/src');

function tsxFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(p);
    return e.name.endsWith('.tsx') ? [p] : [];
  });
}

/** Each element opened with className containing task-kebab-btn, up to its closing tag. */
function kebabButtons(src: string): string[] {
  const out: string[] = [];
  const re = /<(\w+)\b[^>]*?className=["{`][^"}`]*\btask-kebab-btn\b/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const close = src.indexOf(`</${m[1]}>`, m.index);
    expect(close, 'a task-kebab-btn element has a closing tag').toBeGreaterThan(m.index);
    out.push(src.slice(m.index, close));
  }
  return out;
}

describe('task kebab buttons', () => {
  const found = tsxFiles(ROOT).flatMap((file) =>
    kebabButtons(fs.readFileSync(file, 'utf8')).map((jsx) => ({ file: path.relative(ROOT, file), jsx })));

  it('finds the kebabs it guards', () => {
    expect(found.map((f) => f.file)).toEqual(expect.arrayContaining([
      path.join('components', 'tasks', 'TaskKebabMenu.tsx'),
      path.join('components', 'sessions', 'TaskQuickActions.tsx'),
    ]));
  });

  it('draws the dots with KebabIcon, not a font glyph', () => {
    for (const { file, jsx } of found) {
      expect(jsx, `${file}: a task-kebab-btn draws <KebabIcon />`).toContain('<KebabIcon');
      expect(jsx, `${file}: a task-kebab-btn types a glyph (font-dependent ink)`).not.toMatch(/[⋮⋯…•·]/);
    }
  });

  it('sizes the dots with one rule of their own', () => {
    // The first name tried, task-kebab-icon, was the menu rows' 16px icon box, which drew
    // the dots half as large again. The dots' class is theirs alone.
    const css = fs.readdirSync(path.join(ROOT, 'styles')).filter((f) => f.endsWith('.css'))
      .map((f) => fs.readFileSync(path.join(ROOT, 'styles', f), 'utf8')).join('\n');
    expect(css.match(/\.task-kebab-dots\b/g)?.length).toBe(1);
    const tsx = tsxFiles(ROOT).filter((f) => fs.readFileSync(f, 'utf8').includes('task-kebab-dots'));
    expect(tsx.map((f) => path.basename(f))).toEqual(['KebabIcon.tsx']);
  });
});
