/**
 * `--wn-scrollbar-h` — the measured cost of a scrollbar, which code blocks
 * subtract from their bottom padding (web/src/utils/scrollbar-metrics.ts).
 *
 * The number itself can only be measured by a real engine (6px in the Mac app,
 * 0px where scrollbars overlay, ~15px on Windows), and the browser tier pins it:
 * tests/e2e/browser/code-block-hscroll-overlap{,.webkit}.spec.ts assert
 * `padding-bottom + reserved === the surface's design bottom edge`.
 *
 * What can only be pinned HERE is the contract when there is nothing to measure.
 * linkedom has no layout at all, so every box is 0×0 — exactly the shape a broken
 * or detached document produces. The util must answer 0 (meaning "compensate
 * nothing", which leaves the design padding intact) and must still publish the
 * property, because CSS reading an unset var falls back to its own `0px` default
 * and a missing property would be indistinguishable from a real 0 — but a
 * property that is never set at all means main.tsx was never wired up.
 */
import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { measureScrollbarHeight, publishScrollbarMetrics, SCROLLBAR_H_VAR } from '../../web/src/utils/scrollbar-metrics';

const html = '<!doctype html><html><body><div id="app"></div></body></html>';

describe('scrollbar metrics', () => {
  it('answers 0 when the document has no layout, rather than a negative padding', () => {
    const { document } = parseHTML(html);
    expect(measureScrollbarHeight(document as unknown as Document)).toBe(0);
  });

  it('publishes the property on <html> and leaves no probe behind', () => {
    const { document } = parseHTML(html);
    const doc = document as unknown as Document;
    const value = publishScrollbarMetrics(doc);

    expect(value).toBe(0);
    expect(doc.documentElement.style.getPropertyValue(SCROLLBAR_H_VAR)).toBe('0px');
    // The probe is a real element appended to the body; leaking one per call would
    // grow the DOM on every publish.
    expect(doc.body.children.length).toBe(1);
    expect(doc.body.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('is idempotent — publishing twice leaves one value and no extra nodes', () => {
    const { document } = parseHTML(html);
    const doc = document as unknown as Document;
    publishScrollbarMetrics(doc);
    publishScrollbarMetrics(doc);

    expect(doc.documentElement.style.getPropertyValue(SCROLLBAR_H_VAR)).toBe('0px');
    expect(doc.body.children.length).toBe(1);
  });
});
