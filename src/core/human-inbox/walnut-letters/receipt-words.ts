/**
 * Walnut's own words on a mail item's execution receipt (human-inbox/item-execution.ts), shown under
 * the item in the letter, and the stand-in title of an org thread that holds only a picture
 * (org/threads-model.ts). They follow the letter language like every Walnut letter (languages.ts;
 * 2026-11-02 review: both were English for a user whose letters are Chinese).
 *
 * An error a server, a tool or the mail provider returned is kept as it came, after Walnut's own
 * sentence and marked as the original error (`raw`), never translated.
 */
import type { ByLang } from './languages.js';

export interface ReceiptWords {
  retryNotRecorded: string;
  startNotRecorded: string;
  startUnconfirmed: string;
  recoveryOutcomeNotRecorded: string;
  recoveryNotDispatched: string;
  notDispatched: string;
  readInterrupted: string;
  taskSavedNotStarted: string;
  createUnconfirmed: string;
  readNotConfirmed: string;
  /** A recovery start that could not cancel the previous pending start; `detail` is Walnut's words or `raw(...)`. */
  recoveryRefused: (detail: string) => string;
  /** An error returned as it came: Walnut's sentence first, the original after it. */
  raw: (error: string) => string;
}

export const RECEIPT_WORDS: ByLang<ReceiptWords> = {
  en: {
    retryNotRecorded: 'The server stopped before recording this retry. Review the same task before confirming another start.',
    startNotRecorded: 'The server stopped before recording this start. Review the same task before confirming a retry.',
    startUnconfirmed: 'The previous start outcome is unconfirmed. Nothing will be resent automatically. Only confirming a reviewed retry cancels the previous pending start before starting this same task again.',
    recoveryOutcomeNotRecorded: 'The server stopped before the recovery start outcome was recorded',
    recoveryNotDispatched: 'The server stopped before the reviewed recovery was dispatched',
    notDispatched: 'The server stopped before this action was dispatched. No operation was sent.',
    readInterrupted: 'The server stopped before the mail provider confirmed this email as read. Check it or confirm setting it to read again.',
    taskSavedNotStarted: 'Task saved. The server stopped before its start was dispatched.',
    createUnconfirmed: 'The previous create result was not confirmed and the reserved task is not present. Confirm retrying the same task ID and payload.',
    readNotConfirmed: 'The mail provider did not confirm this exact email as read',
    recoveryRefused: (detail) => `Recovery did not confirm cancelling the previous pending start: ${detail.slice(0, 250)}. The previous outcome remains unconfirmed; no replacement start is confirmed. Check status or review another retry. Cancellation happens only after confirmation.`,
    raw: (error) => error,
  },
  zh: {
    retryNotRecorded: '服务器在记下这次重试之前停了。请先看一下同一个任务，再确认要不要重新启动。',
    startNotRecorded: '服务器在记下这次启动之前停了。请先看一下同一个任务，再确认要不要重试。',
    startUnconfirmed: '上一次启动的结果还没有确认。不会自动重新发送。只有你确认一次看过的重试，才会先取消上一次待定的启动，再重新启动这个任务。',
    recoveryOutcomeNotRecorded: '服务器在记下恢复启动的结果之前停了',
    recoveryNotDispatched: '服务器在发出看过的恢复操作之前停了',
    notDispatched: '服务器在发出这个操作之前停了，没有发出任何操作。',
    readInterrupted: '服务器在邮件服务确认这封邮件已读之前停了。请检查一下，或者确认再设一次已读。',
    taskSavedNotStarted: '任务已保存。服务器在发出启动之前停了。',
    createUnconfirmed: '上一次创建的结果没有确认，预留的任务也不在。请确认用同样的任务 ID 和内容重试。',
    readNotConfirmed: '邮件服务没有确认这封邮件已读',
    recoveryRefused: (detail) => `恢复没有确认取消上一次待定的启动，上一次的结果仍未确认，也没有确认新的启动。请查看状态，或者再看一次重试；只有确认以后才会取消。原因：${detail.slice(0, 250)}`,
    raw: (error) => `没有完成。原始报错（原文）：${error}`,
  },
};

/** The stand-in title of a thread whose first message is only a picture. */
export const PICTURE_TITLE_WORDS: ByLang<() => string> = {
  en: () => 'A picture',
  zh: () => '一张图片',
};
