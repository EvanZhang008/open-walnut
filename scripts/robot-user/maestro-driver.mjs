#!/usr/bin/env node
/**
 * Thin wrapper around the maestro MCP-as-CLI used by the robot user.
 *
 * Two hard-won rules are baked in here (do not "simplify" them away):
 *  1. Every CLI invocation is preceded by resetting ~/.maestro/device_locks.json to {} —
 *     each call can leave a stale lock behind whose owner pid is already dead, and the
 *     next call then fails with "DEVICE LOCKED - in use by another agent".
 *  2. Screenshots go through `xcrun simctl io <udid> screenshot` — the maestro
 *     take_screenshot tool is broken (returns an error/empty payload).
 *
 * Every exported call resolves to { ok, error?, ms, ... } so the caller never throws.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP_ID = 'dev.openwalnut.ios';

const DEFAULT_CLI = path.join(os.homedir(), '.claude', 'skills', 'maestro-as-cli', 'scripts', 'maestro');
const LOCK_FILE = path.join(os.homedir(), '.maestro', 'device_locks.json');

export function maestroCliPath() {
  return process.env.MAESTRO_CLI || DEFAULT_CLI;
}

/** Clear the stale device lock. Best-effort: a missing ~/.maestro is fine. */
function clearDeviceLocks() {
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    fs.writeFileSync(LOCK_FILE, '{}');
  } catch {
    /* ignore — the CLI will report a real lock problem if it matters */
  }
}

/** Unwrap the MCP content envelope some tools use: { content: [{ type:'text', text }] }. */
function unwrap(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { json: null, text: raw };
  }
  if (parsed && Array.isArray(parsed.content)) {
    const text = parsed.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
    return { json: parsed, text, isError: parsed.isError === true };
  }
  return { json: parsed, text: raw, isError: parsed && parsed.isError === true };
}

/** Raw `maestro tools call <tool> '<json>'`. */
function callTool(tool, payload, timeoutMs = 90_000) {
  clearDeviceLocks();
  const t0 = Date.now();
  const res = spawnSync(maestroCliPath(), ['tools', 'call', tool, JSON.stringify(payload)], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  if (res.error) return { ok: false, ms, error: `${tool}: ${res.error.message}`, timedOut: res.error.code === 'ETIMEDOUT' };
  if (res.status !== 0) {
    return { ok: false, ms, error: `${tool}: exit ${res.status} ${(res.stderr || '').slice(0, 300)}` };
  }
  const { json, text, isError } = unwrap(res.stdout || '');
  if (isError) return { ok: false, ms, error: `${tool}: ${String(text).slice(0, 300)}`, json, text };
  return { ok: true, ms, json, text };
}

function simctl(args, timeoutMs = 60_000) {
  const t0 = Date.now();
  const res = spawnSync('xcrun', ['simctl', ...args], { encoding: 'utf8', timeout: timeoutMs });
  const ms = Date.now() - t0;
  if (res.error) return { ok: false, ms, error: res.error.message };
  if (res.status !== 0) return { ok: false, ms, error: `simctl ${args[0]}: ${(res.stderr || '').trim().slice(0, 300)}` };
  return { ok: true, ms, text: res.stdout || '' };
}

// ─── view-hierarchy CSV parsing ──────────────────────────────────────────────
// Rows look like:
//   element_num,depth,bounds,attributes,parent_num
//   15,15,"[20,66][56,102]","accessibilityText=Clock; resource-id=chat.history; enabled=true",14

const ATTR_KEYS = ['resource-id', 'accessibilityText', 'enabled', 'hintText', 'clickable', 'focused', 'selected', 'checked', 'index'];

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseAttrs(blob) {
  const attrs = {};
  if (!blob) return attrs;
  // Values may themselves contain "; " (accessibilityText of a chat bubble), so only
  // split where the next token is a known key.
  const keyRe = new RegExp(`;\\s*(?=(?:${ATTR_KEYS.join('|')})=)`);
  for (const part of blob.split(keyRe)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    attrs[part.slice(0, eq).trim()] = part.slice(eq + 1);
  }
  return attrs;
}

function parseBounds(s) {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(s || '');
  if (!m) return null;
  const [x, y, x2, y2] = m.slice(1).map(Number);
  return { x, y, x2, y2, w: x2 - x, h: y2 - y };
}

export function parseHierarchyCsv(csv) {
  const rows = [];
  const lines = String(csv || '').split('\n');
  for (const line of lines) {
    if (!line.trim() || line.startsWith('element_num')) continue;
    const cells = splitCsvLine(line);
    if (cells.length < 4) continue;
    const attrs = parseAttrs(cells[3]);
    rows.push({
      num: Number(cells[0]),
      depth: Number(cells[1]),
      bounds: parseBounds(cells[2]),
      id: attrs['resource-id'] || null,
      text: attrs.accessibilityText || null,
      enabled: attrs.enabled !== 'false',
      parent: cells[4] === '' ? null : Number(cells[4]),
    });
  }
  return rows;
}

// ─── driver ──────────────────────────────────────────────────────────────────

/**
 * @param {{ deviceId: string, appId?: string, onFlow?: (yaml:string)=>void }} opts
 */
export function createDriver({ deviceId, appId = APP_ID, onFlow }) {
  let lastHierarchyMs = 0;

  const header = `appId: ${appId}\n---\n`;
  const withHeader = (body) => (/^\s*appId:/.test(body) ? body : header + body);

  const driver = {
    kind: 'maestro',
    deviceId,
    appId,
    get lastHierarchyMs() { return lastHierarchyMs; },

    /** Run an ad-hoc flow. The appId header is prepended when missing. */
    runFlow(devId, yamlBody) {
      const yaml = withHeader(yamlBody);
      if (onFlow) onFlow(yaml);
      const r = callTool('run-flow', { device_id: devId || deviceId, flow_yaml: yaml });
      return { ...r, yaml };
    },

    inspectHierarchy(devId) {
      const r = callTool('inspect-view-hierarchy', { device_id: devId || deviceId }, 60_000);
      lastHierarchyMs = r.ms;
      if (!r.ok) return { ok: false, ms: r.ms, error: r.error, rows: [] };
      return { ok: true, ms: r.ms, rows: parseHierarchyCsv(r.text), raw: r.text };
    },

    tapId(id, devId) {
      return driver.runFlow(devId, `- tapOn:\n    id: ${JSON.stringify(id)}\n`);
    },

    tapPoint(pctX, pctY, devId) {
      return driver.runFlow(devId, `- tapOn:\n    point: ${Math.round(pctX)}%, ${Math.round(pctY)}%\n`);
    },

    inputText(text, devId) {
      // Double-quoted YAML scalars accept JSON escaping, which keeps emoji/CJK/newlines intact.
      return driver.runFlow(devId, `- inputText: ${JSON.stringify(text)}\n`);
    },

    swipe({ fromX, fromY, toX, toY, durationMs = 400 }, devId) {
      return driver.runFlow(
        devId,
        `- swipe:\n    start: ${Math.round(fromX)}%, ${Math.round(fromY)}%\n` +
          `    end: ${Math.round(toX)}%, ${Math.round(toY)}%\n    duration: ${Math.round(durationMs)}\n`,
      );
    },

    back(devId) {
      return driver.runFlow(devId, '- back\n');
    },

    /** simctl screenshot — maestro's own screenshot tool is broken. */
    screenshot(devId, filePath) {
      try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch { /* ignore */ }
      const r = simctl(['io', devId || deviceId, 'screenshot', filePath], 30_000);
      return r.ok ? { ok: true, ms: r.ms, path: filePath } : r;
    },

    terminate(devId) {
      return simctl(['terminate', devId || deviceId, appId], 30_000);
    },

    launch(devId) {
      return simctl(['launch', devId || deviceId, appId], 30_000);
    },
  };

  return driver;
}

export { callTool as maestroCall, simctl };
