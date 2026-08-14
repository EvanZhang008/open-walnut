import { describe, it, expect } from 'vitest';
import { renderMarkdownWithRefs } from '@/utils/markdown';

/**
 * Contract: the lane-mode focused-task prefix (`Re: <task-ref id label/>`)
 * emitted by MainPage.handleSendMessage renders as a clickable task pill in
 * the session chat history — NOT as raw bracket/XML text.
 *
 * The reported bug (reported with screenshot: user bubble): lane sends prefixed
 * the raw text `[Regarding task "…" (id: …)]`, which the session renderer has
 * no rule for, so the user saw the bracket dump verbatim. The fix emits the
 * same <task-ref/> tag the agent side uses; both chat and session bubbles
 * share renderMarkdownWithRefs, so one emission format covers both surfaces.
 */

/**
 * Mirror of the escaper in MainPage.handleSendMessage's lane branch — the
 * same contract as server taskRefTag (escape ONLY `"`; decodeRefAttr on the
 * render side undoes only &quot;).
 */
const esc = (s: string) => s.replace(/"/g, '&quot;');

describe('lane focused-task prefix renders as a task pill', () => {
  it('plain title: anchor with data-task-id, no raw tag leaks', () => {
    const text = `Re: <task-ref id="t-abc123-217f" label="${esc('Acme invoice review')}"/>\nwhat is the status?`;
    const html = renderMarkdownWithRefs(text);
    expect(html).toContain('data-task-id="t-abc123-217f"');
    expect(html).toContain('class="task-link"');
    expect(html).toContain('Acme invoice review');
    expect(html).not.toContain('<task-ref');
    expect(html).toContain('what is the status?');
  });

  it('title with quotes and ampersand survives the attr round-trip', () => {
    const title = 'Fix "A & B" dispute';
    const text = `Re: <task-ref id="t-1" label="${esc(title)}"/>\nhi`;
    const html = renderMarkdownWithRefs(text);
    // decodeRefAttr unescapes &quot; then the anchor body re-escapes for HTML.
    expect(html).toContain('Fix &quot;A &amp; B&quot; dispute');
    expect(html).not.toContain('<task-ref');
  });
});
