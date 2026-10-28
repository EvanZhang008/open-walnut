/**
 * The user's own terms as speech context, and the correction list learning from
 * dictations the user fixed by hand before sending.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../src/constants.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, get WALNUT_HOME() { return home.dir; } };
});
const config = vi.hoisted(() => ({ value: {} as Record<string, unknown>, writes: [] as unknown[] }));
vi.mock('../../src/core/config-manager.js', () => ({
  migrateStoredConfig: async (mutate: (doc: Record<string, unknown>) => boolean) => {
    const doc = structuredClone(config.value);
    if (!mutate(doc)) return false;
    config.writes.push({ stt_corrections: doc.stt_corrections });
    config.value = doc;
    return true;
  },
}));
const role = vi.hoisted(() => ({ follower: false }));
vi.mock('../../src/core/server-role.js', () => ({ isFollower: () => role.follower }));

import { termsFromTitles, mergeTerms, speechContext, _setTitleTermsForTest, MAX_TERMS } from '../../src/core/stt/user-terms.js';
import { editPairs, noteDictation, learnFromSend, learnedTerms, _resetLearningForTest } from '../../src/core/stt/learn-from-sends.js';
import type { Config } from '../../src/core/types.js';

describe('terms from task titles', () => {
  it('takes English words of mixed zh/en titles, most used first, in their usual spelling', () => {
    const titles = [
      '修 clouddev 上的 build', 'clouddev 断线', 'Clouddev 重连', '把 Sidebar 改短', 'sidebar 图标', '侧栏 Sidebar',
      'Fix the build on Linux', 'Fix the build again', 'Fix it', // no Chinese: not mixed speech
      '一次性的 Rarely 词',
    ];
    expect(termsFromTitles(titles)).toEqual(['clouddev', 'Sidebar']);
  });

  it('leaves out function words and counts a word once per title', () => {
    expect(termsFromTitles(['的 the the the', '和 the', '与 the'])).toEqual([]);
    expect(termsFromTitles(['bun bun bun 编译'])).toEqual([]);
  });

  it('merges sources in order without case duplicates, at most MAX_TERMS', () => {
    expect(mergeTerms([['Walnut', 'Claude'], ['claude', 'typo'], ['TYPO', 'bun']])).toEqual(['Walnut', 'Claude', 'typo', 'bun']);
    const many = Array.from({ length: 100 }, (_, i) => `term${i}`);
    expect(mergeTerms([many])).toHaveLength(MAX_TERMS);
  });

  it('builds the context from vocab, correction terms, then title words; auto_context false drops the titles', () => {
    _setTitleTermsForTest(['clouddev', 'Sidebar']);
    const cfg = { stt_corrections: { typo: ['泰普'] } } as unknown as Config;
    expect(speechContext(cfg, ['Walnut'])).toBe('Walnut, typo, clouddev, Sidebar');
    expect(speechContext({ ...cfg, stt: { auto_context: false } } as unknown as Config, ['Walnut'])).toBe('Walnut, typo');
  });
});

describe('learning from edited dictations', () => {
  beforeEach(async () => {
    home.dir = await mkdtemp(join(tmpdir(), 'stt-learn-'));
    config.value = {};
    config.writes = [];
    role.follower = false;
    _resetLearningForTest();
    _setTitleTermsForTest([]);
  });
  afterEach(async () => { await rm(home.dir, { recursive: true, force: true }); });

  it('finds the span the user replaced with an English term', () => {
    expect(editPairs('我说泰文，我说泰普。', '我说泰文，我说typo')).toEqual([{ heard: '泰普', term: 'typo' }]);
    expect(editPairs('现在哪些任务在 Cloud Deep 上面跑', '现在哪些任务在 clouddev 上面跑')).toEqual([{ heard: 'Cloud Deep', term: 'clouddev' }]);
  });

  it('learns nothing from a rewrite, a change into Chinese, an addition or the same words', () => {
    expect(editPairs('我们明天再看这个问题吧', '完全不同的一句话 about something else')).toBeNull();
    expect(editPairs('这个是一线的问题', '这个是胰腺的问题')).toEqual([]);
    expect(editPairs('把它放到上面', '把它放到 clouddev 上面')).toEqual([]);
    expect(editPairs('我们用 Cloud Dev 跑这个测试', '我们用 clouddev 跑这个测试')).toEqual([]);
  });

  it('an English grammar edit is not a mishearing', () => {
    expect(editPairs('so this is broken on the phone today', 'so this was broken on the phone today')).toEqual([]);
    expect(editPairs('please open the PR now for review', 'please open the PRs now for review')).toEqual([]);
    expect(editPairs('我们在 Cloud Deep 上面跑这个测试', '我们在 clouddev 上面跑这个测试')).toEqual([{ heard: 'Cloud Deep', term: 'clouddev' }]);
  });

  const DAY = 86_400_000;
  /** One hand-fixed take on day `d` (0 = today). */
  const fixOn = async (d: number, n: string) => {
    const at = Date.now() + d * DAY;
    noteDictation(`${n}又是一个泰普的问题`, at);
    return learnFromSend(`${n}又是一个typo的问题`, at);
  };

  it('a hand-fixed dictation adds its term to the context at once and to the list on a second day', async () => {
    noteDictation('我说泰文，我说泰普。');
    expect(await learnFromSend('我说泰文，我说typo')).toEqual([{ heard: '泰普', term: 'typo' }]);
    expect(learnedTerms()).toEqual(['typo']);
    expect(config.writes).toEqual([]);
    expect(speechContext({} as Config, [])).toBe('typo');

    await fixOn(0, '今天'); // the same day again: still only a soft bias
    expect(config.writes).toEqual([]);
    await fixOn(1, '明天');
    expect(config.writes).toEqual([{ stt_corrections: { typo: ['泰普'] } }]);
    const stored = JSON.parse(await readFile(join(home.dir, 'local', 'stt-learned-corrections.json'), 'utf8'));
    expect(stored.pairs).toMatchObject([{ term: 'typo', heard: '泰普', count: 3 }]);

    // A third day does not write again, and a form already listed is not added twice.
    await fixOn(2, '后天');
    expect(config.writes).toHaveLength(1);
  });

  it('keeps the user list as it is when adding, and never writes config on a follower', async () => {
    config.value = { stt_corrections: { typo: ['type o'], clouddev: ['Cloud Deep'] } };
    await fixOn(0, 'a');
    await fixOn(1, 'b');
    expect(config.writes).toEqual([{ stt_corrections: { typo: ['type o', '泰普'], clouddev: ['Cloud Deep'] } }]);

    _resetLearningForTest();
    await rm(join(home.dir, 'local'), { recursive: true, force: true });
    config.writes = [];
    role.follower = true;
    await fixOn(0, 'c');
    await fixOn(1, 'd');
    expect(config.writes).toEqual([]);
  });

  it('one dictation teaches once: a retry, a resend, or a take sent as heard learns nothing more', async () => {
    noteDictation('我说泰文，我说泰普。');
    expect(await learnFromSend('我说泰文，我说typo', Date.now(), 'qm-1')).toHaveLength(1);
    noteDictation('又一个泰普的问题');
    expect(await learnFromSend('又一个typo的问题', Date.now(), 'qm-1')).toEqual([]); // same message id
    expect(await learnFromSend('我说泰文，我说typo', Date.now(), 'qm-2')).toEqual([]); // its dictation is used up
    noteDictation('这段原样发出');
    expect(await learnFromSend('这段原样发出', Date.now(), 'qm-3')).toEqual([]);
    const stored = JSON.parse(await readFile(join(home.dir, 'local', 'stt-learned-corrections.json'), 'utf8'));
    expect(stored.pairs[0].count).toBe(1);
  });

  it('a store that does not parse is left alone', async () => {
    await mkdir(join(home.dir, 'local'), { recursive: true });
    await writeFile(join(home.dir, 'local', 'stt-learned-corrections.json'), '{broken');
    noteDictation('我说泰文，我说泰普。');
    expect(await learnFromSend('我说泰文，我说typo')).toEqual([]);
    expect(await readFile(join(home.dir, 'local', 'stt-learned-corrections.json'), 'utf8')).toBe('{broken');
  });

  it('only a recent dictation counts', async () => {
    noteDictation('我说泰普', Date.now() - 20 * 60_000);
    expect(await learnFromSend('我说typo')).toEqual([]);
    noteDictation('我说泰普');
    expect(await learnFromSend('我说typo', Date.now() + 16 * 60_000)).toEqual([]);
  });
});
