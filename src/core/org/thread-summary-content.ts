/**
 * A thread's summary must say something on its own (2026-11-23, the user, on a card whose whole
 * summary was "the stand-up summary for yesterday and today was given to you": "the thread should be
 * readable self contained, I don't know what you are talking about"; "you should not say you
 * already told me ... the summary should tell me which task, how it stands"). His card shows only
 * the title and the summary, so a summary that only points at an answer elsewhere (given, sent,
 * told, see above, in the chat) shows him nothing, and one that says his own message back (summaryRepeatsHim)
 * tells him nothing new. Every writer of a summary asks both:
 * a thread_update reply (threads-model.ts updateThread) and the status line (sessions/status-threads.ts patchForLine).
 * The rule in words is the status question's line format (sessions/status-threads.ts keptBlock) and these refusals: every
 * node's prompt is at its budget, and a rule the code enforces needs no line there. Pure.
 */

/** Phrases that only point at an answer given somewhere else (Chinese and English). */
const POINTERS: readonly RegExp[] = [
  // "already given / told / sent / replied to you (the user)"; never him or them, who in a summary are a colleague or a vendor
  /(?:\u5df2|\u5df2\u7ecf|\u90fd)(?:\u7ecf)?[^\uff0c\u3002,.;\uff1b]{0,8}?(?:\u7ed9|\u544a\u8bc9|\u544a\u77e5|\u53d1\u7ed9|\u56de\u590d|\u7b54\u590d|\u8f6c\u7ed9|\u8bf4\u7ed9|\u8bb2\u7ed9|\u6c47\u62a5\u7ed9|\u540c\u6b65\u7ed9|\u4ea4\u7ed9|\u53d1\u9001\u7ed9|\u63d0\u4f9b\u7ed9)(?:\u4e86)?(?:\u4f60|\u60a8|\u7528\u6237)/i,
  // "already answered / said in the chat or reply"
  /(?:\u5df2|\u5df2\u7ecf)(?:\u5728)?(?:\u804a\u5929|\u5bf9\u8bdd|\u4f1a\u8bdd|chat|\u56de\u590d|\u56de\u7b54)(?:\u91cc|\u4e2d|\u4e0a)?(?:\u8bf4|\u8bb2|\u56de|\u7b54|\u7ed9|\u5199|\u53d1)/i,
  // "see above / see the chat / as above"
  /(?:\u89c1|\u8be6\u89c1|\u53c2\u89c1|\u770b)(?:\u4e0a|\u4e0a\u6587|\u4e0a\u9762|\u524d\u9762|\u804a\u5929|\u5bf9\u8bdd|\u56de\u590d|chat)/i,
  /\u5982\u4e0a/,
  /^(?:\u5df2|\u5df2\u7ecf)?(?:\u56de\u590d|\u7b54\u590d|\u56de\u7b54|\u544a\u77e5|\u53d1\u9001|\u53d1\u51fa|\u7ed9\u51fa)(?:\u4e86)?$/,
  /\b(?:told|given|sent|shown|showed|gave|passed|handed|reported|delivered|explained|answered)\b[^.;]{0,40}?\b(?:you|the user)\b/i,
  /\b(?:answered|replied|covered|explained|posted|shared)\b[^.;]{0,20}?\b(?:in|on|at)\s+(?:the\s+|my\s+|our\s+)?(?:chat|reply|answer|thread|message)\b/i,
  /\bsee\s+(?:above|below|the\s+chat|my\s+(?:chat\s+)?(?:reply|answer|message))\b/i,
  /\bas\s+(?:above|said|mentioned)\b/i,
  /^(?:already\s+)?(?:answered|replied|sent|told)\.?$/i,
];

/** A proof (a path or URL) is content by itself: a summary with one is never pointer-only. */
const PROOF_RE = /(?:https?:\/\/\S+|(?:^|\s)\/[\w.\-/]+\.\w{2,5}\b|\blt-[a-z0-9]+\b)/i;

/** What a clause carries, in words: two CJK characters count as one word. */
function units(clause: string): number {
  const cjk = clause.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const words = clause.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ').match(/[A-Za-z0-9][\w\-.]*/g)?.length ?? 0;
  return Math.ceil(cjk / 2) + words;
}

/** A clause shorter than this, beside a pointer, names only what was given ("the summary"), not what it says ("live on prod" does). */
const SHORT_CLAUSE = 3;
/** After its pointer, a clause that goes on this long says what happened ("already gave you the three tasks deadlines"). */
const SAYS_MORE = 4;
/** What a pointer is followed by when it only names what was told: an open question ("told you where the task is"). */
const OPEN_QUESTION = /^(?:where|which|what|how|when|who|why|whether)\b|^[^\uff0c\u3002,.]{0,6}(?:\u54ea|\u4ec0\u4e48|\u600e\u4e48|\u5982\u4f55|\u591a\u5c11|\u4e3a\u4ec0\u4e48)/i;

/** The clause only points elsewhere: a pointer, and after it nothing but an open question or a few words. */
function pointsOnly(clause: string): boolean {
  for (const re of POINTERS) {
    const m = re.exec(clause);
    if (!m) continue;
    const after = clause.slice(m.index + m[0].length).trim();
    if (units(after) < SAYS_MORE || OPEN_QUESTION.test(after)) return true;
  }
  return false;
}

/**
 * Why `summary` says nothing on its own, or null when it does. It points elsewhere when every
 * clause either points at an answer given somewhere else (and says nothing more after the pointer)
 * or is too short to carry one, and at least one clause points. A summary with a proof (a path, a
 * URL, a letter id) always says something.
 */
export function summaryPointsElsewhere(summary: string | null | undefined): string | null {
  const text = (summary ?? '').replace(/\s+/g, ' ').trim();
  if (!text || PROOF_RE.test(text)) return null;
  const clauses = text.split(/[\u3002\uff0e.!\uff01?\uff1f;\uff1b:\uff1a,\uff0c\u3001\n]+/).map((c) => c.trim()).filter(Boolean);
  let pointed = false;
  for (const c of clauses) {
    if (pointsOnly(c)) { pointed = true; continue; }
    if (units(c) >= SHORT_CLAUSE) return null;
  }
  return pointed
    ? 'This summary only says the answer was given somewhere else, and his card shows nothing else: write the answer itself, '
      + 'readable by someone who never saw your chat (the result or the question, naming the task by its title and where it '
      + 'stands). A thread with nothing left for him is done (close it).'
    : null;
}

/** A run of his own words this long, found in a summary, is his message said back to him. */
const HIS_RUN_CJK = 20;
const HIS_RUN = 70;
/** His words as compared: a path, a link, an id or code he gave is proof the summary may repeat. */
const flat = (text: string): string => text
  .replace(/`[^`]*`|https?:\/\/\S+|(?:~|\.{0,2})\/[\w.\-/]+|\b(?:lt|th|tm|rq)-[\w-]+/g, ' ')
  .replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Why `summary` repeats the user's own words, or null (2026-11-23, the user, on a card that opened
 * with his voice message quoted: "it repeats my question completely ... my words are sometimes
 * messy; summarize it, or just say the matter"). `his`: his messages in the thread. A short phrase
 * of his is fine; a run of 70 characters (20 when it is mostly CJK) is his message again, paths, links,
 * ids and code aside (they are proof). Pure.
 */
export function summaryRepeatsHim(summary: string | null | undefined, his: readonly string[]): string | null {
  const text = flat(summary ?? '');
  if (text.length < HIS_RUN_CJK) return null;
  for (const raw of his.slice(-6)) {
    const words = flat(raw);
    const cjk = (words.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0) * 2 >= words.length;
    const run = cjk ? HIS_RUN_CJK : HIS_RUN;
    for (let i = 0; i + run <= words.length; i += 4) {
      if (text.includes(words.slice(i, i + run))) {
        return 'This summary repeats the user\'s own message back to them. Say the matter in one line in your own words '
          + '(what it is and where it stands), never their words again.';
      }
    }
  }
  return null;
}
