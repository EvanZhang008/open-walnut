/**
 * The report Main or a lead sends the user (org/morning-report.ts): built by Walnut from its record,
 * so its headings and fixed lines are Walnut's. Task titles, asks, what a task waits on, results and
 * the node's Brief are the tasks' own words and go in as given; times come preformatted.
 */
import type { ByLang } from './languages.js';
import { letterKind } from './kind.js';
import { USER_STATE_LABELS } from '../../user-status.js';

export interface OrgReportParams {
  /** null = Main. */
  owner: string | null;
  /** When the report counts from, as the report says times. */
  since: string;
  needs: Array<{ title: string; ask?: string; checked?: string; unverified?: boolean; yesNo?: boolean; options?: string[]; letter?: string }>;
  decisions: Array<{ subject: string; from?: string }>;
  done: Array<{ title: string; result?: string }>;
  moved: Array<{ title: string; snoozedUntil?: string; waitingOn?: string; waiting?: boolean; now?: string }>;
  brief?: { text: string; at?: string };
  /** Rows a list shows before "and N more". */
  listMax: number;
  /** The first few titles that need the user, for the preview line. */
  needsPreview: string[];
}

interface Words {
  needsHead: (n: number) => string;
  decisionsHead: (n: number) => string;
  doneHead: (since: string, n: number) => string;
  movedHead: (since: string, n: number) => string;
  briefHead: (owner: string | null, at: string | undefined) => string;
  more: (n: number) => string;
  nothing: string;
  noWords: string;
  checked: (at: string, unverified: boolean) => string;
  yesNo: string;
  options: (labels: string[]) => string;
  tapLetter: (subject: string) => string;
  tapChat: string;
  decision: (subject: string, from: string | undefined) => string;
  snoozed: (until: string) => string;
  waitsOn: (what: string) => string;
  waiting: string;
  working: string;
  subject: (needs: number, done: number, moved: number, sinceShort: string) => string;
  previewNeeds: (titles: string[], more: boolean) => string;
  previewQuiet: (done: number, moved: number) => string;
}

const WORDS: ByLang<Words> = {
  en: {
    needsHead: (n) => `## Needs you (${n})`,
    decisionsHead: (n) => `## Other decisions waiting in your inbox (${n})`,
    doneHead: (since, n) => `## Done since ${since} (${n})`,
    movedHead: (since, n) => `## Moved since ${since} (${n})`,
    briefHead: (owner, at) => `## ${owner ?? 'Main'}'s Brief (written ${at ?? 'earlier'})`,
    more: (n) => `- and ${n} more`,
    nothing: '- Nothing.',
    noWords: 'its ask has no words yet',
    checked: (at, unverified) => ` (checked ${at}${unverified ? ', not verified since' : ''})`,
    yesNo: ' Yes or no.',
    options: (labels) => ` Options: ${labels.join(' / ')}.`,
    tapLetter: (subject) => ` One tap: the letter "${subject}" in your inbox.`,
    tapChat: ' Answer in its chat.',
    decision: (subject, from) => `- "${subject}"${from ? ` from ${from}` : ''}: one tap answers it.`,
    snoozed: (until) => `snoozed until ${until}`,
    waitsOn: (what) => `waits on ${what}`,
    waiting: 'waiting',
    working: 'working',
    subject: (needs, done, moved, since) => `Report: ${needs} ${USER_STATE_LABELS.needs}, ${done} ${USER_STATE_LABELS.done}, ${moved} moved since ${since}`,
    previewNeeds: (titles, more) => `Needs you: ${titles.join('; ')}${more ? '; …' : ''}`,
    previewQuiet: (done, moved) => `Nothing needs you. ${done} done, ${moved} moved.`,
  },
  zh: {
    needsHead: (n) => `## 需要你（${n}）`,
    decisionsHead: (n) => `## 收件箱里其他等你决定的事（${n}）`,
    doneHead: (since, n) => `## ${since} 以来完成的（${n}）`,
    movedHead: (since, n) => `## ${since} 以来有进展的（${n}）`,
    briefHead: (owner, at) => `## ${owner ?? 'Main'} 的简报（写于 ${at ?? '更早'}）`,
    more: (n) => `- 还有 ${n} 项`,
    nothing: '- 没有。',
    noWords: '它的请求还没写内容',
    checked: (at, unverified) => `（${at} 核实过${unverified ? '，之后未再核实' : ''}）`,
    yesNo: '回答是或否。',
    options: (labels) => `选项：${labels.join(' / ')}。`,
    tapLetter: (subject) => `一键回答：收件箱里的信"${subject}"。`,
    tapChat: '在它的对话里回答。',
    decision: (subject, from) => `- "${subject}"${from ? `（来自 ${from}）` : ''}：一键即可回答。`,
    snoozed: (until) => `推迟到 ${until}`,
    waitsOn: (what) => `在等：${what}`,
    waiting: '等待中',
    working: '进行中',
    subject: (needs, done, moved, since) => `报告：${needs} 项需要你，${done} 项完成，${since} 以来 ${moved} 项有进展`,
    previewNeeds: (titles, more) => `需要你：${titles.join('；')}${more ? '；…' : ''}`,
    previewQuiet: (done, moved) => `没有需要你的事。完成 ${done} 项，有进展 ${moved} 项。`,
  },
};

export const ORG_REPORT = letterKind<OrgReportParams>({
  id: 'org-report',
  type: 'info',
  callers: ['src/core/org/morning-report.ts'],
  marked: false,
  render: (lang, p) => {
    const w = WORDS[lang];
    const lines: string[] = [];
    const list = <T>(rows: readonly T[], line: (r: T) => string): void => {
      for (const r of rows.slice(0, p.listMax)) lines.push(line(r));
      if (rows.length > p.listMax) lines.push(w.more(rows.length - p.listMax));
      if (!rows.length) lines.push(w.nothing);
    };
    // The English line ends "...(checked X). Options: ..."; the Chinese one needs no joining period.
    const end = lang === 'en' ? '.' : '。';
    lines.push(w.needsHead(p.needs.length));
    list(p.needs, (n) => `- **${n.title}**: ${n.ask ?? w.noWords}${n.checked ? w.checked(n.checked, !!n.unverified) : ''}${end}`
      + `${n.yesNo ? w.yesNo : n.options?.length ? w.options(n.options) : ''}${n.letter ? w.tapLetter(n.letter) : w.tapChat}`);
    if (p.decisions.length) {
      lines.push('', w.decisionsHead(p.decisions.length));
      list(p.decisions, (d) => w.decision(d.subject, d.from));
    }
    lines.push('', w.doneHead(p.since, p.done.length));
    list(p.done, (d) => `- **${d.title}**${d.result ? `: ${d.result}` : ''}`);
    lines.push('', w.movedHead(p.since, p.moved.length));
    list(p.moved, (m) => `- **${m.title}**: ${m.snoozedUntil ? w.snoozed(m.snoozedUntil) : m.waitingOn ? w.waitsOn(m.waitingOn) : m.waiting ? w.waiting : m.now ?? w.working}`);
    if (p.brief) lines.push('', w.briefHead(p.owner, p.brief.at), '', p.brief.text);
    return {
      subject: w.subject(p.needs.length, p.done.length, p.moved.length, p.since.slice(11, 16)),
      markdown: lines.join('\n'),
      text: p.needs.length ? w.previewNeeds(p.needsPreview.slice(0, 3), p.needsPreview.length > 3) : w.previewQuiet(p.done.length, p.moved.length),
    };
  },
  samples: [
    {
      owner: 'Walnut lead', since: '2026-11-01 06:00 UTC', listMax: 20, needsPreview: ['Hosts overview'],
      needs: [{ title: 'Hosts overview', ask: 'Start step one?', checked: '2026-11-01 07:00 UTC', options: ['In settings', 'Own page'], letter: 'Hosts overview: start?' }],
      decisions: [{ subject: 'Pick a layout', from: 'Web redesign' }],
      done: [{ title: 'Fix the build', result: 'green on main' }],
      moved: [{ title: 'Docs', waitingOn: 'the review' }, { title: 'Later', snoozedUntil: '2026-11-03 09:00 UTC' }],
      brief: { text: 'All on track.', at: '2026-11-01 14:00 UTC' },
    },
    { owner: null, since: '2026-11-01 06:00 UTC', listMax: 20, needsPreview: [], needs: [], decisions: [], done: [], moved: [] },
  ],
  stillNeeded: { none: 'a report: it asks nothing itself (each decision it lists has its own letter)' },
});
