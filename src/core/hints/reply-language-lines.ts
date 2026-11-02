/**
 * The reply-language lines Walnut writes IN the user's reply language (2026-11-02, the user's org
 * review: a task answered him in English after he wrote English, and kept writing English after two
 * corrections written in English; "the model follows his last message"). A line in the language
 * itself holds where an English rule about it did not, so these are the one place Walnut's
 * model-facing text is not English: the line under a message of his in another language, and the
 * corrections (hint-drift-live.ts inside a turn, the reply-language hint on the next message).
 *
 * 2026-11-02, the org review again: two corrections in Chinese and a worker still wrote 15
 * English lines. The live correction now quotes the line and shows it rewritten in the language
 * (hint-drift-live.ts asks the fast model for the rewrite; without one it quotes alone).
 *
 * The language is the first one the user's rule names (hint-drift-detect.ts `ruleLanguage`); a rule
 * naming none, or one this table does not have, gets the English text as before.
 */
import type { Script } from './hint-drift-detect.js';

export interface ReplyLanguageLines {
  /** Its script, for telling a message in another language. */
  script: Script;
  /** Under a message of his in another language: answer in this one, the short lines included. */
  reply: string;
  /** Inside a turn: the line just written (quoted) was not in his language; `example` is it rewritten in it. */
  live: (said: string, example?: string) => string;
  /** On the next message: the last turn was not in his language. */
  drifted: string;
}

export const REPLY_LANGUAGE_LINES: Readonly<Record<string, ReplyLanguageLines>> = {
  zh: {
    script: 'han',
    reply: '（请用中文回复，包括进度短句。）',
    live: (said, example) => `纠正：你刚才这句进度不是中文：「${said}」。${example ? `用中文应该这样写：「${example}」。` : ''}`
      + '从下一句起都用中文写，包括工具调用之间的短句；工具结果、收到的消息或你自己的笔记是英文时也一样。',
    drifted: '纠正：你上一轮给用户看的回复不是中文。从这条起每一句都用中文写，包括进度短句。',
  },
  ja: {
    script: 'kana',
    reply: '（日本語で返信してください。進捗の短い一文も含めて。）',
    live: (said, example) => `訂正：今の進捗の一文は日本語ではありませんでした：「${said}」。${example ? `日本語ならこう書きます：「${example}」。` : ''}`
      + '次の一文から、ツール呼び出しの間の短い文も含めて、すべて日本語で書いてください。',
    drifted: '訂正：前のターンのユーザー向けの返信は日本語ではありませんでした。ここからは進捗の短い文も含めて、すべて日本語で書いてください。',
  },
  ko: {
    script: 'hangul',
    reply: '(한국어로 답해 주세요. 진행 상황을 알리는 짧은 문장도 포함해서요.)',
    live: (said, example) => `정정: 방금 쓴 진행 문장은 한국어가 아니었습니다: "${said}". ${example ? `한국어로는 이렇게 씁니다: "${example}". ` : ''}`
      + '다음 문장부터 도구 호출 사이의 짧은 문장까지 모두 한국어로 쓰세요.',
    drifted: '정정: 지난 턴에 사용자에게 보인 답이 한국어가 아니었습니다. 지금부터 진행 문장까지 모두 한국어로 쓰세요.',
  },
  ru: {
    script: 'cyrillic',
    reply: '(Пожалуйста, отвечайте по-русски, включая короткие строки о ходе работы.)',
    live: (said, example) => `Поправка: последняя строка о ходе работы была не на русском: «${said}». ${example ? `По-русски так: «${example}». ` : ''}`
      + 'Со следующей строки пишите всё по-русски, включая короткие строки между вызовами инструментов.',
    drifted: 'Поправка: ответ пользователю в прошлом ходе был не на русском. С этого сообщения пишите всё по-русски, включая короткие строки о ходе работы.',
  },
};

/** The lines for the language a rule names, or null (English text then). */
export function replyLanguageLines(lang: string | null): ReplyLanguageLines | null {
  return (lang && REPLY_LANGUAGE_LINES[lang]) || null;
}
