/**
 * Unit tests for the leading-banner splitter behind the session panel's folded
 * "Context Walnut added" row.
 *
 * The happy shape is built from the REAL server constants
 * (`CATCH_UP_BANNER_OPEN`/`CLOSE`) and composed exactly the way `lane-turn.ts`
 * composes it, so a wording drift on the server breaks this file instead of
 * silently putting the injected prose back inside the user's chat bubble.
 *
 * The rest of the file is the malformed half, which matters more: a parser that
 * swallows a real message on bad input is worse than the artifact it removes.
 * Every case below asserts the human's typed words survive.
 */
import { describe, it, expect } from 'vitest';
import {
  CATCH_UP_BANNER_OPEN,
  CATCH_UP_BANNER_CLOSE,
} from '../../src/core/chat-history';
import {
  splitLeadingBanners,
  injectedBannerLabel,
} from '../../web/src/components/sessions/injected-banner';

/** The recap body the server injects (shape only — content is a rendered recap). */
const RECAP = [
  '## Conversation turns you have not seen (injected by Walnut)',
  'These turns are part of THIS conversation and the user can see them.',
  '',
  '### User',
  'RECAP_BODY_MARKER',
].join('\n');

/** Composed exactly as src/core/sessions/lane-turn.ts composes it. */
function laneMessage(userText: string): string {
  return `${CATCH_UP_BANNER_OPEN}\n${RECAP}\n${CATCH_UP_BANNER_CLOSE}\n\n${userText}`;
}

describe('splitLeadingBanners — the shapes Walnut actually writes', () => {
  it('peels the block off the front and leaves the typed text as the body', () => {
    const split = splitLeadingBanners(laneMessage('so what about that?'));
    expect(split).not.toBeNull();
    expect(split!.banners).toHaveLength(1);
    expect(split!.banners[0].name).toBe('Conversation context');
    expect(split!.banners[0].label).toBe('Context Walnut added');
    expect(split!.banners[0].body).toContain('RECAP_BODY_MARKER');
    // The human's words, and ONLY the human's words.
    expect(split!.body).toBe('so what about that?');
    expect(split!.body).not.toContain('RECAP_BODY_MARKER');
    expect(split!.body).not.toContain('[Conversation context]');
  });

  it('keeps a multi-line typed message intact, blank lines and all', () => {
    const typed = 'first line\n\nsecond paragraph\n- a bullet';
    const split = splitLeadingBanners(laneMessage(typed));
    expect(split!.body).toBe(typed);
  });

  it('reports the exact slice it consumed as raw', () => {
    const split = splitLeadingBanners(laneMessage('hi'));
    expect(split!.banners[0].raw.startsWith(CATCH_UP_BANNER_OPEN)).toBe(true);
    expect(split!.banners[0].raw.endsWith(CATCH_UP_BANNER_CLOSE)).toBe(true);
  });

  it('handles a turn that is ONLY the block, with no typed text', () => {
    const onlyBlock = `${CATCH_UP_BANNER_OPEN}\n${RECAP}\n${CATCH_UP_BANNER_CLOSE}`;
    const split = splitLeadingBanners(onlyBlock);
    expect(split!.banners).toHaveLength(1);
    // Empty body is the signal the caller uses to drop the bubble chrome.
    expect(split!.body).toBe('');
  });

  it('handles the same turn when the trailing blank lines are still there', () => {
    const split = splitLeadingBanners(laneMessage(''));
    expect(split!.banners).toHaveLength(1);
    expect(split!.body).toBe('');
  });

  it('peels several stacked banner kinds, in order', () => {
    const text = [
      '[Task Context]',
      'id: task-abc',
      '[/Task Context]',
      '',
      CATCH_UP_BANNER_OPEN,
      RECAP,
      CATCH_UP_BANNER_CLOSE,
      '',
      'and now my actual question',
    ].join('\n');
    const split = splitLeadingBanners(text);
    expect(split!.banners.map((b) => b.name)).toEqual(['Task Context', 'Conversation context']);
    expect(split!.banners[0].label).toBe('Task context Walnut added');
    expect(split!.body).toBe('and now my actual question');
  });

  it('labels an unknown banner kind by naming its author', () => {
    const split = splitLeadingBanners('[Pending Cron Digest]\nx fired\n[/Pending Cron Digest]\n\nhello');
    expect(split!.banners[0].label).toBe('Pending Cron Digest (added by Walnut)');
    expect(split!.body).toBe('hello');
  });
});

describe('splitLeadingBanners — ordinary messages are untouched', () => {
  it('returns null for a plain message', () => {
    expect(splitLeadingBanners('just a normal question about the build')).toBeNull();
  });

  it('returns null for empty text', () => {
    expect(splitLeadingBanners('')).toBeNull();
  });

  it('returns null for a message that merely contains brackets', () => {
    expect(splitLeadingBanners('see [the docs](http://example.test) about [x]')).toBeNull();
  });

  it('returns null when a bracketed line appears BELOW the first line', () => {
    expect(splitLeadingBanners('here is the thing\n[Conversation context]\nnope')).toBeNull();
  });

  it('does not treat an unclosed standalone bracket line as a banner', () => {
    // "[Current: …]" has no terminator; stripping it belongs to the single-line
    // readers. Here it stays visible, which loses nothing.
    expect(splitLeadingBanners('[Current: Mon, Sep 7, 2026]\nplease continue')).toBeNull();
  });
});

describe('splitLeadingBanners — malformed input never eats the message', () => {
  it('a truncated write (no terminator) leaves the WHOLE message alone', () => {
    const truncated = `${CATCH_UP_BANNER_OPEN}\n${RECAP}\n\nmy real message here`;
    // No `[/Conversation context]` line at all: not a banner, nothing consumed.
    expect(splitLeadingBanners(truncated)).toBeNull();
  });

  it('a truncated SECOND block keeps the first peel and leaves the rest as text', () => {
    const text = [
      '[Task Context]',
      'id: task-abc',
      '[/Task Context]',
      '',
      CATCH_UP_BANNER_OPEN,
      'recap cut off mid-write',
      '',
      'my real message here',
    ].join('\n');
    const split = splitLeadingBanners(text);
    expect(split!.banners.map((b) => b.name)).toEqual(['Task Context']);
    // Everything the parser could not prove was a banner stays readable.
    expect(split!.body).toContain(CATCH_UP_BANNER_OPEN);
    expect(split!.body).toContain('my real message here');
  });

  it('typed text containing the terminator string is not swallowed', () => {
    const typed = `why did you print ${CATCH_UP_BANNER_CLOSE} at me?`;
    // No opener at the top, so the terminator is never even looked for.
    expect(splitLeadingBanners(typed)).toBeNull();
  });

  it('typed text BELOW a real block may contain the terminator and still survives', () => {
    const typed = `also, what is ${CATCH_UP_BANNER_CLOSE} supposed to mean?`;
    const split = splitLeadingBanners(laneMessage(typed));
    // First matching terminator wins, so the human's copy of it stays in the body.
    expect(split!.body).toBe(typed);
    expect(split!.banners).toHaveLength(1);
  });

  it('a mismatched terminator name does not close the block', () => {
    const text = `${CATCH_UP_BANNER_OPEN}\nrecap\n[/Task Context]\n\nmy real message`;
    expect(splitLeadingBanners(text)).toBeNull();
  });

  it('a terminator-looking first line is not an opener', () => {
    expect(splitLeadingBanners(`${CATCH_UP_BANNER_CLOSE}\nstray tail`)).toBeNull();
  });

  it('an opener and terminator on the SAME line is not a block', () => {
    expect(splitLeadingBanners(`${CATCH_UP_BANNER_OPEN}${CATCH_UP_BANNER_CLOSE}\nhi`)).toBeNull();
  });

  it('a bracketed line with nested brackets is not an opener', () => {
    expect(splitLeadingBanners('[see [1] below]\nbody\n[/see [1] below]\n\nhi')).toBeNull();
  });

  it('a bracketed line of pure punctuation is not an opener', () => {
    expect(splitLeadingBanners('[***]\nbody\n[/***]\n\nhi')).toBeNull();
  });

  it('an absurdly long bracketed line is prose, not a banner name', () => {
    const long = 'x'.repeat(200);
    expect(splitLeadingBanners(`[${long}]\nbody\n[/${long}]\n\nhi`)).toBeNull();
  });

  it('never loses a character of the typed text across a generated matrix', () => {
    const typeds = [
      'plain',
      'with [brackets] inside',
      `with ${CATCH_UP_BANNER_CLOSE} inside`,
      `with ${CATCH_UP_BANNER_OPEN} inside`,
      'multi\nline\n\nwith blanks',
      '```\ncode fence\n```',
      '  leading spaces kept',
    ];
    for (const typed of typeds) {
      const split = splitLeadingBanners(laneMessage(typed));
      expect(split, typed).not.toBeNull();
      expect(split!.body, typed).toBe(typed.replace(/\s+$/, ''));
    }
  });
});

describe('injectedBannerLabel', () => {
  it('names the author for the known kinds, case-insensitively', () => {
    expect(injectedBannerLabel('Conversation context')).toBe('Context Walnut added');
    expect(injectedBannerLabel('conversation CONTEXT')).toBe('Context Walnut added');
    expect(injectedBannerLabel('Task Context')).toBe('Task context Walnut added');
  });

  it('falls back to the bracket name plus attribution', () => {
    expect(injectedBannerLabel('Plan Mode')).toBe('Plan Mode (added by Walnut)');
  });
});
