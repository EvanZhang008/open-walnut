import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Task } from '@open-walnut/core';
import { mailRouterRows, routerTone } from '../../web/src/apps/mail/mail-router-rows';

// The user (2026-11-08): the router, the central task, must be visible in Mail, and as a router
// at the Org level. Mail lists every open router with its live state; the Org chart draws each
// router beside the VPs.
const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const router = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: `Router ${id}`, org_role: 'router', phase: 'IN_PROGRESS', router_paused: true, ...extra,
} as Task);

describe('Mail lists the routers with their live state', () => {
  it('reads Paused first, then what its task is doing', () => {
    expect(routerTone({ router_paused: true })).toBe('paused');
    expect(routerTone({})).toBe('paused');
    expect(routerTone({ router_paused: false, user_status: { state: 'working' } as Task['user_status'] })).toBe('working');
    expect(routerTone({ router_paused: false, user_status: { state: 'needs' } as Task['user_status'] })).toBe('needs');
    expect(routerTone({ router_paused: false, user_status: { state: 'waiting' } as Task['user_status'] })).toBe('ready');
  });

  it('one row per open router, Personal then Work, each opening its own Org node', () => {
    const rows = mailRouterRows([
      router('w', { org_name: 'Work desk', router_area_id: 'work', router_paused: false }),
      router('p', { org_name: 'Home desk', router_area_id: 'personal' }),
      router('done', { router_area_id: 'personal', phase: 'COMPLETE' }),
      { id: 'vp', title: 'Atlas lead', org_role: 'lead', phase: 'IN_PROGRESS' } as Task,
    ], { personal: 'Personal' });
    expect(rows.map((r) => r.taskId)).toEqual(['p', 'w']);
    expect(rows[0]).toMatchObject({ name: 'Home desk', area: 'Personal', tone: 'paused', state: 'Paused', path: '/org?node=router%3Ap' });
    // An area the list has not named yet reads as words, never its raw id.
    expect(rows[1]).toMatchObject({ area: 'Work', tone: 'ready', state: 'Ready' });
  });

  it('the Mail sidebar draws the group, and offers setup when there is no router', () => {
    const pane = read('web/src/apps/mail/MailAccountsPane.tsx');
    expect(pane).toContain('<MailRouterRows onPicked={onPicked} />');
    const rows = read('web/src/apps/mail/MailRouterRows.tsx');
    expect(rows).toContain('useTasksContextSafe()');
    expect(rows).toContain('data-testid="mail-router-setup"');
    expect(rows).toContain('onClick={() => go(r.path)}');
  });
});

describe('the Org chart draws each router beside the VPs', () => {
  it('passes the routers to the chart and draws them in the VPs row, not as VPs', () => {
    expect(read('web/src/pages/OrgPage.tsx')).toContain('routers={channels.routers}');
    const sheet = read('web/src/components/org/OrgChartSheet.tsx');
    expect(sheet).toContain('data-testid="org-chart-router"');
    expect(sheet).toContain('<span className="oc-role">Router</span>');
    // In the same row as the VP cards, before them, and never a drop zone or a drag handle.
    const routerAt = sheet.indexOf('routers.map((r)');
    expect(routerAt).toBeGreaterThan(sheet.indexOf('<ul className="oc-vps"'));
    expect(routerAt).toBeLessThan(sheet.indexOf('cards.map((c)'));
    const card = sheet.slice(routerAt, sheet.indexOf('cards.map((c)'));
    expect(card).not.toMatch(/dropZone|draggable|onDragStart/);
    // A chart with routers and no VP yet is not "no open work".
    expect(sheet).toContain('cards.length === 0 && routers.length === 0 && (');
  });
});
