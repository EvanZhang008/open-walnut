import { describe, expect, it } from 'vitest';
import { showHintTagsAsTyped } from '../../web/src/utils/hint-display';

describe('showHintTagsAsTyped', () => {
  it('escapes the tag in prose and leaves code alone', () => {
    const text = 'see <system-reminder>x</system-reminder> and `<system-reminder>` and\n```\n<system-reminder>\n```';
    expect(showHintTagsAsTyped(text)).toBe('see &lt;system-reminder>x&lt;/system-reminder> and `<system-reminder>` and\n```\n<system-reminder>\n```');
  });
  it('leaves other text untouched', () => {
    expect(showHintTagsAsTyped('<task-ref id="x"/> hello')).toBe('<task-ref id="x"/> hello');
  });
});
