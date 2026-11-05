/**
 * A hint goes out only for one of its own registry triggers (2026-11-05, the user, of the
 * reply-language block under every message of his: "I said don't do this every round remove
 * thies, this alsoshoudln't be in any official walnut product"). Its triggers said session start,
 * compaction, change and drift, yet two rules in the send pipeline added every_turn for every role
 * and for every person's message, so hint_list said one thing and every session got another.
 *
 * The class guard, two halves:
 *   - every built-in and a custom hint, planned for every role, both senders, every session state
 *     and every override of its triggers: each carried hint's reasons are some of its own triggers
 *     (on_request only when the send asked for it);
 *   - in the source, a hint block is rendered only by the registry's pipeline (hint-send.ts) or
 *     for Walnut's own kinds outside the registry, and `every_turn` is named only where triggers
 *     are defined or read, so a new path that sends a hint around the registry fails here.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Config, MessageHintRole, SessionHintState } from '../../../src/core/types.js';
import { HINT_ROLES, effectiveHints } from '../../../src/core/hints/hint-registry.js';
import { planHints, type HintPlan } from '../../../src/core/hints/hint-send.js';

const RULE = 'Talk to the user in Chinese; code stays English.';
const T0 = '2026-11-05T00:00:00.000Z';

function configs(): Array<Pick<Config, 'session'>> {
  const base = { reply_language: RULE, output_mode: 'rich' as const };
  const out: Array<Pick<Config, 'session'>> = [{ session: base } as never, { session: {} } as never];
  // Every built-in, with each single trigger it allows set by hand, and with none.
  for (const h of effectiveHints({ session: base } as never)) {
    for (const t of [...h.allowedTriggers.map((x) => [x]), []]) {
      out.push({ session: { ...base, hints: { [h.kind]: { triggers: t }, tone: { text: 'Keep it short.' } } } } as never);
    }
  }
  return out;
}

function states(): Array<{ hintState?: SessionHintState; lastCompactUuid?: string }> {
  const told = (hash: string) => Object.fromEntries(effectiveHints({ session: { reply_language: RULE } } as never)
    .map((h) => [h.kind, { send: 1, hash, at: T0, compact: 'c0' }]));
  return [
    {},
    { hintState: { sends: 1, told: told('same') }, lastCompactUuid: 'c0' },
    { hintState: { sends: 9, told: told('old') }, lastCompactUuid: 'c1' },
    { hintState: { sends: 3, told: told('old'), drift: { 'reply-language': '2026-11-05T01:00:00.000Z' } }, lastCompactUuid: 'c0' },
  ];
}

function allowed(plan: HintPlan, config: Pick<Config, 'session'>, requested: boolean): string[] {
  const bad: string[] = [];
  const byKind = new Map(effectiveHints(config).map((h) => [h.kind, h]));
  for (const c of plan.carried) {
    const hint = byKind.get(c.kind)!;
    const reasons = plan.reasons[c.kind] ?? [];
    if (!reasons.length) bad.push(`${c.kind}: no reason`);
    for (const r of reasons) {
      if (!hint.triggers.includes(r)) bad.push(`${c.kind}: ${r} is not one of ${hint.triggers.join(',') || 'none'}`);
      if (r === 'on_request' && !requested) bad.push(`${c.kind}: on_request without a request`);
    }
  }
  return bad;
}

describe('a hint goes out only for its own triggers', () => {
  it('every hint, role, sender and session state', () => {
    const bad = new Set<string>();
    let carried = 0;
    for (const config of configs()) {
      for (const role of [...HINT_ROLES, undefined] as Array<MessageHintRole | undefined>) {
        for (const sentBy of ['person', 'agent', undefined] as const) {
          for (const state of states()) {
            for (const requested of [false, true]) {
              const plan = planHints({
                hints: effectiveHints(config), target: { sessionId: 's', ...(role ? { role } : {}) },
                record: { claudeSessionId: 's', output_mode: 'rich', ...state }, config,
                ...(sentBy ? { sentBy } : {}), message: 'how is the build going?', inChat: sentBy === 'person',
                // The org hints only speak with their inputs (Main's and a lead's chat).
                away: { away: true, lastSeenAt: Date.parse(T0) }, brief: { at: null, stale: true, words: 'two lines moved', key: 'k' },
                thread: { threadId: 'th-1', title: 'Fix the hints', created: true, followUp: false, duplicate: false, open: [], closed: [] } as never,
                threadsTidy: { key: 'tidy-1', items: [] } as never,
                ...(requested ? { requested: { question: { arg: '3' }, 'voice-reply': {} } } : {}),
              });
              carried += plan.carried.length;
              for (const b of allowed(plan, config, requested)) bad.add(`${role ?? 'none'}/${sentBy ?? 'host'}: ${b}`);
            }
          }
        }
      }
    }
    expect([...bad]).toEqual([]);
    expect(carried).toBeGreaterThan(0);
  });

  it('the reply language is never due on a plain message after it was told, for any role or sender', () => {
    const config = { session: { reply_language: RULE } } as never;
    for (const role of HINT_ROLES) {
      for (const sentBy of ['person', 'agent'] as const) {
        const plan = planHints({
          hints: effectiveHints(config), target: { sessionId: 's', role }, config, sentBy, message: 'what the hack?',
          record: { claudeSessionId: 's', hintState: { sends: 1, told: { 'reply-language': { send: 1, hash: RULE, at: T0 } } } },
        });
        expect(plan.carried.map((h) => h.kind), `${role}/${sentBy}`).not.toContain('reply-language');
      }
    }
  });

  it('a fresh install sends no reply-language hint', () => {
    for (const config of [null, { session: {} }, { session: { reply_language: '  ' } }] as never[]) {
      const plan = planHints({ hints: effectiveHints(config), target: { sessionId: 's', role: 'main' }, config, record: null, sentBy: 'person', message: 'hi there, how are you?' });
      expect(plan.carried.map((h) => h.kind)).not.toContain('reply-language');
    }
  });

  it('the reply language\'s defaults are its triggers, never every message', () => {
    const h = effectiveHints({ session: { reply_language: RULE } } as never).find((x) => x.kind === 'reply-language')!;
    expect(h.triggers).toEqual(['session_start', 'after_compaction', 'on_change', 'on_drift']);
    // No built-in rides every message by default except threads, which says so (one per message the user files).
    const everyTurn = effectiveHints(null).filter((x) => x.triggers.includes('every_turn')).map((x) => x.kind);
    expect(everyTurn).toEqual(['threads']);
  });
});

const SRC = path.resolve(import.meta.dirname, '../../../src');

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.(ts|tsx|mjs|cjs)$/.test(e.name) ? [p] : [];
  });
}
function code(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('no path sends a hint around the registry', () => {
  const all = files(SRC).map((f) => ({ rel: path.relative(SRC, f), text: code(f) }));

  it('a hint block is rendered only by the pipeline, or for kinds outside the registry', () => {
    // Each with why: none renders a registry hint on a schedule of its own.
    const RENDERERS: Record<string, string> = {
      'core/hints/hint-send.ts': 'the registry pipeline itself',
      'core/hints/hint-format.ts': 'defines the block',
      'core/sessions/voice-reply.ts': 'the voice-reply block a phone send asked for (on_request), composed upstream',
      'core/sessions/engine-switch.ts': 'engine-switch, Walnut text outside the registry',
      'providers/acp-session.ts': 'session-context, Walnut text outside the registry',
    };
    const users = all.filter((f) => /\brenderHintBlock\s*\(/.test(f.text)).map((f) => f.rel);
    expect(users.filter((f) => !RENDERERS[f])).toEqual([]);
    expect(Object.keys(RENDERERS).filter((f) => !users.includes(f))).toEqual([]);
  });

  it('every_turn is named only where triggers are defined or read', () => {
    const NAMES: Record<string, string> = {
      'core/types.ts': 'the trigger type',
      'core/hints/hint-registry.ts': 'the trigger list, and threads\' own default',
      'core/hints/hint-schedule.ts': 'the schedule that reads triggers',
      'core/hints/hint-send.ts': 'the triggers a host can honour',
      'ops/hints.ts': 'hint_set\'s trigger list',
    };
    const users = all.filter((f) => /['"`]every_turn['"`]/.test(f.text)).map((f) => f.rel);
    expect(users.filter((f) => !NAMES[f])).toEqual([]);
  });

  it('the user\'s reply-language words are read only where a hint or a reply in it is made', () => {
    const READERS: Record<string, string> = {
      'core/sessions/output-mode.ts': 'defines it',
      'core/hints/hint-registry.ts': 'the reply-language hint',
      'core/hints/hint-drift-live.ts': 'the correction inside a turn, gated on the hint\'s on_drift',
      'core/human-inbox/walnut-letters/languages.ts': 'the language of Walnut\'s own letters to the user, not a hint',
    };
    const users = all.filter((f) => /\breplyLanguageText\s*\(/.test(f.text)).map((f) => f.rel);
    expect(users.filter((f) => !READERS[f])).toEqual([]);
    expect(Object.keys(READERS).filter((f) => !users.includes(f))).toEqual([]);
  });

  it('both start paths give a new conversation its start hints', () => {
    const runner = all.find((f) => f.rel === 'providers/claude-code-session.ts')!.text;
    expect(runner.match(/prepareStartHints\(/g)?.length).toBe(2);
  });

  it('no rule outside a hint\'s triggers forces it (the removed every-message fields stay gone)', () => {
    const hits = all.filter((f) => /\b(everyTurnRoles|everyPersonTurn)\b/.test(f.text)).map((f) => f.rel);
    expect(hits).toEqual([]);
  });

  it('Walnut writes no reply-language text of its own in another language', () => {
    expect(fs.existsSync(path.join(SRC, 'core/hints/reply-language-lines.ts'))).toBe(false);
    // Model-facing hint text in src/core/hints is English; the drift detector's language names are data.
    const cjk = all.filter((f) => f.rel.startsWith('core/hints/') && f.rel !== 'core/hints/hint-drift-detect.ts'
      // Kana, CJK, Hangul and Cyrillic, escaped (test data stays ASCII here).
      && /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0400-\u04ff]/.test(f.text)).map((f) => f.rel);
    expect(cjk).toEqual([]);
  });
});
