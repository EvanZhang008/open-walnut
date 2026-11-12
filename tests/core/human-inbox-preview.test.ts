import { describe, expect, it } from 'vitest';
import { derivePreview, cleanLegacyPreview } from '../../src/core/human-inbox/preview.js';
import { normalizeStore } from '../../src/core/human-inbox/normalize.js';

describe('letter card summaries', () => {
  it('uses the first prose paragraph, not headings or the whole markdown document', () => {
    expect(derivePreview({ markdown: '# Summary\n\nPlease confirm **Thursday**.\n\n## Details\n\nA long report follows.' })).toBe('Please confirm Thursday.');
  });

  it('uses the reason in old router letters instead of sender and subject metadata', () => {
    const markdown = '**From:** pat@example.invalid\n**Subject:** Dock schedule\n\n**Why it is yours:** Only you can confirm the slot.\n\nPlease reply before Friday.';
    expect(derivePreview({ markdown })).toBe('Only you can confirm the slot.');
    expect(cleanLegacyPreview('From: pat@example.invalid Subject: Dock schedule Why it is yours: Only you can confirm the slot. Please reply before Friday.')).toBe('Only you can confirm the slot. Please reply before Friday.');
  });

  it('cleans legacy summaries on the shared index read used by desktop and phone', () => {
    const raw = { version: 1, letters: [{ id: 'lt-preview-abcdef', textPreview: 'From: pat@example.invalid Subject: Dock schedule Why it is yours: Confirm the time.', read: false }] };
    expect(normalizeStore(raw).letters[0]?.textPreview).toBe('Confirm the time.');
    expect(raw.letters[0]?.textPreview).toContain('From:');
  });

  it('keeps supplied summaries and skips code, images and empty markup', () => {
    expect(derivePreview({ text: 'A short summary.', markdown: '# Ignored' })).toBe('A short summary.');
    expect(derivePreview({ markdown: '# Report\n\n```txt\nnoise\n```\n\n![chart](chart.png)\n\n- Confirm the slot\n- Read the report' })).toBe('Confirm the slot');
    expect(derivePreview({ markdown: '# Only a heading' })).toBe('Only a heading');
    expect(derivePreview({ markdown: '' })).toBe('');
  });

  it('handles wrapped paragraphs, tables, rules and both code fence styles', () => {
    expect(derivePreview({ markdown: 'Please confirm the interview\ntime before Friday.\n\nDetails.' })).toBe('Please confirm the interview time before Friday.');
    expect(derivePreview({ markdown: '---\n\n| a | b |\n| --- | --- |\n\n~~~txt\nnoise\n~~~\n\nConfirm Friday.' })).toBe('Confirm Friday.');
    expect(derivePreview({ markdown: '```txt\nunfinished code' })).toBe('');
    expect(derivePreview({ markdown: '**From:** pat@example.invalid\n**Subject:** Reminder\n\nConfirm Friday.' })).toBe('Confirm Friday.');
    expect(cleanLegacyPreview('From: pat@example.invalid Subject: A very long subject')).toBe('A very long subject');
    expect(derivePreview({ html: '<!-- hidden --><div>Confirm Friday.<p>Details</p></div>' })).toBe('Confirm Friday.');
    expect(derivePreview({ html: '<table><tr><td>First cell</td><td>Second cell</td></tr></table>' })).toBe('First cell');
  });

  it('uses the first HTML prose block without heading, script or style text', () => {
    expect(derivePreview({ html: '<head><title>Hidden</title></head><h2>Report</h2><style>noise</style><p>Confirm Thursday.</p><p>Further details.</p><script>noise</script>' })).toBe('Confirm Thursday.');
    expect(derivePreview({ html: '<h1>Heading only</h1>' })).toBe('Heading only');
  });

  it('preserves Unicode and bounds large bodies without turning details into the summary', () => {
    expect(derivePreview({ markdown: '# Report\n\n\u8bf7\u786e\u8ba4\u65f6\u95f4\u3002\n\n' + 'details '.repeat(100_000) })).toBe('\u8bf7\u786e\u8ba4\u65f6\u95f4\u3002');
    expect(cleanLegacyPreview('Ordinary summary with From: in the middle.')).toBe('Ordinary summary with From: in the middle.');
  });
});
