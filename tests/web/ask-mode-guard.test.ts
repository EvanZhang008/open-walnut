/**
 * Ask here asks in the view the reader is in (2026-11-03, the user: "when i tree
 * conversation mode, I ask here one more time it jump to main conversation ... it
 * should directly go to next level since we are in treemode"), and the pill offers
 * the other way for one question ("people can select inline mode or tree mode for
 * this one"). The rule is web/src/utils/ask-mode.ts; this file pins it and lists
 * every place that moves a session between Conversation Mode and Tree Mode, so a
 * new Ask path that switches the view on its own fails here.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ASK_MODES, askModeOf } from '../../web/src/utils/ask-mode';

const ROOT = path.resolve(__dirname, '../../web/src');
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  return e.isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(e.name) ? [full] : [];
});
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|(^|[^:'"`])\/\/[^\n]*/g, '$1');
const files = walk(ROOT).map((f) => ({ file: path.relative(ROOT, f).split(path.sep).join('/'), text: code(fs.readFileSync(f, 'utf8')) }));

describe('ask mode', () => {
  it('a plain Ask asks in the view the reader is in', () => {
    expect(askModeOf('stack')).toBe('tree');
    expect(askModeOf('linear')).toBe('inline');
    expect([...ASK_MODES].sort()).toEqual(['inline', 'tree']);
  });

  it('every view switch is listed: the mode pill, the Tree and Conversation shortcuts, and an Ask that names its mode', () => {
    const SWITCHES: Record<string, number> = {
      'components/sessions/SessionPanel.tsx': 2, // the header's mode pill (wide and narrow)
      'components/sessions/SessionChatHistory.tsx': 4, // Back to questions, Show all in order, and askAboutQuote's two modes
    };
    const found: Record<string, number> = {};
    for (const { file, text } of files) {
      const n = (text.match(/\bsetViewMode\(/g) ?? []).length;
      if (n && !file.startsWith('hooks/useSessionThreads') && !file.startsWith('contexts/')) found[file] = n;
    }
    expect(found, 'a new place that switches the view: list it here, and an Ask must take its mode from ask-mode.ts').toEqual(SWITCHES);
  });

  it('askAboutQuote switches only toward the mode the Ask names', () => {
    const chat = files.find((f) => f.file === 'components/sessions/SessionChatHistory.tsx')!.text;
    const start = chat.indexOf('const askAboutQuote = useCallback(');
    const body = chat.slice(start, chat.indexOf('}, [', start));
    expect(body).toMatch(/const mode = opts\?\.mode \?\? askModeOf\(stackMode \? 'stack' : 'linear'\)/);
    // Tree: to Tree Mode, then a page one level down; inline: to Conversation Mode.
    const tree = body.slice(body.indexOf("if (mode === 'tree')"), body.indexOf('return;'));
    expect(tree).toMatch(/setViewMode\('stack'\)/);
    expect(tree).toMatch(/stack\.ask\(/);
    expect(tree).not.toMatch(/setViewMode\('linear'\)/);
  });

  it('the pill offers both ways and passes the chosen one', () => {
    const bar = files.find((f) => f.file === 'components/sessions/QuotePinSelectionBar.tsx')!.text;
    expect(bar).toMatch(/data-testid="quote-ask-mode-btn"/);
    expect(bar).toMatch(/ASK_MODES\.map/);
    expect(bar).toMatch(/onClick=\{\(\) => ask\(m\)\}/);
  });
});
