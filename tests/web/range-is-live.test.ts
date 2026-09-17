/**
 * `rangeIsLive` (`web/src/utils/text-quote-anchor.ts`): does a Range still address
 * its passage after React re-rendered the body under it?
 *
 * The trap it encodes (see the quote-pin paint hook, where it was first measured): a
 * DOM removal re-points a Range's boundaries at the removed node's parent, so the
 * Range comes back COLLAPSED on an ELEMENT — `isConnected` still true, no client
 * rects, paints nothing. Shared by the pin paint and by the quote pill's held
 * passage, both of which re-locate from the captured quote when this says no.
 *
 * linkedom's Range has none of the live-mutation behaviour, so the shapes below are
 * plain boundary objects over real linkedom nodes: what is pinned is the RULE
 * (collapsed / element containers / detached nodes), not the browser's mutation.
 */
import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import { rangeIsLive } from '../../web/src/utils/text-quote-anchor';

const { window, document } = parseHTML('<!DOCTYPE html><html><body><p id="p">The writer never blocks.</p></body></html>');
Object.assign(globalThis, { window, document, Node: window.Node });

const p = document.getElementById('p')!;
const text = p.firstChild as Text;

function range(shape: { start: Node; startOffset: number; end: Node; endOffset: number }): Range {
  return {
    collapsed: shape.start === shape.end && shape.startOffset === shape.endOffset,
    startContainer: shape.start,
    endContainer: shape.end,
    startOffset: shape.startOffset,
    endOffset: shape.endOffset,
  } as unknown as Range;
}

describe('rangeIsLive', () => {
  it('a range over a connected text node is live', () => {
    expect(rangeIsLive(range({ start: text, startOffset: 4, end: text, endOffset: 10 }))).toBe(true);
  });

  it('a collapsed range is not — that is the shape a removed text node leaves behind', () => {
    expect(rangeIsLive(range({ start: text, startOffset: 4, end: text, endOffset: 4 }))).toBe(false);
  });

  it('element containers are not — the boundaries were re-pointed at the parent', () => {
    expect(rangeIsLive(range({ start: p, startOffset: 0, end: p, endOffset: 1 }))).toBe(false);
  });

  it('a text node that left the document is not', () => {
    const orphan = document.createTextNode('gone');
    expect(rangeIsLive(range({ start: orphan, startOffset: 0, end: orphan, endOffset: 4 }))).toBe(false);
  });
});
