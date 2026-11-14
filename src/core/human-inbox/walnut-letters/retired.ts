/**
 * Letters Walnut once wrote and writes no more. An open one asks about something Walnut no longer
 * raises with the user, so the sweep (sweep.ts) settles it with the line below (2026-11-02, the org
 * review: "the letters about a problem Walnut no longer raises must take care of themselves").
 *
 * When a kind stops being sent, move it here: its old subject shape and the line the user reads.
 */
import type { LetterRecord } from '../types.js';
import type { ByLang } from './languages.js';

export interface RetiredLetterKind {
  id: string;
  /** When Walnut stopped sending it, and why. */
  retired: string;
  /** A letter Walnut wrote of this kind (its English subject shape; never a session's or a plugin's). */
  matches: (letter: LetterRecord) => boolean;
  /** The one line the user reads on the settled letter. */
  settleReason: ByLang<string>;
  /** Subjects as they were sent, for the tests. */
  samples: readonly string[];
}

/** Walnut's own: no task, session or plugin wrote it. */
export function walnutSent(letter: LetterRecord): boolean {
  const s = letter.sender;
  return !s || (!s.taskId && !s.pluginId && (!s.sessionId || s.sessionId === 'external'));
}

export const TRIGGER_STOPPED: RetiredLetterKind = {
  id: 'trigger-stopped',
  retired: '2026-11-02: a failing trigger is told to the task it watches for, or that task\'s lead, never the user',
  matches: (l) => walnutSent(l) && /^Trigger ".*" stopped after \d+ failed checks$/s.test(l.subject),
  settleReason: {
    en: 'Walnut no longer writes letters about triggers: a failing trigger is told to the task it watches for, or that task\'s lead.',
    zh: 'Walnut 不再为触发器给你写信：触发器出问题时，会告诉它负责的任务，或那个任务的 lead。',
  },
  samples: ['Trigger "New replies arrived in the ask threads..." stopped after 5 failed checks'],
};

const privateDataHoldReason = {
  en: 'This file is in your private data folder, not the Walnut code repository. The held credential was not sent anywhere. Walnut tells its writer, or records it quietly in Health; no review is needed.',
  zh: '这是你的私有数据文件夹，不是 Walnut 代码仓库。被拦下的凭据没有发到任何地方。Walnut 会通知写入任务处理，或在 Health 中安静记录，不需要你审核。',
};

export const GIT_SYNC_SECRET_HOLD: RetiredLetterKind = {
  id: 'git-sync-secret-hold',
  retired: 'Private data holds go to the writer, never the human inbox.',
  matches: (l) => walnutSent(l) && (l.createdByOp?.startsWith('git-sync-secret-hold:') === true
    || /^(?:A file was kept out of sync: it holds a secret|\d+ files were kept out of sync: they hold secrets)$/.test(l.subject)
    || /^有(?:一个文件| \d+ 个文件)没有同步：/.test(l.subject)),
  settleReason: privateDataHoldReason,
  samples: ['A file was kept out of sync: it holds a secret', '2 files were kept out of sync: they hold secrets', '有一个文件没有同步：它含有密钥'],
};

export const GIT_SYNC_SECRET_ASIDE: RetiredLetterKind = {
  id: 'git-sync-secret-aside',
  retired: 'A preserved private-data copy goes to the writer, never the human inbox.',
  matches: (l) => walnutSent(l) && (l.createdByOp?.startsWith('git-sync-secret-aside:') === true
    || l.subject === 'A file kept out of sync was set aside'
    || l.subject === '一个没有同步的文件被移到了一边'),
  settleReason: privateDataHoldReason,
  samples: ['A file kept out of sync was set aside'],
};

export const RETIRED_LETTER_KINDS: readonly RetiredLetterKind[] = [TRIGGER_STOPPED, GIT_SYNC_SECRET_HOLD, GIT_SYNC_SECRET_ASIDE];

export function retiredKindOf(letter: LetterRecord): RetiredLetterKind | undefined {
  return RETIRED_LETTER_KINDS.find((k) => k.matches(letter));
}
