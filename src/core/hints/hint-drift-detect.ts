/**
 * Did a reply drift off the reply-language rule? Pure and cheap: it runs on every
 * turn end of a session whose last message came from a person (hint-drift.ts).
 *
 * The rule is the user's own sentence ("Talk to the user in Chinese; code ...
 * stays English"), so the language it asks for is read from the language names it
 * mentions; a rule that names none is never judged. Code, inline code, links,
 * paths and HTML are left out before counting, because they are English in every
 * language. A short reply proves nothing either way.
 */

type Script = 'han' | 'kana' | 'hangul' | 'latin' | 'cyrillic';

const NAMED: ReadonlyArray<[RegExp, Script]> = [
  [/\b(chinese|mandarin|cantonese)\b|中文|汉语|漢語|普通话/i, 'han'],
  [/\bjapanese\b|日本語/i, 'kana'],
  [/\bkorean\b|한국어/i, 'hangul'],
  [/\brussian\b|русск/i, 'cyrillic'],
  [/\b(english|french|german|spanish|portuguese|italian|dutch)\b/i, 'latin'],
];

/** Fewer letters than this and the reply is not judged. */
const MIN_LETTERS = 40;

/** The script the rule asks for: the first language it names (the rest is usually "code stays English"). */
export function expectedScript(rule: string): Script | null {
  let best: { at: number; script: Script } | null = null;
  for (const [re, script] of NAMED) {
    const m = re.exec(rule);
    if (m && (!best || m.index < best.at)) best = { at: m.index, script };
  }
  return best?.script ?? null;
}

function prose(reply: string): string {
  return reply
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(?:^|\s)[\w.~-]*\/[\w./-]+/g, ' ');
}

export function scriptCounts(text: string): Record<Script, number> {
  const c: Record<Script, number> = { han: 0, kana: 0, hangul: 0, latin: 0, cyrillic: 0 };
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) c.han++;
    else if (cp >= 0x3040 && cp <= 0x30ff) c.kana++;
    else if (cp >= 0xac00 && cp <= 0xd7af) c.hangul++;
    else if (cp >= 0x0400 && cp <= 0x04ff) c.cyrillic++;
    else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f)) c.latin++;
  }
  return c;
}

/**
 * True when the reply is clearly not in the asked language. A CJK character
 * carries about a word, a Latin letter a fifth of one, so letters are weighed
 * (CJK x4) before the share is taken.
 */
export function detectLanguageDrift(rule: string, reply: string): boolean {
  return languageDrift(rule, reply) === true;
}

/** The same verdict, with null when the reply cannot tell (no language named, too short). */
export function languageDrift(rule: string, reply: string): boolean | null {
  const want = expectedScript(rule);
  if (!want || !reply) return null;
  const c = scriptCounts(prose(reply));
  const weight: Record<Script, number> = { han: 4, kana: 4, hangul: 4, latin: 1, cyrillic: 1 };
  const letters = c.han + c.kana + c.hangul + c.latin + c.cyrillic;
  if (letters < MIN_LETTERS) return null;
  const total = (Object.keys(c) as Script[]).reduce((n, s) => n + c[s] * weight[s], 0);
  // Japanese text mixes kanji with kana: either counts for it.
  const mine = want === 'kana' ? c.kana * 4 + c.han * 4 : c[want] * weight[want];
  return mine / total < 0.2;
}
