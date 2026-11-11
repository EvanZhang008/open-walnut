/**
 * A letter id written in agent text (`lt-mvx2abcd-9f3k`) becomes a link that
 * opens that letter (utils/open-anywhere.ts). Agents refer to a letter by its
 * id ("the video is in letter lt-..."); before this, the user read the id and
 * had to go find the letter himself (2026-11-02: "u can give me a link to the
 * letter").
 *
 * Runs on marked's OUTPUT like linkBareTaskIds: never inside an anchor or an
 * element where a link is invalid; inside code the id is linked in place with
 * its text unchanged. The shape is the store's own (`LETTER_ID_RE` in
 * src/core/human-inbox/normalize.ts); dependency-free so the markdown test tier
 * runs it in a bare node env.
 */
import { anchorRanges, NO_LINK_ELEMENTS, splitHtml, TAG_NAME_RE } from './bare-task-ids';
// The store's letter id shape, shared with the server's letter body linker.
import { LETTER_ID_SRC } from '../../../src/lib/letter-id-shape';

export { LETTER_ID_SRC };

export function letterAnchor(id: string): string {
  return `<a class="letter-link" data-letter-id="${id}" href="#" title="Open this letter">${id}</a>`;
}

export function linkLetterIds(html: string): string {
  if (!html.includes('lt-') || !new RegExp(LETTER_ID_SRC).test(html)) return html;
  const parts = splitHtml(html);
  const anchors = anchorRanges(html);
  let nextAnchor = 0;
  const inAnchor = (at: number): boolean => {
    while (nextAnchor < anchors.length && anchors[nextAnchor]![1] <= at) nextAnchor++;
    const a = anchors[nextAnchor];
    return !!a && a[0] <= at && at < a[1];
  };
  let noLinkDepth = 0;
  let changed = false;
  const out: string[] = [];
  for (const p of parts) {
    if (p.tag) {
      const name = TAG_NAME_RE.exec(p.s)?.[1]?.toLowerCase();
      if (name && NO_LINK_ELEMENTS.has(name)) {
        if (p.s.startsWith('</')) noLinkDepth = Math.max(0, noLinkDepth - 1);
        else if (!p.s.endsWith('/>')) noLinkDepth++;
      }
      out.push(p.s);
      continue;
    }
    if (noLinkDepth > 0 || inAnchor(p.at)) { out.push(p.s); continue; }
    const next = p.s.replace(new RegExp(LETTER_ID_SRC, 'g'), (id) => letterAnchor(id));
    if (next !== p.s) changed = true;
    out.push(next);
  }
  return changed ? out.join('') : html;
}
