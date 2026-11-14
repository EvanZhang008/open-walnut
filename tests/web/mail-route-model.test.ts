import { describe, expect, it } from 'vitest';
import { COVERAGE_REASON, mailRouteAction, mailRouteView, outgoingKind, outgoingRouteView, routerPathOf, showsRouteLine } from '../../web/src/apps/mail/mail-route-model.js';
import type { MailRouteDto } from '../../web/src/api/mail.js';
const route = (extra: Partial<MailRouteDto>): MailRouteDto => ({ areaId: 'personal', status: 'routed', reason: 'Existing owner', at: 1, ...extra });
describe('one mail route line', () => {
  it('does not claim old monitoring never reviewed a message without a ledger row', () => {
    const view = mailRouteView(undefined);
    expect(view.text).toBe('No router has seen this');
    expect(view.text).not.toContain('Not reviewed');
    expect(view.link).toBeNull();
  });
  it('opens the live task name and retains the reason', () => {
    const view = mailRouteView(route({ taskId: 'task-1', target: { id: 'task-1', title: 'Dock slot', kind: 'task', available: true } }));
    expect(view.link).toEqual({ id: 'task-1', kind: 'task' });
    expect(view.text).toContain('Dock slot');
    expect(view.text).toContain('Existing owner');
  });
  it('does not treat an unreadable ledger as an absent receipt', () => {
    expect(mailRouteView(undefined, true)).toMatchObject({ status: 'unknown', link: null });
    expect(mailRouteView(undefined, true).text).toContain('Routing record unavailable');
    expect(mailRouteView(undefined, true).text).not.toContain('No router has seen this');
  });
  it('does not promise delivery for an interrupted claim or unknown answer', () => {
    for (const status of ['routing', 'unknown'] as const) {
      const view = mailRouteView(route({ status }));
      expect(view.link).toBeNull();
      expect(view.text).not.toContain('Routed to');
    }
  });
  it('keeps a missing target truthful without a dead link', () => {
    expect(mailRouteView(route({ target: { id: 'gone', title: 'Former owner', kind: 'task', available: false } }))).toMatchObject({ name: 'Former owner', link: null });
  });
  it('shows a refusal and no-action reasons separately', () => {
    expect(mailRouteView(route({ status: 'failed', error: 'Receiver not isolated' })).text).toContain('Receiver not isolated');
    expect(mailRouteView(route({ status: 'not_routed', reason: 'Newsletter' })).text).toContain('Newsletter');
  });
  it('names a receipt recorded after the fact as previously handled, never as routed by the router', () => {
    const target = { id: 'task-1', title: 'Dock slot', kind: 'task' as const, available: true };
    const legacy = mailRouteView(route({ taskId: 'task-1', target, origin: 'legacy', evidence: 'Reply sent from the desk thread' }));
    expect(legacy).toMatchObject({ status: 'routed', lead: 'Previously handled by', name: 'Dock slot', link: { id: 'task-1', kind: 'task' } });
    expect(legacy.text).not.toContain('Routed to');
    expect(legacy.title).toContain('Reply sent from the desk thread');
    const gone = mailRouteView(route({ taskId: 'task-1', target: { ...target, available: false }, origin: 'legacy', evidence: 'Reply sent' }));
    expect(gone).toMatchObject({ lead: 'Previously handled by', link: null });
    expect(gone.title).toContain('Reply sent');
    // An older server sends no origin: the line reads exactly as before.
    expect(mailRouteView(route({ taskId: 'task-1', target })).lead).toBe('Routed to');
  });
  it('adds no route label to outgoing mail or drafts', () => {
    expect(showsRouteLine({ flags: [] }, { outbound: true })).toBe(false);
    expect(showsRouteLine({ flags: ['\\Draft'] })).toBe(false);
    expect(showsRouteLine({ flags: [] }, { role: 'sent' })).toBe(false);
    expect(showsRouteLine({ flags: [] }, { role: 'inbox' })).toBe(true);
  });
  it('outgoing mail outside its own list still says it was not routed and why', () => {
    // A sent or drafts list says it by being that list.
    expect(outgoingKind({ flags: [] }, { outbound: true, role: 'sent' })).toBeNull();
    expect(outgoingKind({ flags: [] }, { role: 'inbox' })).toBeNull();
    // A search hit, a merged list, the reader: sent copies and drafts get the line.
    expect(outgoingKind({ flags: [] }, { role: 'sent' })).toBe('sent');
    expect(outgoingKind({ flags: [] }, { role: 'drafts' })).toBe('draft');
    expect(outgoingKind({ flags: ['\\Draft'] })).toBe('draft');
    expect(outgoingRouteView('sent')).toMatchObject({ status: 'none', lead: 'Not routed', link: null });
    expect(outgoingRouteView('sent').text).toBe('Not routed · You sent this. Routers read only mail you receive');
    expect(outgoingRouteView('draft').text).toContain('A draft');
  });
});

// The line on a row and in the reader head, rendered for real.
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from '../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';

const { MemoryRouter } = await import('../../web/node_modules/react-router-dom');
const { MailRouteLine } = await import('../../web/src/apps/mail/MailRouteLine');
const ROOT = path.resolve(import.meta.dirname, '../..');
const code = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const inRouter = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(MemoryRouter, null, el));

describe('a message its area router has not decided yet', () => {
  it('reads as queued for that area, never as routed', () => {
    const view = mailRouteView(undefined, false, { name: 'Personal' });
    expect(view).toMatchObject({ status: 'queued', lead: 'Queued for', name: 'Personal', link: null, text: 'Queued for Personal · Routing pending' });
    expect(mailRouteView(undefined, false, { name: ' ' }).text).toBe('Queued for its area · Routing pending');
    expect(view.text).not.toMatch(/Routed to|delivered|No router has seen this|not confirmed/i);
  });

  it('one rule for every state: unreadable, then a receipt, then the area, then no record', () => {
    const area = { name: 'Work' };
    expect(mailRouteView(undefined, true, area).status).toBe('unknown');
    expect(mailRouteView(route({ status: 'not_routed', reason: 'Newsletter' }), false, area).lead).toBe('Not routed');
    expect(mailRouteView(undefined, false, area).status).toBe('queued');
    expect(mailRouteView(undefined, false, null).status).toBe('none');
  });

  it('reads the same on a row and in the reader head, with no area form anywhere', () => {
    const area = { id: 'work', name: 'Work' };
    const lineOf = (html: string) => html.match(/data-route-status="([^"]+)"[\s\S]*?class="mail-route-lead">([^<]*)/)!.slice(1);
    const rowHtml = inRouter(createElement(MailRouteLine, { route: undefined, surface: 'row', routingArea: area }));
    const readerHtml = inRouter(createElement(MailRouteLine, { route: undefined, surface: 'reader', routingArea: area }));
    expect(lineOf(rowHtml)).toEqual(['queued', 'Queued for']);
    expect(lineOf(readerHtml)).toEqual(['queued', 'Queued for']);
    for (const html of [rowHtml, readerHtml]) expect(html).not.toMatch(/No router has seen this|mail-router-choose|mail-router-form|mail-router-confirmed/);
  });

  it('whose router is paused says so instead of pending', () => {
    expect(mailRouteView(undefined, false, { name: 'Work', paused: true }).text).toBe('Queued for Work · Its router is paused');
    expect(mailRouteView(undefined, false, { name: 'Work', paused: false }).text).toBe('Queued for Work · Routing pending');
    // An area outranks the coverage reason.
    expect(mailRouteView(undefined, false, { name: 'Work' }, 'no_router').status).toBe('queued');
  });
});

describe('the route line on every surface', () => {
  it('every row says where its message went or why not: a row with no record names the reason the reader names', () => {
    for (const routingCoverage of ['no_router', 'unassigned'] as const) {
      const row = inRouter(createElement(MailRouteLine, { route: undefined, surface: 'row', routingCoverage }));
      const reader = inRouter(createElement(MailRouteLine, { route: undefined, surface: 'reader', routingCoverage }));
      for (const html of [row, reader]) {
        expect(html).toContain('data-route-status="none"');
        expect(html).toContain('Not routed');
        expect(html).toContain(COVERAGE_REASON[routingCoverage]);
        expect(html).not.toContain('route-action');
      }
    }
    // An older server names no reason: the line still shows, and says only that no router saw it.
    expect(inRouter(createElement(MailRouteLine, { route: undefined, surface: 'row' }))).toContain('No router has seen this');
    expect(inRouter(createElement(MailRouteLine, { route: undefined, unavailable: true, surface: 'row' }))).toContain('Routing record unavailable');
    expect(mailRouteView(undefined, false, null, 'bogus' as never).text).toBe('No router has seen this');
  });

  it('every incoming mail row renderer draws the shared routing receipt', () => {
    const files = fs.readdirSync(path.join(ROOT, 'web/src/apps/mail')).filter((name) => name.endsWith('.tsx'));
    const renderers = files.map((name) => ({ name, source: code(`web/src/apps/mail/${name}`) }))
      .filter(({ source }) => source.includes('data-testid="mail-row"'));
    expect(renderers.length).toBeGreaterThanOrEqual(2);
    for (const { name, source } of renderers) {
      expect(source, name).toContain('<MailRouteLine');
      expect(source, name).toContain('showsRouteLine(message');
      expect(source, name).toContain('route={message.route}');
      // ...and the person's own mail in it says why it was not routed (round 3: a search hit had no line).
      expect(source, name).toContain('outgoingKind(message');
      expect(source, name).toContain('outgoing={outgoing}');
    }
  });

  it('every surface that draws the line hands it the message\'s area and coverage', () => {
    const files = fs.readdirSync(path.join(ROOT, 'web/src/apps/mail')).filter((name) => name.endsWith('.tsx') && name !== 'MailRouteLine.tsx');
    const users = files.filter((name) => code(`web/src/apps/mail/${name}`).includes('<MailRouteLine'));
    expect(users.length).toBeGreaterThanOrEqual(3);
    for (const name of users) {
      // A line for the person's own outgoing mail has no route to describe, so it takes none of them.
      const calls = (code(`web/src/apps/mail/${name}`).match(/<MailRouteLine[^>]*\/>/g) ?? []).filter((call) => !call.includes('outgoing={'));
      expect(calls.length, name).toBeGreaterThan(0);
      for (const call of calls) expect(call, name).toContain('routingArea={message.routingArea}');
      for (const call of calls) expect(call, name).toContain('routingCoverage={message.routingCoverage}');
    }
  });

  it('every state that is stuck offers its one next step in the reader, and the rest offer none', () => {
    const area = { id: 'personal', name: 'Personal' };
    // Each receipt status: the ones with no settled delivery open the router; routed and not routed are settled.
    for (const status of ['routing', 'routed', 'not_routed', 'failed', 'unknown'] as const) {
      const r = route({ status, target: { id: 't1', title: 'T', kind: 'task', available: true } });
      const view = mailRouteView(r);
      const want = ['routing', 'failed', 'unknown'].includes(view.status) ? { kind: 'router', areaId: 'personal', label: 'Open router' } : null;
      expect(mailRouteAction(view, r, undefined), status).toEqual(want);
    }
    // A queued message: only a paused router needs a step (resume it); a reading one is just pending.
    expect(mailRouteAction(mailRouteView(undefined, false, { ...area, paused: true }), undefined, { ...area, paused: true }))
      .toEqual({ kind: 'router', areaId: 'personal', label: 'Open router' });
    expect(mailRouteAction(mailRouteView(undefined, false, area), undefined, area)).toBeNull();
    for (const coverage of [undefined, 'no_router', 'unassigned'] as const) {
      expect(mailRouteAction(mailRouteView(undefined, false, undefined, coverage), undefined, undefined)).toBeNull();
    }
    // No area id to open: nothing rather than a dead button.
    expect(mailRouteAction(mailRouteView(route({ status: 'failed' })), { areaId: '' }, undefined)).toBeNull();
  });

  it('finds the area\'s router to open, its reading one first', () => {
    const body = { routers: [{ areaId: 'work', taskId: 'w1', paused: false }, { areaId: 'personal', taskId: 'p-old', paused: true }, { areaId: 'personal', taskId: 'p1', paused: false }] };
    expect(routerPathOf(body, 'personal')).toBe(`/org?node=${encodeURIComponent('router:p1')}`);
    expect(routerPathOf({ routers: [{ areaId: 'personal', taskId: 'p-old', paused: true }] }, 'personal')).toBe(`/org?node=${encodeURIComponent('router:p-old')}`);
    expect(routerPathOf(body, 'none')).toBe('/org');
    expect(routerPathOf(null, 'personal')).toBe('/org');
  });

  it('the reader draws the step beside the line, the row never, so both lines keep the same words', () => {
    const paused = { id: 'personal', name: 'Personal', paused: true };
    const reader = inRouter(createElement(MailRouteLine, { route: undefined, surface: 'reader', routingArea: paused }));
    const row = inRouter(createElement(MailRouteLine, { route: undefined, surface: 'row', routingArea: paused }));
    expect(reader).toContain('data-testid="mail-reader-route-action"');
    expect(row).not.toContain('route-action');
    // The step comes after the line's own element closes.
    expect(reader.indexOf('Open router')).toBeGreaterThan(reader.indexOf('</p>'));
    const failed = inRouter(createElement(MailRouteLine, { route: route({ status: 'failed', error: 'Timeout' }), surface: 'reader' }));
    expect(failed).toContain('data-action="router"');
    expect(failed).toContain('Open router');
  });

  it('no surface asks the person to choose an area or approve a hand-off', () => {
    for (const rel of ['web/src/apps/mail/MailRouteLine.tsx', 'web/src/apps/mail/MailMessageRow.tsx', 'web/src/apps/mail/MailGroupLine.tsx', 'web/src/apps/mail/MailReaderHead.tsx']) {
      expect(code(rel), rel).not.toMatch(/routingHandoff|handoff=|MailRouterAssignment|\/api\/v1\/router\/assign|openApproval/);
    }
  });
});
