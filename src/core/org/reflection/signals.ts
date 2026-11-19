/**
 * Step one of the reflection (reflection.duty.ts): which of the user's messages are worth
 * one model call. Pure and cheap (no model, no file): it only decides what to judge, never what
 * went wrong, so a hit here is a candidate, not a finding (judge.ts decides).
 *
 * Three signals (2026-11-19, the user): he is frustrated ("it should reflect on the stupid thing
 * they did, I angry, I frustrated"); he overruled the session's decision ("his decision is
 * different from mine"); the answer took many rounds ("we talk for 10 round but could just be
 * one"). And a fourth moment, before he reads it: a turn that ends asking him to decide.
 *
 * Measured on the maintainer's real record (2026-11-19, 1211 messages over 30 days in 100 tasks):
 * 38 frustration, 19 overrule and 47 many-round hits, with false hits among them (swearing about
 * himself, a "no no, I want to understand" that is confusion), so the judge sees every one.
 */

export type ReflectionSignal = 'frustration' | 'overruled' | 'many_rounds' | 'decision_ask';

export interface SpokenMessage { id: string; at: string; text: string }

/** Words aimed at a session's work when he is angry or fed up (English and Chinese, escaped). */
const FRUSTRATION_RE = new RegExp([
  'ridiculous', 'stupid', '\\bwtf\\b', 'what the hell', 'are you kidding', 'you are wrong', 'completely wrong', 'so dumb',
  'i told you', 'i already said', 'how many times', 'for the \\w+ time', 'not what i asked', 'makes no sense',
  'be careful', 'too much\\?', '\\?{3,}', '!{3,}',
  '\\u4ed6\\u5988', // ta ma
  '\\u4f60\\u6709\\u75c5', // ni you bing
  '\\u65e0\\u8bed', // wu yu
  '\\u79bb\\u8c31', // li pu
  '\\u50bb\\u903c', // sha bi
  '\\u641e\\u4ec0\\u4e48', // gao shen me
  '\\u4e0d\\u662f\\u4e0d\\u662f', // bu shi bu shi
  '\\u5b8c\\u5168\\u662f\\u9519', // wan quan shi cuo
  '\\u5b8c\\u5168\\u9519', // wan quan cuo
  '\\u6211\\u8bf4\\u8fc7', // wo shuo guo
  '\\u6211\\u8bf4\\u4e86', // wo shuo le
  '\\u8bf4\\u4e86\\u591a\\u5c11\\u904d', // shuo le duo shao bian
  '\\u600e\\u4e48\\u53c8', // zen me you
  '\\u4ec0\\u4e48\\u9b3c', // shen me gui
  '\\u778e', // xia (blindly)
  '\\u5c0f\\u5fc3', // xiao xin (careful)
].join('|'), 'i');

/** An opening that turns down what came before. */
const OVERRULE_OPEN_RE = new RegExp('^\\s*(?:' + [
  'no\\b(?![ -]?(?:problem|worries|rush))', 'nope', 'wrong', 'not this', 'actually,? no', 'instead', 'rather', 'don\'t', 'do not',
  '\\u4e0d\\u662f', // bu shi
  '\\u4e0d\\u5bf9', // bu dui
  '\\u4e0d\\u8981', // bu yao
  '\\u4e0d\\u884c', // bu xing
  '\\u9519\\u4e86', // cuo le
  '\\u522b\\u8fd9\\u6837', // bie zhe yang (not like this); a bare bie opens many plain asks
  '\\u7b97\\u4e86', // suan le
].join('|') + ')', 'i');

/** A session's turn that recommends or puts a choice to the user. */
const RECOMMENDS_RE = new RegExp([
  'i recommend', 'my recommendation', 'i suggest', 'i\'d suggest', 'my pick', 'option [a-d1-4]\\b', 'should i', 'do you want',
  'which (?:one|do you)', 'or would you', 'your call',
  '\\u6211\\u7684\\u5efa\\u8bae', // wo de jian yi
  '\\u6211\\u5efa\\u8bae', // wo jian yi
  '\\u5efa\\u8bae\\u4f60', // jian yi ni
  '\\u5efa\\u8bae\\u662f', // jian yi shi
  '\\u63a8\\u8350', // tui jian
  '\\u8981\\u4e0d\\u8981', // yao bu yao
  '\\u4f60\\u5b9a', // ni ding
  '\\u7531\\u4f60\\u5b9a', // you ni ding
  '\\u9009\\u54ea', // xuan na
  '\\u65b9\\u6848[a-d1-4\\u4e00\\u4e8c\\u4e09]', // fang an A / yi / er / san (a numbered option, not any plan)
].join('|'), 'i');

/** A follow-up that asks again what the last answer should have said. */
const FOLLOW_UP_RE = new RegExp('(?:^\\s*(?:so\\b|then\\b|wait|why|what do you mean|i don\'t (?:get|understand))|' + [
  '\\u6240\\u4ee5', // suo yi
  '\\u4e3a\\u4ec0\\u4e48', // wei shen me
  '\\u4e0d\\u592a\\u660e\\u767d', // bu tai ming bai
  '\\u4e0d\\u660e\\u767d', // bu ming bai
  '\\u7b49\\u4e00\\u4e0b', // deng yi xia
  '\\u4ec0\\u4e48\\u610f\\u601d', // shen me yi si
  '\\u73b0\\u5728\\u662f\\u600e\\u6837', // xian zai shi zen yang
].join('|') + ')', 'i');

/** Many rounds: at least this many of his messages in one task inside the window, enough of them follow-ups. */
export const MANY_ROUNDS_MIN = 6;
export const MANY_ROUNDS_WINDOW_MS = 90 * 60_000;
export const MANY_ROUNDS_FOLLOW_UPS_MIN = 3;
/** A window is judged once it went quiet this long (the talk is over). */
export const MANY_ROUNDS_QUIET_MS = 30 * 60_000;

export function isFrustrated(text: string): boolean { return FRUSTRATION_RE.test(text); }
export function recommends(text: string): boolean { return RECOMMENDS_RE.test(text); }
export function opensWithOverrule(text: string): boolean { return OVERRULE_OPEN_RE.test(text); }
export function isFollowUp(text: string): boolean { return FOLLOW_UP_RE.test(text); }

/**
 * The signals one of his messages carries. `before` is the session's turn he answered (its last
 * assistant text), when known: an overrule needs a turn that recommended or asked.
 */
export function messageSignals(text: string, before?: string): ReflectionSignal[] {
  const out: ReflectionSignal[] = [];
  if (isFrustrated(text)) out.push('frustration');
  if (opensWithOverrule(text) && (before === undefined || recommends(before))) out.push('overruled');
  return out;
}

export interface RoundsWindow { from: string; to: string; ids: string[]; followUps: number }

/**
 * The closed many-round windows in one task's messages (sorted or not): runs of at least
 * MANY_ROUNDS_MIN messages with no gap over MANY_ROUNDS_WINDOW_MS between the first and the last,
 * MANY_ROUNDS_FOLLOW_UPS_MIN of them follow-ups, and quiet since for MANY_ROUNDS_QUIET_MS by `nowMs`.
 * Each message belongs to at most one window (the earliest that holds it).
 */
export function manyRoundWindows(messages: readonly SpokenMessage[], nowMs: number): RoundsWindow[] {
  const sorted = [...messages].sort((a, b) => a.at.localeCompare(b.at));
  const t = sorted.map((m) => Date.parse(m.at));
  const out: RoundsWindow[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && t[j + 1] - t[i] <= MANY_ROUNDS_WINDOW_MS) j++;
    const run = sorted.slice(i, j + 1);
    const followUps = run.filter((m) => isFollowUp(m.text)).length;
    const quiet = (j + 1 < sorted.length ? t[j + 1] : nowMs) - t[j] >= MANY_ROUNDS_QUIET_MS;
    if (run.length >= MANY_ROUNDS_MIN && followUps >= MANY_ROUNDS_FOLLOW_UPS_MIN && quiet) {
      out.push({ from: run[0].at, to: run[run.length - 1].at, ids: run.map((m) => m.id), followUps });
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}
