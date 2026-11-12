import { expect, it } from 'vitest';
import { routerLetterContent } from '../../src/core/router/letter-content.js';
import { derivePreview } from '../../src/core/human-inbox/preview.js';

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
