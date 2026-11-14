import { readRouterAreas } from '../../core/router/areas.js';
import { handoffAsksForSources } from '../../core/router/handoff-approval.js';
import { routerStore } from '../../core/router/runtime.js';
import { routeViews } from '../../core/router/service.js';
import { routerKey } from '../../core/router/store.js';
import type { MailMessageDto } from './contract.js';

const sourceKey = (account: string, message: string, version?: string) => JSON.stringify([account, message, version ?? '']);
const messageSource = (message: MailMessageDto) => ({ kind: 'mail' as const, account: message.accountId, message: message.messageId, version: message.deliveryVersion });
const receiptKey = (areaId: string, message: MailMessageDto) => JSON.stringify([areaId, routerKey(messageSource(message))]);

export async function decorateMailRoutes(messages: MailMessageDto[], home: string): Promise<MailMessageDto[]> {
  const file = await readRouterAreas(home).catch(() => undefined);
  if (!file) return messages.map((message) => ({ ...message, routingUnavailable: true }));
  const byId = new Map(file.areas.map((area) => [area.id, area]));
  // Confirmed items and a bound mailbox's open arrivals alike: both are the area router's.
  const assignments = new Map([...file.items, ...(file.openItems ?? [])].filter((item) => item.source.kind === 'mail')
    .map((item) => [sourceKey(item.source.account, item.source.message, item.source.version), byId.get(item.areaId)]));
  const areaOf = (message: MailMessageDto) => assignments.get(sourceKey(message.accountId, message.messageId, message.deliveryVersion));
  // An area counts only with a router of its own; the account is what the area lists as a source.
  const withRouter = new Set(file.routers.filter((router) => byId.get(router.areaId)?.taskIds.includes(router.taskId)).map((router) => router.areaId));
  const coveredAccounts = new Set(file.areas.filter((area) => withRouter.has(area.id))
    .flatMap((area) => area.sources.filter((source) => source.kind === 'mail').map((source) => source.account)));
  const paused = (areaId: string) => !file.routers.some((router) => router.areaId === areaId && !router.paused && byId.get(areaId)?.taskIds.includes(router.taskId));
  const groups = new Map<string, MailMessageDto[]>();
  for (const message of messages) {
    const area = areaOf(message);
    if (!area) continue;
    const group = groups.get(area.id) ?? [];
    group.push(message);
    groups.set(area.id, group);
  }
  const routes = new Map<string, NonNullable<MailMessageDto['route']>>();
  const unavailable = new Set<string>();
  const handoffs = new Map<string, NonNullable<MailMessageDto['routingHandoff']>>();
  const handoffUnavailable = new Set<string>();
  await Promise.all([...groups].map(async ([areaId, group]) => {
    try {
      const ledger = await routerStore(areaId, home).getSources(group.map(messageSource));
      const views = new Map((await routeViews([...new Map([...ledger.values()].map((route) => [route.key, route])).values()]))
        .map((view) => [view.key, view]));
      for (const [source, route] of ledger) {
        const view = views.get(route.key)!;
        routes.set(JSON.stringify([areaId, source]), {
          areaId, status: view.status, taskId: view.taskId, target: view.target, reason: view.reason,
          at: view.at, ruleId: view.ruleId, error: view.error,
          ...(view.origin === 'legacy' ? { origin: 'legacy' as const, evidence: view.evidence } : {}),
        });
      }
      // An ask shows only where no receipt exists (the ledger wins), and a pause hides no past ask.
      const routerTaskIds = file.routers.filter((router) => router.areaId === areaId && byId.get(areaId)?.taskIds.includes(router.taskId))
        .map((router) => router.taskId);
      const open = group.map(messageSource).filter((source) => !ledger.has(routerKey(source)));
      if (routerTaskIds.length === 0 || open.length === 0) return;
      try {
        for (const [key, ask] of await handoffAsksForSources(areaId, routerTaskIds, open, { home })) handoffs.set(JSON.stringify([areaId, key]), ask);
      } catch { handoffUnavailable.add(areaId); }
    } catch { unavailable.add(areaId); }
  }));
  return messages.map((message) => {
    const area = areaOf(message);
    const route = area ? routes.get(receiptKey(area.id, message)) : undefined;
    const routingHandoff = area && !route ? handoffs.get(receiptKey(area.id, message)) : undefined;
    const blind = !!area && (unavailable.has(area.id) || (!route && handoffUnavailable.has(area.id)));
    const coverage = area ? {} : { routingCoverage: coveredAccounts.has(message.accountId) ? 'unassigned' as const : 'no_router' as const };
    return { ...message, ...(route ? { route } : {}), ...(area ? { routingArea: { id: area.id, name: area.name, paused: paused(area.id) } } : {}), ...coverage,
      ...(routingHandoff ? { routingHandoff } : {}), ...(blind ? { routingUnavailable: true } : {}) };
  });
}
