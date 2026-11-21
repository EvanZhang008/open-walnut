/**
 * Every call in src/ that puts a line into a session (a send, a raw enqueue, a start), with the
 * `source:` literals named in the call. Shared by the guards that classify send sources:
 * tests/core/sessions/send-sender-guard.test.ts (who counts as a person) and
 * tests/core/program-run-adoption-sources.test.ts (which side of a program run's adoption).
 */
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(__dirname, '../..');
export const SRC = path.join(ROOT, 'src');

export function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const CALL = /\b(sendMessageToSession|deliverToSession|enqueueMessage|startSessionForTask|quickStartSession|continueTaskConversation|performSessionSend|performMobileLaunch|getOrCreateLaneSession)\(|sessionRunner\.startSession\(/g;

export interface Site { file: string; fn: string; line: number; sources: string[] }

/** Every call that puts a line into a session, with the `source:` literals named in the call. */
export function callSites(): Site[] {
  const sites: Site[] = [];
  for (const f of walk(SRC)) {
    const text = fs.readFileSync(f, 'utf8');
    const lines = text.split('\n');
    CALL.lastIndex = 0;
    for (let m = CALL.exec(text); m; m = CALL.exec(text)) {
      if (/function\s+$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
      const line = text.slice(0, m.index).split('\n').length;
      if (/^\s*(\/\/|\*|\/\*)/.test(lines[line - 1])) continue;
      const window = text.slice(m.index, m.index + 900);
      const sources = [...window.matchAll(/source:\s*(?:'([^']+)'|`([^`]+)`|([A-Za-z_][\w.]*))/g)].slice(0, 3)
        .map((x) => x[1] ?? x[2] ?? `<${x[3]}>`);
      sites.push({ file: path.relative(ROOT, f), fn: m[1] ?? 'startSession', line, sources });
    }
  }
  return sites;
}
