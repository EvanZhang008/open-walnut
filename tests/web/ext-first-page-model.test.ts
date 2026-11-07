/**
 * The extension's first page (design option A, 2026-11-07; web/src/popout/ext-home-model.ts,
 * ext-relay-model.ts, and the words ext-panel-model.ts reads for it):
 *   . Send is Home's New task draft (never Ask Walnut), with the page as a hint beside the words and
 *     the task's own directory when no folder is picked (the extension has no folder picker);
 *   . Save as todo names the page it was on in the description, and only when the chip was on;
 *   . the drawing of the next open is read from the task panel's own markup, cut to what it draws;
 *   . the relay word is read strictly (owner keys, http pages, a cap), and the pill, the panel's two
 *     lists and a row's name follow the extension's state.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';

vi.mock('../../web/src/utils/log', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import { HOME_PLACEHOLDER, HOME_SNAP_ROWS, HOME_SNAP_TABS, homeLaunchBody, homeSnapOf, homeTodoInput, isPanelMode, taskPageTitle } from '../../web/src/popout/ext-home-model';
import { readRelay, relayGroups, relayPillOf, relayTabName, taskOfOwner, type RelayState } from '../../web/src/popout/ext-relay-model';
import { readInbound } from '../../web/src/popout/ext-panel-model';
import { initialAskDraft } from '../../web/src/components/chat/ask-object-draft';
import { applyDraftPathPick, leaveWalnutDraft, makeTierKnown } from '../../web/src/components/sessions/draft-ownership';
import { DEFAULT_ENGINE_CATALOG } from '../../web/src/utils/engines';

const TIERS = makeTierKnown([], true);
const draft = () => leaveWalnutDraft(initialAskDraft('ext-home'));
const PAGE = { url: 'https://accounts.example.test/orders', title: 'Lab Accounts' };

describe('Send on the first page', () => {
  it('starts a task (not an ask), in its own directory, with the page as a hint', () => {
    const body = homeLaunchBody({ draft: draft(), message: 'Find the receipt', tierKnown: TIERS, catalog: DEFAULT_ENGINE_CATALOG, hints: { 'object-context': { arg: 'ctx-1' } } });
    expect(body.walnut).not.toBe(true);
    expect(body.message).toBe('Find the receipt');
    expect(body.ownTaskDir).toBe(true);
    expect(body.cwd ?? '').toBe('');
    expect(body.hints).toEqual({ 'object-context': { arg: 'ctx-1' } });
    // The page never rides in the words.
    expect(body.message).not.toContain(PAGE.url);
  });

  it('a draft with a folder starts there, and never asks for its own directory', () => {
    const d = applyDraftPathPick(draft(), { cwd: '/work/repo', host: null }, draft().meta, undefined, () => '', () => false);
    const body = homeLaunchBody({ draft: d, message: 'Go', tierKnown: TIERS, catalog: DEFAULT_ENGINE_CATALOG });
    expect(body.cwd).toBe('/work/repo');
    expect(body.ownTaskDir).toBeUndefined();
    expect(body.hints).toBeUndefined();
  });

  it('a draft left in Ask Walnut mode still starts a task', () => {
    const body = homeLaunchBody({ draft: initialAskDraft('ext-home'), message: 'Go', tierKnown: TIERS, catalog: DEFAULT_ENGINE_CATALOG });
    expect(body.walnut).not.toBe(true);
  });

  it('the placeholder is the mock\'s', () => {
    expect(HOME_PLACEHOLDER).toBe('New task: what should Walnut do?');
  });
});

describe('Save as todo on the first page', () => {
  it('names the page in the description while the chip is on', () => {
    const input = homeTodoInput({ draft: draft(), text: 'Renew the parking permit\nbefore Friday', page: PAGE, withPage: true, tierKnown: TIERS });
    expect(input?.title).toBe('Renew the parking permit');
    expect(input?.description).toContain('From the browser: Lab Accounts (https://accounts.example.test/orders)');
  });
  it('leaves the page out with the chip off, and files nothing for empty words', () => {
    const input = homeTodoInput({ draft: draft(), text: 'Renew the parking permit', page: PAGE, withPage: false, tierKnown: TIERS });
    expect(input?.description ?? '').not.toContain('accounts.example.test');
    expect(homeTodoInput({ draft: draft(), text: '   ', page: PAGE, withPage: true, tierKnown: TIERS })).toBeNull();
  });
});

describe('a task\'s name on its page', () => {
  it('is its title, or its first question while it wears the placeholder', () => {
    expect(taskPageTitle('Rotate the expired API key', 'Find the receipt')).toBe('Rotate the expired API key');
    expect(taskPageTitle('Session: mw5tno2s-9b3f', 'Find the receipt')).toBe('Find the receipt');
    expect(taskPageTitle('Session: mw5tno2s-9b3f', '')).toBe('Session: mw5tno2s-9b3f');
    expect(taskPageTitle(undefined, 'Find it')).toBe('Find it');
    expect(taskPageTitle(undefined, '')).toBe('Task');
  });
});

describe('which page the panel shows', () => {
  it('reads only the three pages', () => {
    for (const m of ['home', 'ask', 'task']) expect(isPanelMode(m)).toBe(true);
    for (const m of ['tasks', '', null, 3, 'HOME']) expect(isPanelMode(m)).toBe(false);
  });
});

describe('the drawing of the first page, from the task panel', () => {
  const doc = parseHTML(`<!doctype html><html><body><div class="ext-home"><div class="todo-panel">
    <div class="todo-section-tabs">
      <button class="todo-section-tab is-active"><span class="todo-section-tab-label">All</span><span class="todo-section-tab-count">128</span></button>
      <button class="todo-section-tab"><span class="todo-section-tab-label">Focus</span><span class="todo-section-tab-count">12</span></button>
      <button class="todo-section-tab"><span class="todo-section-tab-label"></span></button>
      ${Array.from({ length: 8 }, (_, i) => `<button class="todo-section-tab"><span class="todo-section-tab-label">Tab ${i}</span></button>`).join('')}
    </div>
    <div class="todo-panel-item todo-panel-item-needs-action"><span class="todo-item-title">Rotate the expired API key <b>now</b></span></div>
    ${Array.from({ length: 14 }, (_, i) => `<div class="todo-panel-item"><span class="todo-item-title">Task ${i}</span></div>`).join('')}
    <div class="todo-panel-item"><span class="todo-item-title">${'x'.repeat(400)}</span></div>
  </div></div></body></html>`).document;

  it('keeps the tabs and the first rows as words, the needs mark, cut to what it draws', () => {
    const s = homeSnapOf(doc.querySelector('.ext-home')!)!;
    expect(s.tabs.length).toBeLessThanOrEqual(HOME_SNAP_TABS);
    expect(s.tabs[0]).toEqual({ label: 'All', count: '128', on: true });
    expect(s.tabs[1]).toEqual({ label: 'Focus', count: '12' });
    // A tab with no words is not drawn.
    expect(s.tabs.some((t) => !t.label)).toBe(false);
    expect(s.rows.length).toBe(HOME_SNAP_ROWS);
    expect(s.rows[0]).toMatchObject({ title: 'Rotate the expired API key now', needs: true });
    expect(s.rows[1].needs).toBe(false);
  });
  it('says nothing before the panel is drawn', () => {
    const empty = parseHTML('<!doctype html><html><body><div class="ext-home"></div></body></html>').document;
    expect(homeSnapOf(empty.querySelector('.ext-home')!)).toBeNull();
  });
});

describe('the browser relay word', () => {
  const word = {
    on: true,
    tabs: [
      { tab: 4, owner: 'task:t-refund', who: 'Walnut task', title: 'Lab Accounts', url: 'https://accounts.example.test/orders', handed: true },
      { tab: 9, owner: 'task:t-hotel', title: 'Denver hotels', url: 'https://hotels.example.test/' },
      { tab: 11, owner: 'someone-else', title: 'Bad owner' },
      { tab: -1, owner: 'task:t-x' },
      { tab: 12, owner: 'task:t-y', url: 'javascript:alert(1)', title: 'Script page' },
    ],
  };

  it('keeps well-formed tabs only, http pages only', () => {
    const r = readRelay(word)!;
    expect(r.on).toBe(true);
    expect(r.tabs.map((t) => t.tab)).toEqual([4, 9, 12]);
    expect(r.tabs[0].handed).toBe(true);
    expect(r.tabs[2].url).toBeUndefined();
    expect(readRelay({ on: true })).toBeNull();
    expect(readRelay({ tabs: Array.from({ length: 60 }, (_, i) => ({ tab: i, owner: `task:t${i}` })) })!.tabs).toHaveLength(40);
  });

  it('reaches the view through readInbound, and a hand keeps its task flags', () => {
    const EXT = 'chrome-extension://abcdefghijklmnop';
    const m = readInbound({ walnut: 'ext-panel', type: 'relay', ...word }, EXT, true);
    expect(m?.type).toBe('relay');
    // Only the extension page that frames the view is heard.
    expect(readInbound({ walnut: 'ext-panel', type: 'relay', ...word }, 'https://evil.example.test', true)).toBeNull();
    expect(readInbound({ walnut: 'ext-panel', type: 'relay', ...word }, EXT, false)).toBeNull();
    const hand = readInbound({ walnut: 'ext-panel', type: 'hand', open: { taskId: 't-refund', sessionId: 's-1', task: true } }, EXT, true);
    expect(hand).toMatchObject({ type: 'hand', open: { taskId: 't-refund', sessionId: 's-1', task: true } });
    const ask = readInbound({ walnut: 'ext-panel', type: 'hand', ask: { text: 'Find it', page: true, act: false, task: true } }, EXT, true);
    expect(ask).toMatchObject({ type: 'hand', ask: { text: 'Find it', task: true } });
  });

  it('the pill: an agent in this tab, else on or off', () => {
    const r = readRelay(word)!;
    expect(relayPillOf(r, { agents: false, owner: 'task:t-refund' })).toEqual({ kind: 'tab', label: 'Agent in tab' });
    expect(relayPillOf(r, { agents: false })).toEqual({ kind: 'on', label: 'Relay on' });
    expect(relayPillOf({ on: false, tabs: [] }, { agents: true })).toEqual({ kind: 'off', label: 'Relay off' });
    // A tab shared from the panel lets agents in with the switch off.
    expect(relayPillOf({ on: false, tabs: [r.tabs[0]] }, { agents: false }).kind).toBe('on');
    // An older extension says no relay: the page's own word.
    expect(relayPillOf(null, { agents: true }).kind).toBe('on');
    expect(relayPillOf(null, { agents: false }).kind).toBe('off');
  });

  it('the panel lists the tab here and working tasks first, then the rest', () => {
    const r: RelayState = readRelay(word)!;
    const g = relayGroups(r, 9, (id) => id === 't-refund');
    expect(g.now.map((t) => t.tab)).toEqual([9, 4]);
    expect(g.earlier.map((t) => t.tab)).toEqual([12]);
    expect(relayGroups(null, 9, () => true)).toEqual({ now: [], earlier: [] });
  });

  it('a row names its page and site, or this tab', () => {
    const r = readRelay(word)!;
    expect(relayTabName(r.tabs[0], 4)).toBe('Lab Accounts · this tab');
    expect(relayTabName(r.tabs[1], 4)).toBe('Denver hotels · hotels.example.test');
    expect(relayTabName({ tab: 3, owner: 'task:a' }, 4)).toBe('Tab 3');
    expect(taskOfOwner('task:t-refund')).toBe('t-refund');
    expect(taskOfOwner('other')).toBe('');
  });
});
