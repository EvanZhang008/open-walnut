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
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'devprod-render-check.mjs');
const DEV_PROD = path.join(REPO_ROOT, 'scripts', 'dev-prod.sh');

const shell = (body: string) => `<!doctype html><html><body><div id="root">${body}</div></body></html>`;

// One page per verdict. The "boundary" page reproduces what AppErrorBoundary
// does on a render crash: the console line AND the on-screen banner.
function sessionPage(broken: boolean, crash = false, wheel: '' | 'slow' | 'stuck' | 'covered' | 'panel-cover' | 'snapback' = ''): string {
  return shell(`<main class="main-page">
    <style>
      .session-panel { height: 500px; display: flex; flex-direction: column; }
      .session-panel-body { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
      .session-history { flex: 1; min-height: 0; overflow-y: auto; }
      .session-panel-input { height: 80px; flex: none; }
      ${broken ? '' : '.thread-stack-off { display: contents; }'}
    </style>
    <script>
      const sid = new URLSearchParams(location.search).get('s1');
      if (sid) {
        fetch('/api/sessions/' + sid + '/history').then(r => r.json()).then(data => {
          const panel = document.createElement('section');
          panel.className = 'session-panel';
          panel.dataset.sessionId = sid;
          panel.innerHTML = '<div class="session-panel-body"><div class="thread-stack-off"><div class="session-history"></div></div></div><div class="session-panel-input">Composer</div>';
          for (const message of data.messages) {
            const row = document.createElement('p');
            row.textContent = message.text;
            row.style.height = '100px';
            panel.querySelector('.session-history').append(row);
          }
          document.querySelector('main').append(panel);
          const history = panel.querySelector('.session-history');
          ${wheel === 'slow' ? "history.addEventListener('wheel', (e) => { e.preventDefault(); history.scrollTop += Math.sign(e.deltaY) * 30; }, { passive: false });" : ''}
          ${wheel === 'stuck' ? "history.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });" : ''}
          ${wheel === 'panel-cover' ? "const layer = document.createElement('div'); layer.className = 'panel-layer'; layer.style.cssText = 'position:absolute;inset:0;z-index:9;overflow:auto'; layer.innerHTML = '<div style=\"height:3000px\"></div>'; panel.style.position = 'relative'; panel.append(layer);" : ''}
          ${wheel === 'snapback' ? "history.addEventListener('scroll', () => { const end = history.scrollHeight - history.clientHeight; if (history.scrollTop < end - 1) setTimeout(() => { history.scrollTop = end; }, 0); });" : ''}
          ${wheel === 'covered' ? "const cover = document.createElement('div'); cover.className = 'test-cover'; cover.style.cssText = 'position:fixed;inset:0;z-index:9;overflow:auto'; cover.innerHTML = '<div style=\"height:3000px\"></div>'; document.body.append(cover);" : ''}
          ${crash ? "console.error('[error-boundary] render crash caught in the session panel');" : ''}
        });
      }
    </script>
  </main>`);
}

const PAGES: Record<string, string> = {
  '/scrollable': sessionPage(false),
  '/clipped': sessionPage(true),
  '/session-crash': sessionPage(false, true),
  '/scroll-slow': sessionPage(false, false, 'slow'),
  '/scroll-stuck': sessionPage(false, false, 'stuck'),
  '/scroll-covered': sessionPage(false, false, 'covered'),
  '/scroll-panel-cover': sessionPage(false, false, 'panel-cover'),
  '/scroll-snapback': sessionPage(false, false, 'snapback'),
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
    const html = PAGES[new URL(req.url ?? '/', 'http://localhost').pathname];
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
    // extra first: the script reads the first --timeout-ms it is given.
    const child = spawn(process.execPath, [SCRIPT, url, ...extra, '--timeout-ms', '20000'], {
      cwd: REPO_ROOT,
      env: BROWSERS ? { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSERS } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, out }); });
  });
}

/**
 * The browsers directory THIS process sees, handed to the script as well. Under bun
 * os.homedir() keeps the HOME the process started with, while the test setup fakes
 * HOME for every child, so the two would look in different places: the gate would
 * find a browser the script cannot. headless: true launches the headless shell.
 */
const BROWSERS = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const exe: string = require('playwright').chromium.executablePath();
    const parts = exe.split(path.sep);
    const at = parts.findIndex((p) => /^chromium[-_]/.test(p));
    return at > 0 && existsSync(exe) ? parts.slice(0, at).join(path.sep) : null;
  } catch {
    return null;
  }
})();
const hasChromium = BROWSERS !== null
  && readdirSync(BROWSERS).some((name) => name.startsWith('chromium_headless_shell-'));

describe.skipIf(!hasChromium)('devprod-render-check.mjs verdicts', () => {
  it('0: a page whose #root mounted is OK', async () => {
    const r = await run(`${base}/healthy`);
    expect(r.out).toContain('render-check OK');
    expect(r.code).toBe(0);
  });

  it('0: a long session scrolls in both directions and ends above the composer', async () => {
    const r = await run(`${base}/scrollable`);
    expect(r.out).toContain('session scroll OK');
    expect(r.code).toBe(0);
  });

  it('1: a missing wrapper style clips a mounted session and fails the gate', async () => {
    const r = await run(`${base}/clipped`);
    expect(r.out).toContain('session scroll FAILED');
    expect(r.code).toBe(1);
  });

  // 2026-11-11: the live check at load 117 read "could not scroll down within 60000ms" and rolled
  // production back from a good build. A leg that runs out of time is a definitive failure only
  // when the transcript never moved under a wheel the page kept answering, with nothing over it.
  it('2: a transcript that moves but too slowly to reach its end in time is UNDETERMINED, never a rollback', async () => {
    const r = await run(`${base}/scroll-slow`, ['--timeout-ms', '3000']);
    expect(r.out).toContain('session scroll UNDETERMINED');
    expect(r.out).toContain('moved but did not reach its end');
    expect(r.code).toBe(2);
  });

  it('2: something over the transcript is UNDETERMINED, naming it', async () => {
    const r = await run(`${base}/scroll-covered`, ['--timeout-ms', '3000']);
    expect(r.out).toContain('div.test-cover covers the transcript');
    expect(r.code).toBe(2);
  });

  it('1: a layer of the session panel itself over the transcript, eating the wheel, fails the gate', async () => {
    const r = await run(`${base}/scroll-panel-cover`, ['--timeout-ms', '3000']);
    expect(r.out).toContain('did not move under the wheel');
    expect(r.out).toContain('div.panel-layer, part of the session panel');
    expect(r.code).toBe(1);
  });

  it('1: a transcript pulled back to the bottom after every wheel fails the gate (it never gets toward the top)', async () => {
    const r = await run(`${base}/scroll-snapback`, ['--timeout-ms', '3000']);
    expect(r.out).toContain('session scroll FAILED: the transcript did not move under the wheel (scroll up');
    expect(r.code).toBe(1);
  });

  it('1: a transcript that never moves under the wheel fails the gate', async () => {
    const r = await run(`${base}/scroll-stuck`, ['--timeout-ms', '3000']);
    expect(r.out).toContain('did not move under the wheel');
    expect(r.code).toBe(1);
  });

  it('1: an error boundary firing inside the opened session fails the gate', async () => {
    const r = await run(`${base}/session-crash`);
    expect(r.out).toContain('session panel crashed');
    expect(r.code).toBe(1);
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
    expect(idx('WALNUT_DEVPROD_SKIP_TSC')).toBeLessThan(idx('--bun run web:build'));
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

// The class behind 2026-11-11's rollback: a check that rolls production back must call a page
// broken only on evidence, never because it ran out of time. Every definitive verdict of the
// session scroll check is listed here with what it saw; a new one fails until it is listed.
describe('devprod-session-scroll.mjs: a definitive verdict needs evidence, never a timeout', () => {
  const src = require('node:fs').readFileSync(path.join(REPO_ROOT, 'scripts', 'devprod-session-scroll.mjs'), 'utf8') as string;
  const EVIDENCE = [
    'session scroll FAILED: the session panel crashed', // the error boundary fired
    'session scroll FAILED: transcript is clipped or has no scroll range', // measured geometry
    'session scroll FAILED: the transcript did not move under the wheel', // stuck, many answered turns
    'session scroll FAILED (--strict)', // uncaught exceptions, only when asked
  ];
  it('lists every code 1 result', () => {
    const found = [...src.matchAll(/code: 1, message: `([^`$]*)/g)].map((m) => m[1].replace(/\s+$/, ''));
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) expect(EVIDENCE.some((e) => f.startsWith(e)), `unlisted definitive verdict: ${f}`).toBe(true);
    expect(src).not.toMatch(/code: 1[^\n]*within \$\{timeoutMs\}ms/);
  });
});
