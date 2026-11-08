/**
 * Every Ask card in a file view follows its passage as the document scrolls, and is not drawn
 * while the passage is out of the view, whatever state the card is in (2026-11-11 WebKit
 * review: an answered card stayed on screen over other lines while its passage scrolled away;
 * an empty new-question card seemed to follow). The cause was the placement, not the card: a
 * card was pushed back into the box to keep its height and docked at the edge, and the taller a
 * card (an answered one), the sooner it stopped moving with its passage.
 *
 * The node tier has no DOM, so a scrolled document is modelled in host coordinates (the
 * passage's top is its offset in the document less the scroll), and each card state is the
 * height it measures at (`need`, kept while the card stays open). Source guards then pin that
 * nothing about a card's place reads its state, and list every place a card is drawn.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CARD_GAP } from '../../web/src/utils/thread-card';
import { fileCardAway, placeFileCardBelow, type HostRect } from '../../web/src/utils/file-thread';

const WEB = path.join(path.dirname(new URL(import.meta.url).pathname), '../../web/src');
const src = (p: string) => readFileSync(path.join(WEB, p), 'utf8');

/** The card states and the heights they measure at (a draft is small, an answer tall). */
const STATES: Record<string, number> = { empty: 96, sending: 130, answered: 460, error: 170, 'answered-short': 210 };
/** Three views: a short window (the 1280x560 review), a tall one, the Changed tab without a header. */
const VIEWS = [
  { name: 'short', host: { width: 900, height: 520 }, inset: 48 },
  { name: 'tall', host: { width: 1200, height: 900 }, inset: 64 },
  { name: 'no header', host: { width: 700, height: 600 }, inset: 0 },
];

describe('an Ask card follows its passage in every state', () => {
  for (const view of VIEWS) {
    for (const [state, need] of Object.entries(STATES)) {
      it(`${state} card, ${view.name} view: beside its passage while it shows, away once it is gone`, () => {
        const { host, inset } = view;
        const passage = { docTop: 1400, height: 22 };
        let prev: { scroll: number; top: number; above: boolean } | null = null;
        let shown = 0;
        let away = 0;
        for (let scroll = 0; scroll <= 3200; scroll += 7) {
          const top = passage.docTop - scroll;
          const anchor: HostRect = { top, bottom: top + passage.height, left: 40, right: 600 };
          const place = placeFileCardBelow(anchor, host, inset, undefined, need);
          const out = anchor.bottom <= inset || anchor.top >= host.height;
          expect(!!place.away, `scroll ${scroll}`).toBe(out);
          expect(fileCardAway(anchor, host, inset)).toBe(out);
          if (out) { away++; prev = null; continue; }
          shown++;
          const above = place.bottom !== undefined;
          if (above) expect(host.height - place.bottom!, `foot at scroll ${scroll}`).toBe(Math.round(anchor.top - CARD_GAP));
          else expect(place.top, `top at scroll ${scroll}`).toBe(Math.round(anchor.bottom + CARD_GAP));
          // Never over the header, never past the bottom.
          expect(place.top).toBeGreaterThanOrEqual(inset);
          expect(place.top + place.maxHeight).toBeLessThanOrEqual(host.height);
          // On the same side, it moves exactly as far as the passage does.
          if (prev && prev.above === above && !above) expect(place.top - prev.top).toBe(-(scroll - prev.scroll));
          prev = { scroll, top: place.top, above };
        }
        expect(shown).toBeGreaterThan(10);
        expect(away).toBeGreaterThan(10);
      });
    }
  }

  it('the reported case: a tall answered card no longer stays put while its passage leaves the bottom', () => {
    const host = { width: 900, height: 520 };
    const inset = 48;
    const tops = [430, 470, 500, 515].map((t) => placeFileCardBelow({ top: t, bottom: t + 22, left: 40, right: 600 }, host, inset, undefined, 460));
    const feet = tops.map((p) => host.height - p.bottom!);
    // Each step down moves the card's foot down with the passage (it used to stay at one foot).
    for (let i = 1; i < feet.length; i++) expect(feet[i]).toBeGreaterThan(feet[i - 1]);
    expect(placeFileCardBelow({ top: 521, bottom: 543, left: 40, right: 600 }, host, inset, undefined, 460).away).toBe(true);
  });
});

describe('nothing about a card place reads the card state', () => {
  const card = src('components/sessions/ThreadCommentCard.tsx');
  const placeExpr = card.slice(card.indexOf('const place = fill'), card.indexOf('return (', card.indexOf('const place = fill')));

  it('the card draws where its owner places it: fixed only in its own full screen, hidden only when away', () => {
    expect(placeExpr.length).toBeGreaterThan(100);
    // No state of the card (draft, sending, answering, waiting, its status, a failure) decides its place.
    expect(placeExpr).not.toMatch(/\bp\.(draft|answering|waiting|queued|status|unread|canAsk)\b|\bsending\b|\bfailed\b|\berror\b/);
    // `position: fixed` only for full screen (a file card never gets a fillRef).
    const fixed = [...card.matchAll(/position: *['"]fixed['"]/g)];
    expect(fixed).toHaveLength(1);
    expect(placeExpr).toMatch(/const place = fill\s*\?\s*\{ position: 'fixed'/);
    expect(placeExpr).toMatch(/p\.style\.away \? \{ visibility: 'hidden'/);
  });

  it('every ThreadCommentCard is drawn in a scrolling layer or at the file host place (a new one is listed here)', () => {
    const files = ['components/sessions/SessionChatHistory.tsx'];
    const chat = src(files[0]);
    const uses = [...chat.matchAll(/<ThreadCommentCard\b[\s\S]*?\n\s*(?:\/>|>)\n/g)].map((m) => m[0]);
    expect(uses).toHaveLength(2);
    // The timeline's card: in the layer at the top of the content, which scrolls with it.
    expect(uses[0]).toMatch(/style=\{cardPlace\}/);
    // The file card: the place the file view measures (placeFileCardBelow), never a full-screen box.
    expect(uses[1]).toMatch(/style=\{cardFileHost\.place\}/);
    expect(uses[1]).not.toMatch(/fillRef/);
    // No other file draws the card.
    const all = (dir: string): string[] => {
      return readdirSync(path.join(WEB, dir), { withFileTypes: true }).flatMap((d) => (
        d.isDirectory() ? all(path.join(dir, d.name)) : /\.tsx$/.test(d.name) ? [path.join(dir, d.name)] : []));
    };
    const drawing = all('.').filter((f) => /<ThreadCommentCard\b/.test(src(f))).map((f) => f.replace(/^\.\//, ''));
    expect(drawing).toEqual(files);
  });

  it('the file layer measures on every scroll and marks a lost passage away, for every state', () => {
    const layer = src('components/common/FileThreadLayer.tsx');
    const start = layer.indexOf('const measure = (canRender: boolean)');
    const end = layer.indexOf('measure(false);', start);
    const measure = layer.slice(start, end);
    expect(start).toBeGreaterThan(0);
    // The place reads the passage, the header and the card's measured height, never its state.
    expect(measure).not.toMatch(/\b(answering|waiting|unread|status|sending|failed|draftPages)\b/);
    expect(measure).toMatch(/placeFileCardBelow\(anchor, host, inset, minLeft, need\)/);
    expect(measure).toMatch(/lost \? \{ \.\.\.place, away: true \}/);
    // Re-placed on every scroll of the file, attached for whichever card is open.
    // Within the same effect: up to its cleanup.
    expect(layer.slice(end, layer.indexOf('return () =>', end))).toMatch(/root\.addEventListener\('scroll', later, true\)/);
    // And the shared place compares `away`, so a card is hidden and shown again.
    expect(src('hooks/useSessionThreads.ts')).toMatch(/!!a\.away === !!b\.away/);
  });
});
