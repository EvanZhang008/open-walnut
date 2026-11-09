import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Round 3 review (2026-11-08): the rules' refused confirm drew its error below the button, out of
// sight in the settings pane, so the click seemed to do nothing. Every alert an Org router component
// draws AFTER its primary button must scroll itself into view (useRevealWhen); one above the button
// is already where the person looks. A new router component is checked by being in this folder.
const ROOT = path.resolve(__dirname, '../..');
const DIR = path.join(ROOT, 'web/src/components/org');

describe('Org router alerts are seen where they appear', () => {
  const files = fs.readdirSync(DIR).filter((name) => /^OrgRouter.*\.tsx$/.test(name));
  it('finds the router components', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });
  for (const name of files) {
    it(name, () => {
      const source = fs.readFileSync(path.join(DIR, name), 'utf8');
      const primary = source.indexOf('btn-primary');
      if (primary < 0) return;
      const tags = [...source.matchAll(/<p\b[^>]*role="alert"[^>]*>/g)];
      for (const tag of tags) {
        if ((tag.index ?? 0) < primary) continue;
        expect(tag[0], `${name}: an alert below the primary button needs ref={...} from useRevealWhen`).toMatch(/\bref=\{/);
      }
      if (tags.some((tag) => (tag.index ?? 0) > primary)) expect(source).toContain('useRevealWhen');
    });
  }
});
