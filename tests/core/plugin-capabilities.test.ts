/**
 * Manifest v2 deep capabilities: `ui`, `tools`, `skills`.
 *
 * What this file pins:
 *  - registerSync is required ONLY of a sync plugin. A ui/tools/skills-only
 *    manifest loads without it; an absent capabilities block still implies sync
 *    (back-compat), so such a plugin without registerSync is still rejected.
 *  - A non-sync plugin is not a task source (no claim, excluded from
 *    getSyncPlugins / isTaskSource) and is not polled.
 *  - registerTool namespacing, duplicate rejection, and that its tool reaches
 *    getToolSchemas() / executeTool().
 *  - capabilities.ui.app validation drops a bad block WITHOUT unloading the plugin.
 *  - /api/apps lists the app, and /plugin-apps refuses traversal / non-app/ paths
 *    while serving a real file inside app/.
 *  - A plugin's skills/ dir joins BOTH skill-loader discovery scopes, last.
 *
 * Separate from external-plugin-loader.test.ts on purpose: that file is shared
 * ground, this one owns the v2 capability surface.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants('plugin-caps-test'));

vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({
    version: 1,
    user: { name: 'test' },
    defaults: { priority: 'none' },
    provider: { type: 'bedrock' },
    plugins: {},
  })),
  seedConfigDefaults: vi.fn(async () => {}),
}));

import express from 'express';
import request from 'supertest';
import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js';
import { IntegrationRegistry, registry as globalRegistry } from '../../src/core/integration-registry.js';
import {
  loadPlugins,
  getUnsupportedPlugins,
  validatePluginAssetPath,
  pluginToolName,
  getPluginApps,
  getPluginToolSpecs,
} from '../../src/core/integration-loader.js';
import { appsRouter, pluginAppStaticRouter, resolveAppAsset } from '../../src/web/routes/apps.js';
import { getSearchDirs, getPromptSearchDirs, getPluginSkillDirs } from '../../src/core/skill-loader.js';

// ── Helpers ──

const NOOP_SYNC_SOURCE = `{
  createTask: async () => null,
  deleteTask: async () => {},
  updateTitle: async () => {},
  updateDescription: async () => {},
  updateSummary: async () => {},
  updateNote: async () => {},
  updateConversationLog: async () => {},
  updatePriority: async () => {},
  updatePhase: async () => {},
  updateDueDate: async () => {},
  updateProject: async () => {},
  updateDependencies: async () => {},
  associateSubtask: async () => {},
  disassociateSubtask: async () => {},
  syncPoll: async () => {},
}`;

async function writeManifest(pluginDir: string, manifest: Record<string, unknown>): Promise<void> {
  await fsp.mkdir(pluginDir, { recursive: true });
  await fsp.writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify(manifest));
}

async function writePluginTs(pluginDir: string, source: string): Promise<void> {
  await fsp.writeFile(path.join(pluginDir, 'plugin.ts'), source);
}

function pluginPath(...parts: string[]): string {
  return path.join(tmpDir, 'plugins', ...parts);
}

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true });
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
  // The apps route + skill loader read the module-level singleton registry, so
  // every test that registers into it must hand it back clean.
  globalRegistry.clear();
});

// ── registerSync is conditional ──

describe('capability-gated registerSync', () => {
  it('loads a ui-only plugin that never calls registerSync', async () => {
    const dir = pluginPath('ui-only');
    await writeManifest(dir, {
      id: 'ui-only',
      name: 'Ui Only',
      capabilities: { ui: { app: { title: 'Ui Only App' } } },
    });
    await writePluginTs(dir, 'export default function register(_api) {}\n');
    await fsp.mkdir(path.join(dir, 'app'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'app', 'index.html'), '<h1>hi</h1>');

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);

    const plugin = registry.get('ui-only');
    expect(plugin).toBeDefined();
    expect(plugin!.hasSync).toBe(false);
    expect(plugin!.capabilities).toEqual(['ui']);
    expect(plugin!.uiApp).toEqual({ title: 'Ui Only App', entry: 'app/index.html' });
    // The inert stub keeps `registry.get(x).sync.y()` call sites total.
    expect(typeof plugin!.sync.pushTask).toBe('function');
    expect(getUnsupportedPlugins().some(p => p.id === 'ui-only')).toBe(false);
  });

  it('keeps a non-sync plugin out of task sources and refuses its source claim', async () => {
    const dir = pluginPath('tools-only');
    await writeManifest(dir, {
      id: 'tools-only',
      name: 'Tools Only',
      capabilities: { tools: {} },
    });
    // A claim WITHOUT sync would make the plugin selectable as a task source and
    // then silently drop every push — the loader must refuse the claim.
    await writePluginTs(dir, `
export default function register(api) {
  api.registerSourceClaim(() => true, { priority: 100 });
  api.registerTool({
    name: 'ping',
    description: 'Ping',
    input_schema: { type: 'object', properties: {} },
    execute: async () => 'pong',
  });
}
`);

    const registry = new IntegrationRegistry();
    registry.ensureLocalFallback();
    await loadPlugins(registry);

    const plugin = registry.get('tools-only');
    expect(plugin).toBeDefined();
    expect(plugin!.hasSync).toBe(false);
    expect(plugin!.claim).toBeUndefined();
    expect(registry.isTaskSource('tools-only')).toBe(false);
    expect(registry.getSyncPlugins().map(p => p.id)).not.toContain('tools-only');
    // The local fallback still wins for any project, despite the higher priority
    // the refused claim asked for.
    expect((await registry.getForProject('Anything')).id).toBe('local');
  });

  it('still requires registerSync when capabilities are absent (implied sync)', async () => {
    const dir = pluginPath('implied-sync');
    await writeManifest(dir, { id: 'implied-sync', name: 'Implied Sync' });
    await writePluginTs(dir, 'export default function register(_api) {}\n');

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);
    expect(registry.has('implied-sync')).toBe(false);
  });

  it('still requires registerSync when sync is declared alongside ui', async () => {
    const dir = pluginPath('sync-and-ui');
    await writeManifest(dir, {
      id: 'sync-and-ui',
      name: 'Sync And Ui',
      capabilities: { sync: {}, ui: { app: { title: 'Both' } } },
    });
    await writePluginTs(dir, 'export default function register(_api) {}\n');

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);
    expect(registry.has('sync-and-ui')).toBe(false);
  });

  it('marks a plugin declaring only still-reserved capabilities unsupported', async () => {
    const dir = pluginPath('reserved-only');
    await writeManifest(dir, {
      id: 'reserved-only',
      name: 'Reserved Only',
      capabilities: { hooks: {}, routines: {} },
    });
    // Deliberately unparseable — must never be imported.
    await writePluginTs(dir, 'this is not typescript {{{');

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);
    expect(registry.has('reserved-only')).toBe(false);
    expect(getUnsupportedPlugins().find(p => p.id === 'reserved-only')?.capabilities.sort())
      .toEqual(['hooks', 'routines']);
  });
});

// ── registerTool ──

describe('pluginToolName', () => {
  it('namespaces with the plugin id and folds hyphens to underscores', () => {
    expect(pluginToolName('hello-walnut', 'hello')).toBe('hello_walnut_hello');
  });

  it('leaves an already-prefixed name alone', () => {
    expect(pluginToolName('hello-walnut', 'hello_walnut_hello')).toBe('hello_walnut_hello');
  });
});

describe('registerTool', () => {
  it('prefixes tool names with the plugin id', async () => {
    const dir = pluginPath('toolbox');
    await writeManifest(dir, { id: 'toolbox', name: 'Toolbox', capabilities: { tools: {} } });
    await writePluginTs(dir, `
export default function register(api) {
  api.registerTool({
    name: 'echo',
    description: 'Echo the message back',
    input_schema: { type: 'object', properties: { msg: { type: 'string' } } },
    execute: async (params) => 'echo:' + params.msg,
  });
}
`);

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);

    const tools = registry.get('toolbox')!.tools!;
    expect(tools.map(t => t.name)).toEqual(['toolbox_echo']);
    expect(await tools[0].execute({ msg: 'hi' })).toBe('echo:hi');
    expect(getPluginToolSpecs(registry).map(t => t.name)).toEqual(['toolbox_echo']);
  });

  it('rejects a duplicate tool name within one plugin (plugin fails to load)', async () => {
    const dir = pluginPath('dup-tools');
    await writeManifest(dir, { id: 'dup-tools', name: 'Dup Tools', capabilities: { tools: {} } });
    await writePluginTs(dir, `
const spec = {
  name: 'same',
  description: 'Same name twice',
  input_schema: { type: 'object', properties: {} },
  execute: async () => 'ok',
};
export default function register(api) {
  api.registerTool(spec);
  api.registerTool(spec);
}
`);

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);
    // registerTool throws → registration threw → plugin is not registered.
    expect(registry.has('dup-tools')).toBe(false);
  });

  it('rejects an invalid tool name', async () => {
    const dir = pluginPath('bad-tool-name');
    await writeManifest(dir, { id: 'bad-tool-name', name: 'Bad Tool Name', capabilities: { tools: {} } });
    await writePluginTs(dir, `
export default function register(api) {
  api.registerTool({
    name: 'Not Valid!',
    description: 'x',
    input_schema: { type: 'object', properties: {} },
    execute: async () => 'ok',
  });
}
`);

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);
    expect(registry.has('bad-tool-name')).toBe(false);
  });

  it('ignores tools from a plugin that did not declare the tools capability', async () => {
    const dir = pluginPath('undeclared-tools');
    await writeManifest(dir, {
      id: 'undeclared-tools',
      name: 'Undeclared Tools',
      capabilities: { ui: { app: { title: 'App' } } },
    });
    await writePluginTs(dir, `
export default function register(api) {
  api.registerTool({
    name: 'sneaky',
    description: 'Not declared in the manifest',
    input_schema: { type: 'object', properties: {} },
    execute: async () => 'ok',
  });
}
`);

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);
    expect(registry.get('undeclared-tools')!.tools).toBeUndefined();
  });
});

describe('plugin tools reach the Personal AI tool set', () => {
  it('getToolSchemas appends the plugin tool and executeTool dispatches to it', async () => {
    const dir = pluginPath('agent-tool');
    await writeManifest(dir, { id: 'agent-tool', name: 'Agent Tool', capabilities: { tools: {} } });
    await writePluginTs(dir, `
export default function register(api) {
  api.registerTool({
    name: 'shout',
    description: 'Uppercase the text',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async (params) => String(params.text).toUpperCase(),
  });
}
`);

    // Import lazily: src/agent/tools.ts pulls in a large chunk of core, and only
    // this test needs it.
    const { getToolSchemas, executeTool, getPluginTools, tools: builtinTools } =
      await import('../../src/agent/tools.js');

    const before = getToolSchemas();
    expect(before.map(t => t.name)).not.toContain('agent_tool_shout');
    // Nothing registered yet ⇒ the prompt-cached prefix is EXACTLY the static list.
    expect(before.length).toBe(builtinTools.length);

    await loadPlugins(globalRegistry);
    expect(globalRegistry.has('agent-tool')).toBe(true);

    const after = getToolSchemas();
    expect(after.map(t => t.name)).toContain('agent_tool_shout');
    // Appended, never interleaved: the static prefix bytes are untouched.
    expect(after.slice(0, builtinTools.length).map(t => t.name))
      .toEqual(builtinTools.map(t => t.name));
    expect(getPluginTools().map(t => t.name)).toEqual(['agent_tool_shout']);

    expect(await executeTool('agent_tool_shout', { text: 'hi' })).toBe('HI');
  });

  it('a built-in tool name always wins over a plugin tool', async () => {
    const { tools: builtinTools, getPluginTools } = await import('../../src/agent/tools.js');
    const builtinName = builtinTools[0].name;

    // Register by hand: the loader would namespace the name away from the collision.
    globalRegistry.register('collider', {
      id: 'collider',
      name: 'Collider',
      config: {},
      sync: {} as never,
      hasSync: false,
      capabilities: ['tools'],
      migrations: [],
      httpRoutes: [],
      tools: [{
        name: builtinName,
        description: 'Shadowing attempt',
        input_schema: { type: 'object', properties: {} },
        execute: async () => 'shadowed',
      }],
    });

    expect(getPluginTools().map(t => t.name)).not.toContain(builtinName);
  });

  it('plugin tools are NOT in the read-only allowlist', async () => {
    const { READ_ONLY_TOOL_NAMES } = await import('../../src/agent/tools.js');
    expect([...READ_ONLY_TOOL_NAMES].some(n => n.startsWith('agent_tool_'))).toBe(false);
  });
});

// ── capabilities.ui.app validation ──

describe('validatePluginAssetPath', () => {
  it('accepts a plain relative file and strips a leading app/', () => {
    expect(validatePluginAssetPath('index.html')).toEqual({ ok: true, rel: 'index.html' });
    expect(validatePluginAssetPath('app/index.html')).toEqual({ ok: true, rel: 'index.html' });
    expect(validatePluginAssetPath('sub/dir/page.html')).toEqual({ ok: true, rel: 'sub/dir/page.html' });
  });

  it('refuses absolute paths, escapes, and empties', () => {
    for (const bad of ['/etc/passwd', '../../etc/passwd', 'app/../../x.html', 'C:/x.html', '', '   ']) {
      expect(validatePluginAssetPath(bad).ok).toBe(false);
    }
  });

  it('keeps a filename that merely CONTAINS dots', () => {
    // A substring `..` test would reject this ordinary name.
    expect(validatePluginAssetPath('v1..2/index.html')).toEqual({ ok: true, rel: 'v1..2/index.html' });
  });
});

describe('ui.app manifest validation', () => {
  it('drops the app for an escaping entry but keeps the plugin loaded', async () => {
    const dir = pluginPath('bad-entry');
    await writeManifest(dir, {
      id: 'bad-entry',
      name: 'Bad Entry',
      capabilities: { ui: { app: { title: 'Bad', entry: '../../../etc/passwd' } }, tools: {} },
    });
    await writePluginTs(dir, `
export default function register(api) {
  api.registerTool({
    name: 'ok',
    description: 'Still works',
    input_schema: { type: 'object', properties: {} },
    execute: async () => 'ok',
  });
}
`);

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);

    const plugin = registry.get('bad-entry');
    expect(plugin).toBeDefined();          // not unloaded over one bad field
    expect(plugin!.uiApp).toBeUndefined(); // but the app is gone
    expect(plugin!.tools?.map(t => t.name)).toEqual(['bad_entry_ok']);
  });

  it('drops the app when title is missing or too long', async () => {
    for (const [id, app] of [
      ['no-title', { entry: 'index.html' }],
      ['long-title', { title: 'x'.repeat(65) }],
    ] as const) {
      const dir = pluginPath(id);
      await writeManifest(dir, { id, name: id, capabilities: { ui: { app } } });
      await writePluginTs(dir, 'export default function register(_api) {}\n');
    }

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);

    // Still loaded (ui is a supported capability, so it is not "unsupported"),
    // just without an app.
    expect(registry.get('no-title')?.uiApp).toBeUndefined();
    expect(registry.get('long-title')?.uiApp).toBeUndefined();
    expect(getUnsupportedPlugins().some(p => p.id === 'no-title')).toBe(false);
  });

  it('drops only the icon when the icon path is bad', async () => {
    const dir = pluginPath('bad-icon');
    await writeManifest(dir, {
      id: 'bad-icon',
      name: 'Bad Icon',
      capabilities: { ui: { app: { title: 'Fine', icon: '/abs/icon.png' } } },
    });
    await writePluginTs(dir, 'export default function register(_api) {}\n');

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);
    expect(registry.get('bad-icon')!.uiApp).toEqual({ title: 'Fine', entry: 'app/index.html' });
  });

  it('normalizes an explicit app/ prefix and keeps a valid icon', async () => {
    const dir = pluginPath('normalized');
    await writeManifest(dir, {
      id: 'normalized',
      name: 'Normalized',
      capabilities: { ui: { app: { title: 'N', entry: 'app/main.html', icon: 'icon.svg' } } },
    });
    await writePluginTs(dir, 'export default function register(_api) {}\n');

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);
    expect(registry.get('normalized')!.uiApp).toEqual({
      title: 'N', entry: 'app/main.html', icon: 'app/icon.svg',
    });
  });
});

// ── the apps HTTP surface ──

describe('resolveAppAsset (path guard)', () => {
  let pluginDir: string;

  beforeEach(async () => {
    pluginDir = pluginPath('guarded');
    await fsp.mkdir(path.join(pluginDir, 'app', 'sub'), { recursive: true });
    await fsp.writeFile(path.join(pluginDir, 'app', 'index.html'), '<h1>ok</h1>');
    await fsp.writeFile(path.join(pluginDir, 'app', 'sub', 'deep.txt'), 'deep');
    // A secret OUTSIDE app/ — the thing the app-subdir restriction protects.
    await fsp.writeFile(path.join(pluginDir, 'secrets.json'), '{"token":"nope"}');
  });

  it('serves a real file inside app/', async () => {
    const res = await resolveAppAsset(pluginDir, '/app/index.html');
    expect(res.ok).toBe(true);
    expect(res.ok && res.absPath.endsWith(path.join('app', 'index.html'))).toBe(true);
    expect((await resolveAppAsset(pluginDir, '/app/sub/deep.txt')).ok).toBe(true);
  });

  it('refuses anything outside app/', async () => {
    for (const p of ['/secrets.json', '/manifest.json', '/']) {
      expect((await resolveAppAsset(pluginDir, p)).ok).toBe(false);
    }
  });

  it('refuses .. segments, encoded and plain', async () => {
    for (const p of ['/app/../secrets.json', '/app/%2e%2e/secrets.json', '/app/sub/../../secrets.json']) {
      const res = await resolveAppAsset(pluginDir, p);
      expect(res.ok).toBe(false);
      expect(!res.ok && res.status).toBe(400);
    }
  });

  it('refuses an absolute path', async () => {
    // `%2f` decodes to a slash, which path.join would otherwise treat as a root.
    const res = await resolveAppAsset(pluginDir, '/app/%2Fetc%2Fpasswd');
    expect(res.ok).toBe(false);
  });

  it('refuses a symlink that escapes app/ (realpath check)', async () => {
    await fsp.symlink(path.join(pluginDir, 'secrets.json'), path.join(pluginDir, 'app', 'leak.json'));
    const res = await resolveAppAsset(pluginDir, '/app/leak.json');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.status).toBe(400);
  });

  it('refuses a directory (no listings)', async () => {
    const res = await resolveAppAsset(pluginDir, '/app/sub');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.status).toBe(404);
  });

  it('refuses malformed percent-encoding', async () => {
    const res = await resolveAppAsset(pluginDir, '/app/%zz.html');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.status).toBe(400);
  });
});

describe('GET /api/apps and /plugin-apps', () => {
  function createApp() {
    const app = express();
    app.use('/api/apps', appsRouter);
    app.use('/plugin-apps', pluginAppStaticRouter);
    return app;
  }

  beforeEach(async () => {
    const dir = pluginPath('appy');
    await writeManifest(dir, {
      id: 'appy',
      name: 'Appy',
      capabilities: { ui: { app: { title: 'Appy Dashboard', icon: 'icon.svg' } } },
    });
    await writePluginTs(dir, 'export default function register(_api) {}\n');
    await fsp.mkdir(path.join(dir, 'app'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'app', 'index.html'), '<h1>appy</h1>');
    await fsp.writeFile(path.join(dir, 'app', 'icon.svg'), '<svg/>');
    await fsp.writeFile(path.join(dir, 'private.txt'), 'secret');
    await loadPlugins(globalRegistry);
  });

  it('lists the app with server-owned urls', async () => {
    const res = await request(createApp()).get('/api/apps');
    expect(res.status).toBe(200);
    const entry = res.body.find((a: { id: string }) => a.id === 'appy');
    expect(entry).toMatchObject({
      id: 'appy',
      pluginId: 'appy',
      title: 'Appy Dashboard',
      icon: '/plugin-apps/appy/app/icon.svg',
      url: '/plugin-apps/appy/app/index.html',
    });
    expect(getPluginApps(globalRegistry).map(a => a.id)).toContain('appy');
  });

  it('serves a file inside app/ with the right content type', async () => {
    const res = await request(createApp()).get('/plugin-apps/appy/app/index.html');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('appy');
  });

  it('refuses traversal, absolute, and non-app/ requests', async () => {
    const app = createApp();
    for (const url of [
      '/plugin-apps/appy/app/../private.txt',
      '/plugin-apps/appy/app/%2e%2e/private.txt',
      '/plugin-apps/appy/private.txt',
      '/plugin-apps/appy/manifest.json',
      '/plugin-apps/appy/app/%2Fetc%2Fpasswd',
    ]) {
      const res = await request(app).get(url);
      expect([400, 404]).toContain(res.status);
      expect(res.text).not.toContain('secret');
    }
  });

  it('404s an unknown plugin and a plugin with no app', async () => {
    const app = createApp();
    expect((await request(app).get('/plugin-apps/nope/app/index.html')).status).toBe(404);
    expect((await request(app).get('/plugin-apps/local/app/index.html')).status).toBe(404);
  });

  it('still serves when the plugin lives under a DOT-prefixed dir', async () => {
    // The real external plugin home is `~/.open-walnut/plugins/`. res.sendFile
    // with an absolute path and no `root` applies its dotfile rule to every
    // segment of that absolute path, so `.open-walnut` alone would 403 every
    // installed app. Pinning the root-relative form that avoids it.
    const dir = path.join(tmpDir, '.dotted-home', 'plugins', 'appy');
    await writeManifest(dir, {
      id: 'appy',
      name: 'Appy',
      capabilities: { ui: { app: { title: 'Appy' } } },
    });
    await fsp.mkdir(path.join(dir, 'app'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'app', 'index.html'), '<h1>dotted</h1>');

    globalRegistry.clear();
    globalRegistry.register('appy', {
      id: 'appy',
      name: 'Appy',
      config: {},
      sync: {} as never,
      hasSync: false,
      capabilities: ['ui'],
      migrations: [],
      httpRoutes: [],
      uiApp: { title: 'Appy', entry: 'app/index.html' },
      pluginDir: dir,
    });

    const res = await request(createApp()).get('/plugin-apps/appy/app/index.html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('dotted');
  });

  it('refuses a dotfile inside app/', async () => {
    await fsp.writeFile(pluginPath('appy', 'app', '.env'), 'SECRET=1');
    const res = await request(createApp()).get('/plugin-apps/appy/app/.env');
    expect([403, 404]).toContain(res.status);
    expect(res.text).not.toContain('SECRET');
  });

  it('rejects non-GET methods', async () => {
    const res = await request(createApp()).post('/plugin-apps/appy/app/index.html');
    expect(res.status).toBe(405);
  });
});

// ── plugin skills join the discovery scopes ──

describe('plugin skills discovery', () => {
  it('appends <pluginDir>/skills to both scopes, after the built-in dirs', async () => {
    const dir = pluginPath('skilled');
    await writeManifest(dir, { id: 'skilled', name: 'Skilled', capabilities: { skills: {} } });
    await writePluginTs(dir, 'export default function register(_api) {}\n');
    const skillDir = path.join(dir, 'skills', 'plugin-skill');
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: plugin-skill\ndescription: From a plugin\n---\n# body',
    );

    const beforeAll = getSearchDirs();
    expect(getPluginSkillDirs()).toEqual([]);

    await loadPlugins(globalRegistry);
    expect(globalRegistry.get('skilled')!.hasSkills).toBe(true);

    const expected = path.join(dir, 'skills');
    expect(getPluginSkillDirs()).toEqual([expected]);

    // LAST in both scopes: first-wins discovery means a workspace / global /
    // shipped skill of the same name still overrides the plugin's.
    const all = getSearchDirs();
    expect(all[all.length - 1]).toBe(expected);
    expect(all.slice(0, beforeAll.length)).toEqual(beforeAll);

    const prompt = getPromptSearchDirs();
    expect(prompt[prompt.length - 1]).toBe(expected);
  });

  it('does not claim skills when the capability is declared but the dir is missing', async () => {
    const dir = pluginPath('skill-less');
    await writeManifest(dir, { id: 'skill-less', name: 'Skill Less', capabilities: { skills: {} } });
    await writePluginTs(dir, 'export default function register(_api) {}\n');

    await loadPlugins(globalRegistry);
    expect(globalRegistry.get('skill-less')!.hasSkills).toBe(false);
    expect(getPluginSkillDirs()).toEqual([]);
  });
});
