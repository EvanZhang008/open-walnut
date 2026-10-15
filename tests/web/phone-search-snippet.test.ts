/**
 * N26: a phone search row prints its snippet as plain words, never the source
 * marks a note or message carries (markdown, wiki links, highlight tags,
 * entities, line breaks).
 */
import { describe, expect, it } from 'vitest';
import { plainSnippet } from '../../web/src/components/tasks/PhoneSearchLayer';

describe('plainSnippet', () => {
  it('drops markdown marks and keeps the words', () => {
    expect(plainSnippet('## Seed list\n- **tomato** and `basil`\n> water _daily_')).toBe('Seed list tomato and basil water daily');
  });
  it('keeps link and wiki link text, drops images', () => {
    expect(plainSnippet('see [the shed](https://example.test/shed) and [[Garden plan|plan]] ![x](a.png) [[Tools]]')).toBe('see the shed and plan Tools');
  });
  it('drops highlight tags and decodes entities, but keeps a lone comparison', () => {
    expect(plainSnippet('<mark>rake</mark> &amp; hoe &lt;3, a < b and c > d')).toBe('rake & hoe <3, a < b and c > d');
  });
  it('code fences and runs of whitespace become single spaces', () => {
    expect(plainSnippet('run\n```sh\nls ./tools\n```\n\n  done')).toBe('run ls ./tools done');
  });
  it('an identifier keeps its underscores', () => {
    expect(plainSnippet('call seed_list_v2 now')).toBe('call seed_list_v2 now');
  });
  it('nothing in, nothing out', () => {
    expect(plainSnippet(undefined)).toBe('');
    expect(plainSnippet('   ')).toBe('');
  });
});
