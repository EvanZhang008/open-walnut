/**
 * Every letter says who it is from, on every inbox surface (2026-11-04: a Walnut task's decision
 * letter named an outside company in its subject and was taken for that company's new mail).
 *
 * The class: a letter shown, pushed or announced without its origin. This file fails when
 *  - a letter type, a sender shape or a kind of letter Walnut writes itself resolves to no origin;
 *  - a new Walnut letter kind is added without saying which origin its letters carry;
 *  - a web component or an iOS view renders a letter's subject without the origin badge;
 *  - the phone push or the bell's card of a letter does not lead with its origin.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

// It reads the push content builder (pure), and owns its data dir as every push test does.
vi.mock('../../../src/constants.js', () => createMockConstants('letter-origin-surfaces'));
import {
  LETTER_ORIGIN_KINDS, letterOriginLine, letterOriginOf, type LetterOriginKind,
} from '../../../src/core/human-inbox/letter-origin.js';
import { kindOfLetter, WALNUT_LETTER_KINDS } from '../../../src/core/human-inbox/walnut-letters/registry.js';
import { letterPushContent } from '../../../src/core/push/letter-push.js';
import type { LetterRecord, LetterSender, LetterType } from '../../../src/core/human-inbox/types.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const LETTER_TYPES: LetterType[] = ['completion', 'action_required', 'review', 'info'];

function record(sender: LetterSender, extra: Partial<LetterRecord> = {}): LetterRecord {
  return {
    id: 'lt-test-0001', subject: 'Decide on the Acme offer', type: 'action_required', bodyFormat: 'markdown',
    textPreview: '', sender, createdAt: 1, read: false, pinned: false, archived: false, thread: [], ...extra,
  };
}

const SENDERS: Record<string, { sender: LetterSender; kind: LetterOriginKind; name: string }> = {
  task: { sender: { sessionId: 's-1', taskId: 't-1', taskTitle: 'Offer review', sessionTitle: 'offer', host: 'local' }, kind: 'task', name: 'Offer review' },
  'task, no title': { sender: { sessionId: 's-1', taskId: 't-1', host: 'local' }, kind: 'task', name: 'Walnut task' },
  'triage, stamped': { sender: { sessionId: 's-2', taskId: 't-2', taskTitle: 'Triage · 21:38 · 2 items', agentId: 'triage', host: 'local' }, kind: 'triage', name: 'Inbox Triage' },
  'triage, by project (older letter)': { sender: { sessionId: 's-2', taskId: 't-2', project: 'Ask Inbox Triage', host: 'local' }, kind: 'triage', name: 'Inbox Triage' },
  'session, no task': { sender: { sessionId: 's-3', sessionTitle: 'hand-started', host: 'local' }, kind: 'session', name: 'hand-started' },
  plugin: { sender: { sessionId: 'external', pluginId: 'acme-crm', pluginName: 'Acme CRM', host: 'local' }, kind: 'plugin', name: 'Acme CRM' },
  script: { sender: { sessionId: 'external', host: 'local', via: 'api' }, kind: 'script', name: 'A script' },
  'Walnut itself': { sender: { sessionId: 'external', host: 'local' }, kind: 'walnut', name: 'Walnut' },
};

describe('every letter resolves to an origin', () => {
  for (const type of LETTER_TYPES) {
    for (const [label, want] of Object.entries(SENDERS)) {
      it(`${type} from ${label}`, () => {
        const origin = letterOriginOf(record(want.sender, { type }), false);
        expect(LETTER_ORIGIN_KINDS).toContain(origin.kind);
        expect(origin).toMatchObject({ kind: want.kind, name: want.name });
        expect(letterOriginLine(origin).trim()).not.toBe('');
      });
    }
  }
});

/**
 * Each kind of letter Walnut writes itself, with the sender its callers stamp. A new kind fails
 * here until it says which origin its letters read as (never `script`: that is a stranger's).
 */
const WALNUT_KIND_SENDERS: Record<string, LetterSender> = {
  'host-sign-in': { sessionId: 'external', host: 'local' },
  'host-exec-ask': { sessionId: 'external', host: 'local' },
  'budget-paused': { sessionId: 'external', host: 'local' },
  'org-report': { sessionId: 's-main', taskId: 't-main', taskTitle: 'Main', host: 'local' },
  'mail-approval': { sessionId: 'external', host: 'local', pluginId: 'mail', pluginName: 'Mail' },
  'mail-unsubscribe': { sessionId: 'external', host: 'local', pluginId: 'mail', pluginName: 'Mail' },
  'mail-digest': { sessionId: 'external', host: 'local', pluginId: 'mail', pluginName: 'Mail' },
  'offline-conflict': { sessionId: 'external', host: 'devbox' },
  'local-network-blocked': { sessionId: 'external', host: 'local' },
  'ssh-cert-expiry': { sessionId: 'external', host: 'local' },
  'mail-no-router': { sessionId: 'external', host: 'local' },
};

describe('every kind of letter Walnut writes itself has an origin', () => {
  it('lists every kind in the registry', () => {
    expect(Object.keys(WALNUT_KIND_SENDERS).sort()).toEqual(WALNUT_LETTER_KINDS.map((k) => k.id).sort());
  });
  for (const kind of WALNUT_LETTER_KINDS) {
    it(kind.id, () => {
      const sender = WALNUT_KIND_SENDERS[kind.id];
      expect(sender, `add ${kind.id} to WALNUT_KIND_SENDERS with the sender its callers stamp`).toBeDefined();
      const sample = kind.samples[0];
      const rendered = kind.render('en', sample as never);
      const letter = record(sender!, {
        type: kind.type, subject: rendered.subject,
        ...(rendered.actions ? { actions: rendered.actions } : {}),
        ...(kind.marked ? { createdByOp: `${kind.id}:x` } : {}),
      });
      const origin = letterOriginOf(letter, !!kindOfLetter(letter));
      expect(['walnut', 'plugin', 'task']).toContain(origin.kind);
      if (kind.marked && !sender!.taskId) expect(origin.kind).toBe('walnut');
      expect(origin.name.trim()).not.toBe('');
    });
  }
});

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, out);
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

/** Surfaces that show a letter's subject without being where it is read (with why). */
const SUBJECT_ONLY: Record<string, string> = {
  'web/src/components/inbox/LetterReader.tsx': 'the overlay frame: its aria-label only; LetterView inside it leads with the badge',
};

describe('every inbox surface leads a letter with its origin', () => {
  it('web: a component rendering a letter subject renders LetterOriginBadge', () => {
    const files = walk(path.join(ROOT, 'web/src'), '.tsx');
    const subjectText = /\{\s*(?:letter|shown|envelope|l)\??\.subject\b/;
    const surfaces = files.filter((f) => /@\/api\/human-inbox['"]/.test(fs.readFileSync(f, 'utf8')) && subjectText.test(fs.readFileSync(f, 'utf8')));
    expect(surfaces.length).toBeGreaterThanOrEqual(2);
    const missing = surfaces
      .map((f) => path.relative(ROOT, f))
      .filter((rel) => !SUBJECT_ONLY[rel] && !fs.readFileSync(path.join(ROOT, rel), 'utf8').includes('<LetterOriginBadge'));
    expect(missing, 'render <LetterOriginBadge> before the subject, or list the file in SUBJECT_ONLY with why').toEqual([]);
  });

  it('iOS: a view rendering a letter subject renders LetterOriginBadge', () => {
    const files = walk(path.join(ROOT, 'ios-native/Walnut/Views'), '.swift');
    const surfaces = files.filter((f) => /Text\(\s*letter\.subject/.test(fs.readFileSync(f, 'utf8')));
    expect(surfaces.length).toBeGreaterThanOrEqual(2);
    const missing = surfaces.filter((f) => !fs.readFileSync(f, 'utf8').includes('LetterOriginBadge(')).map((f) => path.relative(ROOT, f));
    expect(missing).toEqual([]);
  });

  it('the phone push leads with the origin, the subject in its body', () => {
    const push = letterPushContent({
      letterId: 'lt-test-0001', subject: 'Decide on the Acme offer', type: 'action_required',
      textPreview: 'Two options.', kind: 'new', origin: { kind: 'task', name: 'Offer review' },
    });
    expect(push.title).toBe('Task “Offer review”');
    expect(push.body).toBe('Decide on the Acme offer\nTwo options.');
    const reply = letterPushContent({
      letterId: 'lt-test-0001', subject: 'S', type: 'info', textPreview: '', kind: 'reply',
      origin: { kind: 'triage', name: 'Inbox Triage' },
    });
    expect(reply.title).toBe('Reply · Inbox Triage');
    expect(reply.body).toBe('S');
  });

  it('the letter event carries the origin to the bell and the push', () => {
    const store = fs.readFileSync(path.join(ROOT, 'src/core/human-inbox/store.ts'), 'utf8');
    const emit = store.slice(store.indexOf('function emitLetterEvent'), store.indexOf('// ── Public API'));
    expect(emit).toMatch(/originKind: record\.origin\.kind, originName: record\.origin\.name/);
    const bridge = fs.readFileSync(path.join(ROOT, 'src/core/notifications/letter-bridge.ts'), 'utf8');
    expect(bridge).toMatch(/letterOriginLine\(/);
  });
});
