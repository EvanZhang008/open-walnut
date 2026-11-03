/**
 * GUARD: the session outline (the header's outline button and its rail) lists the places the user
 * marked, never one row per message (2026-11-03, the user, on an outline that listed every message
 * of a long chat, Walnut's notices included: "why it show all the chat history, only show pinned
 * one", and "it should not be per conversation at all; like before, either you pin it or it is an
 * Ask here question ... endlessly long, meaningless"). Pins are its rows; Ask here questions are
 * listed by the question map beside it; with neither, there is no outline button.
 *
 * Enumerated from the source: every component that renders the outline, where its entries come
 * from, and every import of a module that would derive rows from the messages themselves. A new
 * entry kind fails here until it is a kind the user marks.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(__dirname, '../../web/src');
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = walk(WEB).map((p) => ({ rel: path.relative(WEB, p).split(path.sep).join('/'), src: fs.readFileSync(p, 'utf8') }));
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), 'utf8');

describe('guard: the outline lists only what the user marked', () => {
  it('one component renders the outline, and only the chat history does', () => {
    const hosts = files.filter((f) => /<SessionPinnedToc\b/.test(f.src)).map((f) => f.rel);
    expect(hosts).toEqual(['components/sessions/SessionChatHistory.tsx']);
    expect(read('components/sessions/SessionChatHistory.tsx').match(/<SessionPinnedToc\b/g)).toHaveLength(1);
  });

  it('its entries are the pins, nothing else', () => {
    const src = read('components/sessions/SessionChatHistory.tsx');
    const tag = src.slice(src.indexOf('<SessionPinnedToc'), src.indexOf('/>', src.indexOf('<SessionPinnedToc')));
    expect(tag).toMatch(/entries=\{tocEntries\}/);
    // tocEntries <- pagePins.entries <- pinTocEntries <- the stored pins.
    expect(src).toMatch(/const tocEntries = useMemo<TocEntry\[\]>\(\n\s*\(\) => pagePins\.entries\.map\(/);
    expect(src).toMatch(/if \(!stackMode\) return \{ entries: pinTocEntries, other: 0 \};/);
    expect(src).toMatch(/for \(const e of pinTocEntries\)/);
    expect(src).toMatch(/return placePins\(pinsApi\.pins, messages\)/);
    // Nothing else is merged into the outline's rows.
    expect(src).not.toMatch(/mergeOutline|outlineSections|turnTitles/);
  });

  it('with nothing marked there is no outline at all', () => {
    expect(read('components/sessions/SessionPinnedToc.tsx')).toMatch(/if \(entries\.length === 0 && moreCount === 0\) return null;/);
  });

  it('no module derives outline rows from the messages', () => {
    for (const f of files) {
      expect(f.src, f.rel).not.toMatch(/from '@\/utils\/outline-sections'|useTurnTitleRequest|SessionTurnTitle/);
    }
    expect(fs.existsSync(path.join(WEB, 'utils/outline-sections.ts'))).toBe(false);
  });
});
