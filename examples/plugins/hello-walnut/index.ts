/**
 * Hello Walnut — example plugin entry point.
 *
 * The default export receives the PluginApi and registers capabilities. This
 * file deliberately has ZERO top-level imports so it can be copied anywhere and
 * loaded as-is (the loader bundles external .ts plugins on the fly with esbuild).
 *
 * The real types live in the Walnut source tree at
 * `src/core/integration-types.ts` (`PluginApi`, `HttpRoute`, `PluginManifest`).
 * A plugin that lives INSIDE that tree imports them directly:
 *
 *   import type { PluginApi } from '../../core/integration-types.js';
 *
 * An out-of-tree plugin like this one describes only the members it uses, so it
 * has no build-time dependency on Walnut at all.
 */

/** The slice of PluginApi this example uses. See src/core/integration-types.ts. */
interface HelloApi {
  /** The plugin id from manifest.json ("hello-walnut"). */
  id: string;
  /** Values from config.yaml `plugins.hello-walnut`, minus `enabled`. */
  config: Record<string, unknown>;
  /** Subsystem logger, tagged `plugin/hello-walnut`. */
  logger: { info(msg: string, meta?: Record<string, unknown>): void };
  /** Expose a tool to the Personal AI as `<pluginId>_<name>`. */
  registerTool(tool: {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
    execute(params: Record<string, unknown>): Promise<string> | string;
  }): void;
  /** One short paragraph injected into the Personal AI's system prompt. */
  registerAgentContext(snippet: string): void;
  /** Mount an express Router under /api/plugins/<pluginId><path>. */
  registerHttpRoute(route: {
    method: 'get' | 'post' | 'put' | 'patch' | 'delete';
    path: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: any;
  }): void;
}

/** How many greetings the tool has handed out since the server started. */
let greetings = 0;

export default async function register(api: HelloApi): Promise<void> {
  const greeting = typeof api.config.greeting === 'string' && api.config.greeting.trim()
    ? api.config.greeting.trim()
    : 'Hello';

  // ── Tool ──────────────────────────────────────────────────────────────────
  // Reaches the Personal AI as `hello_walnut_hello` (plugin id + tool name,
  // hyphens become underscores). Keep the description written for the model:
  // it is the only thing that decides whether the tool gets called.
  api.registerTool({
    name: 'hello',
    description:
      'Greet someone by name using the greeting configured for the Hello Walnut plugin. '
      + 'Use it when the user asks for a greeting demo or wants to check that plugin tools work.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Who to greet. Defaults to "world".' },
      },
    },
    execute(params) {
      const name = typeof params.name === 'string' && params.name.trim() ? params.name.trim() : 'world';
      greetings += 1;
      api.logger.info('greeted', { name, greetings });
      return `${greeting}, ${name}!`;
    },
  });

  // ── Agent context ─────────────────────────────────────────────────────────
  // One or two sentences, no more: this text is in the prompt on every turn.
  api.registerAgentContext(
    'Hello Walnut plugin is installed; the hello_walnut_hello tool greets people.',
  );

  // ── HTTP route ────────────────────────────────────────────────────────────
  // express is Walnut's own runtime dependency, resolved from Walnut's
  // node_modules — a plugin never installs or ships it. Imported lazily so this
  // file has no top-level imports and needs no package.json.
  //
  // The route is mounted with `router.use()`, so `path: '/stats'` means the
  // router's own '/' handles GET /api/plugins/hello-walnut/stats.
  const { Router } = await import('express');
  const stats = Router();
  stats.get('/', (_req, res) => {
    res.json({ greetings });
  });
  api.registerHttpRoute({ method: 'get', path: '/stats', handler: stats });

  // NOTE: no registerSync() call. The manifest declares ui/tools/skills and no
  // `sync` capability, so this plugin never touches the task sync framework.
}
