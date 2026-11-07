import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

function filesUnder(dir: string, extension: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(file, extension) : file.endsWith(extension) ? [file] : [];
  });
}

const components = filesUnder(path.join(root, 'web/src/components'), '.tsx');
const isTaskRow = (file: string) => /^(tasks|org|board|boards)\//.test(path.relative(path.join(root, 'web/src/components'), file).split(path.sep).join('/'));
const rows = components.filter(isTaskRow);
const gitRendering = /GitGlance(?:Pill|Line)|useSessionGitGlance|git-glance-(?:pill|line)|gitSessionId/;

describe('task rows keep git information inside Changed, never inline', () => {
  it('uses only component-relative directories to classify every row surface', () => {
    for (const dir of ['tasks', 'org', 'board', 'boards']) {
      expect(isTaskRow(path.join(root, 'web/src/components', dir, 'FutureRow.tsx'))).toBe(true);
    }
    expect(isTaskRow(path.join(root, 'web/src/components/sessions/GitGlance.tsx'))).toBe(false);
  });

  it('enumerates every task-row surface, including new components', () => {
    expect(rows.length).toBeGreaterThan(30);
    for (const file of rows) {
      expect(fs.readFileSync(file, 'utf8'), path.relative(root, file)).not.toMatch(gitRendering);
    }
  });

  it('no web component can bring the retired git pill back under another row wrapper', () => {
    for (const file of components) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, path.relative(root, file)).not.toMatch(/GitGlancePill|git-glance-pill/);
      if (!file.includes('/components/sessions/')) {
        expect(source, path.relative(root, file)).not.toMatch(gitRendering);
      }
    }
    expect(fs.readFileSync(path.join(root, 'web/src/components/sessions/SessionDiffView.tsx'), 'utf8'))
      .toContain('<GitGlanceLineView');
  });

  it('native phone task rows and org lists never draw git status', () => {
    const nativeRows = filesUnder(path.join(root, 'ios-native/Walnut/Views'), '.swift')
      .filter((file) => /\/(Tasks|Org)\//.test(file));
    expect(nativeRows.length).toBeGreaterThan(10);
    for (const file of nativeRows) {
      expect(fs.readFileSync(file, 'utf8'), path.relative(root, file))
        .not.toMatch(/GitGlance|gitStatus|gitGlance|git-glance-pill/);
    }
  });
});
