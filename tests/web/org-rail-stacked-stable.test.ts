/**
 * A pane stacked above a node's chat keeps one height while its cards load, fold or change, so the
 * chat under it never moves (2026-11-22, the user, on opening the VP: "it goes up, down, up, down";
 * the rail above the chat was sized by its content up to 45% and grew from its loading line to its
 * cards, pushing the chat down by about 390px).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.join(__dirname, '../../web/src/styles/org-rail.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rulesOf = (sel: RegExp) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => sel.test(m[1]!.trim())).map((m) => m[2]!);

describe('the rail above a chat keeps its height', () => {
  it('is a fixed share of the node, never its content\'s height', () => {
    const base = rulesOf(/^\.org-rail\.is-top$/);
    expect(base.join(';')).toMatch(/(?:^|;)\s*height:\s*45%/);
    // No rule outside full screen sizes the stacked rail by its content again.
    const byContent = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter((m) => /\.org-rail\.is-top/.test(m[1]!) && !/open-walnut-fullscreen/.test(m[1]!))
      .filter((m) => /(?:^|;)\s*(?:max-height|height:\s*auto|height:\s*fit-content)/.test(m[2]!))
      .map((m) => m[1]!.trim());
    expect(byContent).toEqual([]);
  });
});
