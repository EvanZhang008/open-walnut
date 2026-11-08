/**
 * GUARD: every send filed under a question carries that question's `question`
 * hint with its thread id (2026-11-03, the user: "each question has a thread id
 * and thread name, and they must match, each ask from us in that thread also
 * remind model about this, the thread can be nested").
 *
 * The hint is what names the question to the model and asks for the
 * `<walnut-ask-answer thread=".." name="..">` tag its answer is filed from
 * (web/src/utils/ask-answer.ts). A follow-up sent without it is answered with no
 * tag, so its answer reads in the main conversation and the question waits.
 *
 * A send is filed under a question when it pre-assigns the row's uuid (the
 * anchor is written under it). This test finds, from the source, every send call
 * in web/src that passes a `userUuid`, and fails on one without
 * `hints: questionHint(<thread id>)`, except the main conversation's own send.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const WEB = join(ROOT, 'web', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const files = walk(WEB).map((p) => ({ rel: relative(ROOT, p), src: readFileSync(p, 'utf8') }));

/** A send call whose options object pre-assigns the row's uuid, anywhere in it (after a spread too). */
const SEND_WITH_UUID = /\b(?:dispatch|send|interruptSend)\(\s*sessionId\s*,[^;]*?\{[^{}]*\buserUuid\b[^}]*\}/g;

/** The one uuid send that files under no question: the main conversation's
 *  (its uuid only places the optimistic row on the main page at once). */
const ROOT_SEND = /dispatch\(sessionId, text, images, \{ (?:\.\.\.local, )?userUuid \}/;

const QUESTION_HINT = /\bhints: questionHint\((thread|threadIdOfKey\(r, key, issuedRef\.current\))\)/;

describe('guard: every send filed under a question names the question', () => {
  const sends = files.flatMap((f) => [...f.src.matchAll(SEND_WITH_UUID)].map((m) => ({ rel: f.rel, call: m[0], at: m.index ?? 0, src: f.src })));

  it('finds the question sends (the new question, a follow-up from its page or card, Retry)', () => {
    expect(sends.length).toBeGreaterThanOrEqual(3);
    expect(new Set(sends.map((s) => s.rel))).toEqual(new Set(['web/src/hooks/useSessionThreads.ts']));
  });

  it('each one carries the question hint with a thread id, unconditionally', () => {
    for (const s of sends) {
      if (ROOT_SEND.test(s.call)) {
        // Only inside the main conversation's branch.
        const before = s.src.slice(Math.max(0, s.at - 900), s.at);
        const branch = before.lastIndexOf('if (key === ROOT_THREAD_KEY) {');
        expect(branch, `${s.rel}: a send without the question hint outside the main conversation's branch`).toBeGreaterThan(-1);
        // Still inside that branch: its closing brace (four spaces in) not passed yet.
        expect(before.slice(branch)).not.toMatch(/\n {4}\}\n/);
        continue;
      }
      expect(s.call, `${s.rel}: a send filed under a question must pass hints: questionHint(<thread id>)`).toMatch(QUESTION_HINT);
    }
  });

  it('the scan finds a uuid anywhere in the options, and a new call without the hint is flagged', () => {
    const variants = [
      'dispatch(sessionId, text, images, { ...local, userUuid, hints: questionHint(thread) });',
      'send(sessionId, text, undefined, { draftOrigin, userUuid });',
      'interruptSend(sessionId, text, images, { hints: questionHint(thread), userUuid: id });',
      'dispatch(sessionId, text, images, { ...local, userUuid });',
    ].join('\n');
    const found = [...variants.matchAll(SEND_WITH_UUID)].map((m) => m[0]);
    expect(found).toHaveLength(4);
    expect(found.map((c) => ROOT_SEND.test(c))).toEqual([false, false, false, true]);
    expect(found.map((c) => QUESTION_HINT.test(c))).toEqual([true, false, true, false]);
  });

  it('questionHint is only ever given a thread id, never the flat number', () => {
    for (const f of files) {
      for (const m of f.src.matchAll(/\bquestionHint\(([^)]*\)?)\)/g)) {
        if (/function questionHint/.test(f.src.slice(Math.max(0, (m.index ?? 0) - 20), m.index))) continue;
        expect(m[1], `${f.rel}: questionHint(${m[1]})`).toMatch(/^(thread|threadIdOfKey\(r, key, issuedRef\.current\)|thread: string)$/);
      }
    }
  });

  it('every way into a question goes through those sends', () => {
    const src = files.find((f) => f.rel === 'web/src/hooks/useSessionThreads.ts')!.src;
    // The card's composer and a review card's composer post through sendAnchored, pictures too (f471cab33).
    expect(src).toMatch(/const sendToTarget = useCallback\(\s*\(text: string, images\?: ImageAttachment\[\], origin\?: DraftOrigin\) => sendAnchored\(text, images,/);
    expect(src).toMatch(/const sendToQuestion = useCallback\(\s*\(key: string, text: string, images\?: ImageAttachment\[\], origin\?: DraftOrigin\) => sendAnchored\(text, images,/);
    // A new question stores the id it was given, beside its number.
    expect(src).toMatch(/metaEntries\.push\(\{ headId: userUuid, status: 'open', titleState: 'pending', question: message\.slice\(0, 400\), seq, thread \}\)/);
    // Its id and number count the questions asked before their meta was read back (two asks in a row).
    expect(src).toMatch(/const listNow = withIssued\(r\.meta\.list, issuedRef\.current\);/);
    expect(src).toMatch(/nextQuestionSeq\(r\.tree, r\.meta\.index, listNow\)/);
    expect(src).toMatch(/nextQuestionPath\(r\.tree, r\.meta\.index, listNow, within\)/);
    // The panel's composer: every send is sendAnchored's.
    const panel = files.find((f) => f.rel === 'web/src/components/sessions/SessionPanel.tsx')!.src;
    expect(panel).toMatch(/const threadSend = threads\.sendAnchored;/);
    // Tree Mode's split: the left half's composer posts through the panel's one
    // composer send (engine switch, pending comments, then sendAnchored with
    // the left page as its question), and its comment card through sendToQuestion.
    expect(panel).toMatch(/const sideSend = useCallback\(\(key: string, message: string, images\?: ImageAttachment\[\], origin\?: DraftOrigin\) => \(\s*withComments\(\(m, im, o\) => sendFor\(m, im, key, o\), \(\) => key\)\(message, images, origin\)/);
    expect(panel).toMatch(/withComments\(\(m, im, o\) => sendAnchored\(m, im, true, key, o\), \(\) => key\)/);
    expect(panel).toMatch(/return sendAnchored\(message, images, false, targetKey, origin\);/);
    expect(panel).toMatch(/return threadSend\(message, images, interrupt, targetKey, origin\);/);
    // Every page beside the panel's own (left of it, the sibling above it) sends through it.
    expect(panel.match(/onSendFor=\{sideSend\}/g)?.length).toBe(2);
    const left = files.find((f) => f.rel === 'web/src/components/sessions/TreeSplitLeft.tsx')!.src;
    expect(left).toMatch(/const ok = await onSendFor\(leftKey, text, images, origin\);/);
    expect(left).toMatch(/sendToTarget: \(text: string, images\?: ImageAttachment\[\], origin\?: DraftOrigin\) => base\.sendToQuestion\(leftKey, text, images, origin\)/);
    expect(left).toMatch(/<ChatInput\s+onSend=\{send\}/);
  });
});
