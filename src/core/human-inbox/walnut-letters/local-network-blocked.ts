/**
 * "macOS is blocking Walnut from your local network": macOS refuses every connection Walnut makes
 * to a local-network address (hosts/local-network-alert.ts). Only the user can lift that, in System
 * Settings. One letter per episode, marked `local-network-blocked:<episode>`.
 */
import type { ByLang } from './languages.js';
import { letterKind } from './kind.js';

export interface LocalNetworkBlockedParams {
  /** When Walnut first saw the block (epoch ms), shown in this server's local time. */
  firstSeenAt: number;
}

interface Words {
  subject: string;
  cannot: string;
  fix: string;
  cause: string;
  seen: (when: string) => string;
}

const WORDS: ByLang<Words> = {
  en: {
    subject: 'macOS is blocking Walnut from your local network',
    cannot: 'Walnut cannot reach machines on this Mac\'s local network. SSH hosts at local addresses fail with "No route to host", and machines joined to Walnut fall back to the slower relay.',
    fix: 'To fix it, open **System Settings > Privacy & Security > Local Network** and turn on Walnut. If two Walnut entries are listed, turn on both.',
    cause: 'The usual cause: a copy of Walnut.app was opened or registered under another name and shares Walnut\'s program, or a Local Network prompt was answered "Don\'t Allow".',
    seen: (when) => `Walnut first saw this at ${when}. This letter archives itself once Walnut reaches the local network again, or after a day with no sign of the block.`,
  },
  zh: {
    subject: 'macOS 阻止了 Walnut 访问你的局域网',
    cannot: 'Walnut 连不上这台 Mac 所在局域网里的机器：本地地址上的 SSH 主机会报 "No route to host"，加入 Walnut 的机器会改走较慢的中转。',
    fix: '解决办法：打开**系统设置 > 隐私与安全性 > 本地网络**，把 Walnut 打开。如果列出了两个 Walnut，两个都打开。',
    cause: '常见原因：有一份 Walnut.app 的副本以别的名字打开或注册过，和 Walnut 共用同一个程序；或者某次本地网络提示被点了"不允许"。',
    seen: (when) => `Walnut 在 ${when} 第一次发现这个问题。Walnut 重新连上局域网后，或者一天内都没再发现这个问题时，这封信会自动归档。`,
  },
};

/** `YYYY-MM-DD HH:MM` in this server's local time (the Mac's, so the user's own clock). */
export function letterTime(ms: number): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '?';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const LOCAL_NETWORK_BLOCKED = letterKind<LocalNetworkBlockedParams>({
  id: 'local-network-blocked',
  type: 'review',
  callers: ['src/core/hosts/local-network-alert.ts'],
  marked: true,
  render: (lang, { firstSeenAt }) => {
    const w = WORDS[lang];
    return { subject: w.subject, markdown: [w.cannot, w.fix, w.cause, w.seen(letterTime(firstSeenAt))].join('\n\n') };
  },
  samples: [{ firstSeenAt: Date.UTC(2026, 10, 3, 9, 30) }],
  stillNeeded: { none: 'local-network-alert.ts archives it itself once Walnut reaches the local network again, or after a day with no blocked check' },
});
