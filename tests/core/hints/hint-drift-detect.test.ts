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

  it('quoted words keep their own language: an English quote in Chinese is fine, English around a Chinese quote is not', () => {
    const quoting = '用户原话："please make every message to another task follow my language, and tell the sender when it does not"。\n'
      + '> The deploy finished at 06:40 and every check on the live server passed.\n我的理解：发给其他任务的消息也用中文。';
    expect(detectLanguageDrift(RULE, quoting)).toBe(false);
    // 2026-11-16 overnight: the user's Chinese quoted exactly, then the decisions in English.
    const wrapped = 'Evan (11-16, exact, voice): "\u4f60\u4e0d\u8981\u8ba9\u6211\u53bb\u505a\u8fd9\u4e2a\uff0c\u6211\u653e\u90a3\u4e48\u591a\u662f\u6709\u539f\u56e0\u7684"\n\n'
      + 'Decisions: compaction limits stay exactly as he set them, and build cache-aware delivery next.';
    expect(detectLanguageDrift(RULE, wrapped)).toBe(true);
  });

  it('a short reply proves nothing', () => {
    expect(detectLanguageDrift(RULE, 'Done.')).toBe(false);
  });

  it('a rule that names no language is never judged', () => {
    expect(detectLanguageDrift('Be brief.', 'Long English text that goes on for quite a while without any other language in it.')).toBe(false);
  });
});
