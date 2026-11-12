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
