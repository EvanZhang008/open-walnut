/**
 * An app-level alert (a remote host Walnut cannot use, this machine's Claude Code, a found
 * computer to add) never renders inside a chat, session or task column: it is a notification,
 * the notification panel's problem rows plus a toast in the notice stack (2026-11-16, the user:
 * "this shoudl not show on top of quick chat pannel", then "please unified, shodl as
 * notificaiton in the notificaiton bar"). The Home card that used to move between the task
 * panel, the Ask Walnut slot and a draft column pushed the quick chat down.
 *
 * This fails when:
 *  - an alert component is rendered (`<Name`) in a file not listed for it below;
 *  - a chat or session component (web/src/components/chat, web/src/components/sessions)
 *    imports an alert component or the app-level host attention model;
 *  - a chat or session panel grows a free-form slot for one again (the Ask slot's `banner`
 *    prop, the draft column's host notice);
 *  - Home passes an alert into anything but the task panel's own found-computers row.
 * A new alert component joins ALERT_RENDER_SITES with the one place it may render.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sources = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'web/src'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(tsx?|jsx?)$/.test(f) && fs.existsSync(path.join(ROOT, f)));

/** Each app-level alert component and the only files that may render it, with why. */
const ALERT_RENDER_SITES: Record<string, Record<string, string>> = {
  NotificationProblems: { 'web/src/components/common/NotificationPanel.tsx': 'the bell panel: All and Errors lead with the problems' },
  HostProblemNotices: { 'web/src/components/layout/AppShell.tsx': 'mounted once: the toast and the screen reader line' },
  NotificationHostRow: { 'web/src/components/common/NotificationSystemPane.tsx': "the bell panel's System host list" },
  SingleHostRow: {
    'web/src/components/common/NotificationProblems.tsx': 'a problem row in All and Errors',
    'web/src/components/common/NotificationHostRow.tsx': "a problem host in System's list",
  },
  SetupBanner: { 'web/src/components/common/FirstUseSetup.tsx': "the first-use card's install step (onboarding, not an alert)" },
  FoundHostPrompts: { 'web/src/pages/MainPage.tsx': "the task panel's top row only (checked below)" },
};

/** What a chat or session component must not import: a whole module ('*') or the named alert parts of one.
 *  (SetupBanner's ClaudeSignIn button is fine: a session's own wait note offers the sign-in.) */
const ALERT_IMPORTS: Record<string, '*' | string[]> = {
  'components/common/NotificationProblems': '*',
  'components/common/HostProblemNotices': '*',
  'components/common/NotificationHostRow': '*',
  'components/common/FoundHostPrompts': '*',
  'components/common/SetupBanner': ['SetupBanner', 'useLocalClaudeNotice'],
  'utils/host-attention': '*',
  'hooks/useAttentionDots': '*',
};

/** The names a file imports from `module`, or null when it does not import it. */
function importsFrom(text: string, module: string): string[] | null {
  const re = new RegExp(`import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s+from\\s+['"][^'"]*/${module.replace(/[/]/g, '\\/')}['"]|import\\s+[^;]*from\\s+['"][^'"]*/${module.replace(/[/]/g, '\\/')}['"]`, 'g');
  let found: string[] | null = null;
  for (const m of text.matchAll(re)) {
    found ??= [];
    found.push(...(m[1] ?? '*').split(',').map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean));
  }
  return found;
}

const CHAT_DIRS = ['web/src/components/chat/', 'web/src/components/sessions/'];

describe('app-level alerts stay out of chat, session and task columns', () => {
  it('renders each alert component only where it is listed', () => {
    const wrong: string[] = [];
    for (const file of sources) {
      const text = read(file);
      for (const [name, sites] of Object.entries(ALERT_RENDER_SITES)) {
        if (new RegExp(`<${name}\\b`).test(text) && !(file in sites)) wrong.push(`${file} renders <${name}>`);
      }
    }
    expect(wrong, 'an alert is a notification (bell panel + toast), never a card in a column').toEqual([]);
  });

  it('every listed render site still renders its component (the list is not stale)', () => {
    const stale: string[] = [];
    for (const [name, sites] of Object.entries(ALERT_RENDER_SITES)) {
      for (const file of Object.keys(sites)) if (!new RegExp(`<${name}\\b`).test(read(file))) stale.push(`${file} no longer renders <${name}>`);
    }
    expect(stale).toEqual([]);
  });

  it('chat and session components import no alert component and no host attention model', () => {
    const wrong: string[] = [];
    for (const file of sources.filter((f) => CHAT_DIRS.some((d) => f.startsWith(d)))) {
      const text = read(file);
      for (const [m, names] of Object.entries(ALERT_IMPORTS)) {
        const got = importsFrom(text, m);
        if (!got) continue;
        const bad = names === '*' ? got : got.filter((n) => n === '*' || names.includes(n));
        if (bad.length) wrong.push(`${file} imports ${bad.join(', ')} from ${m}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('the Ask Walnut slot and the draft column have no slot an alert could be passed into', () => {
    const slot = read('web/src/components/chat/AskWalnutSlot.tsx');
    expect(slot).not.toMatch(/\bbanner\??:\s*ReactNode/);
    const draft = read('web/src/components/sessions/DraftSessionPanel.tsx');
    expect(draft).not.toMatch(/\bhostNotice\b/);
    // Home never hands a draft column a notice: launchNotice is a draft's own launch error.
    expect(read('web/src/pages/MainPage.tsx')).not.toMatch(/\blaunchNotice=/);
  });

  it('Home renders the found-computers row only inside the task panel banner', () => {
    const page = read('web/src/pages/MainPage.tsx');
    const start = page.indexOf('const tasksBanner = useMemo(');
    expect(start, 'tasksBanner (the task panel top rows) moved: update this guard').toBeGreaterThan(-1);
    const end = page.indexOf(']);', start);
    const all = [...page.matchAll(/<FoundHostPrompts\b/g)].map((m) => m.index!);
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((i) => i < start || i > end), 'FoundHostPrompts outside the task panel').toEqual([]);
  });

  it('the deleted Home card does not come back', () => {
    for (const f of ['web/src/components/common/AttentionBanner.tsx', 'web/src/components/common/AttentionBannerMount.tsx']) {
      expect(fs.existsSync(path.join(ROOT, f)), `${f}: host problems are notifications now`).toBe(false);
    }
    expect(sources.filter((f) => /AttentionBannerMount|<AttentionBanner\b/.test(read(f)))).toEqual([]);
  });
});
