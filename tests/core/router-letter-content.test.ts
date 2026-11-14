import { expect, it } from 'vitest';
import { routerLetterContent } from '../../src/core/router/letter-content.js';
import { derivePreview } from '../../src/core/human-inbox/preview.js';
import { findSecretsInText } from '../../src/integrations/git-sync-secrets.js';
import { REDACTED_LINE } from '../../src/core/human-inbox/letter-credentials.js';

it('keeps the reason in the envelope and formats the briefing before original message metadata', () => {
  const letter = routerLetterContent({ subject: 'Interview\n reminder', sender: 'coordinator@example.invalid' }, { reason: 'Only you can confirm the time.' }, '  - Confirm Thursday\n- Bring your notes  ');
  expect(letter.subject).toBe('For you: Interview reminder');
  expect(derivePreview(letter)).toBe('Only you can confirm the time.');
  expect(letter.markdown).toBe('Only you can confirm the time.\n\n## What needs you\n\n- Confirm Thursday\n- Bring your notes\n\n## Original message\n\n**From:** coordinator@example.invalid  \n**Subject:** Interview reminder');
});

it('keeps no-subject and unknown-sender fallbacks and bounds metadata', () => {
  expect(routerLetterContent({}, { reason: 'Please review.' }, 'Details')).toMatchObject({ subject: 'For you: (no subject)' });
  expect(routerLetterContent({}, { reason: 'Please review.' }, 'Details').markdown).toContain('unknown sender');
  expect(routerLetterContent({ subject: 'x'.repeat(1000) }, { reason: 'Please review.' }, 'Details').subject).toHaveLength(109);
});

it('takes a credential the quoted mail carries out of the letter, and the rest stays', () => {
  // Assembled at run time: the repo's commit scan refuses a literal token.
  const token = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
  const letter = routerLetterContent({ subject: 'Deploy key', sender: 'ops@example.invalid' }, { reason: 'Rotate it.' }, `Their token: ${token}\nRotate by Friday`);
  expect(findSecretsInText(`${letter.subject}\n${letter.text}\n${letter.markdown}`)).toEqual([]);
  expect(letter.markdown).not.toContain(token);
  expect(letter.markdown).toContain(REDACTED_LINE);
  expect(letter.markdown).toContain('Rotate by Friday');
});

it("writes Walnut's own frame in the language of Walnut's letters, every language of it filled", async () => {
  const { LETTER_LANGUAGES } = await import('../../src/core/human-inbox/walnut-letters/languages.js');
  const en = routerLetterContent({}, { reason: 'r' }, 'b', 'en');
  for (const lang of LETTER_LANGUAGES) {
    const l = routerLetterContent({}, { reason: 'r' }, 'b', lang);
    expect(l.subject.length, lang).toBeGreaterThan(2);
    if (lang !== 'en') expect(l.subject, lang).not.toBe(en.subject);
    expect(l.markdown.split('\n').filter((line) => line.startsWith('## '))).toHaveLength(2);
  }
  // '给你' is the Chinese "For you".
  expect(routerLetterContent({ subject: 'Hi' }, { reason: 'r' }, 'b', 'zh').subject).toBe('给你: Hi');
});
