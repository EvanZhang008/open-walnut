/**
 * His own words turn a task's Threads off, or back on (2026-11-21, the user in the Interview
 * task's chat: "你不要再回复这个 thread 了，就回复我就好了", then "我们现在在聊天"; its next
 * message was filed as a new thread all the same and the agent was told to title it, so it wrote
 * one more thread op against his word). Walnut, not the agent's memory, carries out such words: the
 * same switch as Turn off Threads in the task's ⋮ menu (Task.threads_on false, keeps-threads.ts), so
 * nothing is filed, hinted or held at the turn's end any more, and the agent confirms it in one line
 * with how to undo; his words to turn them back on undo it the same way.
 *
 * Only explicit words count, and only in a short message (a long one that discusses Threads is
 * talk about them, not an order): the order alone, or an order about Threads that sends the answer
 * to the chat. A question, words to one thread ("那个 thread", "a new thread") or words that use them
 * ("放到上一个里", "合并", "提醒") switch nothing. Main and the leads keep their Threads: theirs are the org's.
 * Pure: the send path (thread-capture.ts prepareThreadCapture) acts on the answer.
 */

export type ThreadsWordSwitch = 'off' | 'on';

/** Longer than this, a message mentioning threads is about them, not an order to switch them. */
export const SWITCH_WORDS_MAX = 200;

const THREAD = String.raw`(?:threads?|线程)`;
const STOP = '[^。！？!?\\n]';
/** Spoken to one thread, or to another than this one: "那个 thread", "新的 thread", "上一个", "that thread", "a new thread". */
const ONE_THREAD = new RegExp(String.raw`(?:新建|新开|新的?|那个|那条|上一个|上个|另一个|另外的?|别的|其他的?|原来的?|旧的?|之前的?)\s*${THREAD}|\b(?:a new|new|that|the other|another|the previous|the old|other)\s+threads?\b`, 'i');
/** Words that use Threads (put it there, merge, find, its title, its alerts): never an order to stop them. */
const USES_THREADS = /放到|放进|并到|合并|挪到|移到|归到|里找|里面找|里聊|里的|里那|标题|提醒|这么长|只(?:在|写在|回|放)?\s*(?:threads?|线程)|也回|也要|同时|还要|\b(?:merge|move|put|title|remind|also|too|both)\b/i;
/** Words that send the answer to the chat: "就回复我", "回我", "在聊天里", "just answer me", "reply here". */
const TO_CHAT = /回复?我|答我|跟我说|和我说|聊天里|直接回|直接说|在这里回|这里回我|\b(?:reply|answer|talk) to me\b|\banswer me\b|\breply here\b|\bin (?:the )?chat\b/i;
/**
 * Stopping them: an order about Threads that also sends the answer to the chat
 * ("你不要再回复这个 thread 了，就回复我就好了", "别回 thread，就回我", "Do not reply in the thread, just answer me").
 */
const OFF_TO_CHAT: readonly RegExp[] = [
  // 别 alone, not inside 特别, 区别, 分别 and the like.
  new RegExp(String.raw`(?:不要|(?<![特区分个告类级识鉴性])别|不用|不需要)(?:再|继续)?${STOP}{0,4}?(?:回复?|答|用|写|更新|记|归档)?${STOP}{0,6}?${THREAD}`, 'i'),
  new RegExp(String.raw`\b(?:don'?t|do not|stop|no more)\s+(?:use|using|reply(?:ing)? in|answer(?:ing)? in|writ(?:e|ing) in|fil(?:e|ing) (?:in|into))\s+(?:the |this )?threads?\b`, 'i'),
];
/**
 * Or the whole message is the order and nothing else ("别回 thread", "不用 thread 了", "thread 别再更新了",
 * "把 thread 功能关掉", "don't use threads here", "no more threads please", "turn threads off").
 */
const OFF_BARE: readonly RegExp[] = [
  new RegExp(String.raw`^(?:以后|今后|这个任务里?|这里)?都?(?:你)?(?:不要|别|不用|不需要)(?:再|继续)?(?:回复?|用|写|更新|开)?\s*${THREAD}\s*(?:了|啦)?$`, 'i'),
  new RegExp(String.raw`^(?:你)?(?:不要|别)(?:再)?在\s*${THREAD}\s*里面?(?:写|回复?|记)(?:了|啦)?$`, 'i'),
  new RegExp(String.raw`^${THREAD}\s*(?:别再|不要再|不用再)(?:更新|写|回复?|用)?(?:了|啦)?$`, 'i'),
  new RegExp(String.raw`^(?:把\s*)?${THREAD}\s*(?:功能)?\s*(?:关掉|关闭|关了|停掉|停用|禁用)(?:了|吧)?$|^(?:关掉|关闭|停掉|停用|禁用)\s*${THREAD}\s*功能$`, 'i'),
  /^(?:please\s+)?(?:don'?t|do not|stop|never)\s+(?:use|using|filing)\s+threads?(?:\s+(?:here|for this task|anymore|any more))?(?:\s+please)?$/i,
  /^(?:please\s+)?(?:no\s+(?:more\s+)?threads|turn\s+(?:the\s+)?threads\s+off|turn\s+off\s+(?:the\s+)?threads)(?:\s+please)?$/i,
];
/** Bringing them back: "开回 thread", "恢复 thread", "还是用 thread 吧", "打开 Threads 功能", "turn threads back on". */
const ON: readonly RegExp[] = [
  new RegExp(String.raw`(?:开回|用回|恢复|重新开启|重新打开|重新用|还是用|还是开|继续用)\s*${THREAD}|(?:打开|开启)\s*${THREAD}\s*功能`, 'i'),
  new RegExp(String.raw`\bturn\s+(?:the\s+)?threads\s+(?:back\s+)?on\b|\bturn\s+on\s+(?:the\s+)?threads\b|\b(?:use|enable|bring back)\s+(?:the\s+)?threads\s+again\b`, 'i'),
];
/** Words about remembering a thread or asking whether to: "别忘了看 thread", "要不要关掉 thread 功能", "should we use threads". */
const NOT_AN_ORDER = /别忘|不要忘|忘了|要不要|是不是|是否|该不该|能不能|可不可以|吗|\b(?:forget|miss|should|shall|whether)\b/i;
/** A message's ends that carry no meaning here: punctuation, "please", "请", "就好", "吧". */
const bare = (t: string): string => t.replace(/^[\s，,。.!！~～]*(?:请|please\s+)?/i, '').replace(/[\s，,。.!！~～]*(?:吧|啊|呀|哈|please)?[\s，,。.!！~～]*$/i, '').trim();

/**
 * What his message asks of this task's Threads: 'off', 'on', or null (neither, both, or unclear).
 * Unclear stays as it is: a question, words to one thread or that use them never switch anything
 * (review 2026-11-22: "不要开新的 thread，放到上一个里" is the opposite of an order to stop). Pure.
 */
export function threadsSwitchIn(text: string): ThreadsWordSwitch | null {
  const t = text.trim();
  if (!t || Array.from(t).length > SWITCH_WORDS_MAX || /[?？]/.test(t) || NOT_AN_ORDER.test(t)) return null;
  if (ONE_THREAD.test(t) || USES_THREADS.test(t)) return null;
  const words = bare(t);
  const off = OFF_BARE.some((re) => re.test(words)) || (TO_CHAT.test(t) && OFF_TO_CHAT.some((re) => re.test(t)));
  // "不要再用回 thread" holds "用回 thread": an ON phrase inside a stop order is part of it.
  const rest = OFF_TO_CHAT.reduce((s, re) => s.replace(new RegExp(re.source, 'gi'), ' '), t);
  const on = ON.some((re) => re.test(rest));
  if (on === off) return null;
  return off ? 'off' : 'on';
}

/** The line the agent reads with his message once Walnut switched them. */
export function threadsSwitchedText(to: ThreadsWordSwitch): string {
  return to === 'off'
    ? 'he asked to stop Threads here, so Walnut turned Threads off for this task (as Turn off Threads in its menu does): nothing he sends is filed any more and no thread op is needed. Answer him in the chat only, and tell him in one line that this task now answers in the chat only and that saying "turn threads back on" (or Turn on Threads in the menu) brings them back.'
    : 'he asked for Threads here again, so Walnut turned Threads back on for this task (as Turn on Threads in its menu does). Tell him in one line that they are on again; his next messages are filed as before.';
}
