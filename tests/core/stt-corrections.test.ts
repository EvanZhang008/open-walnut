/**
 * The correction list (config stt_corrections): known mishearings mapped to the user's
 * terms after every transcription, and carried to the companion by the config copy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/constants.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  const base = () =>
    (globalThis as unknown as { __sttFixDir?: string }).__sttFixDir ?? join(tmpdir(), 'stt-fix-unset');
  return {
    ...orig,
    get TMP_DIR() { return join(base(), 'tmp'); },
    get WALNUT_HOME() { return base(); },
    get STT_VOCAB_FILE() { return join(base(), 'config', 'share', 'stt-vocab.txt'); },
  };
});

// The engine hears what this test says it heard.
const heard = vi.hoisted(() => ({ text: '' }));
vi.mock('../../src/core/stt/engine-sherpa.js', () => ({
  createSherpaEngine: () => ({
    name: 'sherpa-onnx',
    isAvailable: async () => ({ available: true }),
    transcribe: async () => ({ text: heard.text, durationMs: 5 }),
  }),
}));

import { applyCorrections, parseCorrections } from '../../src/core/stt/corrections.js';
import { transcribeAudio } from '../../src/core/stt/index.js';
import { configCopyRows } from '../../src/core/replication/config-allowlist.js';
import type { Config } from '../../src/core/types.js';

const fix = (text: string, list: unknown) => applyCorrections(text, parseCorrections(list));

describe('correction list', () => {
  const list = {
    clouddev: ['Cloud Deep', 'Cloud Dev', 'Claude Dev', 'CloudDev'],
    typo: ['泰普'],
    Tailscale: ['Tell Tell Scope'],
    daemon: ['Dimon'],
    design: ['D赞'],
  };

  it('replaces mixed zh/en mishearings with the term', () => {
    expect(fix('我说泰文，我说泰普。', list)).toEqual({ text: '我说泰文，我说typo。', applied: 1 });
    expect(fix('在 Cloud Deep 上面，Cloud Deep 那边', list)).toEqual({ text: '在 clouddev 上面，clouddev 那边', applied: 2 });
    expect(fix('你给我出一个D赞', list).text).toBe('你给我出一个design');
    expect(fix('你刚才说 Tell Tell Scope 是这样的', list).text).toBe('你刚才说 Tailscale 是这样的');
  });

  it('matches any case and any spacing between the words of a form', () => {
    expect(fix('on CLOUD  DEEP and clouddeep', list).text).toBe('on clouddev and clouddev');
    expect(fix('在claude dev上', list).text).toBe('在clouddev上');
  });

  it('never fires inside a longer Latin word', () => {
    expect(fix('Dimonds and Dimon', list)).toEqual({ text: 'Dimonds and daemon', applied: 1 });
    expect(fix('ACloud Deeper', list).applied).toBe(0);
  });

  it('counts only real changes and is the same when applied twice', () => {
    const once = fix('CloudDev, clouddev, Cloud Dev', list);
    expect(once).toEqual({ text: 'clouddev, clouddev, clouddev', applied: 2 });
    expect(fix(once.text, list)).toEqual({ text: once.text, applied: 0 });
  });

  it('leaves out a form that would turn a term of the list into something else', () => {
    const rules = parseCorrections({ 'Cloud Box': ['Box'], clouddev: ['Cloud Dev'] });
    expect(rules.map((r) => r.heard)).toEqual(['Cloud Dev']);
  });

  it('puts longer forms first', () => {
    expect(fix('Claude Dev', { Claude: ['Clod'], clouddev: ['Claude Dev'] }).text).toBe('clouddev');
  });

  it('ignores a list that is not a map of strings', () => {
    for (const bad of [undefined, null, 'clouddev', ['Cloud Deep'], { clouddev: [1, null, ''] }, { '': ['x'] }]) {
      expect(fix('Cloud Deep', bad)).toEqual({ text: 'Cloud Deep', applied: 0 });
    }
    expect(fix('Cloud Deep', { clouddev: 'Cloud Deep' }).text).toBe('clouddev');
  });

  it('treats regex characters in a form as plain text', () => {
    expect(fix('a+b (x) a.b', { plus: ['a+b'], dot: ['a.b'] }).text).toBe('plus (x) dot');
  });

  it('rides the config copy, so the companion corrects with the Mac list', () => {
    const r = configCopyRows({ version: 1, stt: { engine: 'qwen' }, stt_corrections: list });
    expect(r.rows.find((row) => row.key === 'stt_corrections')?.value).toEqual(list);
    expect(r.rows.find((row) => row.key === 'stt')?.value).toEqual({ engine: 'qwen' });
  });

  it('copies a term named like a credential field, and still refuses a secret-shaped form', () => {
    const r = configCopyRows({ version: 1, stt: { engine: 'qwen' }, stt_corrections: { token: ['托肯'], password: ['怕死我的'] } });
    expect(r.rows.find((row) => row.key === 'stt_corrections')?.value).toEqual({ token: ['托肯'], password: ['怕死我的'] });
    expect(r.refused).toEqual([]);
    const leak = configCopyRows({ version: 1, stt_corrections: { x: ['ghp_' + 'a'.repeat(36)] } });
    expect(leak.rows.find((row) => row.key === 'stt_corrections')).toBeUndefined();
  });
});

describe('transcribeAudio applies the list', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stt-fix-'));
    (globalThis as unknown as { __sttFixDir?: string }).__sttFixDir = dir;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const config = (corrections?: Record<string, string[]>) =>
    ({ stt: { engine: 'sherpa-onnx' }, ...(corrections ? { stt_corrections: corrections } : {}) }) as unknown as Config;

  it('returns corrected text, and the engine text unchanged without a list', async () => {
    heard.text = '是在 Cloud Deep 上跑的吗';
    expect((await transcribeAudio(config({ clouddev: ['Cloud Deep'] }), { audio: 'AA==', format: 'wav' })).text).toBe('是在 clouddev 上跑的吗');
    expect((await transcribeAudio(config(), { audio: 'AA==', format: 'wav' })).text).toBe(heard.text);
  });

  it('reads the list on every call, so an edit applies to the next take', async () => {
    heard.text = 'Dimon';
    expect((await transcribeAudio(config({ daemon: ['Dimon'] }), { audio: 'AA==', format: 'wav' })).text).toBe('daemon');
    expect((await transcribeAudio(config({ demon: ['Dimon'] }), { audio: 'AA==', format: 'wav' })).text).toBe('demon');
  });
});
