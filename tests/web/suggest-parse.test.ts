/**
 * `<suggest>` action-card parser — the layer that decides whether a click is
 * even possible.
 *
 * Two failure modes drive most of these cases:
 *  - a card that does NOT parse degrades into loose prose (DOMPurify keeps the
 *    text content of unknown tags), so the labels appear as words the user
 *    cannot click. Silently wrong, not visibly broken.
 *  - a card parsed too eagerly renders live buttons out of a code sample that
 *    only DOCUMENTS the syntax, and renders half a card mid-stream.
 */
import { describe, it, expect } from 'vitest';
import { splitSuggestSegments, type SuggestCardSpec } from '@/utils/suggest-parse';

function onlyCard(text: string, scope?: string): SuggestCardSpec {
  const cards = splitSuggestSegments(text, scope).filter((s) => s.kind === 'card');
  expect(cards).toHaveLength(1);
  return (cards[0] as { card: SuggestCardSpec }).card;
}

describe('splitSuggestSegments — plain text', () => {
  it('returns one markdown run when there is no card', () => {
    const text = 'Here is **bold** and a `<code>` sample.';
    expect(splitSuggestSegments(text)).toEqual([{ kind: 'md', text }]);
  });

  it('treats similar words as prose, not a card', () => {
    const text = 'One <suggestion> for you.';
    expect(splitSuggestSegments(text)).toEqual([{ kind: 'md', text }]);
  });

  it('returns nothing for empty text', () => {
    expect(splitSuggestSegments('')).toEqual([]);
  });
});

describe('splitSuggestSegments — one card between markdown', () => {
  const text = [
    'Before the card.',
    '',
    '<suggest title="Triage this">',
    'Pick **one** of these:',
    '<action tool="task_focus_tier_set" args=\'{"id":"t_1","tier":"focus"}\' label="Put to Focus" style="primary"/>',
    '<action dismiss label="Ignore"/>',
    '</suggest>',
    '',
    'After the card.',
  ].join('\n');

  it('keeps the markdown around it, in order', () => {
    const segments = splitSuggestSegments(text);
    expect(segments.map((s) => s.kind)).toEqual(['md', 'card', 'md']);
    expect((segments[0] as { text: string }).text).toContain('Before the card.');
    expect((segments[2] as { text: string }).text).toContain('After the card.');
  });

  it('parses the title, body markdown, and both actions', () => {
    const card = onlyCard(text);
    expect(card.title).toBe('Triage this');
    expect(card.body).toBe('Pick **one** of these:');
    expect(card.multi).toBe(false);
    expect(card.sticky).toBe(false);

    expect(card.actions).toHaveLength(2);
    expect(card.actions[0]).toMatchObject({
      id: 'a0',
      dismiss: false,
      tool: 'task_focus_tier_set',
      args: { id: 't_1', tier: 'focus' },
      label: 'Put to Focus',
      style: 'primary',
    });
    expect(card.actions[0].argsError).toBeUndefined();
    expect(card.actions[1]).toMatchObject({ id: 'a1', dismiss: true, label: 'Ignore', style: 'default' });
    expect(card.actions[1].tool).toBeUndefined();
  });

  it('leaves no action markup behind in the body', () => {
    expect(onlyCard(text).body).not.toContain('<action');
  });

  it('gives the same card id on every parse of the same text', () => {
    expect(onlyCard(text).id).toBe(onlyCard(text).id);
  });
});

describe('splitSuggestSegments — attributes', () => {
  it('reads the multi and sticky flags, bare or valued', () => {
    const bare = onlyCard('<suggest multi sticky><action dismiss label="x"/></suggest>');
    expect(bare.multi).toBe(true);
    expect(bare.sticky).toBe(true);

    const valued = onlyCard('<suggest multi="true" sticky="true"><action dismiss label="x"/></suggest>');
    expect(valued.multi).toBe(true);
    expect(valued.sticky).toBe(true);

    const neither = onlyCard('<suggest><action dismiss label="x"/></suggest>');
    expect(neither.multi).toBe(false);
    expect(neither.sticky).toBe(false);
  });

  it('carries the confirm prompt and normalizes unknown styles', () => {
    const card = onlyCard(
      '<suggest><action tool="task_delete" args=\'{"id":"t_9"}\' confirm="Cannot be undone" label="Delete" style="danger"/>'
      + '<action tool="task_complete" args=\'{"id":"t_9"}\' label="Done" style="rainbow"/></suggest>',
    );
    expect(card.actions[0].confirm).toBe('Cannot be undone');
    expect(card.actions[0].style).toBe('danger');
    expect(card.actions[1].confirm).toBeUndefined();
    expect(card.actions[1].style).toBe('default');
  });

  it('accepts the <action …></action> closing form without leaking it as prose', () => {
    const card = onlyCard('<suggest>Body.<action tool="task_complete" args=\'{"id":"t_1"}\' label="Done"></action></suggest>');
    expect(card.actions).toHaveLength(1);
    expect(card.actions[0].tool).toBe('task_complete');
    expect(card.body).toBe('Body.');
  });

  it('falls back to the tool name when a label is missing', () => {
    const card = onlyCard('<suggest><action tool="task_complete" args=\'{"id":"t_1"}\'/></suggest>');
    expect(card.actions[0].label).toBe('task_complete');
  });

  it('decodes entity-escaped args (double-quoted attribute form)', () => {
    const card = onlyCard('<suggest><action tool="task_complete" args="{&quot;id&quot;:&quot;t_2&quot;}" label="Done"/></suggest>');
    expect(card.actions[0].args).toEqual({ id: 't_2' });
    expect(card.actions[0].argsError).toBeUndefined();
  });

  it('does not let a > inside args end the tag early', () => {
    const card = onlyCard('<suggest><action tool="task_update" args=\'{"id":"t_1","notes":"a > b"}\' label="Note"/></suggest>');
    expect(card.actions).toHaveLength(1);
    expect(card.actions[0].args).toEqual({ id: 't_1', notes: 'a > b' });
    expect(card.body).toBe('');
  });
});

describe('splitSuggestSegments — malformed args', () => {
  it('flags args that are not valid JSON and keeps the button describable', () => {
    const card = onlyCard('<suggest><action tool="task_complete" args=\'{"id": t_1}\' label="Done"/></suggest>');
    expect(card.actions[0].args).toEqual({});
    expect(card.actions[0].argsError).toMatch(/not valid JSON/);
    expect(card.actions[0].label).toBe('Done');
  });

  it('flags args that parse but are not an object', () => {
    for (const raw of ['[1,2]', '"nope"', '42']) {
      const card = onlyCard(`<suggest><action tool="task_complete" args='${raw}' label="Done"/></suggest>`);
      expect(card.actions[0].argsError).toBe('args must be a JSON object');
      expect(card.actions[0].args).toEqual({});
    }
  });

  it('treats an action with no tool as a dismiss, whatever else it carries', () => {
    const card = onlyCard('<suggest><action label="Never mind"/></suggest>');
    expect(card.actions[0].dismiss).toBe(true);
    expect(card.actions[0].tool).toBeUndefined();
  });
});

describe('splitSuggestSegments — markdown inside the body', () => {
  it('keeps lists, code fences, and entity refs untouched for the renderer', () => {
    const card = onlyCard([
      '<suggest title="Pick one">',
      '- first **item**',
      '- second `item`',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      'See <task-ref id="t_1" label="Ship it"/>.',
      '<action tool="task_complete" args=\'{"id":"t_1"}\' label="Complete"/>',
      '</suggest>',
    ].join('\n'));

    expect(card.body).toContain('- first **item**');
    expect(card.body).toContain('```ts');
    expect(card.body).toContain('<task-ref id="t_1" label="Ship it"/>');
    expect(card.actions).toHaveLength(1);
  });

  it('ignores an action tag that only appears inside a fenced sample in the body', () => {
    const card = onlyCard([
      '<suggest title="How to">',
      '```',
      '<action tool="task_delete" args=\'{"id":"x"}\' label="Delete"/>',
      '```',
      '<action dismiss label="Got it"/>',
      '</suggest>',
    ].join('\n'));

    expect(card.actions).toHaveLength(1);
    expect(card.actions[0].dismiss).toBe(true);
    expect(card.body).toContain('<action tool="task_delete"');
  });
});

describe('splitSuggestSegments — code regions outside the card', () => {
  it('renders a fenced sample of the syntax literally', () => {
    const text = [
      'Cards look like this:',
      '',
      '```html',
      '<suggest title="Demo">',
      '<action tool="task_complete" args=\'{"id":"t_1"}\' label="Done"/>',
      '</suggest>',
      '```',
      '',
      'That is all.',
    ].join('\n');

    expect(splitSuggestSegments(text)).toEqual([{ kind: 'md', text }]);
  });

  it('survives a four-backtick fence wrapping inner fences', () => {
    const text = [
      '````md',
      '```',
      '<suggest><action dismiss label="x"/></suggest>',
      '```',
      '````',
    ].join('\n');
    expect(splitSuggestSegments(text)).toEqual([{ kind: 'md', text }]);
  });

  it('renders an inline-code mention literally', () => {
    const text = 'Write `<suggest title="x">` to open a card.';
    expect(splitSuggestSegments(text)).toEqual([{ kind: 'md', text }]);
  });
});

describe('splitSuggestSegments — streaming', () => {
  it('hides a card whose closing tag has not arrived yet', () => {
    const text = 'Working on it.\n\n<suggest title="Triage">\n<action tool="task_complete" args=\'{"id":"t_1"}\'';
    const segments = splitSuggestSegments(text);
    expect(segments.map((s) => s.kind)).toEqual(['md']);
    expect((segments[0] as { text: string }).text).toContain('Working on it.');
    expect((segments[0] as { text: string }).text).not.toContain('task_complete');
  });

  it('hides a partial OPEN tag rather than showing raw markup', () => {
    const text = 'Almost there.\n\n<suggest tit';
    const segments = splitSuggestSegments(text);
    expect(segments).toHaveLength(1);
    expect((segments[0] as { text: string }).text).not.toContain('<suggest');
  });

  it('treats <suggest/> as an empty card, never as an unterminated one', () => {
    // An unterminated card hides everything after it. A self-closing tag must
    // not, or a stray one would swallow a real answer.
    const segments = splitSuggestSegments('Here you go.\n\n<suggest/>\n\nAnd the rest.');
    expect(segments.every((s) => s.kind === 'md')).toBe(true);
    expect(segments.map((s) => (s as { text: string }).text).join(' ')).toContain('And the rest.');
  });

  it('renders the card once the closing tag lands', () => {
    const text = 'Working on it.\n\n<suggest title="Triage">\n<action tool="task_complete" args=\'{"id":"t_1"}\' label="Done"/>\n</suggest>';
    expect(splitSuggestSegments(text).map((s) => s.kind)).toEqual(['md', 'card']);
  });

  it('hides an attribute-less card once its first <action> is streaming', () => {
    const text = 'One sec.\n\n<suggest>\n<action tool="task_complete" args=\'{"id":"t_1"';
    const segments = splitSuggestSegments(text);
    expect(segments.map((s) => s.kind)).toEqual(['md']);
    expect((segments[0] as { text: string }).text).not.toContain('task_complete');
  });
});

describe('splitSuggestSegments — an unclosed tag in prose keeps the answer', () => {
  // A closer is never coming for a prose mention, so "hide to end of text" would
  // delete the rest of the message — on reload too, since history replays this
  // same parse. Losing the answer is far worse than a stray literal tag.
  it('keeps everything after an unfenced prose mention of the tag', () => {
    const text = 'Sure. I can wrap this in a <suggest> card if you like.\n\nHere is the full analysis:\n1. First point\n2. Second point';
    const segments = splitSuggestSegments(text);

    expect(segments.map((s) => s.kind)).toEqual(['md']);
    const rendered = (segments[0] as { text: string }).text;
    expect(rendered).toContain('Here is the full analysis:');
    expect(rendered).toContain('2. Second point');
  });

  it('keeps the answer when the mention is the last thing in the message', () => {
    const text = 'Done. Next time I could offer a <suggest> card for this.';
    expect(splitSuggestSegments(text)).toEqual([{ kind: 'md', text }]);
  });

  it('still renders a card, and the tail, when a mention precedes a real one', () => {
    // The mention is absorbed into the card body here (a closer DOES exist, so
    // first-closer-wins applies, same as the nesting case). What must hold either
    // way: a card renders and the prose after it survives.
    const text = [
      'A <suggest> card looks like this:',
      '',
      '<suggest title="Triage"><action tool="task_complete" args=\'{"id":"t_1"}\' label="Done"/></suggest>',
      '',
      'Tail prose.',
    ].join('\n');
    const segments = splitSuggestSegments(text);

    expect(segments.map((s) => s.kind)).toEqual(['md', 'card', 'md']);
    expect((segments[2] as { text: string }).text).toContain('Tail prose.');
  });
});

describe('splitSuggestSegments — several cards and nesting', () => {
  it('parses sibling cards and keeps their ids distinct', () => {
    const text = [
      '<suggest title="One"><action tool="task_complete" args=\'{"id":"t_1"}\' label="Done"/></suggest>',
      'Middle prose.',
      '<suggest title="Two"><action tool="task_complete" args=\'{"id":"t_2"}\' label="Done"/></suggest>',
    ].join('\n\n');

    const segments = splitSuggestSegments(text);
    expect(segments.map((s) => s.kind)).toEqual(['card', 'md', 'card']);
    const ids = segments.filter((s) => s.kind === 'card').map((s) => (s as { card: SuggestCardSpec }).card.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('keeps two identical cards addressable separately', () => {
    const one = '<suggest title="Same"><action tool="task_complete" args=\'{"id":"t_1"}\' label="Done"/></suggest>';
    const segments = splitSuggestSegments(`${one}\n\n${one}`);
    const ids = segments.filter((s) => s.kind === 'card').map((s) => (s as { card: SuggestCardSpec }).card.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('closes a nested open tag at the FIRST closer and keeps parsing after it', () => {
    // Nesting is not a supported shape; what matters is that it degrades to one
    // card plus prose instead of swallowing the rest of the message.
    const text = '<suggest title="Outer">inner <suggest title="Inner"><action dismiss label="x"/></suggest> tail</suggest>\n\nAfter.';
    const segments = splitSuggestSegments(text);
    expect(segments.some((s) => s.kind === 'card')).toBe(true);
    const tail = segments.filter((s) => s.kind === 'md').map((s) => (s as { text: string }).text).join(' ');
    expect(tail).toContain('After.');
  });
});

// The id is the receipt's persistence key, so these three properties decide
// whether a click is remembered — and whether it is remembered for the RIGHT card.
describe('card identity', () => {
  const card = '<suggest title="Pin this task">'
    + '<action tool="task_pin_set" args=\'{"id":"t_1","pinned":true}\' label="Pin it" style="primary"/>'
    + '</suggest>';

  it('gives the SAME id in the same message on every parse, so a reload restores the receipt', () => {
    const message = `That task is not pinned yet.\n\n${card}\n\nAsk again if you want it unpinned.`;
    expect(onlyCard(message).id).toBe(onlyCard(message).id);
  });

  it('gives DIFFERENT ids to the same card in two different messages', () => {
    // Was one shared key: clicking the first card rendered the second one settled
    // over an op the user never ran.
    const first = onlyCard(`That task is not pinned yet.\n\n${card}`);
    const second = onlyCard(`Still not pinned.\n\n${card}`);
    expect(first.id).not.toBe(second.id);
  });

  it('does not renumber a card while the rest of the message is still streaming', () => {
    // The user can click as soon as the card renders, so its id must already be
    // final: a tail-dependent id would persist the receipt under a key that no
    // longer exists once the turn finishes.
    const prefix = `Here you go.\n\n${card}`;
    const settled = onlyCard(prefix).id;
    expect(onlyCard(`${prefix}\n\nOne more`).id).toBe(settled);
    expect(onlyCard(`${prefix}\n\nOne more thing to note.`).id).toBe(settled);
  });
});

// The residual hole the text-only key left open: two messages whose text is
// byte-identical up to and including the card shared ONE receipt, so clicking the
// first rendered the second already-settled over an op the user never ran. The fix
// is a real per-message id (`scope`) folded into the key — the chat lane's turn
// uuid, the session lane's message uuid.
//
// The scope's one hard requirement: it must be the SAME value in the live render
// and after a reload. These cases pin both directions of that.
describe('card identity — per-message scope', () => {
  const card = '<suggest title="Pin this task">'
    + '<action tool="task_pin_set" args=\'{"id":"t_1","pinned":true}\' label="Pin it" style="primary"/>'
    + '</suggest>';
  // Byte-identical text, twice. Before the scope these collided.
  const message = `Not pinned yet.\n\n${card}`;

  it('separates two messages with byte-identical text', () => {
    expect(onlyCard(message, 'turn-a').id).not.toBe(onlyCard(message, 'turn-b').id);
  });

  it('gives the same id for the same scope, so the reloaded card keeps its receipt', () => {
    // This is the whole persistence contract: the browser renders the streaming
    // turn under scope X, the server stores it and hands it back under scope X.
    expect(onlyCard(message, 'turn-a').id).toBe(onlyCard(message, 'turn-a').id);
  });

  it('still separates two identical cards in DIFFERENT text blocks of ONE message', () => {
    // One message can hold several text blocks, each split on its own — so
    // `occurrence` restarts at 0 per block and only the preceding text tells
    // these apart. Dropping it in favour of the scope alone would re-collide.
    const blockA = `First take.\n\n${card}`;
    const blockB = `Second take.\n\n${card}`;
    expect(onlyCard(blockA, 'turn-a').id).not.toBe(onlyCard(blockB, 'turn-a').id);
  });

  it('still separates two identical cards inside ONE block', () => {
    const cards = splitSuggestSegments(`${card}\n${card}`, 'turn-a')
      .filter((s) => s.kind === 'card')
      .map((s) => (s as { card: SuggestCardSpec }).card.id);
    expect(cards).toHaveLength(2);
    expect(cards[0]).not.toBe(cards[1]);
  });

  it('keeps a scoped id final while the tail is still streaming', () => {
    // The user can click the moment the card renders, so its key must already be
    // the key the finished message will parse to.
    const settled = onlyCard(message, 'turn-a').id;
    expect(onlyCard(`${message}\n\nOne more`, 'turn-a').id).toBe(settled);
    expect(onlyCard(`${message}\n\nOne more thing entirely.`, 'turn-a').id).toBe(settled);
  });

  it('falls back to the text-only key when no scope is available', () => {
    // Cron/heartbeat turns and mobile-initiated turns carry no id. Both sides of
    // the reload see `undefined`, so the fallback has to be self-consistent —
    // an empty-string scope must not be a different key than no scope at all.
    expect(onlyCard(message).id).toBe(onlyCard(message, undefined).id);
    expect(onlyCard(message).id).toBe(onlyCard(message, '').id);
    expect(onlyCard(message).id).not.toBe(onlyCard(message, 'turn-a').id);
  });

  it('scopes every card in a multi-card message', () => {
    const two = `${card}\n\nAnd also:\n\n${card.replace('t_1', 't_2')}`;
    const a = splitSuggestSegments(two, 'turn-a').filter((s) => s.kind === 'card');
    const b = splitSuggestSegments(two, 'turn-b').filter((s) => s.kind === 'card');
    expect(a).toHaveLength(2);
    for (let i = 0; i < a.length; i++) {
      const idA = (a[i] as { card: SuggestCardSpec }).card.id;
      const idB = (b[i] as { card: SuggestCardSpec }).card.id;
      expect(idA).not.toBe(idB);
    }
  });
});
