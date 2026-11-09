/**
 * Ratchet: no delivery failure path can leave a person's message in a silent unknown while
 * its host's link is down (2026-11-06: messages to tasks on a host whose sign-in expired read
 * "Send failed" with no host and no next try, or a bare "Queued", or a grey bubble).
 *
 * The class, enumerated from the source:
 *   1. every runner function that puts a session's rows back or tells the user they failed
 *      (reportBatchFailed, revertToPending, revertIfQueued, parkMessages, parkIfQueued) is
 *      listed below: one that ENDS a delivery asks linkDownHost first, so a link that is down
 *      becomes a wait for that host with its next try (host-link-down-delivery.test.ts); one
 *      that only hands the rows on names where they go; one that is never a link failure says why;
 *   2. "the batch failed" reaches the page only through reportBatchFailed;
 *   3. every SendHeldError a transport throws is classified: a link that is down reads as one
 *      (isHostLinkFailure), any other hold is listed with its reason.
 * A new member fails here until it is classified.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isHostLinkFailure, SendHeldError } from '../../src/providers/delivery-failure.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const RUNNER = path.join(ROOT, 'src/providers/claude-code-session.ts');

/** Ends a delivery attempt and tells the user: must ask whether the host's link is down. */
const ENDS_DELIVERY = new Set(['settleUnansweredLine', 'settleResumeFailure', 'processNextNow', 'drainAcpPrompt']);
/** Puts the rows back and hands them to the next delivery, which ends in one of the above. */
const HANDS_ON: Record<string, string> = {
  injectMidTurn: 'a refused mid-turn write delegates to processNext',
  steerAcpQueued: 'a refused steer leaves the rows to the turn-end drain (drainAcpQueue → drainAcpPrompt)',
  handBackLines: 'lines a dead process never took go back for the next delivery',
  handBackAnsweringLines: 'lines a process answered without taking go back for the next delivery',
  reclaimLostLine: 'a line the CLI read past is written again by the next delivery',
};
/** Never a link failure. */
const NOT_LINK: Record<string, string> = {
  parkLineRows: 'the CLI read the line and dropped it: the host answered, nothing to wait for',
  parkIfRedeliveryLoop: 'a row taken too often in a short time: each take was answered, a loop bound, not a link failure',
};

const FAILURE_CALL = /\b(reportBatchFailed|revertToPending|revertIfQueued|parkMessages|parkIfQueued)\(/g;
const FN_HEAD = /^ {2}(?:private |public |protected )?(?:static )?(?:async )?(\w+)\s*(?:<[^>]*>)?\(|^(?:export )?(?:async )?function (\w+)/;
const NOT_FN = new Set(['if', 'for', 'while', 'switch', 'catch', 'return']);

function failureFunctions(src: string): Map<string, string> {
  const lines = src.split('\n');
  const bodies = new Map<string, string>();
  let current = '';
  let start = 0;
  const flush = (end: number) => { if (current) bodies.set(current, (bodies.get(current) ?? '') + lines.slice(start, end).join('\n')); };
  lines.forEach((line, i) => {
    const m = FN_HEAD.exec(line);
    const name = m ? (m[1] ?? m[2]) : undefined;
    if (name && !NOT_FN.has(name)) { flush(i); current = name; start = i; }
  });
  flush(lines.length);
  const out = new Map<string, string>();
  for (const [name, body] of bodies) {
    if (/^(?:export )?(?:async )?function (reportBatchFailed)\b/m.test(body)) continue;
    if (FAILURE_CALL.test(body)) out.set(name, body);
    FAILURE_CALL.lastIndex = 0;
  }
  return out;
}

describe('delivery failure paths and a host link that is down', () => {
  const src = fs.readFileSync(RUNNER, 'utf-8');
  const found = failureFunctions(src);

  it('every runner function that puts rows back or reports them failed is classified', () => {
    const listed = new Set([...ENDS_DELIVERY, ...Object.keys(HANDS_ON), ...Object.keys(NOT_LINK)]);
    const unlisted = [...found.keys()].filter((n) => !listed.has(n));
    expect(unlisted, 'a new delivery failure path: make it ask linkDownHost (ENDS_DELIVERY), or list where it hands the rows (HANDS_ON) or why it is never a link failure (NOT_LINK)').toEqual([]);
    const gone = [...listed].filter((n) => !found.has(n));
    expect(gone, 'listed but no longer a failure path: drop it from the list').toEqual([]);
  });

  it('every path that ends a delivery asks whether the host link is down first', () => {
    for (const name of ENDS_DELIVERY) {
      const body = found.get(name) ?? '';
      expect(body, name).toContain('this.linkDownHost(');
      const ask = body.indexOf('this.linkDownHost(');
      // Its generic "failed" report comes after the question (a budget or a Stop may go before).
      const generic = body.lastIndexOf('reportBatchFailed(');
      if (generic >= 0 && name !== 'drainAcpPrompt') expect(ask, `${name}: linkDownHost before its last reportBatchFailed`).toBeLessThan(generic);
    }
  });

  it('"the batch failed" reaches the page only through reportBatchFailed', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) {
          const text = fs.readFileSync(p, 'utf-8');
          const emits = text.match(/emit\(\s*EventNames\.SESSION_BATCH_FAILED/g)?.length ?? 0;
          if (emits > 0 && !(p === RUNNER && emits === 1 && /function reportBatchFailed[\s\S]{0,300}SESSION_BATCH_FAILED/.test(text))) offenders.push(path.relative(ROOT, p));
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    expect(offenders).toEqual([]);
  });

  it('every SendHeldError a transport throws is classified as a link that is down, or listed', () => {
    /** Holds that are not the link: the host answered, or the hold is about one line. */
    const NOT_LINK_HOLDS: Record<string, string> = {
      'The session page no longer owns the cloud connection': 'the page let the link go; the next delivery opens its own',
      'The cloud session connection was cancelled': 'a newer connection replaced this one',
      'The companion credential is awaiting recovery': 'a sign-in to recover; the host card says so',
      'The session stream closed before its attachment was confirmed': 'one attach; the next delivery attaches again',
      'Not sent yet: the cloud session connection was cancelled': 'a newer connection replaced this one',
      'Not sent yet: the cloud session host did not confirm a live process': 'the host answered without a process',
      'Not sent yet: the session host could not rediscover the process': 'the host answered; the process is being found',
      'Not sent yet: the session host could not confirm the process identity': 'the host answered; the process is being found',
      'Not sent yet: the session host could not confirm the process': 'the host answered; the process is being found',
      'Not sent yet: the rediscovered host cannot dedupe the user line': 'the host answered; an older daemon',
      'Not sent yet: the session process needs native recovery': 'the host answered; recovery runs first',
      '<default>': 'held behind a line still being confirmed',
      '<reason>': 'cloud link: the reason it was given',
      '<host refused>': 'the host answered and refused',
      '<wrapped>': 'any other error: the host link is read from the pool (linkDownHost)',
    };
    const files = ['src/providers/remote-session-manager.ts', 'src/providers/cloud-session-link.ts'];
    const unclassified: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf-8');
      for (const m of text.matchAll(/new SendHeldError\(([^)]*)\)/g)) {
        const arg = m[1].trim();
        const literal = /^'([^']*)'$/.exec(arg)?.[1];
        const key = literal ?? (arg === '' ? '<default>' : arg === 'reason' ? '<reason>'
          : arg.includes('refused delivery') ? '<host refused>' : arg.includes('err instanceof Error') ? '<wrapped>' : arg);
        if (literal && isHostLinkFailure(new SendHeldError(literal))) continue;
        if (!(key in NOT_LINK_HOLDS)) unclassified.push(`${f}: ${arg}`);
      }
    }
    expect(unclassified, 'a new hold: if it means nothing reaches the host, word it so isHostLinkFailure reads it, else list it').toEqual([]);
    expect(isHostLinkFailure(new SendHeldError('Not sent yet: waiting for the connection to the session host'))).toBe(true);
    expect(isHostLinkFailure(new Error('No companion connection is available for this session'))).toBe(true);
  });
});
