/**
 * The topics services run only while the experiment `topics` is on, on the primary: the reply
 * capture (topic-replies.ts startTopics: a session:result subscription and its expiry timer) and
 * the mail bridge (topic-mail.ts: its pass timer, the mail arrival tap, the message listener).
 *
 * With the flag off none of them subscribes to anything or runs a timer. This supervisor reads the
 * flag at start and again at every `config:changed` (Settings, Experimental), and starts or stops
 * them when it changed: the one subscription it keeps is that config event, the way the hook
 * dispatcher and the search replica follow a Settings change (web/server.ts, search-replica.ts).
 */
import { log } from '../../logging/index.js';

const SUBSCRIBER = 'topics-runtime';

export interface TopicsRuntimeDeps {
  /** The flag is on and this server keeps topics. */
  isOn(): Promise<boolean>;
  /** Start the services; the returned stop ends every subscription and timer they hold. */
  start(): Promise<{ stop: () => void }>;
}

async function defaultDeps(): Promise<TopicsRuntimeDeps> {
  return {
    async isOn() {
      const { isFollower } = await import('../server-role.js');
      const { topicsEnabled } = await import('./topics-store.js');
      return !isFollower() && (await topicsEnabled());
    },
    async start() {
      const { startTopics } = await import('./topic-replies.js');
      const mail = await import('./topic-mail.js');
      const replies = startTopics();
      await mail.startTopicMailBridge().catch((err) => log.task.warn('topics: mail bridge did not start', { error: err instanceof Error ? err.message : String(err) }));
      return { stop: () => { replies.stop(); mail.stopTopicMailBridge(); } };
    },
  };
}

export interface TopicsRuntime {
  stop(): void;
  /** Read the flag again and start or stop (what a config change does); resolves when settled. */
  reconcile(): Promise<void>;
  /** Whether the services run now. */
  running(): boolean;
}

export function startTopicsRuntime(deps?: TopicsRuntimeDeps): TopicsRuntime {
  let stopped = false;
  let live: { stop: () => void } | null = null;
  let chain: Promise<void> = Promise.resolve();
  const depsReady = deps ? Promise.resolve(deps) : defaultDeps();

  const reconcile = (): Promise<void> => {
    chain = chain.then(async () => {
      const d = await depsReady;
      if (stopped) return;
      const on = await d.isOn().catch(() => false);
      if (on && !live) {
        live = await d.start();
        if (stopped) { live.stop(); live = null; }
        else log.task.info('topics: services started (experiment on)');
      } else if (!on && live) {
        live.stop();
        live = null;
        log.task.info('topics: services stopped (experiment off)');
      }
    }).catch((err) => log.task.warn('topics: start or stop failed', { error: err instanceof Error ? err.message : String(err) }));
    return chain;
  };

  void reconcile();
  void import('../event-bus.js').then(({ bus }) => {
    if (stopped) return;
    bus.subscribe(SUBSCRIBER, () => { void reconcile(); }, { global: true, interest: ['config:changed'] });
  });

  return {
    reconcile,
    running: () => live !== null,
    stop() {
      stopped = true;
      live?.stop();
      live = null;
      void import('../event-bus.js').then(({ bus }) => bus.unsubscribe(SUBSCRIBER)).catch(() => {});
    },
  };
}
