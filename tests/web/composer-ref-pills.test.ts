/**
 * The composer draws its references as pills (web/src/components/chat/composer-ref-pills.ts,
 * ComposerRefLayer.tsx). 2026-11-01, the user: a picked task showed as raw
 * `@[Garden planner: ...]` text in the input bar; "it should render ... notes and
 * everything else the same".
 *
 * GUARD (the whole class): every reference kind entity-ref-tags.ts can carry, plus a
 * picked file, is drawn as a pill of its own kind with a CSS rule; and every composer
 * goes through ChatInput, the one place that draws them, so a new composer or a new
 * reference kind that would render raw fails here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { inlineRefs } from '@/components/chat/composer-refs';
import { composerSegments, fileRefsIn, hasPills, pillAt, PILL_KINDS } from '@/components/chat/composer-ref-pills';
import { projectRefTag, sessionRefTag, sourceRefTag, taskRefTag } from '@/utils/entity-ref-tags';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** One tag per kind, as the "@" picker writes it. */
const SAMPLE_TAG: Record<string, string> = {
  task: taskRefTag('t-1', 'Garden planner: water the east beds, add a frost note'),
  session: sessionRefTag('s-1', 'Plan: auth'),
  project: projectRefTag('Walnut'),
  source: sourceRefTag('notes', 'vault-note.md', 'Vault note'),
};

describe('composerSegments', () => {
  it('draws every reference in place and keeps every character', () => {
    const { body, table } = inlineRefs(`fix ${SAMPLE_TAG.task} with ${SAMPLE_TAG.source} and @/repo/src/a.ts now`);
    const segs = composerSegments(body, table);
    expect(segs.map((s) => s.text).join('')).toBe(body);
    const pills = segs.filter((s) => s.pill);
    expect(pills.map((s) => s.pill!.kind)).toEqual(['task', 'source', 'file']);
    expect(pills[0].pill).toMatchObject({ open: '@[', lead: '', label: 'Garden planner: water the east beds, add a frost note', close: ']' });
    // A source's name is drawn quieter, ahead of its words.
    expect(pills[1].pill).toMatchObject({ lead: 'Notes \u00b7 ', label: 'Vault note', sourceId: 'notes' });
    // A file: its folder quieter, its name as the words; the "@" holds the icon.
    expect(pills[2].pill).toMatchObject({ open: '@', lead: '/repo/src/', label: 'a.ts', close: '' });
    for (const p of pills) expect(p.pill!.open + p.pill!.lead + p.pill!.label + p.pill!.close).toBe(p.text);
  });

  it('a quoted file path (one with a space) is one pill', () => {
    const segs = composerSegments('see @"/repo/my notes/plan.md" ok', new Map());
    expect(segs.filter((s) => s.pill).map((s) => s.text)).toEqual(['@"/repo/my notes/plan.md"']);
    expect(segs.find((s) => s.pill)!.pill).toMatchObject({ open: '@"', lead: '/repo/my notes/', label: 'plan.md', close: '"' });
  });

  it('text the table does not know, a typed @word and mid-word @ stay text', () => {
    const { table } = inlineRefs(SAMPLE_TAG.task);
    for (const text of ['see @[nobody] here', 'ask @alice', 'mail me@/x', '@relative/path.ts', '']) {
      expect(hasPills(composerSegments(text, table)), text).toBe(false);
    }
  });

  it('the @query being typed is never a pill until it is picked', () => {
    const body = 'open @/repo/src';
    expect(hasPills(composerSegments(body, new Map(), { active: { start: 5, end: body.length } }))).toBe(false);
    expect(hasPills(composerSegments(body, new Map()))).toBe(true);
  });

  it('with the picked set, only a path the picker wrote is a pill; one typed by hand stays text', () => {
    const body = 'see @/repo/a.ts and @/repo/typed.ts, ok'
    const segs = composerSegments(body, new Map(), { files: new Set(['@/repo/a.ts']) })
    expect(segs.filter((s) => s.pill).map((s) => s.text)).toEqual(['@/repo/a.ts'])
    // Sentence punctuation after a path is not part of it.
    expect(fileRefsIn(body)).toEqual(['@/repo/a.ts', '@/repo/typed.ts'])
  });

  it('Unicode labels keep their characters', () => {
    const { body, table } = inlineRefs(taskRefTag('t-9', 'Fix \u4e2d\u6587 title \u{1F680}'));
    const seg = composerSegments(body, table).find((s) => s.pill)!;
    expect(seg.pill!.label).toBe('Fix \u4e2d\u6587 title \u{1F680}');
    expect(seg.text).toBe(body);
  });
});

describe('pillAt: a pill is one unit for the keys', () => {
  const { body, table } = inlineRefs(`a ${SAMPLE_TAG.task} b`);
  const segs = composerSegments(body, table);
  const pill = segs.find((s) => s.pill)!;

  it('Backspace and Left find the pill that ends at the caret, Delete and Right the one that starts there', () => {
    expect(pillAt(segs, pill.end, 'before')).toBe(pill);
    expect(pillAt(segs, pill.start, 'after')).toBe(pill);
    expect(pillAt(segs, pill.start, 'before')).toBeNull();
    expect(pillAt(segs, pill.end, 'after')).toBeNull();
  });

  it('a caret inside its words is inside, its edges are not', () => {
    expect(pillAt(segs, pill.start + 3, 'inside')).toBe(pill);
    expect(pillAt(segs, pill.start, 'inside')).toBeNull();
    expect(pillAt(segs, pill.end, 'inside')).toBeNull();
  });
});

describe('guard: every reference kind renders as a pill, in every composer', () => {
  const tagsSource = read('web/src/utils/entity-ref-tags.ts');
  const kindUnion = tagsSource.match(/export type EntityRefKind = ([^;]+);/)![1].match(/'([a-z-]+)'/g)!.map((k) => k.slice(1, -1));
  const regexKinds = tagsSource.match(/const ENTITY_REF_RE = \/<\(([a-z|-]+)\)-ref/)![1].split('|');
  const css = read('web/src/styles/composer-ref-pills.css');

  it('the kinds are read from the source', () => {
    expect(kindUnion.length).toBeGreaterThanOrEqual(4);
    expect([...regexKinds].sort()).toEqual([...kindUnion].sort());
  });

  it('each entity kind and a file has a pill kind and a CSS rule', () => {
    for (const kind of [...kindUnion, 'file']) {
      expect(PILL_KINDS, `a new reference kind "${kind}": add it to PILL_KINDS`).toHaveProperty(kind);
      expect(css, `a new reference kind "${kind}": give it a .composer-ref-pill[data-kind="${kind}"] rule`).toContain(`.composer-ref-pill[data-kind="${kind}"]`);
    }
  });

  it('a token of each entity kind is drawn as a pill of that kind, never raw', () => {
    for (const kind of kindUnion) {
      expect(SAMPLE_TAG, `a new reference kind "${kind}": add a sample tag here`).toHaveProperty(kind);
      const { body, table } = inlineRefs(`see ${SAMPLE_TAG[kind]} now`);
      const pills = composerSegments(body, table).filter((s) => s.pill);
      expect(pills.map((s) => s.pill!.kind), kind).toEqual([kind]);
    }
  });

  it('only ChatInput puts references into a text box, and it draws the layer', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.tsx?$/.test(name)) continue;
        const rel = path.relative(ROOT, p);
        if (rel === 'web/src/components/chat/ChatInput.tsx' || rel.startsWith('web/src/components/chat/composer-ref')) continue;
        const text = fs.readFileSync(p, 'utf8');
        if (/\binlineRefs\(/.test(text) || /<MentionPalette\b/.test(text)) offenders.push(rel);
      }
    };
    walk(path.join(ROOT, 'web/src'));
    expect(offenders, 'a composer outside ChatInput would show references as raw text: reuse ChatInput').toEqual([]);
    const chatInput = read('web/src/components/chat/ChatInput.tsx');
    expect(chatInput).toMatch(/<ComposerRefLayer textareaRef=\{textareaRef\} segments=\{pills.segments\} \/>/);
    expect(chatInput).toMatch(/has-ref-pills/);
  });
});
