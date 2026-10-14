/**
 * `walnut.mcp` for plugins: register a stdio MCP server Walnut runs and keeps alive, and call any
 * registered server by name (src/core/mcp-servers/). A registration belongs to the plugin, so its
 * dispose (disable, reload, uninstall) closes the process.
 */
import { bus } from '../event-bus.js';
import { toDisposable, type Disposable } from './disposable.js';
import { getMcpConnection, listMcpServers, registerMcpServer } from '../mcp-servers/registry.js';
import {
  McpCallError, MCP_STATUS_EVENT, type McpCallOptions, type McpCallResult, type McpServerDefinition,
  type McpServerStatus, type McpToolInfo,
} from '../mcp-servers/types.js';

export interface PluginMcpOptions {
  pluginId: string;
  own: <T extends Disposable>(registration: T) => T;
  assertLive: (registration: string) => void;
}

let subscriberSequence = 0;

/**
 * A plugin may restart a server at most this often: a refusal several plugins see at once (a login a
 * long-lived process can no longer refresh) costs one restart, not one per call.
 */
export const PLUGIN_MCP_RESTART_MIN_INTERVAL_MS = 120_000;
const lastPluginRestart = new Map<string, number>();

/** Tests only: forget the restart clock. */
export function _resetPluginMcpRestartsForTesting(): void {
  lastPluginRestart.clear();
}

function connectionOrThrow(name: string) {
  const connection = getMcpConnection(name);
  if (!connection) {
    throw new McpCallError(
      'unavailable',
      `No MCP server named "${name}" is registered. Install or turn on the plugin that provides it.`,
      'before-call',
    );
  }
  return connection;
}

export function createPluginMcp({ pluginId, own, assertLive }: PluginMcpOptions) {
  return {
    register(def: McpServerDefinition): Disposable {
      assertLive(`mcp.register(${String(def?.name)})`);
      const registration = registerMcpServer(pluginId, def);
      return own(toDisposable(() => registration.dispose()));
    },

    /** Resolved on every call, so a handle taken before the server registers works once it does. */
    client(name: string) {
      return {
        name,
        async call(tool: string, args: Record<string, unknown> = {}, options?: McpCallOptions): Promise<McpCallResult> {
          return connectionOrThrow(name).call(tool, args, options);
        },
        async tools(options?: { refresh?: boolean }): Promise<McpToolInfo[]> {
          return connectionOrThrow(name).listTools(options);
        },
        status(): McpServerStatus | null {
          return getMcpConnection(name)?.status() ?? null;
        },
        /**
         * Stop the process and start a fresh one. `restarted: false` when another restart of this
         * server happened in the last PLUGIN_MCP_RESTART_MIN_INTERVAL_MS (the caller just retries).
         */
        async restart(): Promise<{ restarted: boolean; status: McpServerStatus | null }> {
          const connection = connectionOrThrow(name);
          const now = Date.now();
          const last = lastPluginRestart.get(name) ?? Number.NEGATIVE_INFINITY;
          if (now - last < PLUGIN_MCP_RESTART_MIN_INTERVAL_MS) return { restarted: false, status: connection.status() };
          lastPluginRestart.set(name, now);
          return { restarted: true, status: await connection.restart() };
        },
      };
    },

    list(): McpServerStatus[] {
      return listMcpServers();
    },

    onStatus(handler: (change: { name: string; status: McpServerStatus | null }) => void | Promise<void>): Disposable {
      assertLive('mcp.onStatus');
      const subscriber = `plugin:${pluginId}:mcp:${++subscriberSequence}`;
      bus.subscribe(subscriber, async (event) => {
        try { await handler(event.data as { name: string; status: McpServerStatus | null }); }
        catch { /* a handler that throws must not reach the emitter */ }
      }, { global: true, interest: [MCP_STATUS_EVENT] });
      return own(toDisposable(() => bus.unsubscribe(subscriber)));
    },
  };
}
