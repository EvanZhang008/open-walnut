/**
 * Which text a launch is named after (`launchNamingText`).
 *
 * The rule has three jobs and all three matter: prefer the human's words when the
 * launcher supplied them, fall back to the wire message when it did not (so every
 * launch that prepends nothing keeps the titles it always had), and treat blank as
 * absent rather than as a name.
 */

import { describe, it, expect } from 'vitest';
import { launchNamingText } from '../../src/core/sessions/launch-naming.js';
import { buildAskProfilePrefix, ASK_PROFILE_BANNER_OPEN } from '../../src/core/sessions/ask-profile-prefix.js';

describe('launchNamingText', () => {
  it('prefers the human words over the wire message', () => {
    const words = 'what do I have today?';
    const wire = `${buildAskProfilePrefix({ systemPrompt: 'You are Walnut.' })}${words}`;
    expect(wire.startsWith(ASK_PROFILE_BANNER_OPEN)).toBe(true);
    expect(launchNamingText(wire, words)).toBe(words);
  });

  it('falls back to the message when the launcher prepended nothing', () => {
    expect(launchNamingText('fix the failing test')).toBe('fix the failing test');
  });

  it('treats a blank naming text as absent, not as the name', () => {
    expect(launchNamingText('the real message', '')).toBe('the real message');
    expect(launchNamingText('the real message', '   \n ')).toBe('the real message');
  });

  it('keeps the words verbatim, including leading space a title would trim later', () => {
    // The trim is only the emptiness TEST. Slicing and trimming belong to the
    // caller's title format, so this must not quietly reshape the text.
    expect(launchNamingText('wire', '  spaced words  ')).toBe('  spaced words  ');
  });

  it('carries an empty message through when there is nothing to name at all', () => {
    // An init-only spawn (no first turn). Both provider paths fall through to the
    // task's own title when the text is empty, which is the behaviour to preserve.
    expect(launchNamingText('', undefined)).toBe('');
    expect(launchNamingText('', '')).toBe('');
  });
});
