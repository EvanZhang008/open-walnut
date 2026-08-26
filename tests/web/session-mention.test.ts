/**
 * Unit tests for the "@<session> message" composer logic (session-mention.ts):
 * when the line-start "@" opens the SESSION picker vs the file popup, how the
 * leading directive parses, and that file refs / literal "@" text can never be
 * mistaken for a routable directive (they must fall through to a normal send).
 */
import { describe, it, expect } from 'vitest';
import {
  shouldTriggerSessionMention,
  parseSessionDirective,
  formatSessionRef,
  sessionToPaletteItem,
} from '../../web/src/components/chat/session-mention';

describe('shouldTriggerSessionMention', () => {
  it('fires only for the line-start "@"', () => {
    expect(shouldTriggerSessionMention(0, '')).toBe(true);
    expect(shouldTriggerSessionMention(0, 'auth')).toBe(true);
    expect(shouldTriggerSessionMention(5, 'auth')).toBe(false);
  });

  it('yields to the file popup for path-shaped and recents queries', () => {
    expect(shouldTriggerSessionMention(0, 'src/foo')).toBe(false);
    expect(shouldTriggerSessionMention(0, '?recent')).toBe(false);
    expect(shouldTriggerSessionMention(0, '?')).toBe(false);
  });
});

describe('parseSessionDirective', () => {
  it('parses "@<ref> message"', () => {
    expect(parseSessionDirective('@e77d2af7 check the build')).toEqual({
      ref: 'e77d2af7',
      body: 'check the build',
    });
  });

  it('keeps multi-line bodies whole', () => {
    const r = parseSessionDirective('@abcd1234 line one\nline two');
    expect(r?.body).toBe('line one\nline two');
  });

  it('rejects non-directives', () => {
    expect(parseSessionDirective('hello @e77d2af7')).toBeNull(); // not at start
    expect(parseSessionDirective('@e77d2af7')).toBeNull(); // no message
    expect(parseSessionDirective('@ab hi')).toBeNull(); // ref too short (< 4)
    expect(parseSessionDirective('@src/foo.ts fix this')).toBeNull(); // path ref ("/" breaks \w match)
    expect(parseSessionDirective('@"my file.ts" fix')).toBeNull(); // quoted file ref
    expect(parseSessionDirective('@e77d2af7    ')).toBeNull(); // whitespace-only body
  });

  it('parses a name-like ref — resolution decides whether it routes', () => {
    // "@Makefile fix this" parses, but the server prefix lookup fails and the
    // caller falls through to a normal send. Pinned so nobody "optimizes" the
    // regex into rejecting these and nobody routes without resolving.
    expect(parseSessionDirective('@Makefile fix this')).toEqual({ ref: 'Makefile', body: 'fix this' });
  });
});

describe('formatSessionRef / sessionToPaletteItem', () => {
  it('inserts the 8-char id prefix with a trailing space', () => {
    expect(formatSessionRef('e77d2af7-35fa-4de0-92e6-5a4826b9976f')).toBe('@e77d2af7 ');
  });

  it('renders title, host, and status; local host is humanized', () => {
    const item = sessionToPaletteItem({
      id: 'e77d2af7-35fa-4de0-92e6-5a4826b9976f',
      title: 'Fix flaky auth test',
      host: '__local__',
      status: 'running',
    });
    expect(item.name).toBe('e77d2af7');
    expect(item.description).toBe('Fix flaky auth test — local · running');
    expect(item.source).toBe('session');
    expect(item.sessionId).toBe('e77d2af7-35fa-4de0-92e6-5a4826b9976f');
  });

  it('falls back to (untitled) and shows a real host name', () => {
    const item = sessionToPaletteItem({ id: 'abcd1234efgh', title: '', host: 'devbox', status: 'idle' });
    expect(item.description).toBe('(untitled) — devbox · idle');
  });
});
