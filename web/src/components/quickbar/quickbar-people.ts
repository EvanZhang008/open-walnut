/**
 * Who the quick bar talks to: the order of its people list, the person it starts on (the last one
 * chosen), the one Shift-Tab switches to, and the name said at the start of a dictation ("to
 * Walnut VP, ..."), which picks that person. Pure functions, so tests/web/quickbar-people.test.ts
 * pins every rule.
 */

import { stateCountLabel } from '@open-walnut/user-status';

export interface QuickPerson {
  id: string;
  title: string;
  kind: 'ceo' | 'vp' | 'task';
  project: string;
  state: string;
  stateLabel: string;
  line: string;
  needs: number;
}

/** `kind` since 2026-11-20 (older entries have none). */
export interface RecentSend { id: string; title: string; at: number; kind?: QuickPerson['kind'] }

/** Tasks sent to within this long are listed above the other tasks. */
export const RECENT_TASK_MS = 48 * 3_600_000;
const RECENTS_KEY = 'walnut:quickbar-recents';
const MAX_RECENTS = 12;
/**
 * Who was chosen last, newest first: picked in the list, by a number key or Shift-Tab, or sent to.
 * The bar opens on the newest, however long ago (2026-11-22, the user: "the quick search should
 * remember the last time selection, if I choose walnut, it will choose walnut again"; until then
 * it stayed on the last send for ten minutes only, then went back to the CEO).
 */
const CHOSEN_KEY = 'walnut:quickbar-chosen';
const MAX_CHOSEN = 6;

export function readRecents(): RecentSend[] {
  return readList(RECENTS_KEY);
}

type Remembered = Pick<QuickPerson, 'id' | 'title'> & { kind?: QuickPerson['kind'] };

function readList(key: string): RecentSend[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.filter((r) => r && typeof r.id === 'string' && typeof r.at === 'number') : [];
  } catch { return []; }
}

function pushList(key: string, max: number, person: Remembered, now: number): RecentSend[] {
  const next = [{ id: person.id, title: person.title, at: now, ...(person.kind ? { kind: person.kind } : {}) }, ...readList(key).filter((r) => r.id !== person.id)].slice(0, max);
  try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* private mode: no memory */ }
  return next;
}

/** A send is a choice too: the bar opens on that person next time. */
export function rememberSend(person: Remembered, now = Date.now()): RecentSend[] {
  rememberChoice(person, now);
  return pushList(RECENTS_KEY, MAX_RECENTS, person, now);
}

export function readChosen(): RecentSend[] {
  return readList(CHOSEN_KEY);
}

/**
 * The person chosen by hand (list, number key, Shift-Tab): the bar opens on them next time. The
 * CEO chosen while the people list did not load has no id: kept as such, it opens on the CEO.
 */
export function rememberChoice(person: Remembered, now = Date.now()): void {
  if (person.id || person.kind === 'ceo') pushList(CHOSEN_KEY, MAX_CHOSEN, person, now);
}

/** Every person in these lists once, the most recently chosen first. */
function choicesOf(...lists: ReadonlyArray<readonly RecentSend[]>): RecentSend[] {
  const all = lists.flat().sort((a, b) => b.at - a.at);
  return all.filter((r, i) => all.findIndex((x) => x.id === r.id) === i);
}

export interface PeopleSection { label: string; people: QuickPerson[] }

/**
 * CEO first, then the VPs (the ones sent to most recently first), then the tasks sent to in the
 * last two days (newest first), then the other tasks as the server ordered them (needing the
 * user first). A recent task the server no longer lists (finished, or past its limit) stays,
 * by the title it had, so the person can still find who they just talked to.
 */
export function sectionPeople(people: readonly QuickPerson[], recents: readonly RecentSend[], now = Date.now()): PeopleSection[] {
  const rank = new Map(recents.map((r, i) => [r.id, i]));
  const byRecent = (a: QuickPerson, b: QuickPerson) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9);
  const ceo = people.filter((p) => p.kind === 'ceo');
  const vps = people.filter((p) => p.kind === 'vp').map((p, i) => ({ p, i }))
    .sort((a, b) => byRecent(a.p, b.p) || a.i - b.i).map(({ p }) => p);
  const known = new Map(people.map((p) => [p.id, p]));
  const recentTasks: QuickPerson[] = [];
  for (const r of recents) {
    if (now - r.at > RECENT_TASK_MS) continue;
    const listed = known.get(r.id);
    if (listed && listed.kind !== 'task') continue;
    recentTasks.push(listed ?? { id: r.id, title: r.title, kind: 'task', project: '', state: '', stateLabel: '', line: '', needs: 0 });
  }
  const recentIds = new Set(recentTasks.map((p) => p.id));
  const tasks = people.filter((p) => p.kind === 'task' && !recentIds.has(p.id));
  return [
    { label: 'Pinned', people: ceo },
    { label: 'VPs', people: vps },
    { label: 'Recent', people: recentTasks },
    { label: 'Tasks', people: tasks },
  ].filter((s) => s.people.length > 0);
}

/**
 * The last person chosen (or sent to), however long ago, while the list still holds them; else
 * the CEO, else the first listed. A task that finished since is no longer listed: the CEO then.
 */
export function startingPerson(people: readonly QuickPerson[], recents: readonly RecentSend[], chosen: readonly RecentSend[] = []): QuickPerson | null {
  const last = choicesOf(chosen, recents)[0];
  const listed = last ? people.find((p) => p.id === last.id) : undefined;
  return listed ?? people.find((p) => p.kind === 'ceo') ?? people[0] ?? null;
}

/**
 * Who Shift-Tab switches to from `shown`: the CEO from anyone else; from the CEO, back to the last
 * one chosen who is not the CEO and is still listed (`listed`: every row the list shows, recent
 * tasks included). `undefined` when there is nobody to go back to (the Tab list opens instead);
 * `null` is the CEO when the people list did not load (the chip then says CEO).
 */
export function quickSwitchTarget(
  shown: QuickPerson | null,
  listed: readonly QuickPerson[],
  recents: readonly RecentSend[],
  chosen: readonly RecentSend[],
): QuickPerson | null | undefined {
  const ceo = listed.find((p) => p.kind === 'ceo') ?? null;
  if (shown && shown.kind !== 'ceo') return ceo;
  for (const r of choicesOf(chosen, recents)) {
    const hit = listed.find((p) => p.id === r.id);
    if (hit && hit.kind !== 'ceo') return hit;
  }
  return undefined;
}

const GAP = /[\s\p{P}\p{S}]/u;

/** Lowercase, no spaces or punctuation: "Walnut VP", "walnut-vp" and "WalnutVP" are one name. */
function squash(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** The names a person answers to: the title, and a VP's title without its "VP". */
export function namesOf(person: QuickPerson): string[] {
  const names = [person.title];
  if (person.kind === 'vp') {
    const bare = person.title.replace(/\s*\bVP\b\s*/i, ' ').trim();
    if (bare && bare !== person.title) names.push(bare);
  }
  if (person.kind === 'ceo') names.push('CEO', 'Main');
  return names.map(squash).filter((n) => n.length >= 2);
}

/**
 * Words that open an address: English "to / tell / ask / for / hey", and the Chinese gei, gen,
 * gaosu, dui, he, wen (escaped: code holds no CJK text).
 */
const LEADS = /^(?:to|tell|ask|for|hey|\u7ed9|\u8ddf|\u544a\u8bc9|\u5bf9|\u548c|\u95ee)\s*/i;
/** "say" after the name: Chinese shuo yixia or shuo. */
const SAY = /^\s*(?:\u8bf4\u4e00\u4e0b|\u8bf4)/;
/** Punctuation that ends an address: comma or colon, ASCII or full width, the ideographic comma, a dash. */
const END_MARK = /[,:\uff0c\u3001\uff1a-]/;
const SEPARATOR = /^\s*[,:\uff0c\u3001\uff1a-]\s*|^\s+/;

/**
 * A dictation that starts with a person's name picks that person: "to Walnut VP, ...",
 * "Garden VP: ...", the Chinese "gei Walnut VP, ...". Only at the very start, and only a name
 * followed by a comma or colon (or, after a lead word, a space), so a sentence that merely
 * names a VP later on goes as it is. The longest matching name wins ("Walnut VP" over "Walnut").
 */
export function addresseeOf(text: string, people: readonly QuickPerson[]): { person: QuickPerson; rest: string } | null {
  const head = text.trimStart();
  const lead = LEADS.exec(head);
  const afterLead = lead ? head.slice(lead[0].length) : head;
  // Every name the text starts with; the longest one is what was said ("Walnut VP," is never
  // read as "Walnut" with "VP," after it), and at one length a full title beats a short form.
  const said: Array<{ person: QuickPerson; end: number; score: number }> = [];
  for (const person of people) {
    namesOf(person).forEach((name, i) => {
      const end = prefixEnd(afterLead, name);
      if (end !== null) said.push({ person, end, score: name.length * 2 + (i === 0 ? 1 : 0) });
    });
  }
  if (said.length === 0) return null;
  const { person, end } = said.reduce((a, b) => (b.score > a.score ? b : a));
  let at = end;
  const say = SAY.exec(afterLead.slice(at));
  if (say) at += say[0].length;
  // After "say" the words may follow at once (Chinese runs them together).
  const sep = SEPARATOR.exec(afterLead.slice(at)) ?? (say ? [''] : null);
  // Without a lead word the name must end in punctuation: "Walnut is slow" is no address.
  if (!sep || (!lead && !say && !END_MARK.test(sep[0]))) return null;
  const rest = afterLead.slice(at + sep[0].length).trimStart();
  return rest ? { person, rest } : null;
}

/** Where `name` (squashed) ends when read from the start of `text`, skipping spaces and punctuation inside it. */
function prefixEnd(text: string, name: string): number | null {
  let j = 0;
  for (let i = 0; i < text.length; i++) {
    if (j === name.length) return i;
    const c = text[i].toLowerCase();
    if (GAP.test(c)) {
      if (j === 0) return null;
      continue;
    }
    if (c !== name[j]) return null;
    j++;
  }
  return j === name.length ? text.length : null;
}

/** People whose title (or project) holds every word typed, best first. */
export function filterPeople(people: readonly QuickPerson[], query: string): QuickPerson[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...people];
  const scored = people.map((p) => {
    const hay = `${p.title} ${p.project}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) return null;
    const starts = p.title.toLowerCase().startsWith(words[0]) ? 0 : 1;
    const kind = p.kind === 'ceo' ? 0 : p.kind === 'vp' ? 1 : 2;
    return { p, score: starts * 10 + kind };
  }).filter((x): x is { p: QuickPerson; score: number } => !!x);
  return scored.sort((a, b) => a.score - b.score).map((x) => x.p);
}

/** The avatar's letters: "CEO", the first letter of a VP's name, the first of a task's title. */
export function initialsOf(person: Pick<QuickPerson, 'title' | 'kind'>): string {
  if (person.kind === 'ceo') return 'CEO';
  const word = person.title.replace(/\bVP\b/i, '').trim();
  return (word[0] ?? person.title[0] ?? '?').toUpperCase();
}

/** A steady hue per person, so the same VP keeps its color on every open. */
export function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** The line under a name: how many threads of a CEO or VP wait on the user, then what it does now. */
export function personLine(p: Pick<QuickPerson, 'kind' | 'needs' | 'line' | 'stateLabel'>): string {
  if (p.kind !== 'task' && p.needs > 0) return `${stateCountLabel('needs', p.needs)}${p.line ? ` \u00b7 ${p.line}` : ''}`;
  return p.line || p.stateLabel;
}

/**
 * The person the bar opens on when the people list did not load: the last one chosen or sent to,
 * as startingPerson would pick from a loaded list, else null (the chip then says CEO, and the
 * words go to the CEO).
 */
export function personOfRecent(recents: readonly RecentSend[], chosen: readonly RecentSend[] = []): QuickPerson | null {
  const last = choicesOf(chosen, recents)[0];
  if (!last?.id) return null;
  return { id: last.id, title: last.title, kind: last.kind ?? 'task', project: '', state: '', stateLabel: '', line: '', needs: 0 };
}
