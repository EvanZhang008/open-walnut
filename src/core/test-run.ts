/**
 * Test runs on the user's own Walnut stay off the user's board.
 *
 * 2026-10-27: an acceptance run for the Org chart's "+ New VP / + New project" made 9 tasks
 * and 6 projects on the live server; they sat on the user's board and Org page while it ran,
 * and its cleanup left 3 session records with no task. The rule to test on `dev:ephemeral`
 * lived only in prompts. Now a request that says it is a test run (header `x-walnut-test-run`)
 * makes test objects on a real install:
 *
 * - a task it creates is kept off every general surface the way a plugin's own task is
 *   (`plugin_only` = TEST_RUN_OWNER: board, task lists, Org and its counts, search, the
 *   Brief, the phone), born local (never synced) and unpinned; a subtask of a test task is
 *   one too, whoever files it;
 * - a project it creates carries `metadata.test_run` and is left out of every project list;
 * - the sweep (test-run-sweep.ts) deletes both, with the tasks' sessions, once idle.
 *
 * Who says so: the web app under browser automation (`navigator.webdriver`, so every
 * Playwright run marks itself), a page opened with `?walnut-test-run=<label>`, the `walnut`
 * CLI with `WALNUT_TEST_RUN=<label>` in its env, or any client sending the header. The test
 * window itself still sees test objects (the server hands them to it unmarked), so a UI
 * check can find what it made.
 *
 * Throwaway servers (an ephemeral child, the test runner, a data home in a temp or task dir)
 * ignore the marker: everything there is a test object already, and their own tests must
 * see what they create. `WALNUT_TEST_RUN_MARK=1` turns it on there (this feature's tests),
 * `=0` off anywhere.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const TEST_RUN_HEADER = 'x-walnut-test-run';
/** The `plugin_only` owner of a test task. Never a plugin id: those start with [a-z0-9]. */
export const TEST_RUN_OWNER = '@test-run';
/** The key a test project carries in its registry metadata. */
export const TEST_RUN_PROJECT_KEY = 'test_run';

/** A test run's scope: its label, and whether the request it came from is still open. */
interface TestRunScope { label: string; live: () => boolean }

const ambient = new AsyncLocalStorage<TestRunScope>();

/** A header-safe label of at most 60 printable characters, or undefined for none. */
export function parseTestRunLabel(raw: unknown): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 60);
  if (!clean || clean === '0' || clean.toLowerCase() === 'false') return undefined;
  return clean;
}

let markingCache: boolean | undefined;

/** Whether this server turns test-run requests into test objects (see the file comment). */
export async function testRunMarkingEnabled(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const flag = env.WALNUT_TEST_RUN_MARK;
  if (flag === '1') return true;
  if (flag === '0') return false;
  if (markingCache !== undefined) return markingCache;
  const [{ semanticLaneDecision }, { IS_EPHEMERAL, WALNUT_HOME }] = await Promise.all([
    import('./search/semantic-default.js'),
    import('../constants.js'),
  ]);
  // The semantic lane's "is this a real install" test, without its own opt-in flag.
  const decision = semanticLaneDecision({
    env: { ...env, WALNUT_SEARCH_V2_SEMANTIC: undefined },
    isEphemeral: IS_EPHEMERAL,
    walnutHome: WALNUT_HOME,
  });
  markingCache = decision.reason === 'default';
  return markingCache;
}

/**
 * Run `fn` as part of the test run `label` (no-op scope when label is undefined). `live` says
 * whether the request is still open: a timer or a scheduler armed inside the request inherits
 * the scope, and must not stamp the real work it does after the answer went out (a routine's
 * fire, a sync pull), or the sweep would delete it.
 */
export function withTestRun<T>(label: string | undefined, fn: () => T, live: () => boolean = () => true): T {
  return label ? ambient.run({ label, live }, fn) : fn();
}

/** The test run the current request belongs to, while that request is open. */
export function ambientTestRun(): string | undefined {
  const scope = ambient.getStore();
  return scope && scope.live() ? scope.label : undefined;
}

export function isTestRunTask(task: { plugin_only?: string } | null | undefined): boolean {
  return task?.plugin_only === TEST_RUN_OWNER;
}

export function isTestRunProject(record: { metadata?: Record<string, unknown> } | null | undefined): boolean {
  const mark = record?.metadata?.[TEST_RUN_PROJECT_KEY];
  return mark !== undefined && mark !== null && mark !== false;
}

/** The metadata a project made by test run `label` is born with. */
export function testRunProjectMetadata(label: string): Record<string, unknown> {
  return { [TEST_RUN_PROJECT_KEY]: { label, at: new Date().toISOString() } };
}

/**
 * The registry rows a list may show: a test project is left out, except to a test run's own
 * request and while `inUse` says real work lives in it (a task the user filed there later).
 */
export function listedProjects<R extends { metadata?: Record<string, unknown> }>(
  projects: Record<string, R>,
  inUse: (name: string) => boolean = () => false,
): Record<string, R> {
  if (ambientTestRun() !== undefined) return projects;
  return Object.fromEntries(
    Object.entries(projects).filter(([name, rec]) => !isTestRunProject(rec) || inUse(name)),
  );
}

/**
 * What a test window is served instead of a test task: the same task without the marker,
 * so its own filters treat it as ordinary work. Every other task passes through.
 */
export function unmarkForTestViewer<T extends { plugin_only?: string }>(task: T): T {
  if (!isTestRunTask(task)) return task;
  const { plugin_only: _owner, ...rest } = task;
  return rest as T;
}

export function resetTestRunForTesting(): void {
  markingCache = undefined;
}
