/**
 * Every card in the corner stack can be closed (2026-11-22, the user, of a quick bar receipt that
 * said "Not sent" and stayed with nothing to close it: "why there is no x so that i cna close").
 *
 * This fails when a NoticeCard drawn into the stack (a file that renders <CornerSlot> or calls
 * appendToCornerStack) has no × of its own: NoticeCard's `onClose`, or a `wn-notice-x` button in
 * its `end`. An approval waits on a script, so its control there makes it smaller instead of
 * closing it; the "N more" pills open the rest and are not notices.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sources = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'web/src/**/*.tsx'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean).filter((f) => fs.existsSync(path.join(ROOT, f)));

/** A card that is not a notice of its own, or closes another way, and why. */
const NO_X: Array<[RegExp, string]> = [
  [/wn-notice-pill|corner-more|-more\b/, 'an "N more" pill: it opens the rest'],
  [/approval-card/, 'an approval waits on a script: its control makes it smaller (approval-minimize)'],
];

/** Each <NoticeCard ...> element's text: up to its `</NoticeCard>`, never past the next card (a
 *  self-closing one ends there). Its props hold JSX of their own, so a `/>` is no end. */
function cards(src: string): string[] {
  const out: string[] = [];
  for (let at = src.indexOf('<NoticeCard'); at !== -1; at = src.indexOf('<NoticeCard', at + 1)) {
    const ends = [src.indexOf('</NoticeCard>', at), src.indexOf('<NoticeCard', at + 1)].filter((i) => i !== -1);
    out.push(src.slice(at, Math.min(...ends, src.length)));
  }
  return out;
}

describe('every card in the corner stack can be closed', () => {
  const inStack = sources.filter((f) => !f.endsWith('components/common/corner-stack.tsx'))
    .filter((f) => /<CornerSlot\b|appendToCornerStack\(/.test(read(f)) && /<NoticeCard\b/.test(read(f)));

  it('finds the notices it guards', () => {
    expect(inStack).toEqual(expect.arrayContaining([
      'web/src/components/quickbar/QuickBarReceipts.tsx',
      'web/src/components/common/FileAskNotice.tsx',
      'web/src/components/common/NotificationToaster.tsx',
    ]));
  });

  it('each NoticeCard there has its ×', () => {
    const bad: string[] = [];
    for (const f of inStack) {
      for (const card of cards(read(f))) {
        if (NO_X.some(([re]) => re.test(card.slice(0, 400)))) continue;
        if (/\bonClose=|wn-notice-x/.test(card)) continue;
        bad.push(`${f}: ${card.slice(0, 120).replace(/\s+/g, ' ')}`);
      }
    }
    expect(bad, 'Give the card NoticeCard\'s onClose (the one ×), or list here why it closes another way').toEqual([]);
  });

  it('the × is the one NoticeCard draws', () => {
    const card = read('web/src/components/common/NoticeCard.tsx');
    expect(card).toMatch(/onClose\?: \(\) => void;/);
    expect(card).toMatch(/className="wn-notice-x"/);
  });
});
