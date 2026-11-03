/**
 * "Let "<task>" use <host>?": a task on a host the user did not register asks to use another of his
 * hosts (hosts/host-exec-grant.ts grantOrAsk), Allow / Deny. The action ids are the grants store's
 * (exec-grants.ts ALLOW_ACTION / DENY_ACTION) and never change with the language.
 *
 * No longer needed (exec-grants.ts execAskSettleReason): its task is complete or gone, the grant
 * exists, the task now runs on one of the user's own hosts (they ask no one, 2026-11-01), or Walnut
 * holds no ask for the letter any more (an answer to it would do nothing; the task asks again).
 */
import type { LetterRecord } from '../types.js';
import type { ByLang, LetterLang } from './languages.js';
import { letterKind } from './kind.js';

export interface HostExecAskParams {
  title: string;
  /** Where the task runs; null = this Mac. */
  from: string | null;
  /** The host it wants; null = this Mac. */
  target: string | null;
  /** Its first request, as the task sent it. */
  preview: string;
}

/** Why a letter of this kind was settled, in the words the user reads. */
export type HostExecSettleWhy = 'own-host' | 'own-host-now' | 'granted' | 'task-done' | 'task-gone' | 'no-ask';

interface Words {
  mac: string;
  thisMac: string;
  subject: (title: string, target: string) => string;
  wants: (title: string, from: string, target: string) => string;
  first: string;
  allowExplained: (target: string) => string;
  allow: string;
  allowWhat: (target: string) => string;
  deny: string;
  denyWhat: string;
  settled: Record<HostExecSettleWhy, string>;
}

const WORDS: ByLang<Words> = {
  en: {
    mac: 'the Mac',
    thisMac: 'this Mac',
    subject: (title, target) => `Let "${title}" use ${target}?`,
    wants: (title, from, target) => `The task **${title}**, running on ${from}, wants to use **${target}**: run commands there, call its MCP servers and reach its web services.`,
    first: 'Its first request:',
    allowExplained: (target) => `**Allow** lets this task run commands, call MCP servers and reach web services on ${target} as you, in any folder, until you revoke it in Settings › Remote Hosts. `
      + 'A command there can read anything your account can read on that machine. Every request is logged and counted on the grant.',
    allow: 'Allow',
    allowWhat: (target) => `Grant this task permission to use ${target} until you revoke it`,
    deny: 'Deny',
    denyWhat: 'The task is told no and asks nothing more',
    settled: {
      'own-host': 'Walnut allowed it: tasks on your own hosts use your other hosts without asking you (Settings › Remote Hosts revokes one).',
      'own-host-now': 'Not needed any more: this task runs on one of your own hosts, and those use your other hosts without asking you.',
      granted: 'Already allowed: this task has its grant for that host.',
      'task-done': 'Not needed any more: its task is complete.',
      'task-gone': 'Not needed any more: its task no longer exists.',
      'no-ask': 'Not needed any more: Walnut no longer waits on this answer, and the task asks again if it still needs that host.',
    },
  },
  zh: {
    mac: '这台 Mac',
    thisMac: '这台 Mac',
    subject: (title, target) => `允许"${title}"使用 ${target} 吗？`,
    wants: (title, from, target) => `任务 **${title}**（运行在 ${from}）想使用 **${target}**：在那里执行命令、调用它的 MCP 服务器、访问它的 Web 服务。`,
    first: '它的第一个请求：',
    allowExplained: (target) => `点**允许**后，这个任务可以用你的身份在 ${target} 上执行命令、调用 MCP 服务器、访问 Web 服务，不限文件夹，直到你在"设置 › 远程主机"里撤销。`
      + '那里的命令能读取你的账号在那台机器上能读的一切。每个请求都会记录下来，并计入这项授权。',
    allow: '允许',
    allowWhat: (target) => `授权这个任务使用 ${target}，直到你撤销`,
    deny: '拒绝',
    denyWhat: '告诉任务不行，它不会再问',
    settled: {
      'own-host': 'Walnut 已自动允许：你自己的主机上的任务可以直接使用你的其他主机，不用问你（可在"设置 › 远程主机"里撤销）。',
      'own-host-now': '不再需要：这个任务运行在你自己的主机上，这类任务使用你的其他主机不用问你。',
      granted: '已经允许过：这个任务已有使用那台主机的授权。',
      'task-done': '不再需要：它的任务已完成。',
      'task-gone': '不再需要：它的任务已不存在。',
      'no-ask': '不再需要：Walnut 已不再等这个回答；任务如果还需要那台主机，会重新来问。',
    },
  },
};

/** Markdown text that renders as written (a task title is the agent's words). */
export function mdText(s: string): string {
  return s.replace(/[\\`*_[\]<>#|~]/g, (c) => `\\${c}`).replace(/\s+/g, ' ');
}

/** A fenced block no backtick run in the text can close early. */
export function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

export function hostExecSettleReason(lang: LetterLang, why: HostExecSettleWhy): string {
  return WORDS[lang].settled[why];
}

/** The action ids (exec-grants.ts ALLOW_ACTION / DENY_ACTION). */
const ALLOW = 'allow';
const DENY = 'deny';

/** Before the mark: Walnut's own English ask ("use" since 2026-10-31 evening, "run commands on" before). */
const OLD_SUBJECT = /^Let "[\s\S]*" (?:use|run commands on) [\s\S]+\?$/;

export const HOST_EXEC_ASK = letterKind<HostExecAskParams>({
  id: 'host-exec-ask',
  type: 'action_required',
  callers: ['src/core/hosts/host-exec-grant.ts'],
  marked: true,
  matchesUnmarked: (l: LetterRecord) => l.sender?.sessionId === 'external' && !l.sender.pluginId
    && l.type === 'action_required' && OLD_SUBJECT.test(l.subject)
    && !!l.actions?.some((a) => a.id === ALLOW) && !!l.actions?.some((a) => a.id === DENY),
  render: (lang, p) => {
    const w = WORDS[lang];
    const title = p.title.replace(/\s+/g, ' ').slice(0, 120);
    const target = p.target ?? w.mac;
    const from = p.from ?? w.thisMac;
    return {
      subject: w.subject(title, target),
      markdown: [
        w.wants(mdText(title), mdText(from), mdText(target)),
        '',
        w.first,
        '',
        fenced(p.preview.slice(0, 1500)),
        '',
        w.allowExplained(mdText(target)),
      ].join('\n'),
      actions: [
        { id: ALLOW, label: w.allow, description: w.allowWhat(target) },
        { id: DENY, label: w.deny, description: w.denyWhat },
      ],
    };
  },
  samples: [
    { title: 'Run the iOS tests', from: 'Dev box', target: null, preview: 'xcodebuild test -scheme App' },
    { title: 'Fleet capabilities', from: null, target: 'Cloud', preview: 'uname -a' },
  ],
  stillNeeded: {
    check: async (letter, ctx) => (await import('../../hosts/exec-grants.js')).execAskSettleReason(letter, ctx),
  },
});
