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
 *
 * v2 (2026-11-20, the user: "Make sure our reflect also capture this.... I can't tell u every
 * day"): words that say something that worked broke (regression), what was built is not what he
 * said (built_different), the same thing shows more than once (duplicate_display); an ask that
 * reached Needs you (needs_ask, pipeline candidates.ts); an answer in the wrong language
 * (wrong_language, language.ts, judged by no model).
 */

export const REFLECTION_SIGNALS = [
  'frustration', 'overruled', 'many_rounds', 'needs_ask', 'not_for_user', 'unclear_ask', 'unreviewed_design', 'regression', 'built_different', 'duplicate_display', 'wrong_language',
] as const;
export type ReflectionSignal = typeof REFLECTION_SIGNALS[number];

/** One of his messages; `images` are the paths of the pictures it carried. */
export interface SpokenMessage { id: string; at: string; text: string; images?: string[] }

/** Words aimed at a session's work when he is angry or fed up (English and Chinese, escaped). */
const FRUSTRATION_RE = new RegExp([
  // "why" asked about what an agent did; a plain "why does X work" is judged too, the judge decides.
  '\\bwhy (?:did|do|does|is|are|would|the hell|the fuck|u|you)\\b', '^\\s*why\\b',
  '\\bagain\\b', '\\bkeeps? (?:asking|doing|showing|breaking|failing|saying|making|telling|adding|getting|losing)\\b', '\\bfuck',
  'ridiculous', 'stupid', '\\bange?ry\\b', 'so angr', '\\bwtf\\b', 'what the hell', 'are you kidding', 'you are wrong', 'completely wrong', 'so dumb',
  'i told you', 'i already said', 'how many times', 'for the \\w+ time', 'not what i asked', 'makes no sense',
  'be careful', 'too much\\?', '\\?{3,}', '!{3,}',
  // Measured on 11-20's misses: his "why we need this", "so ugly", "it just doesn't".
  '\\bwhy (?:we|i|need|this|it|there|so)\\b', '\\bugly\\b', '\\bgarbage\\b', '\\bweird\\b', 'not working', 'doesn\'t work', 'just doesn\'?t',
  '\\u96be\\u770b', // nan kan (ugly)
  'freaking',
  '\\u4e3a\\u5565', // wei sha (why)
  '\\u4e0d\\u80fd\\u8fd9\\u6837', // bu neng zhe yang (it cannot be like this)
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
  '\\u4ec0\\u4e48\\u9b3c', // shen me gui
  '\\u778e', // xia (blindly)
  '\\u5c0f\\u5fc3', // xiao xin (careful)
  '\\u4e3a\\u4ec0\\u4e48', // wei shen me (why)
  // you (again), only where it complains: zen me you / wei shen me you, you shi, you lai, you chu, you kai shi
  '(?:\\u600e\\u4e48|\\u4e3a\\u4ec0\\u4e48)\\u53c8', '\\u53c8(?:\\u662f|\\u6765|\\u51fa|\\u5f00\\u59cb)',
  '\\u4e00\\u76f4', // yi zhi (all the time)
  '\\u8001\\u662f', // lao shi (always)
  '\\u603b\\u662f', // zong shi (always)
  '\\u6211\\u64cd|\\u64cd\\u4f60|\\u64cd[!\\uff01]', // wo cao, cao ni, cao! (never cao zuo, operate)
].join('|'), 'im');

/** Something that worked is broken now. */
const REGRESSION_RE = new RegExp([
  '\\bbroke', '\\bregress', 'used to', 'no longer', 'was working', 'disappeared', '\\b(?:is|are) gone\\b', 'got lost', '\\blost (?:the|my|all|its)\\b',
  '\\b(?:back|want|wnat) (?:the )?or?i?gi?nal\\b', '\\bthe or?i?gi?nal (?:one|version|design|ui|layout|look)\\b', 'remove(?:d|s)? (?:some |an |the )?existing',
  '\\u539f\\u6765\\u7684', // yuan lai de (the original)
  '\\u6ca1\\u6709\\u6d88\\u5931', // mei you xiao shi (it did not go away)
  '\\u53c8\\u574f', // you huai (broken again)
  '\\u4ee5\\u524d(?:\\u53ef\\u4ee5|\\u80fd|\\u662f|\\u4e0d\\u662f|\\u90fd)', // yi qian ke yi / neng / shi / bu shi / dou (it could / was, before)
  '\\u4e4b\\u524d\\u8fd8', // zhi qian hai (still did before)
  '\\u4e0d\\u89c1\\u4e86', // bu jian le (gone)
  '\\u4e22\\u4e86', // diu le (lost)
  '(?:\\u600e\\u4e48|\\u53c8|\\u90fd|\\u5168)\\u6ca1\\u4e86', // zen me / you / dou / quan mei le (gone, all of it)
  '\\u600e\\u4e48\\u53d8\\u4e86', // zen me bian le (why did it change)
  '\\u88ab\\u6539', // bei gai (was changed)
].join('|'), 'i');

/** What was built is not what he said, or someone said yes for him. */
const BUILT_DIFFERENT_RE = new RegExp([
  'not what i (?:said|asked|wanted)', 'i (?:said|asked) for', 'didn\'t ask', 'did not ask', 'i never (?:said|saw|approved)',
  'completely differ', 'not (?:riht|right)', '^\\s*not \\w+, i (?:want|wnat|mean)',
  '\\u7406\\u89e3\\u9519', // li jie cuo (misunderstood)
  '\\u6211\\u8981\\u7684\\u662f', // wo yao de shi (what I want is)
  '\\u6211\\u8bf4\\u7684\\u662f', // wo shuo de shi (what I said is)
  '\\u6211\\u6ca1\\u8ba9', // wo mei rang (I did not tell you to)
  '\\u4e0d\\u662f\\u6211\\u8981\\u7684', // bu shi wo yao de (not what I want)
  '\\u8c01\\u8ba9\\u4f60', // shei rang ni (who told you to)
  '\\u6211\\u6ca1\\u770b\\u8fc7', // wo mei kan guo (I never saw it)
].join('|'), 'i');

/** The same thing shown more than once. */
const DUPLICATE_RE = new RegExp([
  'duplicat', 'duplciat', '\\btwice\\b', 'three times', 'two kinds', 'both place', 'two (?:places|threads)',
  '\\u4e24\\u79cd', // liang zhong (two kinds)
  '(?:shows|shown|appears|listed|showing|appearing) .{0,40}times',
  '\\u91cd\\u590d', // chong fu (repeated)
  '\\u4e24\\u6b21', // liang ci (twice)
  '\\u4e09\\u6b21', // san ci (three times)
  '\\u51fa\\u73b0\\u4e86.{0,6}\\u6b21', // chu xian le ... ci (showed up ... times)
  '\\u4e24\\u904d', // liang bian (twice)
  '\\u597d\\u51e0\\u4e2a\\u4e00\\u6837', // hao ji ge yi yang (several the same)
].join('|'), 'i');

/** His words say the ask should not have come to him: already done, his to skip, the agent's to decide. */
const NOT_FOR_USER_RE = new RegExp([
  'already (?:did|done|said|answered|replied|approved|sent|told|reviewed|read|ok)', 'do it (?:yourself|urself)', '\\bu decide', 'you decide', 'your call',
  'i don\'?t care how', 'why (?:ask|asking) me', 'why (?:do|did) (?:u|you) (?:keep )?ask', 'just do it',
  '\\u4f60\\u81ea\\u5df1', // ni zi ji (you yourself)
  '\\u81ea\\u5df1\\u51b3\\u5b9a', // zi ji jue ding (decide yourself)
  '\\u4e0d\\u7528\\u95ee\\u6211', // bu yong wen wo (no need to ask me)
  '\\u4e3a\\u4ec0\\u4e48\\u95ee\\u6211', // wei shen me wen wo (why ask me)
  '\\u5df2\\u7ecf(?:\\u505a|\\u8bf4|\\u56de|\\u540c\\u610f)', // yi jing zuo / shuo / hui / tong yi (already did / said / answered / agreed)
].join('|'), 'i');

/** He cannot tell what a question put to him means (2026-11-21: "what are u talk about", a card that said only "put it here?"). */
const UNCLEAR_ASK_RE = new RegExp([
  'what (?:are|r) (?:u|you) talk', 'what (?:do|does) (?:u|you|this|it) mean', 'what is (?:here|this|that) ?\\?', 'what (?:here|place|position)\\b',
  'no idea what', 'don\'?t understand (?:the|this|what)', 'can\'?t understand',
  '\\u770b\\u4e0d\\u61c2', // kan bu dong (cannot understand it)
  '\\u5728\\u8bf4\\u4ec0\\u4e48', // zai shuo shen me (what are you talking about)
  '\\u4ec0\\u4e48\\u610f\\u601d', // shen me yi si (what does it mean)
  '\\u54ea\\u91cc\\u554a', // na li a (where?)
].join('|'), 'i');

/** A design or picture shown to him with visible faults, or never reviewed (2026-11-21: "The design need to be at least reviewed once"). */
const UNREVIEWED_DESIGN_RE = new RegExp([
  'reviewed? (?:at least )?once', '(?:need|needs|should) (?:to |ot )?be (?:at least )?reviewed', 'did (?:anyone|anybody|u|you) (?:even )?(?:review|look|check)',
  '\\boverlap', 'cut off', 'misalign', 'covers? the', 'on top of the (?:menu|icon|button)',
  '\\u6ca1\\u5ba1', // mei shen (not reviewed)
  '\\u5ba1\\u4e00\\u4e0b', // shen yi xia (review it)
  '\\u91cd\\u53e0', // chong die (overlap)
  '\\u538b\\u5728', // ya zai (pressed on top of)
  '\\u6321\\u4f4f', // dang zhu (covers)
  '\\u9519\\u4f4d', // cuo wei (misaligned)
  '\\u622a\\u65ad', // jie duan (cut off)
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
export function saysRegression(text: string): boolean { return REGRESSION_RE.test(text); }
export function saysBuiltDifferent(text: string): boolean { return BUILT_DIFFERENT_RE.test(text); }
export function saysDuplicate(text: string): boolean { return DUPLICATE_RE.test(text); }
export function saysNotForUser(text: string): boolean { return NOT_FOR_USER_RE.test(text); }
export function saysUnclearAsk(text: string): boolean { return UNCLEAR_ASK_RE.test(text); }
export function saysUnreviewedDesign(text: string): boolean { return UNREVIEWED_DESIGN_RE.test(text); }

/** His answer from a card (user-status.ts askAnswerText): `Answer to "<ask>": <words>`. */
export interface CardAnswer { ask: string; words: string }
const CARD_ANSWER_RE = /^Answer to "([\s\S]*?)": ([\s\S]*)$/;

/** The card answer a message is, or null. The ask is the agent's words, the rest his. Pure. */
export function parseCardAnswer(text: string): CardAnswer | null {
  const m = CARD_ANSWER_RE.exec(text.trim());
  return m ? { ask: m[1].trim(), words: m[2].trim() } : null;
}
export function recommends(text: string): boolean { return RECOMMENDS_RE.test(text); }
export function opensWithOverrule(text: string): boolean { return OVERRULE_OPEN_RE.test(text); }
export function isFollowUp(text: string): boolean { return FOLLOW_UP_RE.test(text); }

/**
 * The signals one of his messages carries (for a card answer, pass only his words). `before` is the
 * session's turn he answered (its last assistant text), when known: an overrule needs a turn that
 * recommended or asked.
 */
export function messageSignals(text: string, before?: string): ReflectionSignal[] {
  const out: ReflectionSignal[] = [];
  // The product's defects first: the most specific reason a message is looked at leads.
  if (saysRegression(text)) out.push('regression');
  if (saysBuiltDifferent(text)) out.push('built_different');
  if (saysDuplicate(text)) out.push('duplicate_display');
  if (saysNotForUser(text)) out.push('not_for_user');
  if (saysUnclearAsk(text)) out.push('unclear_ask');
  if (saysUnreviewedDesign(text)) out.push('unreviewed_design');
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
