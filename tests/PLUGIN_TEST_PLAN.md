# Plugin System Test Plan

## Test Framework & Conventions

- **Framework**: Vitest (v3.1+), with `describe`/`it`/`expect`/`vi` for mocking
- **HTTP testing**: `fetch()` against real server (E2E), `supertest` (integration)
- **WebSocket**: `ws` library for real-time event assertions
- **Mock library**: `vi.mock()` for module-level mocks, `vi.fn()` for function stubs
- **Test data isolation**: `createMockConstants()` from `tests/helpers/mock-constants.ts` redirects all file paths to a unique tmpdir
- **Test factories**: `makeTask()`, `makeSession()`, `makeConfig()` from `tests/helpers/factories.ts`
- **Live tests**: Gated by `isLiveTest()` + credential checks; run via `npm run test:live`
- **File patterns**: `tests/core/*.test.ts` (unit), `tests/e2e/*.test.ts` (E2E), `tests/**/*.live.test.ts` (live)

### How to run

```bash
npm run test:unit          # A, B sections (pure unit)
npm run test:e2e           # F section (full server E2E)
npm run test:live          # G section (real API credentials required)
npm run test               # A + B + C-E + F in parallel
```

---

## A. Core Infrastructure Unit Tests

### A1. IntegrationRegistry (`tests/core/integration-registry.test.ts`)

Pure unit tests against the `IntegrationRegistry` class. No mocks needed -- the registry is a simple in-memory Map wrapper.

**Setup**: Import `IntegrationRegistry` directly (not the singleton); create a fresh instance per test via `beforeEach`. Build `RegisteredPlugin` objects using a helper factory (see below).

```typescript
// Helper to build a minimal RegisteredPlugin
function makePlugin(id: string, overrides?: Partial<RegisteredPlugin>): RegisteredPlugin {
  return {
    id,
    name: id,
    config: {},
    sync: noopSync, // reuse local plugin's noop pattern
    migrations: [],
    httpRoutes: [],
    ...overrides,
  };
}
```

#### Test cases:

**A1.1: register and retrieve plugin**
- Behavior: `register('foo', plugin)` stores it; `get('foo')` returns the same object.
- Assertions: `expect(reg.get('foo')).toBe(plugin)`, `expect(reg.has('foo')).toBe(true)`.

**A1.2: duplicate registration throws**
- Behavior: Registering the same ID twice throws.
- Setup: `register('foo', plugin1)` then `register('foo', plugin2)`.
- Assertions: `expect(() => reg.register('foo', plugin2)).toThrow(/already registered/)`.

**A1.3: getAll returns all registered plugins**
- Behavior: After registering 3 plugins, `getAll()` returns an array of length 3.
- Assertions: `expect(reg.getAll()).toHaveLength(3)`, check IDs match.

**A1.4: has returns false for unregistered plugin**
- Behavior: `has('nonexistent')` returns false.
- Assertions: `expect(reg.has('nope')).toBe(false)`.

**A1.5: getForCategory returns highest priority claim match**
- Behavior: Register plugins with priorities -1, 0, and 10. The priority-10 plugin's claim fn returns true for "Work" category.
- Setup: `local` (priority -1, claims all), `ms-todo` (priority 0, claims all), `plugin-a` (priority 10, claims "Work" only).
- Assertions: `expect((await reg.getForCategory('Work')).id).toBe('plugin-a')`.

**A1.6: getForCategory falls back to lower priority when higher doesn't claim**
- Behavior: Same setup as A1.5 but query "Personal" -- plugin-a returns false, ms-todo returns true.
- Assertions: `expect((await reg.getForCategory('Personal')).id).toBe('ms-todo')`.

**A1.7: getForCategory falls back to local when no plugin claims**
- Behavior: Only `local` registered (claims all with priority -1). Query any category.
- Assertions: `expect((await reg.getForCategory('Anything')).id).toBe('local')`.

**A1.8: getForCategory handles async claim functions**
- Behavior: A claim function that returns a Promise. Verify await works.
- Setup: `registerSourceClaim(async (cat) => cat === 'Special')`.
- Assertions: `expect((await reg.getForCategory('Special')).id).toBe(pluginId)`.

**A1.9: getForCategory throws when no fallback and no match**
- Behavior: Empty registry (no local plugin). `getForCategory()` throws.
- Assertions: `expect(reg.getForCategory('x')).rejects.toThrow(/no.*fallback/i)`.

**A1.10: clear removes all plugins**
- Behavior: After `clear()`, `getAll()` is empty and `has()` returns false for previously registered IDs.
- Assertions: `expect(reg.getAll()).toHaveLength(0)`, `expect(reg.has('foo')).toBe(false)`.

---

### A2. IntegrationLoader (`tests/core/integration-loader.test.ts`)

Tests for `loadPlugins()`, `migrateConfigToPlugins()`, and `runPluginMigrations()`. These require filesystem and config mocking because the loader reads directories, manifest files, and config.yaml.

**Mock strategy**:
- `vi.mock('../../src/constants.js', () => createMockConstants())` -- redirects `WALNUT_HOME` to tmpdir
- Create real filesystem structures in tmpdir (manifest.json files, index.ts entry points)
- Mock `config-manager.js` to return controlled config with `plugins` section
- Use a fresh `IntegrationRegistry` instance (not the singleton) to avoid cross-test leakage

**Setup helper**: A function that creates a plugin directory with manifest.json and a minimal index.ts:

```typescript
async function createPluginDir(baseDir: string, manifest: object, entryCode: string) {
  const dir = path.join(baseDir, (manifest as any).id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(dir, 'index.ts'), entryCode);
}
```

#### Test cases:

**A2.1: discovers built-in plugins from integrations directory**
- Behavior: `loadPlugins()` scans the built-in integrations dir and loads plugins with manifest.json.
- Setup: The real `src/integrations/` dir has local, ms-todo, and other plugins with manifests.
- Assertions: After loading, registry contains at least `local`. Verify by `registry.has('local')`.
- Note: Since this tests against real plugin dirs, mock only config to disable external plugins.

**A2.2: discovers external plugins from ~/.walnut/plugins/**
- Behavior: `loadPlugins()` also scans `WALNUT_HOME/plugins/` for additional plugins.
- Setup: Create `tmpdir/plugins/test-plugin/manifest.json` and `index.ts` (with `registerSync` call).
- Assertions: `registry.has('test-plugin')` is true after loading.

**A2.3: skips directories without manifest.json**
- Behavior: A subdirectory in the integrations dir without manifest.json is silently ignored.
- Setup: Create `tmpdir/plugins/no-manifest/` with only an index.ts, no manifest.json.
- Assertions: Registry does not contain 'no-manifest'.

**A2.4: skips plugins with enabled: false in config**
- Behavior: If `config.plugins['ms-todo'].enabled === false`, ms-todo is not loaded.
- Setup: Mock config to have `plugins: { 'ms-todo': { enabled: false } }`.
- Assertions: `registry.has('ms-todo')` is false. `registry.has('local')` is still true (cannot be disabled).

**A2.5: local plugin cannot be disabled**
- Behavior: Even if config has `plugins.local.enabled: false`, local is still loaded.
- Setup: Mock config with `plugins: { local: { enabled: false } }`.
- Assertions: `registry.has('local')` is true.

**A2.6: validates config against configSchema (warns but loads)**
- Behavior: If ms-todo config is missing required `client_id`, loader logs a warning but still loads.
- Setup: Provide ms-todo config without `client_id`. Spy on logger.
- Assertions: Plugin is loaded (registry has it). Warning was logged.

**A2.7: requires registerSync() call -- rejects plugin without it**
- Behavior: If a plugin entry point does not call `api.registerSync()`, it is not registered.
- Setup: Create a plugin whose `default export` calls `api.registerDisplay()` but not `registerSync()`.
- Assertions: `registry.has('bad-plugin')` is false. Error was logged.

**A2.8: registerSync can only be called once per plugin**
- Behavior: If a plugin calls `registerSync()` twice, the second call throws.
- Setup: Create a plugin that calls `api.registerSync(...)` twice.
- Assertions: Plugin fails to load. Error logged mentioning "more than once".

**A2.9: built-in plugins take precedence over external with same ID**
- Behavior: If both built-in and external dirs have a plugin with id "local", only the built-in is loaded.
- Setup: Create `tmpdir/plugins/local/manifest.json` with `id: "local"`.
- Assertions: Only one "local" plugin registered. The built-in version loaded first.

**A2.10: migrateConfigToPlugins moves legacy keys**
- Behavior: `migrateConfigToPlugins()` reads raw config.yaml, moves `ms_todo` -> `plugins['ms-todo']` and other legacy keys to their respective `plugins.*` entries.
- Setup: Write a config.yaml with `ms_todo: { client_id: 'abc' }` at the top level.
- Assertions: After migration, reread config.yaml: `plugins['ms-todo'].client_id === 'abc'`, `plugins['ms-todo'].enabled === true`, top-level `ms_todo` is gone.

**A2.11: migrateConfigToPlugins is idempotent**
- Behavior: Running the migration twice produces the same result as running it once.
- Setup: Run `migrateConfigToPlugins()` twice on a config with legacy keys.
- Assertions: Config file is unchanged after second run. Function returns `false` on second call.

**A2.12: migrateConfigToPlugins does not overwrite existing plugins section**
- Behavior: If `plugins['ms-todo']` already exists, legacy `ms_todo` key is deleted but not merged.
- Setup: Config with both `ms_todo: { client_id: 'old' }` and `plugins: { 'ms-todo': { client_id: 'new' } }`.
- Assertions: After migration, `plugins['ms-todo'].client_id === 'new'`, legacy key deleted.

**A2.13: runPluginMigrations applies all registered migrations**
- Behavior: Each plugin's `MigrateFn` is called against the task store.
- Setup: Register two plugins with migrations. Write a tasks.json with legacy fields.
- Assertions: After running, tasks.json is updated with migrated data.

**A2.14: runPluginMigrations is idempotent (no write if no changes)**
- Behavior: If migrations return the same data, tasks.json is not rewritten.
- Setup: Run migrations on already-migrated data. Spy on `writeJsonFile`.
- Assertions: `writeJsonFile` not called.

**A2.15: runPluginMigrations continues on single migration failure**
- Behavior: If one plugin's migration throws, others still run.
- Setup: Plugin A migration throws; Plugin B migration is valid.
- Assertions: Plugin B's migration was applied. Error logged for Plugin A.

---

### A3. Plugin Migrations (data migration tests)

These test the specific migration functions registered by each plugin. Can be tested as pure unit tests by extracting the migration logic or by loading just the plugin's register function.

**Setup**: Create a `PluginApi` mock (using `createPluginApiBuilder()` from integration-loader or a test double) and call the plugin's `register()` function to collect the migration function.

#### MS To-Do migration:

**A3.1: ms_todo_id migrates to ext['ms-todo']**
- Input: `{ id: '1', ms_todo_id: 'ABC', ms_todo_list: 'list1', ext: undefined }`
- Expected: `{ id: '1', ext: { 'ms-todo': { id: 'ABC', list: 'list1' } } }`, no `ms_todo_id`/`ms_todo_list` keys.

**A3.2: ms-todo migration skips tasks already migrated**
- Input: `{ id: '1', ms_todo_id: 'ABC', ext: { 'ms-todo': { id: 'existing' } } }`
- Expected: `ext['ms-todo'].id` remains `'existing'`.

**A3.3: ms-todo migration handles tasks without ms_todo_id (no-op)**
- Input: `{ id: '1', ext: undefined }` (no legacy fields)
- Expected: Task unchanged.

#### Plugin-A migration:

**A3.4: legacy plugin-a fields migrate to ext['plugin-a']**
- Input: task with legacy flat fields for plugin-a.
- Expected: `ext['plugin-a'] = { ... }`, legacy fields removed.

**A3.5: plugin-a migration skips already migrated**
- Input: task with both legacy fields and `ext['plugin-a']` present.
- Expected: `ext['plugin-a']` unchanged.

#### Plugin-B migration:

**A3.6: legacy plugin-b fields migrate to ext['plugin-b']**
- Input: task with legacy flat fields for plugin-b.
- Expected: `ext['plugin-b'] = { ... }`, legacy fields removed.

**A3.7: plugin-b migration skips already migrated**
- Input: task with both legacy fields and `ext['plugin-b']` present.
- Expected: `ext['plugin-b']` unchanged.

**A3.8: all migrations are idempotent (running twice is safe)**
- Setup: Run each migration function twice on the same task array.
- Assertions: Output of second run matches first run exactly (JSON deep equality).

---

## B. Local Plugin Unit Tests (`tests/core/local-plugin.test.ts`)

Pure unit tests for the local plugin. No mocks needed -- it's all synchronous no-ops.

**Setup**: Import the `register` function from `src/integrations/local/index.ts`. Create a mock `PluginApi` that captures registrations.

#### Test cases:

**B1: register() calls registerSync with all 16 methods**
- Behavior: All 16 IntegrationSync methods exist and are functions.
- Assertions: `Object.keys(collected.sync)` has 16 entries. Each is a function.

**B2: every sync method resolves without error**
- Behavior: Call each of the 16 methods with minimal args. None throws.
- Setup: Create a minimal `Task` fixture.
- Assertions: All 16 `await method(...)` resolve to `undefined` (or `null` for createTask).

**B3: createTask returns null**
- Behavior: Local plugin has no external service, so `createTask()` returns `null`.
- Assertions: `expect(await sync.createTask(task)).toBeNull()`.

**B4: source claim returns true for any category**
- Behavior: The local plugin claims all categories (universal fallback).
- Assertions: `expect(claim.fn('anything')).toBe(true)`, `expect(claim.fn('')).toBe(true)`.

**B5: source claim has priority -1**
- Behavior: Lowest priority so any other plugin takes precedence.
- Assertions: `expect(claim.priority).toBe(-1)`.

**B6: display metadata has badge "L"**
- Assertions: `expect(display.badge).toBe('L')`, `expect(display.badgeColor).toBe('#8E8E93')`.

**B7: display.getExternalUrl returns null**
- Assertions: `expect(display.getExternalUrl(task)).toBeNull()`.

**B8: display.isSynced returns false**
- Assertions: `expect(display.isSynced(task)).toBe(false)`.

---

## C. MS To-Do Plugin Tests (mocked MS Graph)

### C1. Unit: Plugin Registration (`tests/integrations/ms-todo-plugin.test.ts`)

**Setup**: Import `register` from `src/integrations/ms-todo/index.ts`. Use a mock PluginApi builder.

**C1.1: registers sync with all 16 methods**
- Assertions: All methods exist and are functions.

**C1.2: source claim returns true for all categories (priority 0)**
- Assertions: `claim.fn('Work') === true`, `claim.priority === 0`.

**C1.3: display badge is "M" with Microsoft blue**
- Assertions: `badge === 'M'`, `badgeColor === '#0078D4'`.

**C1.4: isSynced checks ext['ms-todo'].id**
- Input: task with `ext: { 'ms-todo': { id: 'abc' } }` -> true. Task without -> false.

**C1.5: registers migration function**
- Assertions: `collected.migrations.length === 1`.

**C1.6: registers agent context string**
- Assertions: `collected.agentContext` contains "Microsoft To-Do".

### C2. E2E: createTask flow (mocked)

**Mock strategy**: Mock `../microsoft-todo.js` module's `autoPushTask` to return a fake MS To-Do ID.

**C2.1: createTask calls autoPushTask and returns ext data**
- Setup: `vi.mock` for `autoPushTask` returning `'ms-task-123'`.
- Assertions: Result is `{ 'ms-todo': { id: 'ms-task-123' } }`.

**C2.2: createTask returns null when autoPushTask returns null**
- Setup: `autoPushTask` returns null.
- Assertions: Result is `null`.

### C3. E2E: updatePhase flow (mocked)

**C3.1: updatePhase calls autoPushTask**
- Setup: Mock `autoPushTask`.
- Assertions: Called once with the task object.

### C4. E2E: syncPoll (deltaPull) (mocked)

**C4.1: syncPoll calls deltaPull with correct context**
- Setup: Mock `deltaPull`. Provide a `SyncPollContext` with `getTasks` returning sample tasks.
- Assertions: `deltaPull` called with tasks array and update/add callbacks.

### C5. E2E: migration

Covered by A3.1-A3.3.

### C6. Error handling

**C6.1: createTask propagates autoPushTask errors**
- Setup: `autoPushTask` throws `Error('Graph API timeout')`.
- Assertions: `expect(sync.createTask(task)).rejects.toThrow('Graph API timeout')`.

---

## D. Plugin-A Tests (mocked external API)

### D1. Unit: Plugin Registration (`tests/integrations/plugin-a-plugin.test.ts`)

**Setup**: Import `register` from the plugin-a entry point. Mock PluginApi builder.

**D1.1: registers sync with all 16 methods**

**D1.2: source claim matches configured category (case-insensitive)**
- Setup: Config `{ category: 'Engineering' }`.
- Assertions: `claim.fn('engineering') === true`, `claim.fn('Personal') === false`.

**D1.3: source claim returns false when no category configured**
- Setup: Config `{ category: '' }`.
- Assertions: `claim.fn('anything') === false`.

**D1.4: claim priority is 0**

**D1.5: display badge has correct letter and color**

**D1.6: isSynced checks ext['plugin-a'].issue_key**

**D1.7: getExternalUrl returns task.external_url**

**D1.8: registers migration function**

### D2. E2E: createTask flow (mocked)

**Mock strategy**: Mock `./sync.js` module's `autoPushTask` and `isPushSuccess`.

**D2.1: createTask returns ext['plugin-a'] with expected fields**

**D2.2: createTask throws on push error**

**D2.3: createTask returns null on non-error non-success**

### D3. E2E: syncPoll (mocked)

**D3.1: syncPoll calls deltaPull with correct context**
- Same pattern as C4.1.

### D4. Migration

Covered by A3.6-A3.7.

---

## E. Plugin-B Tests (mocked external API)

### E1. Unit: Plugin Registration (`tests/integrations/plugin-b-plugin.test.ts`)

**Setup**: Import `register` from the plugin-b entry point. Mock PluginApi builder.

**E1.1: registers sync with all 16 methods**

**E1.2: source claim matches configured category (case-insensitive)**
- Setup: Config `{ category: 'Work' }`.
- Assertions: `claim.fn('work') === true`, `claim.fn('Personal') === false`.

**E1.3: source claim has priority 10 (higher than ms-todo)**
- Assertions: `claim.priority === 10`.

**E1.4: display badge has correct letter and color**

**E1.5: isSynced checks ext['plugin-b'].id**

**E1.6: registers migration function**

**E1.7: registers agent context mentioning plugin-b workflow**

### E2. E2E: createTask flow (mocked)

**Mock strategy**: Mock `./sync.js` module's `autoPushTask` and `isPushSuccess`.

**E2.1: createTask returns ext['plugin-b'] with expected fields**

**E2.2: createTask throws on push error**

**E2.3: createTask returns null on non-error non-success**

### E3. E2E: syncPoll (mocked)

**E3.1: syncPoll calls deltaPull with correct context**

### E4. Migration

Covered by A3.4-A3.5.

---

## F. Full Server E2E Tests (`tests/e2e/plugin-system.test.ts`)

These tests spin up a real server on port 0 with `startServer({ port: 0, dev: true })` and test the plugin system end-to-end via HTTP. The real built-in plugins (local, ms-todo, and any configured plugins) are loaded from the source tree, but their external API calls are mocked.

**Setup**:
```typescript
vi.mock('../../src/constants.js', () => createMockConstants());
// Mock external API modules to prevent real HTTP calls:
vi.mock('../../src/integrations/microsoft-todo.js', () => ({
  autoPushTask: vi.fn().mockResolvedValue('mock-ms-id'),
  deltaPull: vi.fn().mockResolvedValue(undefined),
  // ... other exports
}));
```

```typescript
beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  port = (server.address() as any).port;
});
```

#### Test cases:

**F1: server starts with plugins loaded**
- Behavior: `GET /api/integrations` returns metadata for loaded plugins.
- Assertions: Response is array; each has `badge`, `badgeColor`, `name`.

**F2: GET /api/integrations excludes local plugin**
- Assertions: No object with `id: 'local'` in the response.

**F3: GET /api/integrations returns correct display metadata**
- Assertions: ms-todo has `badge: 'M'`, `badgeColor: '#0078D4'`. Each plugin has its own badge letter and color.

**F4: POST /api/tasks creates task and triggers plugin createTask**
- Setup: Create a task in a category claimed by ms-todo (e.g. "Personal").
- Assertions: Response 201. Task has `source` field. Mock `autoPushTask` was called.

**F5: PATCH /api/tasks/:id with phase change triggers plugin.updatePhase**
- Setup: Create a task, then PATCH with `{ phase: 'IN_PROGRESS' }`.
- Assertions: Mock `autoPushTask` called for the update.

**F6: task source is determined by plugin category claim**
- Setup: Create task in a category claimed by a high-priority plugin.
- Assertions: `task.source` matches the claiming plugin ID.

**F7: task in unclaimed category gets ms-todo source (priority 0, claims all)**
- Setup: Create task in "Life" category (no high-priority plugin claim).
- Assertions: `task.source === 'ms-todo'` (or `'local'` if ms-todo not configured).

**F8: plugin sync error sets sync_error on task**
- Setup: Make `autoPushTask` throw. Create a task.
- Assertions: Task has `sync_error` field set (or check on next sync poll retry).

**F9: WebSocket events include plugin-sourced updates**
- Setup: Connect WS. Trigger a sync poll that updates a task.
- Assertions: WS receives `task:updated` event with task data.

---

## G. Live Tests (`tests/**/*.live.test.ts`)

These hit real external APIs. Gated by `isLiveTest()` and credential checks. Expensive -- run only via `npm run test:live`.

### G1. MS To-Do Live Lifecycle (`tests/integrations/ms-todo-plugin.live.test.ts`)

**Gate**: `describe.skipIf(!isLiveTest() || !hasMsGraphCredentials())`

**G1.1: full lifecycle: create -> update title -> update phase -> syncPoll -> delete**
- Create a task via plugin's `createTask()`. Verify ext['ms-todo'].id returned.
- Update title via `updateTitle()`. Verify no error.
- Update phase to IN_PROGRESS via `updatePhase()`.
- Call `syncPoll()` and verify the task is reflected.
- Clean up: delete the task from MS To-Do.

**G1.2: migration roundtrip: legacy ms_todo_id -> ext['ms-todo']**
- Create a task with legacy fields. Run migration. Verify ext structure. Push to MS To-Do. Verify sync works with new ext format.

### G2. Plugin-A Live Lifecycle (`tests/integrations/plugin-a-plugin.live.test.ts`)

**Gate**: `describe.skipIf(!isLiveTest() || !hasPluginCredentials())`

Add a `hasPluginCredentials()` helper to `tests/helpers/live.ts` that checks for plugin-a env vars.

**G2.1: full lifecycle: create -> update -> phase change -> syncPoll**
- Same pattern as G1.1 but for plugin-a.

### G3. Plugin-B Live Lifecycle (`tests/integrations/plugin-b-plugin.live.test.ts`)

**Gate**: `describe.skipIf(!isLiveTest() || !hasPluginCredentials())`

Add a `hasPluginCredentials()` helper.

**G3.1: full lifecycle: create -> update -> phase change -> syncPoll**
- Same pattern as G1.1 but for plugin-b.

---

## H. Frontend Tests

### H1. GET /api/integrations endpoint (covered by F1-F3)

Already tested in the server E2E section.

### H2. useIntegrations hook (React testing)

**Note**: The Walnut project does not currently use a React testing framework (no @testing-library/react in package.json). Frontend behavior is verified via Playwright browser tests.

**H2.1: Playwright test for integration badges** (`tests/e2e/browser/plugin-badges.spec.ts`)
- Setup: Start test server with plugins loaded. Navigate to `/`.
- Behavior: Tasks from different sources show appropriate sync badges.
- Assertions: Badge elements with correct text ('M', 'J', 'T') appear on tasks.

**H2.2: Playwright test for /api/integrations** (`tests/e2e/browser/plugin-api.spec.ts`)
- Setup: Fetch `/api/integrations` from browser context.
- Assertions: Returns JSON array with expected plugin metadata.

---

## Test File Map

| Test file | Section | Tier | Mock strategy |
|---|---|---|---|
| `tests/core/integration-registry.test.ts` | A1 | Unit | None (pure unit, fresh instance per test) |
| `tests/core/integration-loader.test.ts` | A2 | Unit | Mock fs dirs + config-manager |
| `tests/core/plugin-migrations.test.ts` | A3 | Unit | Mock PluginApi builder to extract migration fns |
| `tests/core/local-plugin.test.ts` | B | Unit | None (call register directly) |
| `tests/integrations/ms-todo-plugin.test.ts` | C | Unit | Mock `microsoft-todo.js` functions |
| `tests/integrations/plugin-a-plugin.test.ts` | D | Unit | Mock plugin-a sync functions |
| `tests/integrations/plugin-b-plugin.test.ts` | E | Unit | Mock plugin-b sync functions |
| `tests/e2e/plugin-system.test.ts` | F | E2E | Real server, mock external APIs at module level |
| `tests/integrations/ms-todo-plugin.live.test.ts` | G1 | Live | Real MS Graph API |
| `tests/integrations/plugin-a-plugin.live.test.ts` | G2 | Live | Real plugin-a API |
| `tests/integrations/plugin-b-plugin.live.test.ts` | G3 | Live | Real plugin-b API |
| `tests/e2e/browser/plugin-badges.spec.ts` | H1-H2 | Browser | Playwright against real server |

---

## Config File Placement

Tests follow existing vitest config patterns:

| Test file pattern | Config | Workers |
|---|---|---|
| `tests/core/*.test.ts` | `vitest.unit.config.ts` | CPU-proportional |
| `tests/integrations/*.test.ts` | `vitest.integration.config.ts` | CPU-proportional |
| `tests/e2e/*.test.ts` | `vitest.e2e.config.ts` | 4 forks |
| `tests/**/*.live.test.ts` | `vitest.live.config.ts` | 1 (serial) |
| `tests/e2e/browser/*.spec.ts` | `playwright.config.ts` | Half CPUs |

---

## Shared Test Utilities to Add

### `tests/helpers/plugin-test-utils.ts`

```typescript
/**
 * Creates a minimal IntegrationSync object where every method is a vi.fn()
 * that resolves to undefined (or null for createTask).
 */
export function makeSpySync(): IntegrationSync & Record<string, Mock> { ... }

/**
 * Creates a mock PluginApi builder that collects registrations
 * (same pattern as integration-loader.ts's createPluginApiBuilder).
 */
export function createTestPluginApi(manifest: Partial<PluginManifest>, config?: Record<string, unknown>): {
  api: PluginApi;
  collected: { sync: IntegrationSync | null; claim: ...; display: ...; migrations: ...; httpRoutes: ... };
} { ... }

/**
 * Factory for RegisteredPlugin objects with sensible defaults.
 */
export function makeRegisteredPlugin(id: string, overrides?: Partial<RegisteredPlugin>): RegisteredPlugin { ... }
```

These utilities reduce boilerplate across all plugin test files and ensure consistent test patterns.

---

## Priority Order for Implementation

1. **A1** (IntegrationRegistry) -- pure unit, no dependencies, validates the core abstraction
2. **B** (Local Plugin) -- pure unit, validates the simplest plugin implementation
3. **A2** (IntegrationLoader) -- validates discovery, loading, validation pipeline
4. **A3** (Migrations) -- validates data migration correctness
5. **C, D, E** (Plugin registration + mocked sync) -- validates each plugin's contract
6. **F** (Server E2E) -- validates full integration at the HTTP level
7. **H** (Browser/Playwright) -- visual verification
8. **G** (Live) -- real API verification (run manually, not in CI)
