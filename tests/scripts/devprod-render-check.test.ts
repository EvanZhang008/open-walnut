/**
 * scripts/devprod-render-check.mjs — the first-paint gate dev-prod.sh runs
 * against its isolated smoke server before killing production.
 *
 * 2026-09-02: a dist built from a half-edited component served /api/config fine
 * and crashed on the first render of `/` in every browser. The smoke boot only
 * probed /api/config, so the deploy went through. This pins the three verdicts
 * the script must keep distinct, because dev-prod.sh maps them to three
 * different actions (proceed / abort with prod untouched / warn-and-proceed):
 *
 *   0 = mounted, 1 = definitive crash, 2 = undetermined.
 *
 * Runs a real headless Chromium (~5s), so it lives in the slow tier
 * (tests/setup/slow-tests.ts), not in `npm run test:quick`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'devprod-render-check.mjs');
const DEV_PROD = path.join(REPO_ROOT, 'scripts', 'dev-prod.sh');

const shell = (body: string) => `<!doctype html><html><body><div id="root">${body}</div></body></html>`;

// One page per verdict. The "boundary" page reproduces what AppErrorBoundary
// does on a render crash: the console line AND the on-screen banner.
const PAGES: Record<string, string> = {
  '/healthy': shell('<nav>Walnut</nav><main>home</main>'),
  '/boundary': `<!doctype html><html><body><div id="root"><div>Something went wrong rendering the page.</div></div>
    <script>console.error('[error-boundary] render crash — tree recovered by boundary', { error: 'ReferenceError: groupBy is not defined' })</script>
    </body></html>`,
  '/blank': `<!doctype html><html><body><div id="root"></div><script>groupBy.length</script></body></html>`,
  '/warned': `<!doctype html><html><body><div id="root"><nav>ok</nav></div><script>setTimeout(() => { throw new Error('late') }, 10)</script></body></html>`,
};

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const html = PAGES[req.url ?? ''];
    if (!html) { res.statusCode = 404; res.end('nope'); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

// Async on purpose: the page server lives in THIS process, so a spawnSync here
// would block the event loop and the browser would never get a response.
function run(url: string, extra: string[] = []): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, url, '--timeout-ms', '20000', ...extra], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, out }); });
  });
}

const hasChromium = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pw = require('playwright');
    return existsSync(pw.chromium.executablePath());
  } catch {
    return false;
  }
})();

describe.skipIf(!hasChromium)('devprod-render-check.mjs verdicts', () => {
  it('0: a page whose #root mounted is OK', async () => {
    const r = await run(`${base}/healthy`);
    expect(r.out).toContain('render-check OK');
    expect(r.code).toBe(0);
  });

  it('1: the React error boundary firing is a DEFINITIVE crash', async () => {
    const r = await run(`${base}/boundary`);
    expect(r.out).toContain('error boundary fired');
    expect(r.code).toBe(1);
  });

  it('1: an empty #root after settle (script died before mount) is a DEFINITIVE crash', async () => {
    const r = await run(`${base}/blank`);
    expect(r.out).toContain('#root is empty');
    expect(r.out).toContain('groupBy');
    expect(r.code).toBe(1);
  });

  it('0 with a warning: an uncaught exception that did not unmount the app only warns (fails under --strict)', async () => {
    const lax = await run(`${base}/warned`);
    expect(lax.out).toContain('render-check WARN');
    expect(lax.code).toBe(0);
    const strict = await run(`${base}/warned`, ['--strict']);
    expect(strict.code).toBe(1);
  });

  it('2: an unreachable URL is UNDETERMINED, never a crash verdict', async () => {
    const r = await run(`${base}/404-not-served`);
    // A 404 body still "loads"; the root is missing → this is inspection, not a crash.
    expect([0, 1, 2]).toContain(r.code);
    const dead = await run('http://127.0.0.1:9/', ['--timeout-ms', '3000']);
    expect(dead.out).toContain('UNDETERMINED');
    expect(dead.code).toBe(2);
  });
});

describe('dev-prod.sh wires the render check into the smoke block', () => {
  const script = require('node:fs').readFileSync(DEV_PROD, 'utf8') as string;
  const idx = (needle: string) => {
    const i = script.indexOf(needle);
    if (i < 0) throw new Error(`dev-prod.sh no longer contains: ${needle}`);
    return i;
  };

  it('type-checks web/ BEFORE the build, with a named escape hatch', () => {
    expect(idx('WALNUT_DEVPROD_SKIP_TSC')).toBeLessThan(idx('npm run web:build'));
    expect(script).toMatch(/WEB_TSC" --noEmit -p tsconfig\.json/);
    expect(script).toContain('web/ type-check FAILED');
  });

  it('runs the render check against the smoke port, after /api/config answered and before smoke_cleanup', () => {
    const probe = idx('/api/config" >/dev/null');
    const render = idx('devprod-render-check.mjs');
    const cleanupCall = script.indexOf('    smoke_cleanup\n', render);
    expect(render).toBeGreaterThan(probe);
    expect(cleanupCall).toBeGreaterThan(render);
    expect(script).toMatch(/devprod-render-check\.mjs" \\\n\s+"http:\/\/localhost:\$smoke_port\/"/);
  });

  it('a definitive crash (rc 1) aborts BEFORE the prod kill; undetermined (rc 2) only warns unless STRICT', () => {
    const fail = idx('Smoke render FAILED');
    const kill = idx('existing_pids="$(listener_pids)"');
    expect(fail).toBeLessThan(kill);
    expect(script.slice(fail, kill)).toMatch(/exit 1/);
    expect(script).toMatch(/smoke_render_rc" == "2" && "\$\{WALNUT_DEVPROD_RENDER_STRICT:-0\}" != "1"/);
    expect(script).toContain('WALNUT_DEVPROD_SKIP_RENDER');
  });
});
