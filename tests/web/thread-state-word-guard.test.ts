/**
 * Guard: the words a Thread shows (the Org page's and a task's Threads, the phone app's) are the
 * user's own groups and nothing else: Needs you, Done, Working, Waiting / Snoozed, Acknowledged,
 * Closed, Archived (src/core/org/thread-groups.ts THREAD_GROUP_LABELS). Its state value stays
 * `answered` inside Walnut; he never reads "Answered", "To read" or "Known" as a state,
 * "Acknowledged" only names the group a card waits in while the AI decides where it goes, and
 * "Done" only names a result waiting on its card, never a thread he closed.
 *
 * 2026-11-20, the user, on chips that read All / Needs you / To read / Waiting / Done: "why there
 * is to read, why ... known", "why the done here means close", then "No Need you, Done, waiting /
 * snoozed, Acknowlegde, closed, archived", and of Acknowledge: "if I ack and ai should determine if
 * it should go to closed or wait or wip", "keep Acknowledged, simpler" (the group a card passes
 * through while the AI decides).
 *
 * The class: every web and iOS source file that renders an org thread (it names the thread type
 * or its API), found from the source, so a new card, list or header joins by itself. A string
 * literal with one of the retired words in any of them fails (an "Acknowledged" but the
 * Acknowledged group's own label on the phone too), and so does any "Done" literal but the Done
 * group's own label (and the phone sheet's standard dismiss button); comments, the
 * `answered` and `known` values (lowercase) and the Acknowledge button are free.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { THREAD_GROUPS, THREAD_GROUP_LABELS } from '../../src/core/org/thread-groups';

const ROOT = join(__dirname, '..', '..');

function walk(dir: string, exts: readonly string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

/** Comments out, string literals kept: `//` lines and block comments go (good enough for a word scan). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Quoted literals ('…', "…", `…`). */
function literals(src: string): string[] {
  return stripComments(src).match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? [];
}

/** The words a thread never shows as a state any more. */
const RETIRED = /\b(Answered|To read|Known|Acknowledged)\b/;
/** An "Acknowledged" a thread file may hold: the Acknowledged group's own label on the phone. */
const ACK_ALLOWED = [/case \.known: return "Acknowledged"/g];
/** A "Done" a thread file may hold: the Done group's own label on the phone, the phone sheet's dismiss. */
const DONE_ALLOWED = [/case \.read: return "Done"/g, /Button\("Done"\) \{ dismiss\(\) \}/g];

/** A word right after an opening quote, so a literal inside a Swift interpolation ("\\(x ? "Known" : y)") is seen too. */
const quoted = (code: string, word: RegExp): string[] => [...code.matchAll(new RegExp(`['"\`](?:${word.source})\\b`, 'g'))].map((m) => m[0]);

function retiredLiterals(src: string): string[] {
  let code = stripComments(src);
  for (const ok of ACK_ALLOWED) code = code.replace(ok, '');
  const whole = literals(code).filter((l) => RETIRED.test(l));
  const inner = quoted(code, /Answered|To read|Known|Acknowledged/).filter((q) => !whole.some((l) => l.startsWith(q)));
  return [...whole, ...inner];
}
function doneLiterals(src: string): string[] {
  let code = stripComments(src);
  for (const ok of DONE_ALLOWED) code = code.replace(ok, '');
  const whole = literals(code).filter((l) => /\bDone\b/.test(l));
  const inner = quoted(code, /Done/).filter((q) => !whole.some((l) => l.startsWith(q)));
  return [...whole, ...inner];
}

const WEB_MARK = /api\/org-threads|useOrgThreads|\bOrgThread\b|thread-groups/;
const IOS_MARK = /\bOrgThread\b/;

const webFiles = walk(join(ROOT, 'web', 'src'), ['.ts', '.tsx']).filter((f) => WEB_MARK.test(readFileSync(f, 'utf8')));
const iosFiles = walk(join(ROOT, 'ios-native', 'Walnut'), ['.swift']).filter((f) => IOS_MARK.test(readFileSync(f, 'utf8')));

describe('Threads show only his own group words', () => {
  it('finds the files that render a thread (the class is not empty)', () => {
    const rel = [...webFiles, ...iosFiles].map((f) => relative(ROOT, f));
    for (const f of [
      'web/src/components/org/OrgThreads.tsx', 'web/src/components/org/OrgThreadsByState.tsx', 'web/src/components/org/ThreadKnown.tsx',
      'web/src/components/board/kanban/kanban-thread-status.ts',
      'ios-native/Walnut/Views/Org/OrgThreadModel.swift', 'ios-native/Walnut/Views/Org/OrgThreadsView.swift', 'ios-native/Walnut/Views/Org/OrgThreadKnownBlock.swift',
    ]) expect(rel).toContain(f);
  });

  it('the groups are exactly Needs you, Done, Working, Waiting / Snoozed, Acknowledged, Closed and Archived', () => {
    expect(THREAD_GROUPS.map((g) => THREAD_GROUP_LABELS[g])).toEqual(['Needs you', 'Done', 'Working', 'Waiting / Snoozed', 'Acknowledged', 'Closed', 'Archived']);
  });

  it('no file that renders a thread has Answered, To read or Known in a string, nor Acknowledged but its group label', () => {
    const hits = [...webFiles, ...iosFiles].flatMap((f) => retiredLiterals(readFileSync(f, 'utf8')).map((l) => `${relative(ROOT, f)}: ${l}`));
    expect(hits, 'a thread reads its group word (THREAD_GROUP_LABELS)').toEqual([]);
  });

  it('"Done" is only the Done group\'s label: a closed thread reads Closed', () => {
    const hits = [...webFiles, ...iosFiles].flatMap((f) => doneLiterals(readFileSync(f, 'utf8')).map((l) => `${relative(ROOT, f)}: ${l}`));
    expect(hits, 'Done names a result waiting on its card; a closed card reads Closed').toEqual([]);
    // The web's card word for an answered, held or closed thread is its group's.
    const web = stripComments(readFileSync(join(ROOT, 'web/src/components/org/OrgThreads.tsx'), 'utf8'));
    expect(web).toMatch(/if \(t\.closed\) return t\.movedTo \? 'Moved' : THREAD_GROUP_LABELS\[group\];/);
    expect(web).toMatch(/return t\.state === 'answered' \|\| known \? THREAD_GROUP_LABELS\[group\] : STATE_LABEL\[t\.state\];/);
    const swift = stripComments(readFileSync(join(ROOT, 'ios-native/Walnut/Views/Org/OrgThreadModel.swift'), 'utf8'));
    expect(swift).toMatch(/if t\.closed != nil \|\| t\.state == "answered" \|\| isKnown\(t\) \{ return group\(t, inView: inView, now: now\)\.label \}/);
  });

  it('the scans catch the old words (self-check)', () => {
    expect(retiredLiterals(`const L = { answered: 'To read', known: 'Known' }; // To read in a comment`)).toEqual([`'To read'`, `'Known'`]);
    expect(retiredLiterals(`/* 'Answered' */ const ok = 'answered'; const b = 'Acknowledge'`)).toEqual([]);
    expect(retiredLiterals(`closedWords = \`Acknowledged \${who}\``)).toEqual(['`Acknowledged ${who}`']);
    expect(doneLiterals(`if let c = t.closed { return c.how == "acked" ? "Done" : "Dropped" }`)).toEqual(['"Done"']);
    expect(doneLiterals(`case .read: return "Done"\nButton("Done") { dismiss() }`)).toEqual([]);
    // Inside a Swift interpolation too.
    expect(retiredLiterals(`Text("\\(c.how == "acked" ? "Acknowledged" : "Dropped")")`).length).toBeGreaterThan(0);
    // The Acknowledged group's own label is free; the word anywhere else is not.
    expect(retiredLiterals(`case .known: return "Acknowledged"`)).toEqual([]);
    expect(retiredLiterals(`case .done: return "Acknowledged"`)).toEqual(['"Acknowledged"']);
  });
});
