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

// The reader's inline Choose area (MailRouterAssignment): one message only, never shown as routed.
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from '../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';

const { MemoryRouter } = await import('../../web/node_modules/react-router-dom');
const assignMod = await import('../../web/src/apps/mail/MailRouterAssignment');
const { MailRouterAssignment, CONFIRMED_NOTE, areasOf, sourceKeyOf, ONLY_THIS_MESSAGE, ORG_ROUTER_SETUP_PATH } = assignMod;
const { MailRouteLine } = await import('../../web/src/apps/mail/MailRouteLine');
const ROOT = path.resolve(import.meta.dirname, '../..');
const code = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const inRouter = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(MemoryRouter, null, el));
const source = { account: 'acct-1', message: 'msg-1' };

describe('choosing a router area for one message', () => {
  it('a confirmed area reads as pending, for this message only, never as routed', () => {
    const view = mailRouteView(undefined, false, undefined, { name: 'Personal' });
    expect(view).toMatchObject({ status: 'confirmed', lead: 'Confirmed for', name: 'Personal', link: null, text: 'Confirmed for Personal \u00b7 Routing pending' });
    expect(mailRouteView(undefined, false, undefined, { name: ' ' }).text).toBe('Confirmed for its area \u00b7 Routing pending');
    expect(CONFIRMED_NOTE).toMatch(/This message only/);
    for (const words of [view.text, CONFIRMED_NOTE]) expect(words).not.toMatch(/Routed to|delivered|whole account|No router has seen this|not confirmed/i);
  });

  it('one rule for every state: unreadable, then a receipt, then an ask, then the confirmed area, then no record', () => {
    const area = { name: 'Work' };
    const ask = { approvalId: 'apr-1', status: 'pending', at: 5, targetTitle: 'Desk' } as never;
    expect(mailRouteView(undefined, true, ask, area).status).toBe('unknown');
    expect(mailRouteView(route({ status: 'not_routed', reason: 'Newsletter' }), false, ask, area).lead).toBe('Not routed');
    expect(mailRouteView(route({ status: 'not_routed', reason: 'Newsletter' }), false, undefined, area).lead).toBe('Not routed');
    expect(mailRouteView(undefined, false, ask, area).status).toBe('handoff');
    expect(mailRouteView(undefined, false, undefined, area).status).toBe('confirmed');
    expect(mailRouteView(undefined, false, undefined, null).status).toBe('none');
  });

  it('a confirmed message reads the same on a row and in the reader head', () => {
    const area = { id: 'work', name: 'Work' };
    const lineOf = (html: string) => html.match(/data-route-status="([^"]+)"[\s\S]*?class="mail-route-lead">([^<]*)/)!.slice(1);
    const rowHtml = inRouter(createElement(MailRouteLine, { route: undefined, surface: 'row', routingArea: area }));
    const readerHtml = inRouter(createElement(MailRouteLine, { route: undefined, surface: 'reader', source, routingArea: area }));
    expect(lineOf(rowHtml)).toEqual(['confirmed', 'Confirmed for']);
    expect(lineOf(readerHtml)).toEqual(['confirmed', 'Confirmed for']);
    for (const html of [rowHtml, readerHtml]) expect(html).not.toContain('No router has seen this');
    expect(readerHtml).toContain(CONFIRMED_NOTE);
  });

  it('reads only areas with an id, naming one without a name by its id', () => {
    expect(areasOf({ areas: [{ id: 'personal', name: 'Personal', host: 'x' }, { id: 'work' }, { name: 'no id' }, null] }))
      .toEqual([{ id: 'personal', name: 'Personal', paused: true }, { id: 'work', name: 'work', paused: true }]);
    // An area reads as running only with a router whose paused is exactly false.
    expect(areasOf({ areas: [{ id: 'personal', name: 'Personal' }, { id: 'work', name: 'Work' }], routers: [{ areaId: 'personal', paused: false }, { areaId: 'work', paused: 'no' }] }))
      .toEqual([{ id: 'personal', name: 'Personal', paused: false }, { id: 'work', name: 'Work', paused: true }]);
    expect(areasOf({})).toEqual([]);
    expect(areasOf(null)).toEqual([]);
    expect(sourceKeyOf(source)).toBe('acct-1\nmsg-1\n');
    // A reused id with a new delivery is another message to the form: no late confirmation carries over.
    expect(sourceKeyOf({ ...source, version: 'v-2' })).toBe('acct-1\nmsg-1\nv-2');
    expect(sourceKeyOf({ ...source, version: 'v-2' })).not.toBe(sourceKeyOf({ ...source, version: 'v-1' }));
  });

  it('says it confirms one message and not the account', () => {
    expect(ONLY_THIS_MESSAGE).toMatch(/this message only/);
    expect(ONLY_THIS_MESSAGE).toMatch(/no access to the rest of the account/);
  });

  it('the reader with no record offers Choose area under the "No router has seen this" line', () => {
    const html = inRouter(createElement(MailRouteLine, { route: undefined, surface: 'reader', source }));
    expect(html).toContain('No router has seen this');
    expect(html).toContain('data-testid="mail-router-choose"');
    expect(html).not.toContain('data-testid="mail-router-form"');
  });

  it('a message the server says is confirmed shows that, with no Choose area to change it', () => {
    const html = inRouter(createElement(MailRouteLine, { route: undefined, surface: 'reader', source, routingArea: { id: 'personal', name: 'Personal' } }));
    expect(html).toContain('data-testid="mail-router-confirmed"');
    expect(html).toContain('Confirmed for Personal');
    expect(html).not.toContain('mail-router-choose');
    expect(html).not.toContain('Routed to');
  });

  it('an unavailable receipt never offers a new assignment', () => {
    const html = inRouter(createElement(MailRouteLine, { route: undefined, unavailable: true, surface: 'reader', source }));
    expect(html).toContain('Routing record unavailable');
    expect(html).not.toContain('mail-router-choose');
  });

  it('every row says where its message went or why not: a row with no record names the reason the reader names', () => {
    for (const routingCoverage of ['no_router', 'unassigned'] as const) {
      const row = inRouter(createElement(MailRouteLine, { route: undefined, surface: 'row', routingCoverage }));
      const reader = inRouter(createElement(MailRouteLine, { route: undefined, surface: 'reader', source, routingCoverage }));
      for (const html of [row, reader]) {
        expect(html).toContain('data-route-status="none"');
        expect(html).toContain('Not routed');
        expect(html).toContain(COVERAGE_REASON[routingCoverage]);
      }
      expect(row).not.toContain('mail-router-choose');
      expect(reader).toContain('data-testid="mail-router-choose"');
    }
    // An older server names no reason: the line still shows, and says only that no router saw it.
    expect(inRouter(createElement(MailRouteLine, { route: undefined, surface: 'row' }))).toContain('No router has seen this');
    expect(inRouter(createElement(MailRouteLine, { route: undefined, unavailable: true, surface: 'row' }))).toContain('Routing record unavailable');
    expect(mailRouteView(undefined, false, undefined, null, 'bogus' as never).text).toBe('No router has seen this');
  });

  it('a confirmed message whose router is paused says so instead of pending', () => {
    expect(mailRouteView(undefined, false, undefined, { name: 'Work', paused: true }).text).toBe('Confirmed for Work \u00b7 Its router is paused');
    expect(mailRouteView(undefined, false, undefined, { name: 'Work', paused: false }).text).toBe('Confirmed for Work \u00b7 Routing pending');
    // A confirmed area outranks the coverage reason.
    expect(mailRouteView(undefined, false, undefined, { name: 'Work' }, 'no_router').status).toBe('confirmed');
  });

  it('a row and a routed message get no area form', () => {
    expect(inRouter(createElement(MailRouteLine, { route: undefined, surface: 'row', source }))).not.toContain('mail-router');
    const routed = inRouter(createElement(MailRouteLine, { route: route({ target: { id: 't1', title: 'Owner', kind: 'task', available: true } }), surface: 'reader', source }));
    expect(routed).not.toContain('mail-router');
    // A receipt with no target reads as unknown: it offers its router, never the area form.
    const unknown = inRouter(createElement(MailRouteLine, { route: route({}), surface: 'reader', source }));
    expect(unknown).toContain('data-testid="mail-reader-route-action"');
    expect(unknown).not.toMatch(/mail-router-choose|mail-router-form/);
    expect(inRouter(createElement(MailRouterAssignment, { source }))).toContain('Choose area');
  });
});

describe('Choose area source guards', () => {
  const assign = code('web/src/apps/mail/MailRouterAssignment.tsx');
  const line = code('web/src/apps/mail/MailRouteLine.tsx');
  const head = code('web/src/apps/mail/MailReaderHead.tsx');
  const row = code('web/src/apps/mail/MailMessageRow.tsx');

  it('posts this one mail message and its area, and reads areas only when the form opens', () => {
    expect(assign).toContain("apiPost<{ areaId?: string; assigned?: boolean }>('/api/v1/router/assign', body)");
    expect(assign).toContain("source: { kind: 'mail', account: source.account, message: source.message, ...(source.version ? { version: source.version } : {}) }, area_id: area.id");
    expect(assign).toContain("apiGet<unknown>('/api/v1/router/areas')");
    expect(assign).toContain('const openForm = () => { setAsking(key); setFailure(null); loadAreas(); };');
    expect(assign).not.toMatch(/useEffect\(\(\) => \{[^}]*loadAreas/);
    expect(assign).toContain("res?.assigned === true ?");
    // The store learns the area as soon as the server confirms it, so the row updates with the reader.
    expect(assign).toContain('if (confirmedArea) onMailAreaConfirmed(source, confirmedArea);');
  });

  it('is an inline radio fieldset: no native select, no menu, no portal', () => {
    expect(assign).not.toMatch(/<select|createPortal|ContextMenu|useMenuPlacement/);
    expect(assign).toContain('<fieldset');
    expect(assign).toContain('type="radio"');
  });

  it('keeps no pick or confirmation of its own on disk: the server\'s routingArea is the record', () => {
    expect(assign).not.toMatch(/localStorage|sessionStorage|writeDraft|usePageView/);
    expect(line).toContain('confirmed: routingArea');
  });

  it('a late answer after another message opened changes nothing on screen', () => {
    expect(assign).toContain('const live = (forKey: string) => mounted.current && currentKey.current === forKey;');
    expect(assign).toContain('if (!live(forKey)) return;');
    expect(assign).toMatch(/mine === areasSeq\.current && live\(forKey\)/);
    // Unmounted (the reader closed, another message opened): no late setState of any kind.
    expect(assign).toContain('return () => { mounted.current = false; areasSeq.current++; };');
    expect(assign).toContain('if (live(forKey)) setFailure(');
    expect(assign).toContain('if (live(forKey)) setSending(null);');
    expect(assign).toContain('const pick = choice?.key === key ? choice.areaId : \'\';');
    expect(line).toContain('<MailRouterAssignment key={sourceKeyOf(source)}');
  });

  it('a failed confirm keeps the pick and offers Try again; zero areas link to the Org router setup', () => {
    expect(assign).toMatch(/error \? 'Try again' : 'Confirm for this message'/);
    expect(assign).toContain('onClick={() => navigate(ORG_ROUTER_SETUP_PATH)}');
    expect(ORG_ROUTER_SETUP_PATH).toBe('/org?router_setup=1');
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

  it('only the reader passes the message as the source; a row never does', () => {
    expect(line).toContain("surface === 'reader' && !unavailable && !outgoing && !route && source");
    expect(head).toContain('source={{ account: message.accountId, message: message.messageId, ...(message.deliveryVersion ? { version: message.deliveryVersion } : {}) }} routingArea={message.routingArea}');
    expect(row).not.toMatch(/<MailRouteLine[^>]*source=/);
  });
});

describe('a handoff waiting on the person', () => {
  const ask = (status: string, extra: Record<string, unknown> = {}) => ({ approvalId: 'apr-1', status, at: 5, targetTitle: 'Accounts payable', ...extra }) as never;

  it('words every state without claiming a route, and never links the target', () => {
    const leads: Record<string, string> = {
      pending: 'Waiting for approval', approved: 'Handoff approved, delivery pending', denied: 'Handoff not approved',
      expired: 'Handoff approval expired', canceled: 'Handoff approval withdrawn', missing: 'Handoff state unknown', claim_incomplete: 'Handoff state unknown',
    };
    for (const [status, lead] of Object.entries(leads)) {
      const view = mailRouteView(undefined, false, ask(status));
      expect(view).toMatchObject({ status: 'handoff', lead, link: null });
      expect(view.text).toContain('Accounts payable');
      expect(view.text).not.toMatch(/Routed|Not routed|No router has seen this/);
    }
    expect(mailRouteView(undefined, false, ask('pending', { targetTitle: undefined })).text).toBe('Waiting for approval \u00b7 Not delivered until you approve it');
    expect(mailRouteView(undefined, false, ask('approved', { targetTitle: undefined })).text).toBe('Handoff approved, delivery pending \u00b7 Not delivered yet');
    for (const status of ['surprise', '__proto__', 'constructor', 'toString']) {
      expect(mailRouteView(undefined, false, ask(status)).lead).toBe('Handoff state unknown');
    }
  });

  it('a receipt wins over an ask, and an unreadable record wins over both', () => {
    expect(mailRouteView(route({ status: 'not_routed', reason: 'Newsletter' }), false, ask('pending')).lead).toBe('Not routed');
    expect(mailRouteView(undefined, true, ask('pending')).text).toContain('Routing record unavailable');
  });

  it('the reader shows the ask instead of the confirmed-area line, with no link or Choose area', () => {
    const html = inRouter(createElement(MailRouteLine, { route: undefined, surface: 'reader', source, routingArea: { id: 'personal', name: 'Personal' }, handoff: ask('pending') }));
    expect(html).toContain('Waiting for approval');
    expect(html).toContain('data-route-status="handoff"');
    expect(html).not.toMatch(/mail-router-confirmed|mail-router-choose|route-link|routing pending/);
  });

  it('every surface that draws the line hands it the message\'s confirmed area and coverage', () => {
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
    // Each handoff state: a waiting one opens its approval, every other one the area's router.
    for (const status of ['pending', 'approved', 'denied', 'expired', 'canceled', 'missing', 'claim_incomplete']) {
      const view = mailRouteView(undefined, false, ask(status), area);
      expect(mailRouteAction(view, undefined, ask(status), area), status)
        .toEqual(status === 'pending' ? { kind: 'approval', approvalId: 'apr-1', label: 'Review approval' } : { kind: 'router', areaId: 'personal', label: 'Open router' });
    }
    // Each receipt status: the ones with no settled delivery open the router; routed and not routed are settled.
    for (const status of ['routing', 'routed', 'not_routed', 'failed', 'unknown'] as const) {
      const r = route({ status, target: { id: 't1', title: 'T', kind: 'task', available: true } });
      const view = mailRouteView(r);
      const want = ['routing', 'failed', 'unknown'].includes(view.status) ? { kind: 'router', areaId: 'personal', label: 'Open router' } : null;
      expect(mailRouteAction(view, r, undefined, undefined), status).toEqual(want);
    }
    // A confirmed area: only a paused router needs a step (resume it); a reading one is just pending.
    expect(mailRouteAction(mailRouteView(undefined, false, undefined, { ...area, paused: true }), undefined, undefined, { ...area, paused: true }))
      .toEqual({ kind: 'router', areaId: 'personal', label: 'Open router' });
    expect(mailRouteAction(mailRouteView(undefined, false, undefined, area), undefined, undefined, area)).toBeNull();
    // No record: the reader's Choose area is the step, so no second one.
    for (const coverage of [undefined, 'no_router', 'unassigned'] as const) {
      expect(mailRouteAction(mailRouteView(undefined, false, undefined, undefined, coverage), undefined, undefined, undefined)).toBeNull();
    }
    // No area id to open: nothing rather than a dead button.
    expect(mailRouteAction(mailRouteView(undefined, false, ask('denied')), undefined, ask('denied'), undefined)).toBeNull();
  });

  it('finds the area\'s router to open, its reading one first', () => {
    const body = { routers: [{ areaId: 'work', taskId: 'w1', paused: false }, { areaId: 'personal', taskId: 'p-old', paused: true }, { areaId: 'personal', taskId: 'p1', paused: false }] };
    expect(routerPathOf(body, 'personal')).toBe(`/org?node=${encodeURIComponent('router:p1')}`);
    expect(routerPathOf({ routers: [{ areaId: 'personal', taskId: 'p-old', paused: true }] }, 'personal')).toBe(`/org?node=${encodeURIComponent('router:p-old')}`);
    expect(routerPathOf(body, 'none')).toBe('/org');
    expect(routerPathOf(null, 'personal')).toBe('/org');
  });

  it('the reader draws the step beside the line, the row never, so both lines keep the same words', () => {
    const reader = inRouter(createElement(MailRouteLine, { route: undefined, surface: 'reader', source, routingArea: { id: 'personal', name: 'Personal' }, handoff: ask('pending') }));
    const row = inRouter(createElement(MailRouteLine, { route: undefined, surface: 'row', routingArea: { id: 'personal', name: 'Personal' }, handoff: ask('pending') }));
    expect(reader).toContain('data-testid="mail-reader-route-action"');
    expect(reader).toContain('Review approval');
    expect(row).not.toContain('route-action');
    // The step comes after the line's own element closes.
    expect(reader.indexOf('Review approval')).toBeGreaterThan(reader.indexOf('</p>'));
    const failed = inRouter(createElement(MailRouteLine, { route: route({ status: 'failed', error: 'Timeout' }), surface: 'reader', source }));
    expect(failed).toContain('data-action="router"');
    expect(failed).toContain('Open router');
  });

  it('every surface hands the message\'s ask to the line', () => {
    for (const rel of ['web/src/apps/mail/MailMessageRow.tsx', 'web/src/apps/mail/MailGroupLine.tsx', 'web/src/apps/mail/MailReaderHead.tsx']) {
      expect(code(rel), rel).toContain('handoff={message.routingHandoff}');
    }
  });
});
