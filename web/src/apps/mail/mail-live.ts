/**
 * The mail console's wiring to things that outlive it: the socket, the plugin runtime, the badge.
 *
 * Split from the store and the actions because those two are deliberately React-free and WS-free
 * (the node test tier drives them). This file is the only mail module that touches `wsClient` or
 * the plugin runtime snapshot.
 *
 * Everything here is SESSION-scoped rather than mount-scoped, which is the point. The sidebar
 * badge has to move when mail lands in a tab that has never opened Mail, so the `plugin:mail:`
 * subscription is installed once at app boot and never taken down: it costs one `startsWith` per
 * inbound frame, and the alternative (subscribe on mount) means the badge is a number frozen at
 * whenever the console last happened to be open.
 *
 * Events are taken by PREFIX rather than by five named subscriptions, because the plugin owns its
 * event names and a name it adds later must reach the console without a matching change here.
 */
import { wsClient } from '@/api/ws';
import { getWebPluginRuntimeSnapshot, subscribeWebPluginRuntime } from '@/plugins/runtime-store';
import { loadMailBadgeSource, onMailEvent } from './mail-actions';
import { setMailBadgeHandle, type MailBadgeHandle } from './mail-store';

const PREFIX = 'plugin:mail:';

let subscribed = false;
let badgeSourceStarted = false;
let stopRuntimeWatch: (() => void) | null = null;

/**
 * Whether the plugin's routes are answering.
 *
 * Asking before the runtime is `ready` would read as "no mail plugin" (the snapshot is empty until
 * its first fetch lands), so an unready runtime means "not yet", never "no".
 */
function mailPluginActive(): boolean {
  const runtime = getWebPluginRuntimeSnapshot();
  return runtime.ready
    && runtime.plugins.some((plugin) => plugin.id === 'mail' && plugin.state === 'active');
}

function startBadgeSource(): void {
  if (badgeSourceStarted) return;
  badgeSourceStarted = true;
  void loadMailBadgeSource();
}

/**
 * Install the session-scoped wiring. Idempotent, so both callers can just ask.
 *
 * The first badge read waits for the plugin to be active: hitting `/api/plugins/mail/accounts`
 * while the plugin is off answers 404 for every tab on every boot, which is noise that says
 * nothing. When mail is not active yet the runtime store is watched until it is (it may be
 * installed or switched on later in the same session), and the watch drops itself afterwards.
 */
export function ensureMailLive(): void {
  if (!subscribed) {
    subscribed = true;
    // The unsubscribe is deliberately dropped: this lives as long as the page does.
    wsClient.subscribeAll((name, data) => {
      if (!name.startsWith(PREFIX)) return;
      onMailEvent(name.slice(PREFIX.length), data);
    });
  }
  if (badgeSourceStarted) return;
  if (mailPluginActive()) { startBadgeSource(); return; }
  if (stopRuntimeWatch) return;
  stopRuntimeWatch = subscribeWebPluginRuntime(() => {
    if (!mailPluginActive()) return;
    stopRuntimeWatch?.();
    stopRuntimeWatch = null;
    startBadgeSource();
  });
}

/** Called once at app boot by `core-apps.tsx`, which owns the registry handle. */
export function attachMailBadge(handle: MailBadgeHandle): void {
  setMailBadgeHandle(handle);
  ensureMailLive();
}
