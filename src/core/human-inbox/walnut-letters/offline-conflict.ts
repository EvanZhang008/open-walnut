/**
 * "N changes made while your Mac was away did not merge cleanly": the one letter of a host's
 * offline drain that has a conflict needing the user (offline-merge/letter.ts sends it). Built
 * from the conflict log, so a resend is the same letter. Values from the log (ids, field
 * values, reasons, paths, host keys) go in as given; raw field names stay as given too.
 *
 * The body is capped at LETTER_BODY_MAX bytes in every language (a Han character is 3 bytes):
 * items that do not fit are counted in a "more" line linking the full list.
 */
import type { ConflictEntry, ConflictLogFile } from '../../offline-merge/conflict-log.js';
import {
  LETTER_BODY_MAX, conflictEntryLink, conflictNeedsUser, memoryDocName, noteLink, refusedBySession, taskLink,
} from '../../offline-merge/letter-rules.js';
import type { ByLang, LetterLang } from './languages.js';
import { letterKind } from './kind.js';

export interface ConflictLetter {
  subject: string;
  markdown: string;
  taskRefs: string[];
  /** Every link the body holds, for tests and the log line. */
  links: string[];
  /** Entries that need the user, the ones the body lists (the cap may cut it short), and those settled by their own rule (in the log only). */
  needed: number;
  listed: number;
  settled: number;
}

const VALUE_PREVIEW = 160;

interface Words {
  subject: (n: number) => string;
  companion: string;
  host: (key: string) => string;
  head: (who: string) => string;
  settledLine: (n: number, all: string) => string;
  moreLine: (n: number, all: string) => string;
  line: (target: string, item: string, entryLink: string) => string;
  target: {
    task: (id: string, link: string) => string;
    board: (id: string, link: string) => string;
    note: (path: string, link: string) => string;
    chat: string;
    letter: string;
    change: string;
  };
  none: string;
  empty: string;
  /** Walnut's words for a task field (others stay as given); `undefined` is any change. */
  fields: { 'project+group_id': string; change: string };
  /** A note change lettered after the host had freed its text (offline-handover.ts noteBodies). */
  lost: string;
  attached: string;
  /** A sentence ending: after a value inserted as given. */
  stop: string;
  item: {
    taskField: (field: string, keptReplica: boolean, mac: string, away: string) => string;
    taskDeleted: (field: string, away: string) => string;
    refused: (reason: string) => string;
    givenUp: (reason: string) => string;
    actorDropped: (reason?: string) => string;
    parentRefused: (reason: string) => string;
    createCollision: (reason: string) => string;
    board: (reason: string) => string;
    memory: (conflict: boolean) => string;
    conversation: (keptReplica: boolean, mac: string, away: string) => string;
  };
  note: {
    copy: (path: string, link: string) => string;
    conflict: string;
    tooLarge: string;
    macDeleted: string;
    createExists: string;
    createBoth: string;
    deleteKept: string;
    restored: string;
    moveNotMade: (reason?: string) => string;
    attachmentKept: (copy?: { path: string; link: string }) => string;
  };
}

const WORDS: ByLang<Words> = {
  en: {
    subject: (n) => `${n} change${n === 1 ? '' : 's'} made while your Mac was away did not merge cleanly`,
    companion: 'your cloud companion',
    host: (key) => `host ${key}`,
    head: (who) => `While your Mac was away, ${who} saved changes. When they were applied, these needed a choice. Each item says what was kept; the other side is kept in full in the linked entry.\n\n`,
    settledLine: (n, all) => {
      const one = n === 1;
      return `\n${n} other change${one ? '' : 's'} to task settings (a phase, a priority, a date, a place, a link) ${one ? 'was' : 'were'} settled automatically: the newer change was kept (on a tie, the Mac's). ${one ? 'It needs' : 'They need'} nothing from you and ${one ? 'is' : 'are'} in [the full list](${all}).\n`;
    },
    moreLine: (n, all) => `\n${n} more are in [the full list](${all}).\n`,
    line: (target, item, entryLink) => `- ${target}: ${item} [Full entry](${entryLink})\n`,
    target: {
      task: (id, link) => `[task ${id}](${link})`,
      board: (id, link) => `[Board of ${id}](${link})`,
      note: (p, link) => `[note ${p}](${link})`,
      chat: 'a chat',
      letter: 'a letter to you',
      change: 'a change',
    },
    none: '(none)',
    empty: '(empty)',
    fields: { 'project+group_id': 'project and folder', change: 'change' },
    lost: ' Its text was no longer on the host, so it could not be attached.',
    attached: ' The change is attached.',
    stop: '.',
    item: {
      taskField: (f, r, mac, away) => `${f}: kept ${r ? 'the change made while away' : 'the Mac\'s value'}. Mac: "${mac}"; while away: "${away}".`,
      taskDeleted: (f, away) => `the task was deleted on the Mac; a change made while away was dropped (${f}: "${away}").`,
      refused: (reason) => `the Mac refused a change made while away: ${reason}.`,
      givenUp: (reason) => `could not apply: ${reason}.`,
      actorDropped: (reason) => `a change from a device that is no longer paired was not applied${reason ? ` (${reason})` : ''}.`,
      parentRefused: (reason) => `the parent link was not applied: ${reason}.`,
      createCollision: (reason) => `a task created while away got a new id (${reason}).`,
      board: (reason) => `a Board edit conflicted; the Mac's page was kept: ${reason}.`,
      memory: (c) => `${c ? 'both sides changed the same lines; the newer change is in the document' : 'it could not be merged line by line; the newer version is the document'}, the other version is in the full entry.`,
      conversation: (r, mac, away) => `both sides renamed it; kept ${r ? 'the name given while away' : 'the Mac\'s name'}. Mac: "${mac}"; while away: "${away}".`,
    },
    note: {
      copy: (p, link) => ` The other version is the note [${p}](${link}).`,
      conflict: 'both sides changed the same lines; the newer change is in the note.',
      tooLarge: 'the note was too large to merge line by line; the newer version is the note.',
      macDeleted: 'the note was deleted on the Mac, so the change made while away was kept as a copy.',
      createExists: 'a note made while away has the path of a note on the Mac; the Mac\'s note stays.',
      createBoth: 'two notes were made at this path while away; the newer one is the note.',
      deleteKept: 'the note was deleted while away but edited since; it was kept.',
      restored: 'the note was deleted while away and also edited; the edit won and the note is back.',
      moveNotMade: (reason) => `a move or rename made while away was not made: ${reason ?? 'the note stays where it is'}.`,
      attachmentKept: (c) => `a different picture or file is at this path on the Mac, so it stays; the one saved while away is${c ? ` [${c.path}](${c.link})` : ' beside it'}.`,
    },
  },
  zh: {
    subject: (n) => `你的 Mac 离线期间所做的 ${n} 处改动未能顺利合并`,
    companion: '你的云端伴侣上',
    host: (key) => `主机 ${key} 上`,
    head: (where) => `你的 Mac 离线期间，有一些改动保存在${where}。应用这些改动时，下面几项需要取舍。每一项都写明了保留的是哪一边；另一边的内容完整保存在所链接的记录里。\n\n`,
    settledLine: (n, all) => `\n另有 ${n} 处任务设置的改动（阶段、优先级、日期、位置、链接）已自动处理：保留了较新的改动（时间相同时保留 Mac 上的）。这些不需要你处理，都在[完整列表](${all})里。\n`,
    moreLine: (n, all) => `\n还有 ${n} 项在[完整列表](${all})里。\n`,
    line: (target, item, entryLink) => `- ${target}：${item} [完整记录](${entryLink})\n`,
    target: {
      task: (id, link) => `[任务 ${id}](${link})`,
      board: (id, link) => `[${id} 的 Board](${link})`,
      note: (p, link) => `[笔记 ${p}](${link})`,
      chat: '一个对话',
      letter: '一封给你的信',
      change: '一处改动',
    },
    none: '（无）',
    empty: '（空）',
    fields: { 'project+group_id': '项目和文件夹', change: '改动' },
    lost: '它的内容已不在该主机上，所以没能附上。',
    attached: '改动已附上。',
    stop: '。',
    item: {
      taskField: (f, r, mac, away) => `${f}：保留了${r ? '离线期间的改动' : ' Mac 上的值'}。Mac 上：“${mac}”；离线期间：“${away}”。`,
      taskDeleted: (f, away) => `这个任务已在 Mac 上删除，离线期间的一处改动被丢弃（${f}：“${away}”）。`,
      refused: (reason) => `Mac 拒绝了离线期间的一处改动：${reason}。`,
      givenUp: (reason) => `无法应用：${reason}。`,
      actorDropped: (reason) => `一台已不再配对的设备所做的改动没有应用${reason ? `（${reason}）` : ''}。`,
      parentRefused: (reason) => `父任务链接没有应用：${reason}。`,
      createCollision: (reason) => `离线期间新建的一个任务换了新 id（${reason}）。`,
      board: (reason) => `一处 Board 编辑有冲突，保留了 Mac 上的页面：${reason}。`,
      memory: (c) => `${c ? '两边改了同样的几行，文档里是较新的改动' : '无法逐行合并，文档里是较新的版本'}；另一个版本在完整记录里。`,
      conversation: (r, mac, away) => `两边都给它改了名，保留了${r ? '离线期间起的名字' : ' Mac 上的名字'}。Mac 上：“${mac}”；离线期间：“${away}”。`,
    },
    note: {
      copy: (p, link) => `另一个版本是笔记 [${p}](${link})。`,
      conflict: '两边改了同样的几行，笔记里是较新的改动。',
      tooLarge: '这条笔记太大，无法逐行合并，笔记里是较新的版本。',
      macDeleted: '这条笔记已在 Mac 上删除，所以离线期间的改动另存为一份副本。',
      createExists: '离线期间新建的笔记和 Mac 上的一条笔记路径相同，Mac 上的笔记保留不动。',
      createBoth: '离线期间在这个路径新建了两条笔记，较新的那条就是现在的笔记。',
      deleteKept: '这条笔记在离线期间被删除，但之后又被编辑过，所以保留了下来。',
      restored: '这条笔记在离线期间被删除，同时又被编辑过；编辑优先，笔记已恢复。',
      moveNotMade: (reason) => `离线期间的一次移动或改名没有执行：${reason ?? '笔记留在原处'}。`,
      attachmentKept: (c) => `Mac 上这个路径已有另一张图片或另一个文件，所以保留它；离线期间保存的那份${c ? `是 [${c.path}](${c.link})` : '在它旁边'}。`,
    },
  },
};

function preview(w: Words, v: unknown): string {
  let s = typeof v === 'string' ? v : v === undefined ? w.none : JSON.stringify(v);
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) s = w.empty;
  return s.length > VALUE_PREVIEW ? `${s.slice(0, VALUE_PREVIEW)}...` : s;
}

function fieldName(w: Words, f: string | undefined): string {
  return f === 'project+group_id' ? w.fields['project+group_id'] : f ?? w.fields.change;
}

function itemLine(w: Words, e: ConflictEntry): string {
  const p = (v: unknown): string => preview(w, v);
  const i = w.item;
  switch (e.kind) {
    case 'task-field': return i.taskField(fieldName(w, e.field), e.kept === 'replica', p(e.mac), p(e.replica));
    case 'task-deleted': return i.taskDeleted(fieldName(w, e.field), p(e.replica));
    case 'refused': return `${i.refused(p(e.reason))}${e.bodiesLost ? w.lost : ''}`;
    case 'given-up': return `${i.givenUp(p(e.reason))}${e.bodiesLost ? w.lost : w.attached}`;
    case 'actor-dropped': return i.actorDropped(e.reason ? p(e.reason) : undefined);
    case 'parent-refused': return i.parentRefused(p(e.reason));
    case 'create-collision': return i.createCollision(p(e.reason));
    case 'board': return i.board(p(e.reason));
    case 'note': return noteLine(w, e);
    case 'memory': return i.memory(e.why === 'conflict');
    case 'conversation': return i.conversation(e.kept === 'replica', p(e.mac), p(e.replica));
  }
}

function noteLine(w: Words, e: ConflictEntry): string {
  const n = w.note;
  const copy = e.copyPath ? n.copy(e.copyPath, noteLink(e.copyPath)) : '';
  switch (e.why) {
    case 'conflict': return `${n.conflict}${copy}`;
    case 'over-budget': case 'deadline': return `${n.tooLarge}${copy}`;
    case 'mac-deleted': return `${n.macDeleted}${copy}`;
    case 'create-exists': return `${n.createExists}${copy}`;
    case 'create-both': return `${n.createBoth}${copy}`;
    case 'delete-kept': return n.deleteKept;
    case 'restored': return n.restored;
    case 'move-kept': case 'move-taken': return n.moveNotMade(e.reason);
    case 'attachment-kept': return n.attachmentKept(e.copyPath ? { path: e.copyPath, link: noteLink(e.copyPath) } : undefined);
    default: return `${preview(w, e.reason)}${w.stop}${copy}`;
  }
}

function targetOf(w: Words, e: ConflictEntry): string {
  const t = w.target;
  if (e.taskId) return t.task(e.taskId, taskLink(e.taskId));
  if (e.boardTaskId) return t.board(e.boardTaskId, taskLink(e.boardTaskId));
  if (e.notePath) return t.note(e.notePath, noteLink(e.notePath));
  return memoryDocName(e) ?? (e.recordKind === 'conversation-edit' ? t.chat : e.recordKind === 'letter' ? t.letter : t.change);
}

/** The letter for a log in `lang`, or null when the log holds nothing that needs the user. */
export function conflictLetterIn(lang: LetterLang, file: ConflictLogFile): ConflictLetter | null {
  const w = WORDS[lang];
  // The index in the log, for the entry links: settled entries stay in the log, unlisted.
  const needed = file.entries.flatMap((e, i) => (conflictNeedsUser(e) ? [i] : []));
  if (needed.length === 0) return null;
  const n = needed.length;
  // Refusals told to the session that made them are neither the user's nor "settled".
  const settled = file.entries.filter((e) => !conflictNeedsUser(e) && !refusedBySession(e)).length;
  const who = file.hostKey === 'companion' ? w.companion : w.host(file.hostKey);
  const all = `/api/v1/offline-conflicts/${encodeURIComponent(file.drainId)}`;
  const links: string[] = [];
  const taskRefs: string[] = [];
  const settledLine = settled > 0 ? w.settledLine(settled, all) : '';
  // Room for the tail: the settled line and the longest "more" line it may need.
  const budget = LETTER_BODY_MAX - Buffer.byteLength(settledLine) - Buffer.byteLength(w.moreLine(n, all));
  let body = w.head(who);
  let shown = 0;
  for (const i of needed) {
    const e = file.entries[i];
    const entryLink = conflictEntryLink(file.drainId, i);
    const line = w.line(targetOf(w, e), itemLine(w, e), entryLink);
    if (Buffer.byteLength(body) + Buffer.byteLength(line) > budget) break;
    body += line;
    links.push(entryLink);
    if (e.taskId) { links.push(taskLink(e.taskId)); if (!taskRefs.includes(e.taskId)) taskRefs.push(e.taskId); }
    shown++;
  }
  if (shown < n) body += w.moreLine(n - shown, all);
  body += settledLine;
  if (shown < n || settled > 0) links.push(all);
  return { subject: w.subject(n), markdown: body, taskRefs: taskRefs.slice(0, 20), links, needed: n, listed: shown, settled };
}

const SAMPLE_BASE = { v: 2 as const, home: '/tmp/walnut-sample', startedAt: '2026-11-02T00:00:00.000Z' };

export const OFFLINE_CONFLICT = letterKind<ConflictLogFile>({
  id: 'offline-conflict',
  type: 'review',
  callers: ['src/core/offline-merge/letter.ts'],
  marked: false,
  // A log with nothing that needs the user sends no letter; render then gives just the subject.
  render: (lang, file) => {
    const letter = conflictLetterIn(lang, file);
    return { subject: letter?.subject ?? WORDS[lang].subject(0), markdown: letter?.markdown ?? '' };
  },
  samples: [
    {
      ...SAMPLE_BASE, drainId: 'd-sample-1', hostKey: 'companion',
      entries: [
        { kind: 'task-field', seq: 1, recordKind: 'task-patch', taskId: 't-1', field: 'title', mac: 'Mac title', replica: 'Away title', kept: 'mac' },
        { kind: 'task-field', seq: 2, recordKind: 'task-patch', taskId: 't-1', field: 'priority', mac: 'high', replica: 'low', kept: 'replica' },
        { kind: 'note', seq: 3, recordKind: 'note', notePath: 'Acme/plan.md', why: 'conflict', copyPath: 'Acme/plan (conflict).md' },
        { kind: 'memory', seq: 4, recordKind: 'memory', field: 'MEMORY.md', why: 'conflict' },
      ],
    },
    {
      ...SAMPLE_BASE, drainId: 'd-sample-2', hostKey: 'dev-box',
      entries: [
        { kind: 'given-up', seq: 1, recordKind: 'op', taskId: 't-2', reason: 'write timed out' },
        { kind: 'board', seq: 2, recordKind: 'board', boardTaskId: 't-3', reason: 'edit did not match' },
        { kind: 'conversation', seq: 3, recordKind: 'conversation-edit', kept: 'replica', mac: 'Old name', replica: 'New name' },
      ],
    },
  ],
  stillNeeded: { none: 'a report of a merge that already happened: every item says what was kept, nothing waits on the user\'s answer' },
});
