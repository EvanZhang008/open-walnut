/**
 * "Your SSH certificate for <hosts> expires at <time>": this machine's SSH certificate for remote
 * hosts runs out soon (hosts/ssh-cert-expiry-alert.ts). Renewing it needs the user's own hand, so
 * the letter goes out a few hours ahead; when it has run out and a fresh sign-in fails, the same
 * letter gets one more turn (sshCertExpiredTurn), so the whole story stays in one thread. The next
 * step is the user's own words from config `ssh_login_hint`, inserted as given.
 */
import type { ByLang, LetterLang } from './languages.js';
import { letterKind } from './kind.js';

export interface SshCertExpiryParams {
  hosts: string[];
  /** When the certificate stops being valid (epoch ms). */
  expiresAt: number;
  /** When the letter is written (epoch ms), for the "in about N hours". */
  now: number;
  /** config `ssh_login_hint`, as the user wrote it. */
  hint?: string;
}

interface Words {
  someHost: string;
  genericStep: string;
  names: (labels: string[]) => string;
  inAbout: (minutes: number) => string;
  subject: (names: string, at: string) => string;
  soon: (named: string, at: string, inWords: string, step: string) => string;
  why: string;
  closes: string;
  expired: (named: string, at: string, step: string) => string;
  sshSaid: string;
}

const WORDS: ByLang<Words> = {
  en: {
    someHost: 'your remote hosts',
    genericStep: 'renew your login credentials',
    names: (l) => (l.length === 2 ? `${l[0]} and ${l[1]}` : `${l[0]} and ${l.length - 1} more hosts`),
    inAbout: (m) => (m < 60 ? `in about ${Math.max(1, m)} minutes` : `in about ${Math.round(m / 60)} ${Math.round(m / 60) === 1 ? 'hour' : 'hours'}`),
    subject: (names, at) => `SSH certificate for ${names} expires at ${at}`,
    soon: (named, at, inWords, step) => `This machine's SSH certificate for ${named} expires at ${at} (${inWords}). After that, new sessions and tests there cannot sign in. To keep them working, ${step} before then.`,
    why: 'Walnut cannot renew it for you: it needs your own sign-in.',
    closes: 'This letter archives itself once a renewed certificate is in place.',
    expired: (named, at, step) => `The certificate expired at ${at}, and a fresh SSH sign-in to ${named} now fails. Connections opened before then may still work for a while, but new ones cannot sign in. To fix it, ${step}.`,
    sshSaid: 'What SSH said:',
  },
  zh: {
    someHost: '你的远程主机',
    genericStep: '请重新登录以续期凭据',
    names: (l) => (l.length === 2 ? `${l[0]} 和 ${l[1]}` : `${l[0]} 等 ${l.length} 台主机`),
    inAbout: (m) => (m < 60 ? `大约 ${Math.max(1, m)} 分钟后` : `大约 ${Math.round(m / 60)} 小时后`),
    subject: (names, at) => `${names} 的 SSH 证书将于 ${at} 过期`,
    soon: (named, at, inWords, step) => `这台机器登录 ${named} 用的 SSH 证书将于 ${at} 过期（${inWords}）。过期后，那里新开的会话和测试都无法登录。为了不中断，请在此之前${step}。`,
    why: 'Walnut 无法替你续期：这需要你本人登录。',
    closes: '续期后的新证书就位后，这封信会自动归档。',
    expired: (named, at, step) => `证书已于 ${at} 过期，现在新建的 SSH 登录 ${named} 会失败。过期前建立的连接可能还能用一阵，但新的连接无法登录。解决办法：${step}。`,
    sshSaid: 'SSH 的原话：',
  },
};

/** The time as the letter prints it: UTC, to the minute. */
export function certTimeWords(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The step as a clause: trimmed, no trailing period (either script). */
function stepOf(hint: string | undefined, generic: string): string {
  const h = (hint ?? '').trim().replace(/[.。\s]+$/, '');
  return h || generic;
}

function named(w: Words, hosts: readonly string[], bold: boolean): string {
  const labels = bold ? hosts.map((h) => `**${h}**`) : [...hosts];
  return labels.length <= 1 ? (labels[0] ?? w.someHost) : w.names(labels);
}

/** The turn the letter gets when the certificate has run out and a fresh sign-in fails: plain text (a thread turn reads as written). */
export function sshCertExpiredTurn(lang: LetterLang, p: { hosts: string[]; expiresAt: number; hint?: string; error?: string }): string {
  const w = WORDS[lang];
  const lines = [w.expired(named(w, p.hosts, false), certTimeWords(p.expiresAt), stepOf(p.hint, w.genericStep))];
  if (p.error) lines.push(`${w.sshSaid} ${p.error.replace(/\s+/g, ' ').slice(0, 300)}`);
  lines.push(w.closes);
  return lines.join('\n\n');
}

export const SSH_CERT_EXPIRY = letterKind<SshCertExpiryParams>({
  id: 'ssh-cert-expiry',
  type: 'review',
  callers: ['src/core/hosts/ssh-cert-expiry-alert.ts'],
  marked: true,
  render: (lang, { hosts, expiresAt, now, hint }) => {
    const w = WORDS[lang];
    const at = certTimeWords(expiresAt);
    const subject = w.subject(named(w, hosts, false), at);
    const minutes = Math.round((expiresAt - now) / 60_000);
    const markdown = [w.soon(named(w, hosts, true), at, w.inAbout(minutes), stepOf(hint, w.genericStep)), w.why, w.closes].join('\n\n');
    return { subject: subject.length > 200 ? `${subject.slice(0, 199)}…` : subject, markdown };
  },
  samples: [
    { hosts: ['Dev box'], expiresAt: Date.UTC(2026, 10, 4, 15, 52), now: Date.UTC(2026, 10, 4, 12, 50), hint: 'run your login command' },
    { hosts: ['Dev box', 'Build host', 'GPU box'], expiresAt: Date.UTC(2026, 10, 4, 15, 52), now: Date.UTC(2026, 10, 4, 15, 20) },
  ],
  stillNeeded: { none: 'ssh-cert-expiry-alert.ts archives it itself once a renewed certificate is in place, or its hosts left Settings' },
});
