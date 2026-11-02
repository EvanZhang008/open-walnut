/**
 * "SSH sign-in to <hosts> failed": SSH refuses this machine's sign-in (hosts/host-auth-alert.ts).
 * The next step is the user's own words from config `ssh_login_hint`, inserted as given; the
 * generic step stands in when config names none.
 */
import type { ByLang, LetterLang } from './languages.js';
import { letterKind } from './kind.js';

export interface HostSignInParams {
  hosts: Array<{ label: string; error?: string }>;
  /** config `ssh_login_hint`, as the user wrote it. */
  hint?: string;
  /** Walnut re-dials these on its own (a login failure); a key refusal waits for a Retry. */
  retries?: boolean;
}

interface Words {
  someHost: string;
  genericStep: string;
  names: (labels: string[]) => string;
  list: (bold: string[]) => string;
  subject: (names: string, step: string) => string;
  cannot: (named: string, step: string) => string;
  retrying: string;
  retryYourself: string;
  sshSaid: string;
}

const WORDS: ByLang<Words> = {
  en: {
    someHost: 'a remote host',
    genericStep: 'refresh your login credentials',
    names: (l) => (l.length === 2 ? `${l[0]} and ${l[1]}` : `${l[0]} and ${l.length - 1} more hosts`),
    list: (b) => `${b.slice(0, -1).join(', ')} and ${b[b.length - 1]}`,
    subject: (names, step) => `SSH sign-in to ${names} failed: ${step}`,
    cannot: (named, step) => `Walnut cannot sign in to ${named} over SSH, so sessions and tests there are stuck. To fix it, ${step}.`,
    retrying: 'Walnut keeps retrying and archives this letter by itself once the host connects again.',
    retryYourself: 'Then use Retry on the host (or start work there); this letter archives itself once the host connects.',
    sshSaid: 'What SSH said:',
  },
  zh: {
    someHost: '一台远程主机',
    genericStep: '请重新登录以刷新凭据',
    names: (l) => (l.length === 2 ? `${l[0]} 和 ${l[1]}` : `${l[0]} 等 ${l.length} 台主机`),
    list: (b) => `${b.slice(0, -1).join('、')} 和 ${b[b.length - 1]}`,
    subject: (names, step) => `SSH 登录 ${names} 失败：${step}`,
    cannot: (named, step) => `Walnut 无法通过 SSH 登录 ${named}，那里的会话和测试都卡住了。解决办法：${step}。`,
    retrying: 'Walnut 会自动重试；主机重新连上后，这封信会自动归档。',
    retryYourself: '然后在该主机上点"重试"（或在那里开始工作）；主机连上后，这封信会自动归档。',
    sshSaid: 'SSH 的原话：',
  },
};

/** The step a letter names when config gives none. */
export function genericSignInStep(lang: LetterLang): string {
  return WORDS[lang].genericStep;
}

/** The step as a clause: trimmed, no trailing period (either script). */
function stepOf(hint: string | undefined, generic: string): string {
  const h = (hint ?? '').trim().replace(/[.。\s]+$/, '');
  return h || generic;
}

export const HOST_SIGN_IN = letterKind<HostSignInParams>({
  id: 'host-sign-in',
  type: 'review',
  callers: ['src/core/hosts/host-auth-alert.ts'],
  marked: true,
  render: (lang, { hosts, hint, retries }) => {
    const w = WORDS[lang];
    const labels = hosts.map((h) => h.label);
    const step = stepOf(hint, w.genericStep);
    const names = labels.length <= 1 ? (labels[0] ?? w.someHost) : w.names(labels);
    const subject = w.subject(names, step);
    const bold = labels.map((l) => `**${l}**`);
    const named = bold.length > 1 ? w.list(bold) : (bold[0] ?? w.someHost);
    const lines = [w.cannot(named, step), retries ? w.retrying : w.retryYourself];
    const said = hosts.filter((h) => h.error).map((h) => `${h.label}: ${h.error!.replace(/\s+/g, ' ').slice(0, 300)}`);
    if (said.length) lines.push(`${w.sshSaid}\n\n~~~\n${said.join('\n').replace(/~~~/g, '~ ~ ~')}\n~~~`);
    return { subject: subject.length > 200 ? `${subject.slice(0, 199)}…` : subject, markdown: lines.join('\n\n') };
  },
  samples: [
    { hosts: [{ label: 'Dev box', error: 'Permission denied (publickey)' }], retries: true },
    { hosts: [{ label: 'Dev box' }, { label: 'Build host' }, { label: 'GPU box' }], hint: 'run your login command' },
  ],
  stillNeeded: { none: 'host-auth-alert.ts archives it itself once a host of its episode connects again, or every host of it left Settings' },
});
