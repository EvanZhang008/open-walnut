import { describe, expect, it } from 'vitest';
import { detectLanguageDrift, expectedScript } from '../../../src/core/hints/hint-drift-detect.js';

const RULE = 'Talk to the user in Chinese; code, commits, UI strings and repo docs stay English.';

describe('expectedScript', () => {
  it('reads the first language the rule names', () => {
    expect(expectedScript(RULE)).toBe('han');
    expect(expectedScript('Answer in English, never Chinese')).toBe('latin');
    expect(expectedScript('用中文回答')).toBe('han');
    expect(expectedScript('Be nice')).toBeNull();
  });
});

describe('detectLanguageDrift', () => {
  it('an English reply under a Chinese rule drifted', () => {
    expect(detectLanguageDrift(RULE, 'I updated the registry and ran the focused tests; all of them pass now and the build is green.')).toBe(true);
  });

  it('a Chinese reply with code, paths and identifiers did not', () => {
    const reply = '已修改 `src/core/hints/hint-send.ts`，测试全部通过。\n\n```ts\nconst plan = planHints({ hints, target, record, config });\nexport function composeHinted() {}\n```\n见 https://example.com/very/long/path 与 /tmp/x/y.png';
    expect(detectLanguageDrift(RULE, reply)).toBe(false);
  });

  it('a short reply proves nothing', () => {
    expect(detectLanguageDrift(RULE, 'Done.')).toBe(false);
  });

  it('a rule that names no language is never judged', () => {
    expect(detectLanguageDrift('Be brief.', 'Long English text that goes on for quite a while without any other language in it.')).toBe(false);
  });
});
