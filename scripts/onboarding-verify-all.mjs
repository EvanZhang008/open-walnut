#!/usr/bin/env node
/**
 * End-to-end verification of ALL onboarding cases against pristine clean-room servers.
 * Drives the real UI, asserts health + DOM, and (when a real credential is provided)
 * proves the butler ACTUALLY REPLIES. Captures screenshots into demo/onboarding-shots/.
 *
 * Each case runs its own isolated server on :3458 with a fresh HOME + OPEN_WALNUT_HOME,
 * so ~/.claude and ~/.aws are empty. Production :3456 is never touched.
 *
 * Live cases need a real Bedrock token in the parent env as WALNUT_TEST_TOKEN
 * (+ optional WALNUT_TEST_REGION, default us-west-2). Detection-only cases run without it.
 *
 * Usage: WALNUT_TEST_TOKEN=... WALNUT_TEST_REGION=... node scripts/onboarding-verify-all.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = 3458;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(os.tmpdir(), 'walnut-verify');
const SHOTS = path.join(REPO, 'demo', 'onboarding-shots');
const TOKEN = process.env.WALNUT_TEST_TOKEN || '';
const REGION = process.env.WALNUT_TEST_REGION || 'us-west-2';
const RECORDER = path.join(os.homedir(), '.claude/skills/record-webapp-video/scripts/recorder.mjs');

fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } };
const log = (...a) => console.log(...a);

let chromium;
const results = [];
function record(name, pass, detail) { results.push({ name, pass, detail }); log(`${pass ? '✓ PASS' : '✗ FAIL'}  ${name} — ${detail}`); }

/**
 * Launch an isolated clean-room server. `seed(homeDir, walnutHome)` runs AFTER the
 * dirs are wiped+created but BEFORE the server starts, so a case can drop a
 * settings.json or config.yaml in place. `extraEnv` merges onto the pristine base.
 */
function launch(homeDir, walnutHome, { seed, extraEnv = {} } = {}) {
  rmrf(homeDir); rmrf(walnutHome);
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(walnutHome, { recursive: true });
  if (seed) seed(homeDir, walnutHome);
  const env = {
    HOME: homeDir, PATH: process.env.PATH, NODE_ENV: 'production',
    WALNUT_DISABLE_SEARCH: '1', OPEN_WALNUT_HOME: walnutHome,
    WALNUT_DAEMON_DIR: path.join(ROOT, 'daemon'), ...extraEnv,
  };
  return spawn('node', [path.join(REPO, 'dist/cli.js'), 'web', '--port', String(PORT)],
    { env, stdio: ['ignore', 'ignore', 'ignore'] });
}

async function waitHealth(timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(`${BASE}/api/system/health`); if (r.ok) return await r.json(); } catch { /* not up */ }
    await sleep(800);
  }
  throw new Error('server did not become healthy in time');
}
function stop(srv) { try { srv.kill('SIGTERM'); } catch { /* ignore */ } }
async function killPort() {
  await new Promise((res) => spawn('bash', ['-c', `lsof -ti:${PORT} -sTCP:LISTEN | xargs kill 2>/dev/null || true`]).on('close', res));
  await sleep(500);
}

async function newPage() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 820 } });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2800);
  return { browser, page };
}

async function shoot(name) {
  const { browser, page } = await newPage();
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file });
  await browser.close();
  return file;
}

/**
 * Drive the chat composer and wait for a real assistant reply. We embed a unique
 * marker token in the prompt and wait for the page to render it back from the
 * assistant turn (a "WALNUT" message containing the marker), which is robust
 * regardless of reply length. The marker is NOT the same string the user typed
 * verbatim once — we ask the butler to echo it, then require it to appear at least
 * TWICE (the user echo + the assistant reply).
 */
async function butlerReplies(marker, shotName) {
  const { browser, page } = await newPage();
  let replied = false, text = '';
  const prompt = `Reply with exactly this token and nothing else: ${marker}`;
  try {
    const box = page.locator('textarea').first();
    await box.waitFor({ state: 'visible', timeout: 10000 });
    await box.click();
    await box.fill(prompt);
    await box.press('Enter');
    // Wait until the marker appears at least twice (user bubble + assistant reply).
    await page.waitForFunction(
      (m) => ((document.body.innerText || '').match(new RegExp(m, 'g')) || []).length >= 2,
      marker, { timeout: 70000 },
    );
    await page.waitForTimeout(1200); // let streaming settle for the screenshot
    replied = true;
    text = (await page.evaluate(() => document.body.innerText)).slice(-260).replace(/\s+/g, ' ');
  } catch (e) {
    text = `(no reply: ${e.message.split('\n')[0]})`;
  }
  await page.screenshot({ path: path.join(SHOTS, `${shotName}.png`) });
  await browser.close();
  return { replied, text };
}

async function main() {
  try { ({ chromium } = await import(RECORDER)); } catch { /* fall back */ }
  if (!chromium) ({ chromium } = await import('playwright'));

  const HOME = path.join(ROOT, 'home');
  const WH = path.join(ROOT, 'wh');
  await killPort();

  // ── Case 1: clean room, no creds → onboarding shows ──
  log('\n── Case 1: clean room (no creds) ──');
  let srv = launch(HOME, WH);
  let h = await waitHealth();
  record('C1 health', h.hasReadyProvider === false && h.credentialSource === 'none', `hasReadyProvider=${h.hasReadyProvider} source=${h.credentialSource}`);
  {
    const { browser, page } = await newPage();
    const banner = await page.locator('text=Get Walnut talking').count();
    const hero = await page.locator('text=Paste this into it').count();
    const manual = await page.locator('text=AI Provider').count();
    record('C1 UI', banner > 0 && hero > 0 && manual > 0, `banner=${banner} hero=${hero} manual=${manual}`);
    await page.screenshot({ path: path.join(SHOTS, 'case1-clean-onboarding.png') });
    await browser.close();
  }
  stop(srv); await killPort();

  // ── Case 2: settings.json env auto-detect (+ LIVE reply) ──
  log('\n── Case 2: ~/.claude/settings.json env auto-detect ──');
  srv = launch(HOME, WH, {
    seed: (home) => {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
        JSON.stringify({ env: { AWS_BEARER_TOKEN_BEDROCK: TOKEN || 'fake-detect-token', AWS_REGION: REGION } }));
    },
  });
  h = await waitHealth();
  record('C2 health', h.hasReadyProvider === true && h.credentialSource === 'claude-settings', `source=${h.credentialSource} detail=${h.credentialDetail}`);
  {
    const { browser, page } = await newPage();
    const note = await page.locator('text=Auto-detected Bedrock via').count();
    record('C2 UI note', note > 0, `auto-detect note=${note}`);
    await page.screenshot({ path: path.join(SHOTS, 'case2-autodetect-note.png') });
    await browser.close();
  }
  if (TOKEN) {
    const r = await butlerReplies('ONBOARDINGOK', 'case2-live-reply');
    record('C2 LIVE reply', r.replied, r.replied ? `replied: …${r.text.slice(-90)}` : r.text);
  } else record('C2 LIVE reply', false, 'SKIPPED — no WALNUT_TEST_TOKEN');
  stop(srv); await killPort();

  // ── Case 3: env-var auto-detect (no settings.json) ──
  log('\n── Case 3: env-var auto-detect ──');
  if (TOKEN) {
    srv = launch(HOME, WH, { extraEnv: { AWS_BEARER_TOKEN_BEDROCK: TOKEN, AWS_REGION: REGION } });
    h = await waitHealth();
    record('C3 env-detect', h.hasReadyProvider === true && h.credentialSource === 'env', `source=${h.credentialSource} detail=${h.credentialDetail}`);
    stop(srv); await killPort();
  } else record('C3 env-detect', false, 'SKIPPED — no WALNUT_TEST_TOKEN');

  // ── Case 4: hero skill writes config.yaml (+ LIVE reply) ──
  log('\n── Case 4: hero skill → config.yaml ──');
  srv = launch(HOME, WH, {
    seed: (_home, wh) => {
      fs.writeFileSync(path.join(wh, 'config.yaml'),
        `version: 1\nproviders:\n  bedrock:\n    api: bedrock\n    region: ${REGION}\n` + (TOKEN ? `    bearer_token: ${TOKEN}\n` : ''));
    },
  });
  h = await waitHealth();
  record('C4 config', h.hasReadyProvider === true && h.credentialSource === 'config', `source=${h.credentialSource}`);
  if (TOKEN) {
    const r = await butlerReplies('HEROOK', 'case4-live-reply');
    record('C4 LIVE reply', r.replied, r.replied ? `replied: …${r.text.slice(-90)}` : r.text);
  } else record('C4 LIVE reply', false, 'SKIPPED — no WALNUT_TEST_TOKEN');
  stop(srv); await killPort();

  // ── Case 5: manual via API (the path the banner's Settings link drives) ──
  log('\n── Case 5: manual via /api/config (Settings UI path) ──');
  srv = launch(HOME, WH);
  let h0 = await waitHealth();
  record('C5 pre', h0.hasReadyProvider === false, `pre source=${h0.credentialSource}`);
  if (TOKEN) {
    await fetch(`${BASE}/api/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providers: { bedrock: { api: 'bedrock', region: REGION, bearer_token: TOKEN } } }),
    });
    let h1; for (let i = 0; i < 12; i++) { await sleep(600); h1 = await (await fetch(`${BASE}/api/system/health`)).json(); if (h1.hasReadyProvider) break; }
    record('C5 after-save', h1.hasReadyProvider === true && h1.credentialSource === 'config', `source=${h1.credentialSource}`);
    await shoot('case5-after-save');
    const r = await butlerReplies('MANUALOK', 'case5-live-reply');
    record('C5 LIVE reply', r.replied, r.replied ? `replied: …${r.text.slice(-90)}` : r.text);
  } else record('C5 after-save', false, 'SKIPPED — no WALNUT_TEST_TOKEN');
  stop(srv); await killPort();

  // ── Summary ──
  log('\n══════════ SUMMARY ══════════');
  let pass = 0, fail = 0, skip = 0;
  for (const r of results) { if (r.detail.includes('SKIPPED')) skip++; else if (r.pass) pass++; else fail++; }
  log(`PASS=${pass}  FAIL=${fail}  SKIP=${skip}`);
  log(`Screenshots → ${SHOTS}`);
  process.exitCode = fail > 0 ? 1 : 0;
}

await main();
