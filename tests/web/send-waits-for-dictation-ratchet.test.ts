/**
 * Every composer with a mic sends through useSendAfterDictation.
 *
 * 2026-11-01, the user: "currently send doesn't wait the voice button I think
 * it should wait, and send afterward". A send pressed while the mic was still
 * recording sent the text as it stood and threw the rest of the words away.
 * Now Send stops the recording, waits for the final words and sends once
 * (web/src/hooks/useSendAfterDictation.ts). This test lists every file that
 * draws a mic and fails when one of them has a mic its send does not wait on,
 * so a new composer cannot skip the rule.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../../web/src');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}
const files = sources(ROOT).map((p) => ({ rel: relative(ROOT, p), text: readFileSync(p, 'utf8') }));

/** The mic components themselves: they hand their owner the handle the gate waits on. */
const MIC_COMPONENTS = new Set([
  'components/common/MicButton.tsx',
  'components/common/BoxMic.tsx',
  'components/common/EditorMic.tsx',
  'components/common/AnswerBox.tsx',
  'plugins/views.tsx',
]);

/**
 * Files with a mic whose words are never sent by a press: each says why. A file
 * with a send of its own does not belong here.
 */
const NO_SEND: Record<string, string> = {
  'components/sessions/SessionNotes.tsx': 'the session note autosaves on every change; the mic appends to it and nothing submits the words',
  'components/notes/NotesEditor.tsx': 'the editor autosaves through onDirty; none of its hosts has a submit action for dictated words',
};

/** A direct use of a gated function that is meant to skip the wait, each with why. */
const DIRECT_OK: Record<string, { near: string; why: string }> = {
  commitNote: {
    near: 'onBlur={commitNote}',
    why: 'leaving the host note box saves what it holds (an autosave); the final words are saved by the next blur or Enter',
  },
};

const MIC_TAG = /<(MicButton|BoxMic|MicField|EditorMic|AnswerBox)\b/g;

/** The JSX element starting at `start` (`<Tag ... >` or `/>`), braces respected. */
function elementAt(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

/** The ref a mic element hands its handle to, or null when it hands none. */
function micRefOf(el: string): string | null {
  const m = el.match(/\b(?:controlRef|handleRef|micRef)=\{\s*([A-Za-z_$][\w$.]*)\s*\}/);
  return m ? m[1] : null;
}

/** Every ref named inside a `useSendAfterDictation([...]` array in the file. */
function gatedRefs(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/useSendAfterDictation\(\s*\[([^\]]*)\]/g)) {
    for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) out.add(name);
  }
  return out;
}

/** The argument list of the call whose `(` is at `open`. */
function callArgs(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/**
 * Functions a gate runs that the file also calls or binds outside a gate: a
 * submit path that skips the wait. (`useCallback` and the gate's own call are
 * not uses; a name that is only defined and handed to the gate is fine.)
 */
function bypasses(text: string): string[] {
  const out: string[] = [];
  const gateSpans: Array<[number, number]> = [];
  const names = new Set<string>();
  for (const m of text.matchAll(/useSendAfterDictation\(/g)) {
    const open = m.index! + m[0].length - 1;
    const args = callArgs(text, open);
    gateSpans.push([open, open + args.length + 1]);
    const sendArg = args.slice(args.indexOf(']') + 1).replace(/^\s*,/, '').replace(/,\s*[\w$.]+\s*$/, '').trim();
    // The send is a function name, or an arrow that only calls one: `() => void submit()`.
    const named = sendArg.match(/^([A-Za-z_$][\w$]*)$/)
      ?? sendArg.match(/^\(\)\s*=>\s*\{?\s*(?:void\s+)?([A-Za-z_$][\w$]*)\([^()]*\)\s*;?\s*\}?$/);
    if (named) names.add(named[1]);
  }
  const inGate = (i: number) => gateSpans.some(([a, b]) => i >= a && i <= b);
  for (const name of names) {
    const esc = name.replace(/\$/g, '\\$');
    const use = new RegExp(`(?:=\\{\\s*${esc}\\s*\\}|(?<![\\w$.])${esc}\\s*\\()`, 'g');
    for (const u of text.matchAll(use)) {
      const at = u.index!;
      if (inGate(at)) continue;
      if (DIRECT_OK[`${name}`] && text.slice(Math.max(0, at - 40), at + 40).includes(DIRECT_OK[name].near)) continue;
      const before = text.slice(Math.max(0, at - 16), at);
      if (/(function|const|let)\s+$/.test(before) || /function\s*$/.test(before)) continue;
      out.push(`${name} at offset ${at}: ${text.slice(at, at + 40).replace(/\s+/g, ' ')}`);
    }
  }
  return out;
}

const owners = files.filter((f) => !MIC_COMPONENTS.has(f.rel) && /<(MicButton|BoxMic|MicField|EditorMic|AnswerBox)\b/.test(f.text));

describe('send waits for the dictation in every composer with a mic', () => {
  it('finds the composers (the scan is alive)', () => {
    expect(owners.length).toBeGreaterThan(20);
    expect(owners.map((f) => f.rel)).toContain('components/chat/ChatInput.tsx');
  });

  it('AnswerBox and the plugin mic route their own send through the gate', () => {
    const answer = files.find((f) => f.rel === 'components/common/AnswerBox.tsx')!.text;
    expect(answer).toMatch(/useSendAfterDictation\(\s*\[\s*mic\s*\]/);
    const api = readFileSync(join(__dirname, '../../packages/plugin-api/src/web.ts'), 'utf8');
    expect(api).toMatch(/finish\?\(\): Promise<\{ error: string \| null \}>/);
  });

  for (const f of owners) {
    it(`${f.rel}: every mic is waited on by its send`, () => {
      if (NO_SEND[f.rel]) {
        expect(f.text, `${f.rel} is listed as having no send but routes one through the gate`).not.toMatch(/useSendAfterDictation\(/);
        return;
      }
      const gated = gatedRefs(f.text);
      const problems: string[] = [];
      for (const m of f.text.matchAll(MIC_TAG)) {
        const el = elementAt(f.text, m.index!);
        const ref = micRefOf(el);
        // An AnswerBox that owns the send (onSubmit: its button and Enter) waits on its own mic.
        if (m[1] === 'AnswerBox' && /\bonSubmit=/.test(el)) continue;
        if (!ref) { problems.push(`<${m[1]}> hands its owner no handle (controlRef/handleRef/micRef)`); continue; }
        if (!gated.has(ref)) problems.push(`<${m[1]}> ${ref} is in no useSendAfterDictation([...]) of this file`);
      }
      expect(problems, `${f.rel}: a send here must wait for its mic (or list the file in NO_SEND with why)`).toEqual([]);
      expect(bypasses(f.text), `${f.rel}: a function a gate runs is also called directly, so that path does not wait`).toEqual([]);
    });
  }
});
