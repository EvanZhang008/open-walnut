import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  deleteRoutingRule, firstMatchingRule, noteRoutedItem, readRoutingRules, ruleMatches, setRoutingRule,
  type TriageRoutingRule,
} from '../../../src/core/triage/routing-rules.js';
import { routingSection } from '../../../src/core/triage/batch.js';

const HUMAN = { by: 'human' as const };

function rule(over: Partial<TriageRoutingRule>): TriageRoutingRule {
  return { id: 'rr-1', match: {}, taskId: 't-1', enabled: true, createdAt: 0, updatedAt: 0, author: HUMAN, ...over };
}

describe('matching', () => {
  it('matches case-insensitive substrings; both halves when both are set', () => {
    const r = rule({ match: { from: 'ACME.example', subject: 'offer' } });
    expect(ruleMatches(r, { source: 'mail', from: 'HR <hr@acme.example>', subject: 'Your Offer letter' })).toBe(true);
    expect(ruleMatches(r, { source: 'mail', from: 'hr@acme.example', subject: 'Lunch' })).toBe(false);
    // Unicode test data (CJK): a subject rule matches inside a longer CJK text.
    expect(ruleMatches(rule({ match: { subject: '\u62db\u8058' } }), { source: 'slack', from: 'bob #jobs', subject: '\u65b0\u7684\u62db\u8058\u901a\u77e5' })).toBe(true);
  });
  it('a turned-off rule matches nothing, and the first live rule wins', () => {
    const rules = [rule({ id: 'rr-a', match: { from: 'acme' }, enabled: false }), rule({ id: 'rr-b', match: { from: 'acme' } }), rule({ id: 'rr-c', match: { from: 'acme' } })];
    expect(firstMatchingRule(rules, { source: 'mail', from: 'acme', subject: '' })?.id).toBe('rr-b');
  });
  it('no live rule: no section in the batch', () => {
    expect(routingSection([rule({ match: { from: 'x' }, enabled: false })], [], [])).toBeNull();
  });
  it('caps the pre-matched list and says how many there were', () => {
    const headlines = Array.from({ length: 5 }, (_, i) => ({ from: 'a@acme.example', subject: `m${i}` }));
    const mail = Array.from({ length: 10 }, (_, i) => ({ accountId: `acc${i}`, count: 5, atMs: 1, headlines }));
    const text = routingSection([rule({ match: { from: 'acme' } })], mail, [])!;
    expect(text).toMatch(/first 40 of 50/);
  });
});

describe('the rules file', () => {
  it('creates, changes, records a route, deletes; parallel writes all land', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-rr-'));
    try {
      const created = await Promise.all(Array.from({ length: 6 }, (_, i) => setRoutingRule(home, { from: `s${i}`, taskId: 't-1' }, HUMAN)));
      expect(new Set(created.map((r) => r.id)).size).toBe(6);
      expect(await readRoutingRules(home)).toHaveLength(6);

      const changed = await setRoutingRule(home, { id: created[0]!.id, subject: 'offer' }, { by: 'task', taskId: 't-vp', name: 'VP' }, Date.now() + 5000);
      expect(changed.match).toEqual({ from: 's0', subject: 'offer' });
      expect(changed.createdAt).toBe(created[0]!.createdAt);
      await expect(setRoutingRule(home, { id: created[0]!.id, from: '', subject: '' }, HUMAN)).rejects.toThrow(/sender or a subject/);
      await expect(setRoutingRule(home, { id: 'rr-none' }, HUMAN)).rejects.toThrow(/No routing rule/);

      await Promise.all([1, 2, 3].map((n) => noteRoutedItem(home, created[1]!.id, { at: n, item: `item ${n}` })));
      const noted = (await readRoutingRules(home)).find((r) => r.id === created[1]!.id)!;
      expect(noted.routedCount).toBe(3);
      expect(noted.recent).toHaveLength(3);

      expect(await deleteRoutingRule(home, created[2]!.id)).toBe(true);
      expect(await deleteRoutingRule(home, created[2]!.id)).toBe(false);
      expect(await readRoutingRules(home)).toHaveLength(5);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('a pasted "Name <address>" sender is kept as the address', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-needle-'));
    const r = await setRoutingRule(home, { from: 'Contractor Bob <bob@kitchenpros.example>', taskId: 't-1' }, HUMAN);
    expect(r.match.from).toBe('bob@kitchenpros.example');
    const plain = await setRoutingRule(home, { from: 'kitchenpros', taskId: 't-1' }, HUMAN);
    expect(plain.match.from).toBe('kitchenpros');
    await fs.rm(home, { recursive: true, force: true });
  });
  it('refuses the same match to the same task twice, and keeps who added a rule across changes', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-dup-'));
    const vp = { by: 'task' as const, taskId: 'vp-1', name: 'Walnut VP' };
    const r = await setRoutingRule(home, { from: 'kitchenpros.example', taskId: 't-1' }, vp);
    await expect(setRoutingRule(home, { from: 'KitchenPros.example', taskId: 't-1' }, HUMAN)).rejects.toMatchObject({ code: 'duplicate_rule', status: 409 });
    // The same match to another task is another rule (Settings warns that it is never used).
    await setRoutingRule(home, { from: 'kitchenpros.example', taskId: 't-2' }, HUMAN);
    // Saving a rule unchanged is not a duplicate of itself.
    const toggled = await setRoutingRule(home, { id: r.id, enabled: false }, HUMAN);
    expect(toggled.author).toEqual(HUMAN);
    expect(toggled.createdBy).toEqual(vp);
    expect((await setRoutingRule(home, { id: r.id, from: 'kitchenpros.example' }, HUMAN)).createdBy).toEqual(vp);
    await fs.rm(home, { recursive: true, force: true });
  });
  it('a broken or foreign entry in the file is dropped, not fatal', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-rr-'));
    try {
      await fs.mkdir(path.join(home, 'triage'), { recursive: true });
      await fs.writeFile(path.join(home, 'triage', 'routing-rules.json'), JSON.stringify({ version: 1, rules: [{ id: 'bad' }, { id: 'rr-ok', match: { from: 'a' }, taskId: 't' }, { id: 'kitchen', match: { from: 'b' }, taskId: 't' }, { id: '../x', match: { from: 'c' }, taskId: 't' }] }));
      // A hand-named id is kept; one that is no plain name is not.
      expect((await readRoutingRules(home)).map((r) => r.id)).toEqual(['rr-ok', 'kitchen']);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
