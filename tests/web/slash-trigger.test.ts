/**
 * Slash-command trigger detection (web/src/components/chat/slash-trigger.ts).
 *
 * The palette used to open only when the WHOLE input started with "/" —
 * typing any text first killed autocomplete. detectSlashCommand mirrors the
 * "@" mention trigger: a "/" at input start or after whitespace, caret still
 * inside the command name, fires anywhere in the message. These tests pin the
 * boundary rules (paths, URLs, math, mid-word slashes must NOT fire).
 */
import { describe, it, expect } from 'vitest';
import { detectSlashCommand } from '@/components/chat/slash-trigger';

describe('detectSlashCommand', () => {
  it('fires at input start', () => {
    expect(detectSlashCommand('/', 1)).toEqual({ slashIndex: 0, query: '' });
    expect(detectSlashCommand('/mod', 4)).toEqual({ slashIndex: 0, query: 'mod' });
  });

  it('fires mid-message after whitespace', () => {
    const text = 'please run /com';
    expect(detectSlashCommand(text, text.length)).toEqual({ slashIndex: 11, query: 'com' });
  });

  it('fires after a newline', () => {
    const text = 'line one\n/pl';
    expect(detectSlashCommand(text, text.length)).toEqual({ slashIndex: 9, query: 'pl' });
  });

  it('does not fire when "/" follows a non-space char (paths, URLs, math)', () => {
    expect(detectSlashCommand('src/foo', 7)).toBeNull();
    expect(detectSlashCommand('https://example.com', 8)).toBeNull();
    expect(detectSlashCommand('5/3', 3)).toBeNull();
  });

  it('does not fire once the query contains whitespace (command already typed)', () => {
    const text = '/model opus';
    expect(detectSlashCommand(text, text.length)).toBeNull();
  });

  it('does not fire once the query contains a second "/" (absolute path)', () => {
    const text = 'see /Users/me';
    expect(detectSlashCommand(text, text.length)).toBeNull();
  });

  it('does not fire with caret at 0 even when text starts with "/"', () => {
    expect(detectSlashCommand('/model', 0)).toBeNull();
  });

  it('does not fire when caret moved left of the "/"', () => {
    // caret at index 3 inside "abc /cmd" — nearest "/" is right of the caret
    expect(detectSlashCommand('abc /cmd', 3)).toBeNull();
  });

  it('uses the caret, not the end of text, to bound the query', () => {
    // caret inside "/com|mand trailing" → query is what's left of the caret
    expect(detectSlashCommand('/command trailing', 4)).toEqual({ slashIndex: 0, query: 'com' });
  });

  it('returns null for empty text', () => {
    expect(detectSlashCommand('', 0)).toBeNull();
  });
});
