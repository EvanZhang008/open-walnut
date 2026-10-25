/**
 * Unit tests for the splitter that takes Walnut's own notices off the FRONT of a
 * stored user message (place note, org digest, routing rules, app state), so the
 * person's words after them keep their user bubble.
 *
 * The riders are built by the production builders, composed exactly the way
 * session-message-queue.ts composes a row (`${notes}\n\n${body}`). Most of the
 * file is the unsafe half: a splitter that hides a person's words on bad input
 * is worse than the bug it fixes, so every malformed shape must return null
 * (render as before) and lose nothing.
 */
import { describe, expect, it } from 'vitest';
import { splitLeadingRiders, withoutLeadingRiders } from '@open-walnut/history-walnut-riders';
import { typedUserText } from '@open-walnut/history-injected-banner';
import { buildDigestText } from '../../src/core/org/org-store';
import { buildPlaceNoticeText } from '../../src/core/sessions/place-notice';
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit';
import { CATCH_UP_BANNER_CLOSE, CATCH_UP_BANNER_OPEN } from '../../src/core/chat-history';
import { IMAGES_ATTACHED_LINE } from '../../src/core/sessions/cloud-images';
import { dedupeOptimisticMessages } from '@/components/sessions/optimistic-dedup';

const kit = createEnvelopeKit();
const NOW = Date.parse('2026-10-24T12:00:00Z');
const org = buildDigestText({ id: 'task-main', title: 'Main' }, ['Sample lead finished the review'], 2,
  new Date(NOW - 14 * 60_000).toISOString(), NOW);
const moved = buildPlaceNoticeText({ id: 'task-a', title: 'Sample task' }, { project: 'Sample' }, ['project "Old" became "Sample"']);
const routing = kit.buildWalnutMessage({
  kind: 'notification',
  attrs: { from: 'Walnut', outcome: 'task-routing-policy', note: 'current product rules, not a work request' },
  body: 'These current product rules replace older instructions.\n\nRule one.\n\nRule two.',
});
const appState = kit.buildWalnutMessage({
  kind: 'app-state',
  attrs: { from: 'Sample App', 'about-task': 'task-a', title: '1 change', note: 'automated app state, background only' },
  body: 'Changed in Sample App since you last saw it:\ncount = 3',
});
const notice = (outcome: string, from = 'Walnut') => kit.buildWalnutMessage({
  kind: 'notification', attrs: { from, outcome, note: 'automated Walnut status notice' }, body: 'Some status line.',
});
const trigger = kit.buildWalnutMessage({ kind: 'trigger', attrs: { from: 'Trigger: sample', note: 'fired' }, body: 'Check the feed.' });
const peer = kit.buildWalnutMessage({ kind: 'peer-note', attrs: { from: 'Other [abcd1234]' }, body: 'Please look.' });
/** How the queue composes a row. */
const row = (notes: string[], body: string) => `${notes.join('\n\n')}\n\n${body}`;

describe('splitLeadingRiders: the rows Walnut writes', () => {
  it('splits an org digest off the words, verbatim', () => {
    const words = 'First paragraph.\n\nSecond paragraph.';
    const split = splitLeadingRiders(row([org], words));
    expect(split?.body).toBe(words);
    expect(split?.riders.map((r) => r.kind)).toEqual(['notification']);
    expect(split?.riders[0].raw).toBe(org);
  });

  it('keeps an image block, a quote and several paragraphs in the body', () => {
    const words = `${IMAGES_ATTACHED_LINE}\n- /tmp/a.png\n\nLook.\n\n> quoted\n\nEnd.`;
    expect(splitLeadingRiders(row([org], words))?.body).toBe(words);
  });

  it('splits all four riders in the queue order', () => {
    const split = splitLeadingRiders(row([moved, routing, org, appState], 'The words.'));
    expect(split?.riders.map((r) => r.kind)).toEqual(['notification', 'notification', 'notification', 'app-state']);
    expect(split?.riders.map((r) => r.raw)).toEqual([moved, routing, org, appState]);
    expect(split?.body).toBe('The words.');
  });

  it('leaves what follows the riders to the old path: a trigger or peer envelope stays the body', () => {
    expect(splitLeadingRiders(row([org], trigger))?.body).toBe(trigger);
    expect(splitLeadingRiders(row([moved], peer))?.body).toBe(peer);
  });

  it('a rider followed by a non-rider tag ends the run there', () => {
    const text = row([org, notice('other')], 'Words.');
    const split = splitLeadingRiders(text);
    expect(split?.riders).toHaveLength(1);
    expect(split?.body).toBe(`${notice('other')}\n\nWords.`);
  });

  it('a plain message, and a message that only mentions a rider, are not touched', () => {
    expect(splitLeadingRiders('Just words.')).toBeNull();
    expect(splitLeadingRiders(`About this:\n${org}`)).toBeNull();
    expect(splitLeadingRiders('')).toBeNull();
  });
});

describe('splitLeadingRiders: unsafe shapes return null and lose nothing', () => {
  it('an outcome outside the closed list', () => {
    expect(splitLeadingRiders(row([notice('some-other')], 'Words.'))).toBeNull();
    expect(splitLeadingRiders(row([notice('completed')], 'Words.'))).toBeNull();
  });

  it('a rider outcome from someone other than Walnut', () => {
    expect(splitLeadingRiders(row([notice('moved', 'Someone')], 'Words.'))).toBeNull();
  });

  it('a rider that never closes', () => {
    const cut = org.slice(0, org.lastIndexOf('\n</walnut-message>'));
    expect(splitLeadingRiders(`${cut}\n\nWords that must stay.`)).toBeNull();
  });

  it('a rider that never closes cannot borrow the close of a later envelope', () => {
    const cut = org.slice(0, org.lastIndexOf('\n</walnut-message>'));
    expect(splitLeadingRiders(`${cut}\n\nWords that must stay.\n\n${trigger}`)).toBeNull();
  });

  it('a rider not followed by a blank line', () => {
    expect(splitLeadingRiders(`${org}\nWords glued on.`)).toBeNull();
  });

  it('a rider and nothing else (an envelope-only row keeps its old path)', () => {
    expect(splitLeadingRiders(org)).toBeNull();
    expect(splitLeadingRiders(`${org}\n\n   \n`)).toBeNull();
    expect(splitLeadingRiders(row([moved, org], ''))).toBeNull();
  });

  it('a rider after leading whitespace or text is not leading', () => {
    expect(splitLeadingRiders(` ${row([org], 'Words.')}`)).toBeNull();
    expect(splitLeadingRiders(`Words first.\n\n${org}`)).toBeNull();
  });

  it('a rider-shaped line inside a code fence of the words is the words', () => {
    const words = `See this:\n\`\`\`\n${org}\n\`\`\``;
    expect(splitLeadingRiders(row([moved], words))?.body).toBe(words);
  });

  it('withoutLeadingRiders is the identity whenever the split is null', () => {
    for (const t of ['x', org, `Words first.\n\n${org}`, row([notice('x')], 'w')]) expect(withoutLeadingRiders(t)).toBe(t);
  });
});

describe('typedUserText: one body for previews, counts, thread titles and text dedup', () => {
  it('takes riders off first, then the bracket blocks', () => {
    const banner = `${CATCH_UP_BANNER_OPEN}\nrecap\n${CATCH_UP_BANNER_CLOSE}`;
    expect(typedUserText(row([org], `${banner}\n\nThe words.`))).toBe('The words.');
    expect(typedUserText(row([moved, appState], 'The words.'))).toBe('The words.');
  });

  it('an old row with no riders reads exactly as before', () => {
    expect(typedUserText('Plain.')).toBe('Plain.');
    expect(typedUserText(org)).toBe(org);
  });
});

describe('text dedup: a rider-led history row consumes the bubble of the words', () => {
  // The id path (echo claims) holds the rider bytes and is in-memory: a server
  // restart drops it, and then only the text path stands between the person
  // and two copies of their message.
  const persisted = (text: string) => ({
    role: 'user' as const, text, timestamp: new Date(NOW + 1_000).toISOString(), msgId: '0199ce01-0000-4aaa-8bbb-000000000001',
  });

  it('one bubble, consumed by the words after the riders', () => {
    const out = dedupeOptimisticMessages([{ text: 'The words.', status: 'delivered', queueId: 'qm-1' }],
      [persisted(row([moved, org], 'The words.'))], 0);
    expect(out).toHaveLength(0);
  });

  it('with an image preamble the server reports as dedupText', () => {
    const words = `${IMAGES_ATTACHED_LINE}\n- /tmp/a.png\n\nLook.`;
    const out = dedupeOptimisticMessages([{ text: 'Look.', dedupText: words, status: 'delivered', queueId: 'qm-2' }],
      [persisted(row([org], words))], 0);
    expect(out).toHaveLength(0);
  });

  it('a rider-only row accounts for no bubble', () => {
    const out = dedupeOptimisticMessages([{ text: 'The words.', status: 'delivered', queueId: 'qm-3' }], [persisted(org)], 0);
    expect(out).toHaveLength(1);
  });
});
